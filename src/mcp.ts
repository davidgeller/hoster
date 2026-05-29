import {
  existsSync, readdirSync, statSync, mkdirSync, unlinkSync,
  realpathSync, readFileSync, writeFileSync, appendFileSync, renameSync
} from "fs";
import { join, resolve, dirname } from "path";
import { Jimp, JimpMime } from "jimp";
import { getSite, listSites, listVersions, getVersion, commitVersion, markVersionModified, uploadFileToSite, SITES_DIR, type Site } from "./sites";
import { fetchRemoteMedia, MAX_BYTES as REMOTE_MAX_BYTES } from "./remote-fetch";
import db, { sqliteNow } from "./db";

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    site_slug TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mcp_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER,
    token_label TEXT,
    tool TEXT NOT NULL,
    site_slug TEXT,
    path TEXT,
    success INTEGER DEFAULT 1,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_audit_created ON mcp_audit_log(created_at);
`);

// --- Constants ---

const MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB per tool call (base64 payload)
const MAX_BINARY_FILE_SIZE = 100 * 1024 * 1024; // 100 MB total file size
const MAX_AUDIT_ROWS = 10_000;

// Allowed media formats for write_media_file, mapped to content validators.
// Validator returns true if `bytes` looks like a valid instance of the format.
// For chunked uploads we only validate on the first chunk (append:false);
// subsequent appends are gated only by the extension allowlist since the
// header is already on disk. SVG bans chunked uploads (see CHUNKABLE) because
// the script-rejection check needs to see the whole document.
const MEDIA_FORMATS: Record<string, (b: Buffer) => boolean> = {
  ".jpg":  b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".jpeg": b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".png":  b => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  ".gif":  b => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
    && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  ".mp3":  b => b.length >= 3 && (
    // ID3v2 tag
    (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
    // MPEG audio frame sync (11 bits set)
    (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
  ),
  // MP4 / ISO BMFF: bytes 4-7 are "ftyp"
  ".mp4":  b => b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  // SVG: XML text, not a binary signature. Require an <svg root element near
  // the top (after any XML declaration, DOCTYPE, comments, or BOM). Reject
  // active-content vectors — script tags, JS-protocol URLs, and inline event
  // handlers — so an agent can't import an SVG that runs code when a visitor
  // views it directly (e.g. via <object>/<embed> or right-click → view image).
  ".svg":  b => {
    if (b.length < 5) return false;
    // Cap at 1 MB for the text scan; that's plenty for any real SVG.
    const head = b.subarray(0, Math.min(b.length, 1024 * 1024)).toString("utf-8");
    const text = head.charCodeAt(0) === 0xFEFF ? head.slice(1) : head;
    if (!/<svg[\s>]/i.test(text)) return false;
    if (/<script[\s>]/i.test(text)) return false;
    if (/<foreignObject[\s>]/i.test(text)) return false;
    if (/\son\w+\s*=/i.test(text)) return false;
    if (/javascript:/i.test(text)) return false;
    return true;
  },
};
// Extensions that may be split across multiple write_media_file calls. SVG
// can't because we need to see the whole document to enforce the script
// rejection — chunk 2 could otherwise smuggle in a <script> past the gate.
const CHUNKABLE_MEDIA: Set<string> = new Set([".jpg", ".jpeg", ".png", ".gif", ".mp3", ".mp4"]);
const MEDIA_EXTENSIONS = Object.keys(MEDIA_FORMATS).join(", ");

function mediaExt(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.substring(dot).toLowerCase();
  return MEDIA_FORMATS[ext] ? ext : null;
}

// Raster formats resize_image can decode (source) and encode (destination).
// PNG keeps an alpha channel; JPEG is flattened onto a background when a
// transparent source is converted to it. GIF/SVG/video are out of scope —
// resampling those needs different handling than a single still frame.
const RESIZABLE_FORMATS: Set<string> = new Set([".png", ".jpg", ".jpeg"]);

function rasterExt(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.substring(dot).toLowerCase();
  return RESIZABLE_FORMATS.has(ext) ? ext : null;
}

// Parse a CSS hex color (#RGB, #RRGGBB, #RRGGBBAA) into Jimp's 0xRRGGBBAA
// integer. Returns null on malformed input. Used to flatten transparency when
// converting a PNG to JPEG.
function parseHexColor(s: string): number | null {
  let h = s.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (h.length === 6) h += "ff";
  if (h.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(h)) return null;
  return parseInt(h, 16) >>> 0;
}

// --- Token Management ---

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(token);
  return hasher.digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

interface McpTokenRecord {
  id: number;
  token_hash: string;
  label: string;
  site_slug: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface McpTokenInfo {
  id: number;
  label: string;
  site_slug: string | null;
  expires_at: string | null;
  created_at: string;
  expired: boolean;
}

export function createMcpToken(label: string, siteSlug: string | null, expiresInDays: number | null): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const hash = hashToken(token);

  let expiresAt: string | null = null;
  if (expiresInDays && expiresInDays > 0) {
    expiresAt = sqliteNow(expiresInDays * 24 * 60 * 60 * 1000);
  }

  db.run(
    "INSERT INTO mcp_tokens (token_hash, label, site_slug, expires_at) VALUES (?, ?, ?, ?)",
    hash, label, siteSlug || null, expiresAt
  );
  return token;
}

export function listMcpTokens(): McpTokenInfo[] {
  const rows = db.query("SELECT id, label, site_slug, expires_at, created_at FROM mcp_tokens ORDER BY created_at DESC").all() as McpTokenInfo[];
  const now = sqliteNow();
  return rows.map(r => ({
    ...r,
    expired: r.expires_at ? r.expires_at < now : false,
  }));
}

export function deleteMcpToken(id: number): boolean {
  const result = db.run("DELETE FROM mcp_tokens WHERE id = ?", id);
  return result.changes > 0;
}

interface ValidatedToken {
  id: number;
  label: string;
  site_slug: string | null;
  issued_via: "static" | "oauth";
  scopes: string[] | null; // null for static tokens (full access within scope)
}

function validateMcpToken(token: string): ValidatedToken | null {
  const incoming = hashToken(token);
  const rows = db.query(
    "SELECT id, token_hash, label, site_slug, expires_at, issued_via, scopes FROM mcp_tokens"
  ).all() as Array<McpTokenRecord & { issued_via: string | null; scopes: string | null }>;

  for (const row of rows) {
    if (constantTimeEqual(incoming, row.token_hash)) {
      // Check expiration
      if (row.expires_at) {
        const now = sqliteNow();
        if (row.expires_at < now) return null; // expired
      }
      const issuedVia = (row.issued_via === "oauth" ? "oauth" : "static") as "static" | "oauth";
      return {
        id: row.id,
        label: row.label,
        site_slug: row.site_slug,
        issued_via: issuedVia,
        scopes: row.scopes ? row.scopes.split(/\s+/).filter(Boolean) : null,
      };
    }
  }
  return null;
}

// Migrate: move legacy single token from config to mcp_tokens table
try {
  const legacy = db.query("SELECT value FROM config WHERE key = 'mcp_token_hash'").get() as { value: string } | null;
  if (legacy) {
    const exists = db.query("SELECT 1 FROM mcp_tokens WHERE token_hash = ?").get(legacy.value);
    if (!exists) {
      db.run(
        "INSERT INTO mcp_tokens (token_hash, label, site_slug, expires_at) VALUES (?, ?, NULL, NULL)",
        legacy.value, "Migrated token"
      );
    }
    db.run("DELETE FROM config WHERE key = 'mcp_token_hash'");
  }
} catch (_) {}

// --- Audit Logging ---

function logAudit(tokenId: number, tokenLabel: string, tool: string, siteSlug: string | null, path: string | null, success: boolean, error: string | null) {
  db.run(
    "INSERT INTO mcp_audit_log (token_id, token_label, tool, site_slug, path, success, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    tokenId, tokenLabel, tool, siteSlug, path, success ? 1 : 0, error
  );
  // Auto-prune
  const count = (db.query("SELECT COUNT(*) as c FROM mcp_audit_log").get() as any).c;
  if (count > MAX_AUDIT_ROWS) {
    db.run(`DELETE FROM mcp_audit_log WHERE id IN (SELECT id FROM mcp_audit_log ORDER BY created_at ASC LIMIT ?)`, count - MAX_AUDIT_ROWS);
  }
}

export function getMcpAuditLog(limit: number): any[] {
  return db.query("SELECT * FROM mcp_audit_log ORDER BY created_at DESC LIMIT ?").all(limit);
}

// --- Site File Operations ---

function getContentDir(slug: string): string | null {
  const site = getSite(slug);
  if (!site || !site.mcp_enabled) return null;

  const siteDir = join(SITES_DIR, slug, "_current");
  if (!existsSync(siteDir)) return null;

  const contentDir = site.root_dir ? join(siteDir, site.root_dir) : siteDir;
  if (!existsSync(contentDir)) return null;

  return contentDir;
}

function safePath(contentDir: string, filePath: string): string | null {
  if (filePath.includes("\0")) return null;

  const resolved = resolve(contentDir, filePath);
  if (!resolved.startsWith(contentDir + "/") && resolved !== contentDir) return null;

  if (existsSync(resolved)) {
    const realContentDir = realpathSync(contentDir);
    const realResolved = realpathSync(resolved);
    if (!realResolved.startsWith(realContentDir + "/") && realResolved !== realContentDir) return null;
  }
  return resolved;
}

function walkFiles(dir: string, base = ""): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, rel));
    } else if (entry.isFile()) {
      results.push({ path: rel, size: statSync(full).size });
    }
  }
  return results;
}

function isTextFile(path: string, buffer: Buffer): boolean {
  const textExtensions = new Set([
    ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
    ".json", ".xml", ".svg", ".txt", ".md", ".markdown",
    ".ts", ".tsx", ".jsx", ".vue", ".svelte",
    ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
    ".sh", ".bash", ".zsh", ".fish",
    ".py", ".rb", ".php", ".java", ".c", ".h", ".cpp", ".hpp",
    ".rs", ".go", ".swift", ".kt", ".cs", ".lua", ".pl",
    ".map", ".csv", ".log", ".env",
    ".gitignore", ".editorconfig", ".prettierrc", ".eslintrc",
    ".htaccess", ".nginx",
  ]);
  const dot = path.lastIndexOf(".");
  if (dot >= 0) {
    const ext = path.substring(dot).toLowerCase();
    if (textExtensions.has(ext)) return true;
  }
  const check = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return false;
  }
  return true;
}

// --- MCP Protocol ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

function rpcResult(id: string | number | null, result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "list_sites",
    description: "List all sites that have MCP access enabled",
    inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "list_files",
    description: "List all files in a site's current deployment with their sizes",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug (e.g. 'activewords')" },
      },
      required: ["site"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file from a site. Returns text for text files, base64-encoded data for binary files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        path: { type: "string" as const, description: "File path relative to site root (e.g. 'index.html', 'css/style.css')" },
      },
      required: ["site", "path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file in a site. Creates parent directories if needed. Overwrites existing files. Blocked if site is read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        path: { type: "string" as const, description: "File path relative to site root" },
        content: { type: "string" as const, description: "File content (text)" },
      },
      required: ["site", "path", "content"],
    },
  },
  {
    name: "write_media_file",
    description: "Write a media file (image, vector, or audio/video) to a site. Allowed formats: JPEG, PNG, GIF, SVG, MP3, MP4 — identified by file extension and content validation (magic-byte signature for binary formats; XML structure + script-vector rejection for SVG). Content must be base64-encoded. Supports chunked uploads for binary formats: set `append: false` (or omit) on the first call to create/truncate, then call again with `append: true` for additional chunks. Per-call payload limit is 10 MB of base64 (~7.5 MB raw); total file size limit is 100 MB. SVG must be uploaded in a single call (no `append: true`) so the full document can be checked for embedded scripts. Blocked if site is read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        path: { type: "string" as const, description: "File path relative to site root. Extension must be one of: .jpg, .jpeg, .png, .gif, .mp3, .mp4 (e.g. 'media/intro.mp4')" },
        content: { type: "string" as const, description: "Base64-encoded media content for this chunk" },
        append: { type: "boolean" as const, description: "If true, append to existing file (for chunk 2+ of a large upload). Default: false (truncate/create)." },
      },
      required: ["site", "path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from a site. Blocked if site is read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        path: { type: "string" as const, description: "File path relative to site root" },
      },
      required: ["site", "path"],
    },
  },
  {
    name: "list_versions",
    description: "List all snapshot versions of a site, newest first. Each entry includes the version id, optional label, file count, size, and whether the version has been modified by MCP writes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
      },
      required: ["site"],
    },
  },
  {
    name: "commit_version",
    description: "Freeze the current working state of a site as a named snapshot, then fork a new mutable copy for further edits. Use this to mark meaningful checkpoints (e.g. 'first draft', 'after hero redesign') that an admin can roll back to. Blocked if site is read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        label: { type: "string" as const, description: "Optional short label applied to the snapshot being frozen (e.g. 'v1 — initial layout')" },
      },
      required: ["site"],
    },
  },
  {
    name: "fetch_remote_media",
    description: "Import a media file from a public URL into a site. Hoster does the HTTP fetch server-side, so the bytes never round-trip through chat. Use this when building or updating a site that needs images, vectors, audio, or video from CDNs, icon libraries, stock-photo sites, or other public sources. Allowed formats and content validation match write_media_file (.jpg, .jpeg, .png, .gif, .svg, .mp3, .mp4). The destination extension must match the downloaded content — magic-byte check for binary formats, and XML + script-vector rejection for SVG. Source URL must be public http or https (no private/loopback/link-local IPs, no schemes other than http/https, ports 80/443 only). Max 50 MB per file, 30s total timeout, up to 5 redirects each re-validated. Blocked if site is read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        url: { type: "string" as const, description: "Public source URL (http or https)" },
        path: { type: "string" as const, description: "Destination path within the site (e.g. 'media/hero.jpg'). The extension determines the expected format and is checked against the downloaded content's magic bytes." },
        replace: { type: "boolean" as const, description: "Overwrite an existing file at the destination. Default false — fetch fails with an error if a file already exists there." },
      },
      required: ["site", "url", "path"],
    },
  },
  {
    name: "rename_file",
    description: "Rename or move a file within a site. Works across folders (e.g. 'draft.html' → 'archive/draft.html'), creating destination directories as needed. Fails if the destination already exists unless `replace` is true. Source must be an existing file, not a directory. Blocked if site is read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        from: { type: "string" as const, description: "Current file path relative to site root" },
        to: { type: "string" as const, description: "New file path relative to site root. May be in a different folder (moves the file)." },
        replace: { type: "boolean" as const, description: "Overwrite an existing file at the destination. Default false — rename fails if a file already exists there." },
      },
      required: ["site", "from", "to"],
    },
  },
  {
    name: "resize_image",
    description: "Resize and/or re-encode a PNG or JPEG image already in the site, writing the result back. Use this to shrink large images. Three things you can do, in any combination: (1) Scale down — give `width` and/or `height` (max bounds, aspect ratio preserved, never upscales) or `scale` (0–1 fraction). This is the main way to shrink a PNG. (2) Convert format — set `output` to a path with a different extension; PNG→JPEG flattens transparency onto `background` (default white), JPEG→PNG is lossless. (3) Recompress JPEG — for JPEG output, lower `quality` (1–100, default 80) for smaller, lossier files. PNG output is always lossless (transparency preserved); `quality` does not apply to it. If `output` is omitted the source is overwritten in place. Blocked if site is read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        site: { type: "string" as const, description: "Site slug" },
        path: { type: "string" as const, description: "Source image path relative to site root. Must be an existing .png, .jpg, or .jpeg file." },
        output: { type: "string" as const, description: "Destination path (.png, .jpg, or .jpeg). Extension selects the output format. Omit to overwrite the source in place." },
        width: { type: "number" as const, description: "Maximum output width in pixels. Aspect ratio is preserved; the image is never enlarged." },
        height: { type: "number" as const, description: "Maximum output height in pixels. Aspect ratio is preserved; the image is never enlarged." },
        scale: { type: "number" as const, description: "Scale factor between 0 and 1 (e.g. 0.5 = half size). Ignored if width or height is given." },
        quality: { type: "number" as const, description: "JPEG output quality 1–100 (lower = smaller/lossier, default 80). Has no effect on PNG output, which is always lossless." },
        background: { type: "string" as const, description: "Fill color (CSS hex like '#ffffff') used to flatten transparency when converting a transparent PNG to JPEG. Default white." },
      },
      required: ["site", "path"],
    },
  },
];

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// If the site has auto-commit enabled and its current version has not yet been
// touched by MCP, snapshot it before applying the incoming write/delete so the
// pre-MCP state is preserved as a rollback point.
function autoCommitIfNeeded(siteSlug: string, token: ValidatedToken): void {
  const site = getSite(siteSlug);
  if (!site || !site.mcp_auto_commit || !site.current_version) return;
  const current = getVersion(siteSlug, site.current_version);
  if (!current || current.mcp_modified) return;
  try {
    const newVer = commitVersion(siteSlug, null);
    if (newVer) {
      logAudit(token.id, token.label, "auto_commit", siteSlug, null, true, null);
    }
  } catch (e: any) {
    logAudit(token.id, token.label, "auto_commit", siteSlug, null, false, e?.message || "unknown");
  }
}

function markCurrentModified(siteSlug: string): void {
  const site = getSite(siteSlug);
  if (site?.current_version) {
    markVersionModified(siteSlug, site.current_version);
  }
}

// Map MCP tool names to the OAuth scope they require. Tools with no entry
// require no scope check (e.g. list_sites is always allowed within audience).
const TOOL_SCOPE: Record<string, "read" | "write" | "commit"> = {
  list_files: "read",
  read_file: "read",
  list_versions: "read",
  write_file: "write",
  write_media_file: "write",
  fetch_remote_media: "write",
  delete_file: "write",
  rename_file: "write",
  resize_image: "write",
  commit_version: "commit",
};

async function handleToolCall(name: string, args: any, token: ValidatedToken, touched: Set<string>): Promise<ToolResult> {
  try {
    // For site-specific tools, check token scope
    const siteSlug = args.site as string | undefined;
    if (siteSlug) touched.add(siteSlug);

    if (siteSlug && token.site_slug && token.site_slug !== siteSlug) {
      const err = `Token is scoped to site '${token.site_slug}', cannot access '${siteSlug}'`;
      logAudit(token.id, token.label, name, siteSlug, args.path || null, false, err);
      return { content: [{ type: "text", text: err }], isError: true };
    }

    // OAuth scope enforcement (static tokens skip — they have full access within their site scope).
    if (token.issued_via === "oauth" && token.scopes) {
      const required = TOOL_SCOPE[name];
      if (required && !token.scopes.includes(required)) {
        const err = `OAuth token lacks '${required}' scope for tool '${name}'`;
        logAudit(token.id, token.label, name, siteSlug || null, args.path || null, false, err);
        return { content: [{ type: "text", text: err }], isError: true };
      }
    }

    switch (name) {
      case "list_sites": {
        let sites = listSites().filter((s: Site) => s.mcp_enabled);
        // If token is scoped, only show that site
        if (token.site_slug) {
          sites = sites.filter(s => s.slug === token.site_slug);
        }
        const result = sites.map(s => ({
          slug: s.slug,
          name: s.name,
          active: !!s.active,
          read_only: !!s.mcp_read_only,
          cms_enabled: !!s.cms_enabled,
          file_count: s.file_count,
          size_bytes: s.size_bytes,
        }));
        logAudit(token.id, token.label, name, null, null, true, null);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_files": {
        if (!siteSlug) return missingArg("site");
        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const files = walkFiles(contentDir);
        logAudit(token.id, token.label, name, siteSlug, null, true, null);
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "read_file": {
        if (!siteSlug) return missingArg("site");
        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const resolved = safePath(contentDir, args.path);
        if (!resolved) return pathError(token, name, siteSlug, args.path);
        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          logAudit(token.id, token.label, name, siteSlug, args.path, false, "File not found");
          return { content: [{ type: "text", text: "File not found" }], isError: true };
        }

        const buffer = readFileSync(resolved);
        logAudit(token.id, token.label, name, siteSlug, args.path, true, null);
        if (isTextFile(args.path, buffer)) {
          return { content: [{ type: "text", text: buffer.toString("utf-8") }] };
        } else {
          return { content: [{ type: "text", text: `[Binary file, ${buffer.length} bytes, base64]:\n${buffer.toString("base64")}` }] };
        }
      }

      case "write_file": {
        if (!siteSlug) return missingArg("site");

        // Read-only check
        const site = getSite(siteSlug);
        if (site?.mcp_read_only) {
          const err = `Site '${siteSlug}' is read-only`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        // Size limit
        if (args.content && args.content.length > MAX_WRITE_SIZE) {
          const err = `Content exceeds maximum write size of ${MAX_WRITE_SIZE / (1024 * 1024)} MB`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        autoCommitIfNeeded(siteSlug, token);

        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const resolved = safePath(contentDir, args.path);
        if (!resolved) return pathError(token, name, siteSlug, args.path);

        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, args.content, "utf-8");
        markCurrentModified(siteSlug);
        logAudit(token.id, token.label, name, siteSlug, args.path, true, null);
        return { content: [{ type: "text", text: `Written ${args.content.length} bytes to ${args.path}` }] };
      }

      case "write_media_file": {
        if (!siteSlug) return missingArg("site");

        const site = getSite(siteSlug);
        if (site?.mcp_read_only) {
          const err = `Site '${siteSlug}' is read-only`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        if (typeof args.path !== "string") return missingArg("path");
        const ext = mediaExt(args.path);
        if (!ext) {
          const err = `File extension not allowed. Supported media formats: ${MEDIA_EXTENSIONS}`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        if (typeof args.content !== "string") {
          const err = "`content` must be a base64-encoded string";
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }
        if (args.content.length > MAX_WRITE_SIZE) {
          const err = `Chunk exceeds per-call limit of ${MAX_WRITE_SIZE / (1024 * 1024)} MB of base64. Split into smaller chunks with append: true.`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        const bytes = Buffer.from(args.content, "base64");
        // Bun/Node's base64 decoder silently drops invalid chars, so a zero-length
        // decode from a non-empty input signals garbage content.
        if (bytes.length === 0 && args.content.length > 0) {
          const err = "Invalid base64 content: decoded to zero bytes";
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        const append = args.append === true;

        // Some formats (SVG) must be written in a single call so the full
        // document is in front of the validator — chunk 2 could otherwise
        // smuggle a <script> past a clean first chunk.
        if (append && !CHUNKABLE_MEDIA.has(ext)) {
          const err = `${ext} files must be uploaded in a single call (append:true is not supported for this format).`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        // Validate content on the first chunk. Appends can't be re-validated
        // (header is already on disk) but the extension allowlist above still
        // applies. Non-chunkable formats are always validated against the full
        // payload because of the guard above.
        if (!append) {
          const validate = MEDIA_FORMATS[ext];
          if (!validate(bytes)) {
            const err = `File content doesn't match ${ext} format. ${ext === ".svg" ? "Must contain a valid <svg> element and may not include <script>, <foreignObject>, javascript: URLs, or inline event handlers (on*=)." : `First chunk must contain a valid ${ext} header.`}`;
            logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
            return { content: [{ type: "text", text: err }], isError: true };
          }
        }

        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const resolved = safePath(contentDir, args.path);
        if (!resolved) return pathError(token, name, siteSlug, args.path);

        const existingSize = append && existsSync(resolved) ? statSync(resolved).size : 0;
        if (existingSize + bytes.length > MAX_BINARY_FILE_SIZE) {
          const err = `Total file size would exceed ${MAX_BINARY_FILE_SIZE / (1024 * 1024)} MB limit`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        // Only snapshot on the first chunk; appends are continuations of a single logical write.
        if (!append) autoCommitIfNeeded(siteSlug, token);

        mkdirSync(dirname(resolved), { recursive: true });
        if (append) {
          appendFileSync(resolved, bytes);
        } else {
          writeFileSync(resolved, bytes);
        }
        const totalSize = existingSize + bytes.length;
        markCurrentModified(siteSlug);
        logAudit(token.id, token.label, name, siteSlug, args.path, true, null);
        return { content: [{ type: "text", text: `${append ? "Appended" : "Wrote"} ${bytes.length} bytes to ${args.path} (file now ${totalSize} bytes)` }] };
      }

      case "delete_file": {
        if (!siteSlug) return missingArg("site");

        // Read-only check
        const delSite = getSite(siteSlug);
        if (delSite?.mcp_read_only) {
          const err = `Site '${siteSlug}' is read-only`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        autoCommitIfNeeded(siteSlug, token);

        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const resolved = safePath(contentDir, args.path);
        if (!resolved) return pathError(token, name, siteSlug, args.path);
        if (!existsSync(resolved)) {
          logAudit(token.id, token.label, name, siteSlug, args.path, false, "File not found");
          return { content: [{ type: "text", text: "File not found" }], isError: true };
        }
        if (statSync(resolved).isDirectory()) {
          logAudit(token.id, token.label, name, siteSlug, args.path, false, "Is a directory");
          return { content: [{ type: "text", text: "Cannot delete a directory, only files" }], isError: true };
        }

        unlinkSync(resolved);
        markCurrentModified(siteSlug);
        logAudit(token.id, token.label, name, siteSlug, args.path, true, null);
        return { content: [{ type: "text", text: `Deleted ${args.path}` }] };
      }

      case "rename_file": {
        if (!siteSlug) return missingArg("site");
        if (typeof args.from !== "string") return missingArg("from");
        if (typeof args.to !== "string") return missingArg("to");

        const rnSite = getSite(siteSlug);
        if (rnSite?.mcp_read_only) {
          const err = `Site '${siteSlug}' is read-only`;
          logAudit(token.id, token.label, name, siteSlug, args.from, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const fromResolved = safePath(contentDir, args.from);
        if (!fromResolved) return pathError(token, name, siteSlug, args.from);
        const toResolved = safePath(contentDir, args.to);
        if (!toResolved) return pathError(token, name, siteSlug, args.to);

        if (!existsSync(fromResolved)) {
          logAudit(token.id, token.label, name, siteSlug, args.from, false, "Source not found");
          return { content: [{ type: "text", text: `Source file '${args.from}' not found` }], isError: true };
        }
        if (statSync(fromResolved).isDirectory()) {
          logAudit(token.id, token.label, name, siteSlug, args.from, false, "Is a directory");
          return { content: [{ type: "text", text: "Cannot rename a directory, only files" }], isError: true };
        }
        if (fromResolved === toResolved) {
          logAudit(token.id, token.label, name, siteSlug, args.to, false, "Same path");
          return { content: [{ type: "text", text: "Source and destination are the same path" }], isError: true };
        }
        if (existsSync(toResolved)) {
          if (statSync(toResolved).isDirectory()) {
            logAudit(token.id, token.label, name, siteSlug, args.to, false, "Destination is a directory");
            return { content: [{ type: "text", text: `Destination '${args.to}' is a directory` }], isError: true };
          }
          if (args.replace !== true) {
            const err = `Destination '${args.to}' already exists. Set replace: true to overwrite.`;
            logAudit(token.id, token.label, name, siteSlug, args.to, false, err);
            return { content: [{ type: "text", text: err }], isError: true };
          }
        }

        autoCommitIfNeeded(siteSlug, token);
        mkdirSync(dirname(toResolved), { recursive: true });
        renameSync(fromResolved, toResolved);
        markCurrentModified(siteSlug);
        logAudit(token.id, token.label, name, siteSlug, `${args.from} -> ${args.to}`, true, null);
        return { content: [{ type: "text", text: `Renamed ${args.from} -> ${args.to}` }] };
      }

      case "resize_image": {
        if (!siteSlug) return missingArg("site");
        if (typeof args.path !== "string") return missingArg("path");

        const rsSite = getSite(siteSlug);
        if (rsSite?.mcp_read_only) {
          const err = `Site '${siteSlug}' is read-only`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        if (!rasterExt(args.path)) {
          const err = "Source must be a .png, .jpg, or .jpeg file";
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        const outPath = typeof args.output === "string" && args.output ? args.output : args.path;
        const outExt = rasterExt(outPath);
        if (!outExt) {
          const err = "Output must be a .png, .jpg, or .jpeg file";
          logAudit(token.id, token.label, name, siteSlug, outPath, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const srcResolved = safePath(contentDir, args.path);
        if (!srcResolved) return pathError(token, name, siteSlug, args.path);
        const dstResolved = safePath(contentDir, outPath);
        if (!dstResolved) return pathError(token, name, siteSlug, outPath);

        if (!existsSync(srcResolved) || statSync(srcResolved).isDirectory()) {
          logAudit(token.id, token.label, name, siteSlug, args.path, false, "Source not found");
          return { content: [{ type: "text", text: `Source image '${args.path}' not found` }], isError: true };
        }

        // Validate numeric inputs before handing them to jimp.
        const toDim = (v: any, label: string): number | null | string => {
          if (v === undefined || v === null) return null;
          if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) return `\`${label}\` must be a positive integer`;
          return v;
        };
        const width = toDim(args.width, "width");
        if (typeof width === "string") { logAudit(token.id, token.label, name, siteSlug, args.path, false, width); return { content: [{ type: "text", text: width }], isError: true }; }
        const height = toDim(args.height, "height");
        if (typeof height === "string") { logAudit(token.id, token.label, name, siteSlug, args.path, false, height); return { content: [{ type: "text", text: height }], isError: true }; }
        if (args.scale !== undefined && args.scale !== null && (typeof args.scale !== "number" || !(args.scale > 0 && args.scale <= 1))) {
          const err = "`scale` must be a number greater than 0 and at most 1";
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }
        let quality = 80;
        if (args.quality !== undefined && args.quality !== null) {
          if (typeof args.quality !== "number" || !Number.isInteger(args.quality) || args.quality < 1 || args.quality > 100) {
            const err = "`quality` must be an integer between 1 and 100";
            logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
            return { content: [{ type: "text", text: err }], isError: true };
          }
          quality = args.quality;
        }
        const bgInt = parseHexColor(typeof args.background === "string" && args.background ? args.background : "#ffffff");
        if (bgInt === null) {
          const err = "`background` must be a hex color like '#ffffff'";
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        const inputBytes = readFileSync(srcResolved);
        const originalSize = inputBytes.length;
        const isJpegOut = outExt === ".jpg" || outExt === ".jpeg";

        let outBuf: Buffer;
        let outMeta: { width?: number; height?: number } = {};
        try {
          const img = await Jimp.read(inputBytes);
          const ow = img.width, oh = img.height;

          // Resize, preserving aspect ratio and never enlarging the source.
          if (width !== null || height !== null) {
            const tw = width !== null ? Math.min(width, ow) : null;
            const th = height !== null ? Math.min(height, oh) : null;
            if (tw !== null && th !== null) {
              img.scaleToFit({ w: tw, h: th });
            } else if (tw !== null && tw < ow) {
              img.resize({ w: tw });
            } else if (th !== null && th < oh) {
              img.resize({ h: th });
            }
          } else if (typeof args.scale === "number" && args.scale < 1) {
            img.scale(args.scale);
          }

          if (isJpegOut) {
            // JPEG has no alpha; composite over a solid background to flatten
            // any transparency, then encode at the requested quality.
            const bg = new Jimp({ width: img.width, height: img.height, color: bgInt });
            bg.composite(img, 0, 0);
            outBuf = await bg.getBuffer(JimpMime.jpeg, { quality });
          } else {
            // PNG keeps its alpha channel. jimp has no lossy PNG knob, so size
            // reduction here comes from scaling; output is lossless deflate.
            outBuf = await img.getBuffer(JimpMime.png);
          }
          outMeta = { width: img.width, height: img.height };
        } catch (e: any) {
          const err = `Image processing failed: ${e?.message || "unknown error"}`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        if (outBuf!.length > MAX_BINARY_FILE_SIZE) {
          const err = `Output (${outBuf!.length} bytes) exceeds ${MAX_BINARY_FILE_SIZE / (1024 * 1024)} MB limit`;
          logAudit(token.id, token.label, name, siteSlug, outPath, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        autoCommitIfNeeded(siteSlug, token);
        mkdirSync(dirname(dstResolved), { recursive: true });
        writeFileSync(dstResolved, outBuf!);
        markCurrentModified(siteSlug);
        logAudit(token.id, token.label, name, siteSlug, outPath, true, null);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              source: args.path,
              output: outPath,
              original_bytes: originalSize,
              output_bytes: outBuf!.length,
              dimensions: outMeta.width ? `${outMeta.width}x${outMeta.height}` : undefined,
            }, null, 2),
          }],
        };
      }

      case "list_versions": {
        if (!siteSlug) return missingArg("site");
        const site = getSite(siteSlug);
        if (!site || !site.mcp_enabled) return siteError(siteSlug, token, name);
        const versions = listVersions(siteSlug).map(v => ({
          version: v.version,
          label: v.label,
          size_bytes: v.size_bytes,
          file_count: v.file_count,
          created_at: v.created_at,
          mcp_modified: !!v.mcp_modified,
          current: v.version === site.current_version,
        }));
        logAudit(token.id, token.label, name, siteSlug, null, true, null);
        return { content: [{ type: "text", text: JSON.stringify(versions, null, 2) }] };
      }

      case "commit_version": {
        if (!siteSlug) return missingArg("site");
        const site = getSite(siteSlug);
        if (!site || !site.mcp_enabled) return siteError(siteSlug, token, name);
        if (site.mcp_read_only) {
          const err = `Site '${siteSlug}' is read-only`;
          logAudit(token.id, token.label, name, siteSlug, null, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }
        const label = typeof args.label === "string" ? args.label : null;
        const newVer = commitVersion(siteSlug, label);
        if (!newVer) {
          const err = `Site '${siteSlug}' has no current version to commit`;
          logAudit(token.id, token.label, name, siteSlug, null, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }
        logAudit(token.id, token.label, name, siteSlug, label, true, null);
        return { content: [{ type: "text", text: `Committed snapshot${label ? ` '${label}'` : ""}; new working version is ${newVer.version}` }] };
      }

      case "fetch_remote_media": {
        if (!siteSlug) return missingArg("site");
        if (typeof args.url !== "string") return missingArg("url");
        if (typeof args.path !== "string") return missingArg("path");

        const site = getSite(siteSlug);
        if (!site || !site.mcp_enabled) return siteError(siteSlug, token, name);
        if (site.mcp_read_only) {
          const err = `Site '${siteSlug}' is read-only`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        // Destination extension must be on the media allowlist — this also
        // determines which magic-byte signature we'll require below.
        const ext = mediaExt(args.path);
        if (!ext) {
          const err = `Destination extension not allowed. Supported: ${MEDIA_EXTENSIONS}`;
          logAudit(token.id, token.label, name, siteSlug, args.path, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        // Fetch with all the SSRF/size/time defenses in remote-fetch.ts.
        let fetched;
        try {
          fetched = await fetchRemoteMedia(args.url);
        } catch (e: any) {
          logAudit(token.id, token.label, name, siteSlug, args.url, false, e.message);
          return { content: [{ type: "text", text: `Fetch failed: ${e.message}` }], isError: true };
        }

        // Magic-byte check: the downloaded bytes must match the destination
        // extension. A mismatch most commonly means the server returned an
        // HTML error page instead of an image — without this check we'd write
        // the HTML out as foo.jpg and the agent wouldn't notice.
        const validate = MEDIA_FORMATS[ext];
        if (!validate(fetched.bytes)) {
          const err = `Downloaded content doesn't match ${ext} signature (Content-Type: ${fetched.contentType || "unknown"}, ${fetched.bytes.length} bytes). The URL may serve an error page or a different format than the destination extension suggests.`;
          logAudit(token.id, token.label, name, siteSlug, args.url, false, err);
          return { content: [{ type: "text", text: err }], isError: true };
        }

        // Use the shared upload helper so version stats, mcp_modified, and
        // auto-commit are handled identically to other write paths.
        try {
          const upload = uploadFileToSite(siteSlug, args.path, fetched.bytes, { replace: args.replace === true });
          touched.add(siteSlug);
          logAudit(token.id, token.label, name, siteSlug, args.path, true, null);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                path: upload.path,
                bytes_written: upload.size,
                source_url: fetched.finalUrl,
                redirects: fetched.redirects,
                content_type: fetched.contentType,
                replaced: upload.replaced,
                snapshot_version: upload.snapshot_version,
              }, null, 2),
            }],
          };
        } catch (e: any) {
          logAudit(token.id, token.label, name, siteSlug, args.path, false, e.message);
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e: any) {
    logAudit(token.id, token.label, name, args.site || null, args.path || null, false, e.message);
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
}

function missingArg(arg: string): ToolResult {
  return { content: [{ type: "text", text: `Missing required argument: ${arg}` }], isError: true };
}

function siteError(slug: string, token: ValidatedToken, tool: string): ToolResult {
  const err = `Site '${slug}' not found or MCP not enabled`;
  logAudit(token.id, token.label, tool, slug, null, false, err);
  return { content: [{ type: "text", text: err }], isError: true };
}

function pathError(token: ValidatedToken, tool: string, slug: string, path: string): ToolResult {
  logAudit(token.id, token.label, tool, slug, path, false, "Invalid path");
  return { content: [{ type: "text", text: "Invalid path" }], isError: true };
}

// Build the MCP `instructions` string returned in the initialize response.
// MCP clients (Claude.ai, Claude Code, Cursor, etc.) surface this as a soft
// system prompt, so the agent gets the relevant context for the connected
// site without the user having to brief it manually.
//
// Always covers the basic Hoster file-tool conventions. When the connection
// is bound to a site that has CMS enabled (or when an unscoped token sees
// any CMS-enabled sites), also includes the CMS schema + the read-mutate-
// write index pattern that's easy to get wrong.
function buildMcpInstructions(token: ValidatedToken): string {
  const lines: string[] = [];

  if (token.site_slug) {
    lines.push(`You're connected to Hoster site '${token.site_slug}'. All file tools (read_file, write_file, delete_file, rename_file, write_media_file, fetch_remote_media, resize_image, list_files) operate on that site; you don't need to specify it elsewhere unless a tool's schema asks for it.`);
  } else {
    lines.push(`You're connected to Hoster with cross-site access. Call list_sites first to see which sites you can manage; each tool takes a 'site' argument.`);
  }
  lines.push(`To bring in images, audio, or video from public URLs, use fetch_remote_media — Hoster downloads server-side and writes the file directly. Avoid base64-streaming via write_media_file when you can just pass a URL.`);
  lines.push(`To shrink large images use resize_image (scale down, convert PNG↔JPEG, or recompress JPEG/PNG). Use rename_file to rename or move a file in place rather than read+write+delete.`);
  lines.push(`Use commit_version to checkpoint a snapshot before non-trivial edits — that gives the human admin a clean rollback point.`);

  // Determine CMS-enabled sites visible to this token.
  const allSites = listSites().filter(s => s.mcp_enabled);
  const visible = token.site_slug ? allSites.filter(s => s.slug === token.site_slug) : allSites;
  const cmsSites = visible.filter(s => s.cms_enabled);

  if (cmsSites.length) {
    lines.push("");
    if (token.site_slug && cmsSites.length === 1) {
      lines.push(`## CMS is enabled on '${token.site_slug}'`);
    } else {
      lines.push("## Sites with the CMS enabled");
      lines.push(cmsSites.map(s => `- ${s.slug}`).join("\n"));
    }
    lines.push(`
Content lives as JSON files under \`.cms/content/\` in each CMS-enabled site:

- \`.cms/content/index.json\` — master post list, METADATA ONLY (no bodies)
- \`.cms/content/posts/<slug>.json\` — one file per post (metadata + body)
- \`.cms/content/categories.json\` — category definitions
- \`.cms/templates/\` — page templates; don't touch unless asked

### Post file schema (\`.cms/content/posts/<slug>.json\`)

\`\`\`json
{
  "slug": "my-post",
  "title": "My Post",
  "excerpt": "Short summary shown in listings.",
  "publishedAt": "2026-05-12T09:00:00Z",
  "updatedAt": "2026-05-12T09:00:00Z",
  "categories": ["announcements"],
  "tags": ["intro"],
  "author": "Name",
  "coverImage": null,
  "draft": false,
  "body": { "format": "markdown", "content": "# Heading\\n\\nBody…" },
  "seo": { "metaDescription": null, "ogImage": null }
}
\`\`\`

\`body.format\` is \`"markdown"\` (preferred) or \`"html"\`.

### Index entry schema (one per post inside \`index.json.posts\`)

Same fields as the post file MINUS \`body\` and \`seo\`. The index never contains body content.

### Rules — easy to forget, please don't:

1. **Adding a post**: write the new \`posts/<slug>.json\`, then read \`index.json\`, splice in a matching metadata entry, write \`index.json\` back. A post file without an index entry is invisible to the blog.
2. **Editing**: rewrite \`posts/<slug>.json\`. If \`title\`, \`excerpt\`, \`categories\`, \`tags\`, \`author\`, \`coverImage\`, \`publishedAt\`, or \`draft\` changed, also update the matching entry in \`index.json\`. Bump \`updatedAt\` to the current ISO 8601 UTC timestamp in BOTH places.
3. **Deleting**: \`delete_file\` the post JSON, then remove the index entry.
4. **Drafts**: set \`"draft": true\` in both files. Drafts are hidden from listings by default; appending \`?preview=1\` to any CMS URL reveals them.
5. **Slugs**: lowercase, hyphenated, alphanumeric. Must match the filename and the \`slug\` field.
6. **Categories**: if you reference a category that isn't in \`categories.json\`, add it there too (\`{ slug, name, description }\`).

When starting a CMS task, read \`index.json\` first to see what exists.`);
  }

  return lines.join("\n");
}

async function handleRpc(request: JsonRpcRequest, token: ValidatedToken, touched: Set<string>): Promise<JsonRpcResponse | null> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      return rpcResult(id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hoster", version: "1.0.0" },
        instructions: buildMcpInstructions(token),
      });

    case "notifications/initialized":
      return null;

    case "ping":
      return rpcResult(id ?? null, {});

    case "tools/list":
      return rpcResult(id ?? null, { tools: TOOLS });

    case "tools/call": {
      const { name, arguments: args } = params || {};
      if (!name) return rpcError(id ?? null, -32602, "Missing tool name");
      const result = await handleToolCall(name, args || {}, token, touched);
      return rpcResult(id ?? null, result);
    }

    default:
      return rpcError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

export interface McpResult {
  response: Response;
  siteSlug: string | null;  // For request-log annotation. Joined comma-list if a batch touched several sites.
}

function bare(response: Response): McpResult {
  return { response, siteSlug: null };
}

// Build a WWW-Authenticate Bearer challenge that points clients at the
// resource metadata endpoint, per the MCP authorization profile.
function unauthorizedHeaders(req: Request, urlSlug: string | null, error: string, description: string): Record<string, string> {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  const origin = `${proto}://${host}`;
  const resourceMeta = urlSlug
    ? `${origin}/.well-known/oauth-protected-resource/_mcp/${urlSlug}`
    : `${origin}/.well-known/oauth-protected-resource`;
  return {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer error="${error}", error_description="${description}", resource_metadata="${resourceMeta}"`,
  };
}

export async function handleMcp(req: Request, urlSlug: string | null = null): Promise<McpResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return bare(new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers }));
  }

  // Authenticate via Bearer token
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return bare(new Response(
      JSON.stringify(rpcError(null, -32000, "Unauthorized — Bearer token required")),
      { status: 401, headers: unauthorizedHeaders(req, urlSlug, "invalid_token", "Bearer token required") }
    ));
  }

  const rawToken = authHeader.substring(7);
  const token = validateMcpToken(rawToken);
  if (!token) {
    return bare(new Response(
      JSON.stringify(rpcError(null, -32000, "Invalid or expired token")),
      { status: 401, headers: unauthorizedHeaders(req, urlSlug, "invalid_token", "Invalid or expired token") }
    ));
  }

  // Audience binding: when the request hit /_mcp/<slug>, the token must be
  // scoped to that site. OAuth tokens are always single-site; static tokens
  // may be scoped or unscoped, but if scoped must match the URL.
  if (urlSlug !== null) {
    if (token.site_slug && token.site_slug !== urlSlug) {
      return bare(new Response(
        JSON.stringify(rpcError(null, -32000, `Token not valid for site '${urlSlug}'`)),
        { status: 401, headers: unauthorizedHeaders(req, urlSlug, "invalid_token", "Token audience does not match resource URL") }
      ));
    }
    if (token.issued_via === "oauth" && token.site_slug !== urlSlug) {
      return bare(new Response(
        JSON.stringify(rpcError(null, -32000, `OAuth token audience mismatch`)),
        { status: 401, headers: unauthorizedHeaders(req, urlSlug, "invalid_token", "OAuth tokens are bound to a single site") }
      ));
    }
  }

  // Parse request body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return bare(new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers }));
  }

  // A scoped token always implicates its site, even on tools that don't take a site arg
  // (e.g. tools/list, ping). Pre-seeding `touched` keeps log annotations accurate.
  const touched = new Set<string>();
  if (token.site_slug) touched.add(token.site_slug);

  let response: Response;

  // Batch requests
  if (Array.isArray(body)) {
    // Process each in order so audit-log and side-effect ordering matches the
    // request order. Tools rarely overlap, so the parallelism savings would
    // be marginal and the predictability is worth more.
    const responses: JsonRpcResponse[] = [];
    for (const r of body as JsonRpcRequest[]) {
      const out = await handleRpc(r, token, touched);
      if (out) responses.push(out);
    }
    response = responses.length === 0
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(responses), { headers });
  } else {
    // Single request
    const single = await handleRpc(body, token, touched);
    response = single === null
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(single), { headers });
  }

  const siteSlug = touched.size === 0 ? null : [...touched].sort().join(",");
  return { response, siteSlug };
}
