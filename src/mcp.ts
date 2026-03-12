import {
  existsSync, readdirSync, statSync, mkdirSync, unlinkSync,
  realpathSync, readFileSync, writeFileSync
} from "fs";
import { join, resolve, dirname } from "path";
import { getSite, listSites, SITES_DIR, type Site } from "./sites";
import db from "./db";

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

const MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_AUDIT_ROWS = 10_000;

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
    const d = new Date();
    d.setDate(d.getDate() + expiresInDays);
    expiresAt = d.toISOString().replace("T", " ").substring(0, 19);
  }

  db.run(
    "INSERT INTO mcp_tokens (token_hash, label, site_slug, expires_at) VALUES (?, ?, ?, ?)",
    hash, label, siteSlug || null, expiresAt
  );
  return token;
}

export function listMcpTokens(): McpTokenInfo[] {
  const rows = db.query("SELECT id, label, site_slug, expires_at, created_at FROM mcp_tokens ORDER BY created_at DESC").all() as McpTokenInfo[];
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
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
}

function validateMcpToken(token: string): ValidatedToken | null {
  const incoming = hashToken(token);
  const rows = db.query("SELECT id, token_hash, label, site_slug, expires_at FROM mcp_tokens").all() as McpTokenRecord[];

  for (const row of rows) {
    if (constantTimeEqual(incoming, row.token_hash)) {
      // Check expiration
      if (row.expires_at) {
        const now = new Date().toISOString().replace("T", " ").substring(0, 19);
        if (row.expires_at < now) return null; // expired
      }
      return { id: row.id, label: row.label, site_slug: row.site_slug };
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
];

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function handleToolCall(name: string, args: any, token: ValidatedToken): ToolResult {
  try {
    // For site-specific tools, check token scope
    const siteSlug = args.site as string | undefined;

    if (siteSlug && token.site_slug && token.site_slug !== siteSlug) {
      const err = `Token is scoped to site '${token.site_slug}', cannot access '${siteSlug}'`;
      logAudit(token.id, token.label, name, siteSlug, args.path || null, false, err);
      return { content: [{ type: "text", text: err }], isError: true };
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

        const contentDir = getContentDir(siteSlug);
        if (!contentDir) return siteError(siteSlug, token, name);
        const resolved = safePath(contentDir, args.path);
        if (!resolved) return pathError(token, name, siteSlug, args.path);

        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, args.content, "utf-8");
        logAudit(token.id, token.label, name, siteSlug, args.path, true, null);
        return { content: [{ type: "text", text: `Written ${args.content.length} bytes to ${args.path}` }] };
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
        logAudit(token.id, token.label, name, siteSlug, args.path, true, null);
        return { content: [{ type: "text", text: `Deleted ${args.path}` }] };
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

function handleRpc(request: JsonRpcRequest, token: ValidatedToken): JsonRpcResponse | null {
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
      const result = handleToolCall(name, args || {}, token);
      return rpcResult(id ?? null, result);
    }

    default:
      return rpcError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(req: Request): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  // Authenticate via Bearer token
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify(rpcError(null, -32000, "Unauthorized — Bearer token required")),
      { status: 401, headers }
    );
  }

  const rawToken = authHeader.substring(7);
  const token = validateMcpToken(rawToken);
  if (!token) {
    return new Response(
      JSON.stringify(rpcError(null, -32000, "Invalid or expired token")),
      { status: 401, headers }
    );
  }

  // Parse request body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers });
  }

  // Batch requests
  if (Array.isArray(body)) {
    const responses = body
      .map((r: JsonRpcRequest) => handleRpc(r, token))
      .filter((r): r is JsonRpcResponse => r !== null);
    if (responses.length === 0) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(responses), { headers });
  }

  // Single request
  const response = handleRpc(body, token);
  if (response === null) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(response), { headers });
}
