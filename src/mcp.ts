import {
  existsSync, readdirSync, statSync, mkdirSync, unlinkSync,
  realpathSync, readFileSync, writeFileSync, appendFileSync
} from "fs";
import { join, resolve, dirname } from "path";
import { getSite, listSites, listVersions, getVersion, commitVersion, markVersionModified, SITES_DIR, type Site } from "./sites";
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

// Allowed media formats for write_media_file, mapped to magic-byte validators.
// Validator returns true if `bytes` starts with a valid signature for the format.
// For chunked uploads we only validate on the first chunk (append:false); subsequent
// appends are gated only by the extension allowlist since the header is already on disk.
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
};
const MEDIA_EXTENSIONS = Object.keys(MEDIA_FORMATS).join(", ");

function mediaExt(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.substring(dot).toLowerCase();
  return MEDIA_FORMATS[ext] ? ext : null;
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
    description: "Write a media file (image or audio/video) to a site. Allowed formats: JPEG, PNG, GIF, MP3, MP4 — identified by both file extension and magic-byte signature. Content must be base64-encoded. Supports chunked uploads: set `append: false` (or omit) on the first call to create/truncate, then call again with `append: true` for additional chunks. Per-call payload limit is 10 MB of base64 (~7.5 MB raw); total file size limit is 100 MB. For files larger than ~7 MB raw, split into multiple calls. Blocked if site is read-only.",
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
  delete_file: "write",
  commit_version: "commit",
};

function handleToolCall(name: string, args: any, token: ValidatedToken, touched: Set<string>): ToolResult {
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

        // Verify magic bytes on the first chunk only. Appends can't be re-validated
        // (header is already on disk) but the extension allowlist above still applies.
        if (!append) {
          const validate = MEDIA_FORMATS[ext];
          if (!validate(bytes)) {
            const err = `File content doesn't match ${ext} format (magic-byte signature mismatch). First chunk must contain a valid ${ext} header.`;
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

function handleRpc(request: JsonRpcRequest, token: ValidatedToken, touched: Set<string>): JsonRpcResponse | null {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      return rpcResult(id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hoster", version: "1.0.0" },
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
      const result = handleToolCall(name, args || {}, token, touched);
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
    const responses = body
      .map((r: JsonRpcRequest) => handleRpc(r, token, touched))
      .filter((r): r is JsonRpcResponse => r !== null);
    response = responses.length === 0
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(responses), { headers });
  } else {
    // Single request
    const single = handleRpc(body, token, touched);
    response = single === null
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(single), { headers });
  }

  const siteSlug = touched.size === 0 ? null : [...touched].sort().join(",");
  return { response, siteSlug };
}
