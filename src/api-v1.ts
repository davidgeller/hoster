// External REST API for document repositories — /api/v1/*.
//
// Built for server-to-server clients (a CRM, an integration) that hold an API
// key and want to browse repositories, search them, and mint anonymous share
// links. Contract highlights the client depends on:
//
//   * Never redirects. Every path answers in place, with or without a trailing
//     slash; the client refuses redirects.
//   * Bearer keys (`Authorization: Bearer hk_...`). Every key belongs to
//     exactly one repository and can never see anything outside it: no other
//     repository, no account data. Keys are managed in that repository's own
//     settings. Expired and revoked keys are told apart.
//   * Errors are always { error: { code, message } } with a stable code:
//     unauthorized, key_expired, key_revoked, forbidden, not_found,
//     rate_limited, invalid_request (plus internal_error for bugs).
//   * Lists are bare JSON arrays.
//   * Ids are strings: repositories are sites.id, items are repo_files.id —
//     both survive renames, moves, and slug changes.
//   * Share and repository links are root-relative ("/<slug>/_repo/s/<token>");
//     the client prepends the Hoster base URL from its own configuration.
//   * POST .../shares honours Idempotency-Key: the same key returns the same
//     share and the same URL. The URL's token is HMAC(server secret, random
//     per-share nonce); only the nonce is stored with the idempotency record,
//     so a replay can rebuild the URL without the token being stored in
//     plaintext. Once a share is purged its record goes with it, and the same
//     Idempotency-Key mints a new share under a new nonce — a revoked link can
//     never come back.
//
// Keys carry no cookies, so this surface is safe to serve on the sites
// hostname (and the admin hostname) alongside hosted content.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import db from "./db";
import { auditLog, getClientIp } from "./auth";
import { getSite, type Site } from "./sites";
import {
  createRepoShare, revokeRepoShare, getRepoShareById, readRepoContent, MAX_SHARE_DURATION_HOURS, type RepoShare,
} from "./repo";

// --- Schema ---

// An earlier, never-released draft keyed API keys to accounts. Drop its
// tables if a development database still has them.
db.exec(`
  DROP TABLE IF EXISTS api_idempotency;
  DROP TABLE IF EXISTS api_key_repos;
  DROP TABLE IF EXISTS api_keys;
`);

db.exec(`
  -- One row per key. A key belongs to exactly one repository (site_id) and
  -- dies with it. Only the key's SHA-256 is stored.
  CREATE TABLE IF NOT EXISTS repo_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT UNIQUE NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    site_id INTEGER NOT NULL,
    can_share INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    created_by TEXT,
    last_used_at TEXT,
    last_used_ip TEXT,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_repo_api_keys_site ON repo_api_keys(site_id);

  -- Idempotency-Key -> share. The key itself is stored only as an HMAC.
  CREATE TABLE IF NOT EXISTS repo_api_idempotency (
    key_id INTEGER NOT NULL,
    idem_hash TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    share_id INTEGER NOT NULL,
    nonce TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (key_id, idem_hash),
    FOREIGN KEY (key_id) REFERENCES repo_api_keys(id) ON DELETE CASCADE,
    FOREIGN KEY (share_id) REFERENCES repo_shares(id) ON DELETE CASCADE
  );
`);
// Each idempotent share's token is derived from a random per-share nonce (see
// createShare). Rows from before that change can't be replayed; drop them so
// a retry mints a fresh share rather than returning a wrong URL.
try { db.exec("ALTER TABLE repo_api_idempotency ADD COLUMN nonce TEXT"); } catch (_) {}
db.exec("DELETE FROM repo_api_idempotency WHERE nonce IS NULL");

// --- Constants ---

const KEY_PREFIX = "hk_";
const RATE_LIMIT_PER_MIN = 240;          // per key
const BAD_KEY_LIMIT_PER_MIN = 30;        // failed authentications per IP
const MAX_BODY_BYTES = 16 * 1024;
const MAX_LABEL = 200;
const MAX_IDEMPOTENCY_KEY = 255;
const SEARCH_DEFAULT = 50;
const SEARCH_MAX = 200;
const SEARCH_SCAN_CAP = 5000;            // rows examined per repository, keeps search well under a second

// --- Small helpers ---

export type ApiErrorCode =
  | "unauthorized" | "key_expired" | "key_revoked" | "forbidden" | "not_found"
  | "rate_limited" | "invalid_request" | "internal_error";

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Retry-After, Idempotent-Replayed",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...extra },
  });
}

function apiError(status: number, code: ApiErrorCode, message: string, extra: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, extra);
}

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> ISO 8601 "YYYY-MM-DDTHH:MM:SSZ".
export function isoFromSqlite(v: string | null | undefined): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(" ", "T") + "Z" : v;
}

function sqliteFromDate(d: Date): string {
  return d.toISOString().replace("T", " ").substring(0, 19);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, ch => "\\" + ch);
}

function getSecret(): Buffer {
  const row = db.query("SELECT value FROM config WHERE key = 'api_share_secret'").get() as { value: string } | null;
  if (row?.value) return Buffer.from(row.value, "hex");
  const fresh = randomBytes(32).toString("hex");
  db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('api_share_secret', ?)", fresh);
  const again = db.query("SELECT value FROM config WHERE key = 'api_share_secret'").get() as { value: string };
  return Buffer.from(again.value, "hex");
}

function hmac(purpose: string, data: string): Buffer {
  return createHmac("sha256", getSecret()).update(purpose + "\0" + data).digest();
}

// --- Key management (used by the admin API, per repository) ---

interface KeyRow {
  id: number; public_id: string; key_hash: string; label: string; site_id: number;
  can_share: number; expires_at: string | null; revoked_at: string | null;
  created_at: string; created_by: string | null; last_used_at: string | null; last_used_ip: string | null;
}

export interface ApiKeyInfo {
  id: number;
  key_id: string;
  label: string;
  repository_id: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
  created_by: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  status: "active" | "expired" | "revoked";
}

function keyStatus(r: KeyRow): ApiKeyInfo["status"] {
  if (r.revoked_at) return "revoked";
  if (r.expires_at && r.expires_at <= sqliteFromDate(new Date())) return "expired";
  return "active";
}

function toKeyInfo(r: KeyRow): ApiKeyInfo {
  return {
    id: r.id, key_id: r.public_id, label: r.label, repository_id: String(r.site_id),
    scopes: r.can_share ? ["read", "share"] : ["read"],
    expires_at: isoFromSqlite(r.expires_at), revoked_at: isoFromSqlite(r.revoked_at),
    created_at: isoFromSqlite(r.created_at), created_by: r.created_by,
    last_used_at: isoFromSqlite(r.last_used_at), last_used_ip: r.last_used_ip,
    status: keyStatus(r),
  };
}

function requireRepository(slug: string): Site {
  const site = getSite(slug);
  if (!site) throw new Error(`Site '${slug}' not found`);
  if (site.site_type !== "repository") throw new Error("API keys are only available for repositories");
  return site;
}

export function listApiKeys(slug: string): ApiKeyInfo[] {
  const site = requireRepository(slug);
  return (db.query("SELECT * FROM repo_api_keys WHERE site_id = ? ORDER BY revoked_at IS NOT NULL, id DESC").all(site.id) as KeyRow[]).map(toKeyInfo);
}

export interface CreateApiKeyInput {
  label: unknown;
  can_share?: unknown;          // default true
  expires_at?: unknown;         // ISO timestamp, or null for no expiry
  expires_in_days?: unknown;    // alternative to expires_at
}

export function createApiKey(slug: string, input: CreateApiKeyInput, actor: string | null): { key: string; info: ApiKeyInfo } {
  const site = requireRepository(slug);
  const label = typeof input.label === "string" ? input.label.replace(/[\x00-\x1f\x7f]/g, "").trim() : "";
  if (!label) throw new Error("Label is required");
  if (label.length > 100) throw new Error("Label is too long (max 100 characters)");

  let expires: string | null = null;
  if (input.expires_at != null && input.expires_at !== "") {
    const d = new Date(String(input.expires_at));
    if (Number.isNaN(d.getTime())) throw new Error("Expiry must be an ISO timestamp");
    if (d.getTime() <= Date.now()) throw new Error("Expiry must be in the future");
    expires = sqliteFromDate(d);
  } else if (input.expires_in_days != null && input.expires_in_days !== "") {
    const days = Number(input.expires_in_days);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error("Expiry must be between 1 day and 10 years");
    expires = sqliteFromDate(new Date(Date.now() + days * 86400_000));
  }

  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const publicId = "key_" + randomBytes(8).toString("hex");
  const canShare = input.can_share === undefined ? true : input.can_share === true || input.can_share === 1 || input.can_share === "1";
  const ins = db.run(
    "INSERT INTO repo_api_keys (public_id, key_hash, label, site_id, can_share, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    publicId, sha256(key), label, site.id, canShare ? 1 : 0, expires, actor
  );
  return { key, info: toKeyInfo(db.query("SELECT * FROM repo_api_keys WHERE id = ?").get(Number(ins.lastInsertRowid)) as KeyRow) };
}

// Both take the repository's slug so a caller allowed to manage one
// repository can never touch another repository's keys by id.
export function revokeApiKey(slug: string, id: number): ApiKeyInfo | null {
  const site = requireRepository(slug);
  db.run("UPDATE repo_api_keys SET revoked_at = datetime('now') WHERE id = ? AND site_id = ? AND revoked_at IS NULL", id, site.id);
  const r = db.query("SELECT * FROM repo_api_keys WHERE id = ? AND site_id = ?").get(id, site.id) as KeyRow | null;
  return r ? toKeyInfo(r) : null;
}

export function deleteApiKey(slug: string, id: number): boolean {
  const site = requireRepository(slug);
  return db.run("DELETE FROM repo_api_keys WHERE id = ? AND site_id = ?", id, site.id).changes > 0;
}

// --- Authentication ---

interface ApiAuth {
  key: KeyRow;
  site: Site;        // the one repository this key can reach
  actor: string;     // audit-log actor
}

type AuthResult = { ok: true; auth: ApiAuth } | { ok: false; res: Response };

const keyWindows = new Map<number, { start: number; count: number }>();
const badKeyWindows = new Map<string, { start: number; count: number }>();
let lastSweep = 0;

function hit(map: Map<any, { start: number; count: number }>, id: any, limit: number): number | null {
  const now = Date.now();
  let w = map.get(id);
  if (!w || now - w.start >= 60_000) { w = { start: now, count: 0 }; map.set(id, w); }
  w.count++;
  if (map.size > 10_000) { // keep memory bounded under a key-guessing flood
    // Full sweep at most once a second, so a flood can't make every request
    // walk the whole map.
    if (now - lastSweep > 1000) {
      lastSweep = now;
      for (const [k, v] of map) if (now - v.start >= 60_000) map.delete(k);
    }
    // Still full of live windows (e.g. a flood from spoofed addresses): drop
    // the oldest. Map iteration order is insertion order.
    for (const k of map.keys()) { if (map.size <= 10_000) break; map.delete(k); }
  }
  return w.count > limit ? Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000)) : null;
}

function badKeyLimited(ip: string): number | null {
  const w = badKeyWindows.get(ip);
  if (!w || Date.now() - w.start >= 60_000) return null;
  return w.count >= BAD_KEY_LIMIT_PER_MIN ? Math.max(1, Math.ceil((w.start + 60_000 - Date.now()) / 1000)) : null;
}

function presentedKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
    return m ? m[1] : null;
  }
  return req.headers.get("x-api-key")?.trim() || null;
}

function authenticate(req: Request, ip: string): AuthResult {
  const wwwAuth = { "WWW-Authenticate": 'Bearer realm="hoster"' };

  const fail = (code: ApiErrorCode, message: string): AuthResult => {
    // The per-IP lockout applies to unknown keys only, and only after the key
    // has been looked up: a valid key is never locked out because someone
    // else on the same address (NAT, a shared integration platform) guessed
    // badly. A real but expired/revoked key keeps hearing exactly that.
    if (code === "unauthorized") {
      const limited = badKeyLimited(ip);
      if (limited) return { ok: false, res: apiError(429, "rate_limited", "Too many failed authentication attempts. Try again shortly.", { "Retry-After": String(limited) }) };
      hit(badKeyWindows, ip, Infinity);
    }
    return { ok: false, res: apiError(401, code, message, wwwAuth) };
  };

  const presented = presentedKey(req);
  if (!presented) return fail("unauthorized", "Missing API key. Send it as 'Authorization: Bearer <key>'.");
  if (!presented.startsWith(KEY_PREFIX) || presented.length > 200) return fail("unauthorized", "Invalid API key.");
  const hash = sha256(presented);
  const row = db.query("SELECT * FROM repo_api_keys WHERE key_hash = ?").get(hash) as KeyRow | null;
  // The lookup is by hash (an index probe, not a comparison of secrets); the
  // constant-time check below is belt and braces.
  if (!row || !timingSafeEqual(Buffer.from(row.key_hash), Buffer.from(hash))) return fail("unauthorized", "Invalid API key.");
  if (row.revoked_at) return fail("key_revoked", "This API key has been revoked.");
  if (row.expires_at && row.expires_at <= sqliteFromDate(new Date())) return fail("key_expired", "This API key has expired.");
  const siteRow = db.query("SELECT slug FROM sites WHERE id = ? AND site_type = 'repository'").get(row.site_id) as { slug: string } | null;
  const site = siteRow ? getSite(siteRow.slug) : null;
  // Deleting the repository cascades its keys away; this only guards a race.
  if (!site) return fail("unauthorized", "Invalid API key.");

  const retry = hit(keyWindows, row.id, RATE_LIMIT_PER_MIN);
  if (retry) return { ok: false, res: apiError(429, "rate_limited", `Rate limit is ${RATE_LIMIT_PER_MIN} requests per minute per key.`, { "Retry-After": String(retry) }) };

  // Record use at most once a minute per key to keep writes off the hot path.
  if (!row.last_used_at || row.last_used_at < sqliteFromDate(new Date(Date.now() - 60_000))) {
    db.run("UPDATE repo_api_keys SET last_used_at = datetime('now'), last_used_ip = ? WHERE id = ?", ip, row.id);
  }
  return { ok: true, auth: { key: row, site, actor: `api:${row.label}`.slice(0, 80) } };
}

// --- Repository access ---

function resolveRepoId(id: string): Site | null {
  if (!/^\d{1,12}$/.test(id)) return null;
  const row = db.query("SELECT slug FROM sites WHERE id = ? AND site_type = 'repository'").get(Number(id)) as { slug: string } | null;
  return row ? getSite(row.slug) : null;
}

function keyAllowsSite(auth: ApiAuth, site: Site): boolean {
  return site.id === auth.key.site_id;
}

function accessibleRepos(auth: ApiAuth): Site[] {
  return [auth.site];
}

type RepoResult = { ok: true; site: Site } | { ok: false; res: Response };

function repoFor(auth: ApiAuth, id: string): RepoResult {
  const site = resolveRepoId(id);
  // Any repository but the key's own answers exactly like one that doesn't
  // exist, so a key can't probe which ids are repositories elsewhere.
  if (!site || !keyAllowsSite(auth, site)) return { ok: false, res: apiError(404, "not_found", "Repository not found.") };
  return { ok: true, site };
}

// --- Links ---

// Links are root-relative ("/<slug>/..."). The client keeps the Hoster base
// URL in its own configuration and prepends it, so the API never has to guess
// which hostname or scheme the outside world uses.
function repoPath(site: Site): string {
  return `/${site.slug}/`;
}

// --- Serialization ---

interface FileRow {
  id: number; site_slug: string; path: string; kind: "file" | "dir"; size: number; mime: string | null;
  sha256: string | null; version_no: number; created_at: string; updated_at: string;
  created_by: string | null; updated_by: string | null; description: string | null;
}

function tagNames(fileIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (!fileIds.length) return map;
  for (let i = 0; i < fileIds.length; i += 500) {
    const chunk = fileIds.slice(i, i + 500);
    const rows = db.query(
      `SELECT it.file_id, t.name FROM repo_item_tags it JOIN repo_tags t ON t.id = it.tag_id
       WHERE it.file_id IN (${chunk.map(() => "?").join(",")}) ORDER BY t.display_order, lower(t.name)`
    ).all(...chunk) as { file_id: number; name: string }[];
    for (const r of rows) {
      const l = map.get(r.file_id);
      if (l) l.push(r.name); else map.set(r.file_id, [r.name]);
    }
  }
  return map;
}

function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// path -> id for the given folder paths in one site.
function dirIds(slug: string, paths: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const wanted = Array.from(new Set(paths.filter(Boolean)));
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const rows = db.query(
      `SELECT id, path FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL AND kind = 'dir' AND path IN (${chunk.map(() => "?").join(",")})`
    ).all(slug, ...chunk) as { id: number; path: string }[];
    for (const r of rows) map.set(r.path, r.id);
  }
  return map;
}

function serializeItems(site: Site, rows: FileRow[]): any[] {
  const tags = tagNames(rows.map(r => r.id));
  const parents = dirIds(site.slug, rows.map(r => parentPath(r.path)));
  return rows.map(r => {
    const pp = parentPath(r.path);
    const parentId = pp ? parents.get(pp) : undefined;
    const isFile = r.kind === "file";
    return {
      id: String(r.id),
      repository_id: String(site.id),
      type: isFile ? "file" : "folder",
      name: r.path.slice(r.path.lastIndexOf("/") + 1),
      path: r.path,
      parent_id: parentId != null ? String(parentId) : null,
      size: isFile ? r.size : null,
      mime_type: isFile ? r.mime : null,
      version: isFile ? r.version_no : null,
      sha256: isFile ? r.sha256 : null,
      description: r.description ?? null,
      tags: tags.get(r.id) || [],
      created_at: isoFromSqlite(r.created_at),
      updated_at: isoFromSqlite(r.updated_at),
    };
  });
}

function serializeRepo(site: Site, auth: ApiAuth): any {
  const counts = db.query(
    `SELECT SUM(kind = 'file') AS files, SUM(kind = 'dir') AS dirs, COALESCE(SUM(CASE WHEN kind = 'file' THEN size END), 0) AS bytes,
            MAX(updated_at) AS last_change
     FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL`
  ).get(site.slug) as { files: number | null; dirs: number | null; bytes: number; last_change: string | null };
  return {
    id: String(site.id),
    slug: site.slug,
    name: site.name,
    description: site.repo_description ?? null,
    visibility: site.repo_visibility,
    url: repoPath(site),
    file_count: counts.files ?? 0,
    folder_count: counts.dirs ?? 0,
    size_bytes: counts.bytes ?? 0,
    created_at: isoFromSqlite(site.created_at),
    updated_at: isoFromSqlite(counts.last_change && counts.last_change > site.updated_at ? counts.last_change : site.updated_at),
    can_share: !!auth.key.can_share,
  };
}

function itemRow(site: Site, itemId: string): FileRow | null {
  if (!/^\d{1,15}$/.test(itemId)) return null;
  return db.query("SELECT * FROM repo_files WHERE id = ? AND site_slug = ? AND deleted_at IS NULL").get(Number(itemId), site.slug) as FileRow | null;
}

function childRows(site: Site, folder: string): FileRow[] {
  const sql = folder
    ? "SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL AND path LIKE ? ESCAPE '\\' AND instr(path, ?) = 1 AND instr(substr(path, length(?) + 1), '/') = 0 ORDER BY kind = 'file', lower(path)"
    : "SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL AND instr(path, '/') = 0 ORDER BY kind = 'file', lower(path)";
  // LIKE narrows the scan; instr() makes the folder match case-sensitive (LIKE
  // alone would mix in a sibling "public/" under "Public/"); the last test
  // keeps direct children only.
  const args = folder ? [site.slug, escapeLike(folder) + "/%", folder + "/", folder + "/"] : [site.slug];
  return db.query(sql).all(...args) as FileRow[];
}

function serializeShare(share: RepoShare & { site_slug?: string }, site: Site, itemId: string | null, url: string | null): any {
  return {
    share_id: String(share.id),
    url,
    repository_id: String(site.id),
    item_id: itemId,
    path: share.path,
    type: share.kind === "file" ? "file" : "folder",
    label: share.label ?? "",
    expires_at: isoFromSqlite(share.expires_at),
    created_at: isoFromSqlite(share.created_at),
    revoked_at: isoFromSqlite(share.revoked_at),
    active: share.active,
  };
}

// --- Request bodies ---

async function readJsonBody(req: Request): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  const tooLarge = { ok: false as const, res: apiError(413, "invalid_request", "Request body is too large.", { Connection: "close" }) };
  // A declared oversize body is refused before any of it is read (a body
  // that's never touched is discarded by Bun safely).
  const declared = req.headers.get("content-length");
  if (declared && !(Number(declared) <= MAX_BODY_BYTES)) return tooLarge;
  // Otherwise read the stream to its end, keeping at most MAX_BODY_BYTES.
  // Two traps avoided here:
  //   * req.text() would buffer whatever a chunked (length-less) request
  //     sends — up to Bun's ~2 GB body limit — before we could look at it;
  //   * stopping early and cancelling the stream leaves the rest of a chunked
  //     body unread, and some Bun versions then parse it as a new request on
  //     the same connection (request smuggling; see SECURITY-AUDIT.md,
  //     v2.7.0, and test/smuggling.test.ts).
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total <= MAX_BODY_BYTES) chunks.push(value);
      }
    } catch {
      return { ok: false, res: apiError(400, "invalid_request", "Could not read the request body.", { Connection: "close" }) };
    }
    if (total > MAX_BODY_BYTES) return tooLarge;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { return { ok: false, res: apiError(400, "invalid_request", "Request body must be UTF-8 JSON.") }; }
  }
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return { ok: true, body };
  } catch {
    return { ok: false, res: apiError(400, "invalid_request", "Request body must be a JSON object.") };
  }
}

// --- Handlers ---

function whoami(auth: ApiAuth): Response {
  const k = auth.key;
  return json({
    key_id: k.public_id,
    label: k.label,
    repository: { id: String(auth.site.id), slug: auth.site.slug, name: auth.site.name },
    scopes: k.can_share ? ["read", "share"] : ["read"],
    expires_at: isoFromSqlite(k.expires_at),
    created_at: isoFromSqlite(k.created_at),
  });
}

function search(auth: ApiAuth, url: URL, req: Request): Response {
  const q = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
  if (!q) return apiError(400, "invalid_request", "Query parameter 'q' is required.");
  if (q.length > 200) return apiError(400, "invalid_request", "Query is too long (max 200 characters).");
  const limitRaw = url.searchParams.get("limit");
  let limit = SEARCH_DEFAULT;
  if (limitRaw != null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX) return apiError(400, "invalid_request", `'limit' must be between 1 and ${SEARCH_MAX}.`);
  }
  const type = url.searchParams.get("type");
  if (type && type !== "file" && type !== "folder") return apiError(400, "invalid_request", "'type' must be 'file' or 'folder'.");
  void req;

  let repos: Site[];
  const repoParam = url.searchParams.get("repository_id") ?? url.searchParams.get("repository");
  if (repoParam) {
    const r = repoFor(auth, repoParam);
    if (!r.ok) return r.res;
    repos = [r.site];
  } else {
    repos = accessibleRepos(auth);
  }

  const needle = q.toLowerCase();
  const like = "%" + escapeLike(q) + "%";
  const scored: { site: Site; row: FileRow; score: number }[] = [];
  for (const site of repos) {
    const rows = db.query(
      `SELECT DISTINCT f.* FROM repo_files f
       LEFT JOIN repo_item_tags it ON it.file_id = f.id
       LEFT JOIN repo_tags t ON t.id = it.tag_id
       WHERE f.site_slug = ? AND f.deleted_at IS NULL ${type ? "AND f.kind = ?" : ""}
         AND (f.path LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')
       LIMIT ${SEARCH_SCAN_CAP}`
    ).all(...(type ? [site.slug, type === "file" ? "file" : "dir"] : [site.slug]), like, like, like) as FileRow[];
    for (const row of rows) {
      const name = row.path.slice(row.path.lastIndexOf("/") + 1).toLowerCase();
      // Name matches first (exact, then prefix, then anywhere), then path/description/tag hits.
      const score = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3;
      scored.push({ site, row, score });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.row.path.localeCompare(b.row.path));
  const top = scored.slice(0, limit);
  // Serialize per repository (parents and tags are looked up in batches), then restore rank order.
  const bySite = new Map<number, { site: Site; rows: FileRow[] }>();
  for (const s of top) {
    const e = bySite.get(s.site.id);
    if (e) e.rows.push(s.row); else bySite.set(s.site.id, { site: s.site, rows: [s.row] });
  }
  const serialized = new Map<number, any>();
  for (const { site, rows } of bySite.values()) {
    for (const item of serializeItems(site, rows)) serialized.set(Number(item.id), item);
  }
  return json(top.map(s => serialized.get(s.row.id)));
}

async function createShare(req: Request, auth: ApiAuth, site: Site, row: FileRow, ip: string): Promise<Response> {
  if (!auth.key.can_share) return apiError(403, "forbidden", "This API key may not create share links.");
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.body;

  // label: string (may be empty)
  if (body.label != null && typeof body.label !== "string") return apiError(400, "invalid_request", "'label' must be a string.");
  const label = typeof body.label === "string" ? body.label.trim().slice(0, MAX_LABEL) : "";

  // expires_at: ISO timestamp or null
  let expires: string | null = null;
  if (body.expires_at != null) {
    if (typeof body.expires_at !== "string") return apiError(400, "invalid_request", "'expires_at' must be an ISO 8601 timestamp or null.");
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(body.expires_at)) return apiError(400, "invalid_request", "'expires_at' must be an ISO 8601 timestamp or null.");
    if (d.getTime() <= Date.now()) return apiError(400, "invalid_request", "'expires_at' must be in the future.");
    if (d.getTime() > Date.now() + MAX_SHARE_DURATION_HOURS * 3600_000 + 60_000) return apiError(400, "invalid_request", "'expires_at' can be at most one year from now.");
    expires = sqliteFromDate(d);
  }

  const idemRaw = req.headers.get("idempotency-key");
  let idem: string | null = null;
  if (idemRaw != null) {
    idem = idemRaw.trim();
    if (!idem || idem.length > MAX_IDEMPOTENCY_KEY || !/^[\x21-\x7e]+$/.test(idem)) {
      return apiError(400, "invalid_request", `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY} visible ASCII characters.`);
    }
  }

  const base = repoPath(site);
  const fingerprint = sha256(JSON.stringify([site.id, row.id, expires, label]));
  const idemHash = idem ? hmac("idem", `${auth.key.id}:${idem}`).toString("hex") : null;
  const tokenFor = (nonce: string) => hmac("share-token", nonce).toString("base64url");

  // Everything from the replay check to the insert is synchronous, so two
  // concurrent retries can't both miss the replay row.
  try {
    if (idemHash) {
      const prior = db.query("SELECT fingerprint, share_id, nonce FROM repo_api_idempotency WHERE key_id = ? AND idem_hash = ?").get(auth.key.id, idemHash) as { fingerprint: string; share_id: number; nonce: string } | null;
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          return apiError(422, "invalid_request", "This Idempotency-Key was already used for a different request.");
        }
        // The share row exists (purging a share cascades this record away).
        const share = getRepoShareById(prior.share_id);
        if (share && share.site_slug === site.slug) {
          return json(serializeShare(share, site, String(row.id), `${base}_repo/s/${tokenFor(prior.nonce)}`), 200, { "Idempotent-Replayed": "true" });
        }
        db.run("DELETE FROM repo_api_idempotency WHERE key_id = ? AND idem_hash = ?", auth.key.id, idemHash);
      }
    }
    // A fresh random nonce for every new share, idempotent or not.
    const nonce = randomBytes(32).toString("hex");
    const tx = db.transaction(() => {
      const { share, token: minted } = createRepoShare(site.slug, row.path, {
        expires_at: expires, label: label || null, actor: auth.actor, token: tokenFor(nonce),
      });
      if (idemHash) {
        db.run("INSERT INTO repo_api_idempotency (key_id, idem_hash, fingerprint, share_id, nonce) VALUES (?, ?, ?, ?, ?)", auth.key.id, idemHash, fingerprint, share.id, nonce);
      }
      return { share, minted };
    });
    const { share, minted } = tx();
    auditLog("repo_share_created", `${site.slug}:${share.path} via API key ${auth.key.public_id} (${share.expires_at ? `until ${share.expires_at}` : "no expiry"})`, ip, auth.actor);
    return json(serializeShare(share, site, String(row.id), `${base}_repo/s/${minted}`), 201);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/active share links/.test(msg)) return apiError(400, "invalid_request", msg);
    throw e;
  }
}

function deleteShare(auth: ApiAuth, shareId: string, ip: string): Response {
  if (!/^\d{1,15}$/.test(shareId)) return apiError(404, "not_found", "Share not found.");
  const share = getRepoShareById(Number(shareId));
  const site = share ? getSite(share.site_slug) : null;
  if (!share || !site || !keyAllowsSite(auth, site)) return apiError(404, "not_found", "Share not found.");
  if (!auth.key.can_share) return apiError(403, "forbidden", "This API key may not revoke share links.");
  if (revokeRepoShare(site.slug, share.id)) {
    auditLog("repo_share_revoked", `${site.slug} share #${share.id} via API key ${auth.key.public_id}`, ip, auth.actor);
  }
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

function serveItemContent(req: Request, site: Site, row: FileRow): Response {
  if (row.kind !== "file") return apiError(400, "invalid_request", "Folders have no content; list their children instead.");
  const content = readRepoContent(site.slug, row.path);
  if (!content) return apiError(404, "not_found", "File content not found.");
  const etag = `"${content.sha256}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...BASE_HEADERS, ETag: etag } });
  const ascii = content.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(Bun.file(content.abs), {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": content.mime || "application/octet-stream",
      "Content-Length": String(content.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(content.name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      ETag: etag,
    },
  });
}

// --- Router ---

export function isApiV1Path(path: string): boolean {
  return path === "/api/v1" || path.startsWith("/api/v1/");
}

function methodNotAllowed(allowed: string): Response {
  return apiError(405, "invalid_request", `Method not allowed. Use ${allowed}.`, { Allow: allowed });
}

export async function handleApiV1(req: Request, path: string): Promise<Response> {
  try {
    return await route(req, path);
  } catch (e: any) {
    console.error("api/v1 error:", path, e?.message || e);
    return apiError(500, "internal_error", "Something went wrong on the server.");
  }
}

async function route(req: Request, rawPath: string): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...BASE_HEADERS,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-API-Key",
        "Access-Control-Max-Age": "600",
      },
    });
  }

  const url = new URL(req.url);
  // Trailing slashes are accepted, never redirected.
  const path = rawPath.replace(/\/+$/, "") || "/";
  let segs: string[];
  try {
    segs = path.slice("/api/v1".length).split("/").filter(Boolean).map(s => decodeURIComponent(s));
  } catch {
    return apiError(400, "invalid_request", "Malformed URL encoding in path.");
  }

  const ip = getClientIp(req);
  const a = authenticate(req, ip);
  if (!a.ok) return a.res;
  const auth = a.auth;
  const m = req.method === "HEAD" ? "GET" : req.method;

  // /whoami
  if (segs.length === 1 && segs[0] === "whoami") {
    return m === "GET" ? whoami(auth) : methodNotAllowed("GET");
  }

  // /search
  if (segs.length === 1 && segs[0] === "search") {
    return m === "GET" ? search(auth, url, req) : methodNotAllowed("GET");
  }

  // /shares/{share_id}
  if (segs[0] === "shares" && segs.length === 2) {
    return m === "DELETE" ? deleteShare(auth, segs[1], ip) : methodNotAllowed("DELETE");
  }

  if (segs[0] === "repositories") {
    // /repositories
    if (segs.length === 1) {
      if (m !== "GET") return methodNotAllowed("GET");
      return json(accessibleRepos(auth).map(s => serializeRepo(s, auth)));
    }
    const r = repoFor(auth, segs[1]);
    if (!r.ok) return r.res;
    const site = r.site;

    // /repositories/{id}
    if (segs.length === 2) return m === "GET" ? json(serializeRepo(site, auth)) : methodNotAllowed("GET");

    if (segs[2] === "items") {
      // /repositories/{id}/items[?parent_id=]
      if (segs.length === 3) {
        if (m !== "GET") return methodNotAllowed("GET");
        const parentId = url.searchParams.get("parent_id");
        if (parentId) {
          const parent = itemRow(site, parentId);
          if (!parent) return apiError(404, "not_found", "Parent folder not found.");
          if (parent.kind !== "dir") return apiError(400, "invalid_request", "'parent_id' must be a folder.");
          return json(serializeItems(site, childRows(site, parent.path)));
        }
        return json(serializeItems(site, childRows(site, "")));
      }
      const row = itemRow(site, segs[3]);
      if (!row) return apiError(404, "not_found", "Item not found.");

      // /repositories/{id}/items/{item_id}
      if (segs.length === 4) return m === "GET" ? json(serializeItems(site, [row])[0]) : methodNotAllowed("GET");

      if (segs.length === 5) {
        switch (segs[4]) {
          case "children":
            if (m !== "GET") return methodNotAllowed("GET");
            if (row.kind !== "dir") return apiError(400, "invalid_request", "Only folders have children.");
            return json(serializeItems(site, childRows(site, row.path)));
          case "content":
            return m === "GET" ? serveItemContent(req, site, row) : methodNotAllowed("GET");
          case "shares":
            return m === "POST" ? createShare(req, auth, site, row, ip) : methodNotAllowed("POST");
        }
      }
    }
  }

  return apiError(404, "not_found", "No such API endpoint.");
}
