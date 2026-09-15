// Repository sites — a document library with built-in UI.
//
// Unlike web sites (a versioned directory tree served verbatim), a repository
// stores every file version as a content-addressed blob and keeps the
// directory structure in SQLite:
//
//   sites/<slug>/_repo/
//     objects/<aa>/<sha256>   — immutable blobs, deduplicated per site
//     tmp/                    — in-flight uploads (streamed + hashed, then moved)
//     banner.<ext>            — optional banner image
//
//   repo_files      one row per live (or trashed) file/folder path
//   repo_versions   every stored version of a file, newest = highest version_no
//   repo_blobs      per-site blob refcounts → quota accounting + garbage collection
//
// Why content-addressed: uploading the same document twice costs nothing,
// "restore version 3" is a new version row pointing at an existing blob, and
// the quota is simply the sum of live blob sizes. Paths never touch the
// filesystem (except in export/zip staging, where they are re-validated), so
// a hostile filename can't escape the site directory.
//
// Security model (enforced by the HTTP layer in repo-site.ts, but the rules
// live here so they're in one place):
//   * Writers = platform administrators + site users assigned to the site.
//   * Readers = everyone when repo_visibility = "public", else writers only.
//   * Every mutation records the acting username and is audit-logged by the
//     caller. Deletes are soft (trash) and auto-purged after TRASH_TTL_DAYS.

import db from "./db";
import { SITES_DIR, getSite, validateSlug, invalidateSiteCache, normalizeSitePath, type Site, DEFAULT_REPO_QUOTA_BYTES, DEFAULT_REPO_MAX_VERSIONS, REPO_VISIBILITIES, type RepoVisibility } from "./sites";
import { createHash, randomBytes } from "crypto";
import {
  existsSync, mkdirSync, rmSync, renameSync, unlinkSync, copyFileSync, linkSync, statSync,
  readdirSync, readFileSync, writeFileSync, lstatSync, realpathSync,
} from "fs";
import { join, dirname, resolve, sep, extname, basename } from "path";
import { tmpdir } from "os";

db.exec(`
  CREATE TABLE IF NOT EXISTS repo_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_slug TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT,
    sha256 TEXT,
    version_no INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TEXT,
    deleted_by TEXT,
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_files_live ON repo_files(site_slug, path) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_repo_files_site ON repo_files(site_slug, deleted_at);

  CREATE TABLE IF NOT EXISTS repo_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    site_slug TEXT NOT NULL,
    version_no INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    created_by TEXT,
    UNIQUE(file_id, version_no),
    FOREIGN KEY (file_id) REFERENCES repo_files(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_repo_versions_site ON repo_versions(site_slug);

  CREATE TABLE IF NOT EXISTS repo_blobs (
    site_slug TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    refcount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_slug, sha256)
  );
`);

export const REPO_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per upload
export const TRASH_TTL_DAYS = 30;
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const MAX_NOTE_LENGTH = 500;
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024; // in-place editor cap
const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024; // packaged download cap (uncompressed)

// --- Types ---

export interface RepoFile {
  id: number;
  path: string;
  name: string;
  kind: "file" | "dir";
  size: number;
  mime: string | null;
  sha256: string | null;
  version_no: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface RepoTrashEntry extends RepoFile {
  deleted_at: string;
  deleted_by: string | null;
}

export interface RepoVersion {
  id: number;
  version_no: number;
  sha256: string;
  size: number;
  mime: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
  current: boolean;
}

export interface RepoStats {
  used_bytes: number;
  quota_bytes: number;
  file_count: number;
  dir_count: number;
  version_count: number;
  trash_count: number;
}

interface FileRow {
  id: number; site_slug: string; path: string; kind: "file" | "dir"; size: number; mime: string | null;
  sha256: string | null; version_no: number; created_at: string; updated_at: string;
  created_by: string | null; updated_by: string | null; deleted_at: string | null; deleted_by: string | null;
}

// --- MIME detection (by extension; the browser never sniffs thanks to nosniff) ---

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain", ".md": "text/markdown",
  ".markdown": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".log": "text/plain",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".toml": "text/plain", ".ini": "text/plain", ".sh": "text/plain",
  ".ts": "text/plain", ".py": "text/plain", ".rb": "text/plain", ".go": "text/plain", ".rs": "text/plain",
  ".java": "text/plain", ".c": "text/plain", ".h": "text/plain", ".cpp": "text/plain", ".swift": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp", ".avif": "image/avif", ".heic": "image/heic",
  ".tif": "image/tiff", ".tiff": "image/tiff",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation", ".rtf": "application/rtf", ".epub": "application/epub+zip",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

export function mimeForName(name: string): string {
  const ext = extname(name).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

// Types the built-in viewer can render inline. Everything else is offered as
// a download only. HTML/SVG/XML are deliberately excluded from `inline`
// navigation: a hostile document served inline on the site's origin could run
// script with the visitor's cookies. SVG is still fine inside an <img>, which
// is how the UI previews it (see repo-site.ts for the sandboxed raw route).
export function previewKind(mime: string | null): "image" | "video" | "audio" | "pdf" | "text" | "markdown" | "none" {
  if (!mime) return "none";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "markdown";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return "text";
  return "none";
}

// Editable in place: plain-text formats. HTML/XML/SVG are previewed as
// source but not edited here — the library is for documents, not markup.
export function isTextMime(mime: string | null): boolean {
  const k = previewKind(mime);
  if (k !== "text" && k !== "markdown") return false;
  return mime !== "text/html" && mime !== "application/xml" && mime !== "text/xml" && mime !== "image/svg+xml";
}

// --- Paths & directories ---

export function repoDir(slug: string): string {
  return join(SITES_DIR, slug, "_repo");
}

function objectsDir(slug: string): string { return join(repoDir(slug), "objects"); }
function tmpDir(slug: string): string { return join(repoDir(slug), "tmp"); }

export function blobPath(slug: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid blob id");
  return join(objectsDir(slug), sha256.slice(0, 2), sha256);
}

function ensureRepoDirs(slug: string): void {
  mkdirSync(objectsDir(slug), { recursive: true });
  mkdirSync(tmpDir(slug), { recursive: true });
}

// Validate and normalize a repository path. Same rules as site paths (no "..",
// no NUL, forward slashes), plus length limits and no control characters —
// these names are shown in the UI and written into export archives.
export function normalizeRepoPath(relPath: string, opts: { allowEmpty?: boolean } = {}): string {
  const normalized = normalizeSitePath(relPath, { allowEmpty: opts.allowEmpty });
  if (normalized.length > MAX_PATH_LENGTH) throw new Error("Path is too long");
  for (const seg of normalized.split("/")) {
    if (!seg) continue;
    if (seg.length > MAX_SEGMENT_LENGTH) throw new Error("A path segment is too long (max 255 characters)");
    if (/[\x00-\x1f\x7f]/.test(seg)) throw new Error("Path contains control characters");
    if (seg === "_repo" && !normalized.includes("/")) throw new Error("'_repo' is reserved");
  }
  return normalized;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function requireRepoSite(slug: string): Site {
  const site = getSite(slug);
  if (!site) throw new Error("Site not found");
  if (site.site_type !== "repository") throw new Error("Not a repository site");
  return site;
}

function sanitizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const cleaned = String(note).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NOTE_LENGTH ? cleaned.slice(0, MAX_NOTE_LENGTH) : cleaned;
}

function sanitizeActor(actor: string | null | undefined): string | null {
  if (!actor) return null;
  return String(actor).slice(0, 80);
}

// --- Site creation ---

export interface CreateRepositoryOptions {
  quota_bytes?: number;
  max_versions?: number;
  visibility?: RepoVisibility;
  description?: string | null;
}

export function createRepositorySite(slug: string, name: string, opts: CreateRepositoryOptions = {}): Site {
  validateSlug(slug);
  if (getSite(slug)) throw new Error(`Site '${slug}' already exists`);
  const trimmedName = (name || "").trim() || slug;
  if (trimmedName.length > 200) throw new Error("Name exceeds 200 characters");
  const quota = opts.quota_bytes === undefined ? DEFAULT_REPO_QUOTA_BYTES : Math.floor(Number(opts.quota_bytes));
  if (!Number.isFinite(quota) || quota < 0) throw new Error("Invalid storage limit");
  const maxVersions = opts.max_versions === undefined ? DEFAULT_REPO_MAX_VERSIONS : Number(opts.max_versions);
  if (!Number.isInteger(maxVersions) || maxVersions < 0 || maxVersions > 1000) throw new Error("Invalid versions-per-file value");
  const visibility = opts.visibility ?? "private";
  if (!REPO_VISIBILITIES.includes(visibility)) throw new Error("Visibility must be 'public' or 'private'");
  const description = opts.description ? String(opts.description).trim().slice(0, 1000) : null;

  ensureRepoDirs(slug);
  db.run(
    `INSERT INTO sites (slug, name, size_bytes, file_count, current_version, root_dir, spa, mcp_enabled, mcp_read_only,
       site_type, repo_quota_bytes, repo_max_versions, repo_visibility, repo_description, updated_at)
     VALUES (?, ?, 0, 0, NULL, NULL, 0, 0, 0, 'repository', ?, ?, ?, ?, datetime('now'))`,
    slug, trimmedName, quota, maxVersions, visibility, description
  );
  invalidateSiteCache(slug);
  return getSite(slug)!;
}

// --- Quota / stats ---

export function repoUsedBytes(slug: string): number {
  const row = db.query("SELECT COALESCE(SUM(size), 0) AS used FROM repo_blobs WHERE site_slug = ? AND refcount > 0").get(slug) as { used: number };
  return row.used;
}

export function repoStats(slug: string): RepoStats {
  const site = requireRepoSite(slug);
  const files = db.query("SELECT COUNT(*) AS n FROM repo_files WHERE site_slug = ? AND kind = 'file' AND deleted_at IS NULL").get(slug) as { n: number };
  const dirs = db.query("SELECT COUNT(*) AS n FROM repo_files WHERE site_slug = ? AND kind = 'dir' AND deleted_at IS NULL").get(slug) as { n: number };
  const versions = db.query("SELECT COUNT(*) AS n FROM repo_versions WHERE site_slug = ?").get(slug) as { n: number };
  const trash = db.query("SELECT COUNT(*) AS n FROM repo_files WHERE site_slug = ? AND deleted_at IS NOT NULL").get(slug) as { n: number };
  return {
    used_bytes: repoUsedBytes(slug),
    quota_bytes: site.repo_quota_bytes,
    file_count: files.n,
    dir_count: dirs.n,
    version_count: versions.n,
    trash_count: trash.n,
  };
}

// Mirror the live size/count onto the sites row so the admin lists show it
// without a join. Called after every mutation.
function syncSiteStats(slug: string): void {
  const used = repoUsedBytes(slug);
  const files = db.query("SELECT COUNT(*) AS n FROM repo_files WHERE site_slug = ? AND kind = 'file' AND deleted_at IS NULL").get(slug) as { n: number };
  db.run("UPDATE sites SET size_bytes = ?, file_count = ?, updated_at = datetime('now') WHERE slug = ?", used, files.n, slug);
  invalidateSiteCache(slug);
}

// --- Blob helpers ---

function blobRetain(slug: string, sha256: string, size: number): void {
  db.run(
    `INSERT INTO repo_blobs (site_slug, sha256, size, refcount) VALUES (?, ?, ?, 1)
     ON CONFLICT(site_slug, sha256) DO UPDATE SET refcount = refcount + 1`,
    slug, sha256, size
  );
}

function blobRelease(slug: string, sha256: string): void {
  db.run("UPDATE repo_blobs SET refcount = refcount - 1 WHERE site_slug = ? AND sha256 = ?", slug, sha256);
}

// Delete blob files whose refcount dropped to zero. Runs outside the
// transaction that released them so a rolled-back transaction never loses data.
function gcBlobs(slug: string): number {
  const dead = db.query("SELECT sha256 FROM repo_blobs WHERE site_slug = ? AND refcount <= 0").all(slug) as { sha256: string }[];
  let removed = 0;
  for (const { sha256 } of dead) {
    try { unlinkSync(blobPath(slug, sha256)); } catch (_) {}
    db.run("DELETE FROM repo_blobs WHERE site_slug = ? AND sha256 = ?", slug, sha256);
    removed++;
  }
  return removed;
}

function blobExists(slug: string, sha256: string): boolean {
  const row = db.query("SELECT 1 FROM repo_blobs WHERE site_slug = ? AND sha256 = ? AND refcount > 0").get(slug, sha256);
  return !!row && existsSync(blobPath(slug, sha256));
}

// Stream an incoming body to a temp file while hashing it. Returns the hash
// and size; the caller moves the temp file into objects/ or discards it.
export interface StagedBlob { tmpPath: string; sha256: string; size: number }

export async function stageBlob(slug: string, body: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | null, maxBytes: number): Promise<StagedBlob> {
  ensureRepoDirs(slug);
  const tmpPath = join(tmpDir(slug), `${Date.now()}-${randomBytes(8).toString("hex")}`);
  const hash = createHash("sha256");
  let size = 0;
  const file = Bun.file(tmpPath);
  const writer = file.writer();
  try {
    if (body === null) {
      // empty file
    } else if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      if (bytes.byteLength > maxBytes) throw new Error(`File exceeds the ${formatLimit(maxBytes)} limit`);
      hash.update(bytes);
      size = bytes.byteLength;
      writer.write(bytes);
    } else {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (size > maxBytes) throw new Error(`File exceeds the ${formatLimit(maxBytes)} limit`);
        hash.update(value);
        writer.write(value);
      }
    }
    await writer.end();
  } catch (e) {
    try { await writer.end(); } catch (_) {}
    try { unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
  return { tmpPath, sha256: hash.digest("hex"), size };
}

function discardStaged(staged: StagedBlob): void {
  try { unlinkSync(staged.tmpPath); } catch (_) {}
}

// Move a staged blob into the object store (or drop it if identical content
// already exists). Filesystem only; the DB refcount is handled by the caller.
function adoptStaged(slug: string, staged: StagedBlob): void {
  const dest = blobPath(slug, staged.sha256);
  if (existsSync(dest)) {
    discardStaged(staged);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(staged.tmpPath, dest);
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// Clear stale temp uploads (crashed/aborted requests). Called by the periodic
// cleanup in index.ts.
export function cleanRepoTemp(maxAgeMs = 24 * 60 * 60 * 1000): void {
  if (!existsSync(SITES_DIR)) return;
  for (const slug of readdirSync(SITES_DIR)) {
    const t = tmpDir(slug);
    if (!existsSync(t)) continue;
    for (const f of readdirSync(t)) {
      const p = join(t, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
      } catch (_) {}
    }
  }
}

// --- Rows ---

function liveRow(slug: string, path: string): FileRow | null {
  return db.query("SELECT * FROM repo_files WHERE site_slug = ? AND path = ? AND deleted_at IS NULL").get(slug, path) as FileRow | null;
}

function toRepoFile(r: FileRow): RepoFile {
  return {
    id: r.id, path: r.path, name: basename(r.path), kind: r.kind, size: r.size, mime: r.mime, sha256: r.sha256,
    version_no: r.version_no, created_at: r.created_at, updated_at: r.updated_at,
    created_by: r.created_by, updated_by: r.updated_by,
  };
}

// Make sure every ancestor directory of `path` has a live row. A file may not
// be created beneath a path that is currently a file.
function ensureParents(slug: string, path: string, actor: string | null): void {
  const parent = parentOf(path);
  if (!parent) return;
  const existing = liveRow(slug, parent);
  if (existing) {
    if (existing.kind !== "dir") throw new Error(`'${parent}' is a file, not a folder`);
    return;
  }
  ensureParents(slug, parent, actor);
  db.run(
    "INSERT INTO repo_files (site_slug, path, kind, created_by, updated_by) VALUES (?, ?, 'dir', ?, ?)",
    slug, parent, actor, actor
  );
}

// --- Listing ---

export interface RepoTree {
  files: RepoFile[];
  dirs: RepoFile[];
}

export function listRepoTree(slug: string): RepoTree {
  requireRepoSite(slug);
  const rows = db.query(
    "SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL ORDER BY path"
  ).all(slug) as FileRow[];
  const files: RepoFile[] = [];
  const dirs: RepoFile[] = [];
  for (const r of rows) (r.kind === "dir" ? dirs : files).push(toRepoFile(r));
  return { files, dirs };
}

export function getRepoFile(slug: string, relPath: string): RepoFile | null {
  requireRepoSite(slug);
  const path = normalizeRepoPath(relPath);
  const row = liveRow(slug, path);
  return row ? toRepoFile(row) : null;
}

// Absolute path of the blob backing a file (or one of its versions). Verified
// to live inside the site's object store before it is handed to the server.
export interface RepoContent { abs: string; size: number; mime: string; name: string; sha256: string; version_no: number }

export function readRepoContent(slug: string, relPath: string, versionNo?: number | null): RepoContent | null {
  requireRepoSite(slug);
  const path = normalizeRepoPath(relPath);
  const row = liveRow(slug, path);
  if (!row || row.kind !== "file" || !row.sha256) return null;
  let sha = row.sha256, size = row.size, mime = row.mime, vno = row.version_no;
  if (versionNo != null && versionNo !== row.version_no) {
    const v = db.query("SELECT * FROM repo_versions WHERE file_id = ? AND version_no = ?").get(row.id, versionNo) as any;
    if (!v) return null;
    sha = v.sha256; size = v.size; mime = v.mime; vno = v.version_no;
  }
  const abs = blobPath(slug, sha);
  if (!existsSync(abs)) return null;
  const real = realpathSync(abs);
  const realObjects = realpathSync(objectsDir(slug));
  if (!(real === realObjects || real.startsWith(realObjects + sep))) return null;
  return { abs, size, mime: mime || mimeForName(path), name: basename(path), sha256: sha, version_no: vno };
}

// --- Writes ---

export interface PutResult {
  file: RepoFile;
  created: boolean;      // true when the path did not exist before
  new_version: boolean;  // false when the uploaded bytes matched the current version (no-op)
  pruned_versions: number;
}

interface PutOptions { actor?: string | null; note?: string | null; replace?: boolean; mime?: string | null }

// Store a staged blob at `relPath` as a new version (or a new file). The
// caller stages the bytes first (stageBlob) so hashing/streaming happens
// outside the DB transaction. Quota is checked against the actual size.
export function commitRepoFile(slug: string, relPath: string, staged: StagedBlob, opts: PutOptions = {}): PutResult {
  const site = requireRepoSite(slug);
  const path = normalizeRepoPath(relPath);
  const actor = sanitizeActor(opts.actor);
  const note = sanitizeNote(opts.note);
  const mime = opts.mime || mimeForName(path);

  const existing = liveRow(slug, path);
  if (existing && existing.kind === "dir") { discardStaged(staged); throw new Error(`'${path}' is a folder`); }
  if (existing && opts.replace === false) { discardStaged(staged); throw new Error(`'${path}' already exists`); }

  // Identical content to the current version: nothing to store.
  if (existing && existing.sha256 === staged.sha256) {
    discardStaged(staged);
    return { file: toRepoFile(existing), created: false, new_version: false, pruned_versions: 0 };
  }

  // Quota: only new blobs consume space.
  const needsSpace = !blobExists(slug, staged.sha256);
  if (needsSpace && site.repo_quota_bytes > 0) {
    const used = repoUsedBytes(slug);
    if (used + staged.size > site.repo_quota_bytes) {
      discardStaged(staged);
      throw new Error(`Not enough space: this repository allows ${formatLimit(site.repo_quota_bytes)} and ${formatLimit(used)} is in use`);
    }
  }

  adoptStaged(slug, staged);

  let result!: PutResult;
  const tx = db.transaction(() => {
    ensureParents(slug, path, actor);
    let fileId: number;
    let versionNo: number;
    if (existing) {
      fileId = existing.id;
      versionNo = existing.version_no + 1;
      db.run(
        `UPDATE repo_files SET size = ?, mime = ?, sha256 = ?, version_no = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`,
        staged.size, mime, staged.sha256, versionNo, actor, fileId
      );
    } else {
      versionNo = 1;
      const ins = db.run(
        `INSERT INTO repo_files (site_slug, path, kind, size, mime, sha256, version_no, created_by, updated_by)
         VALUES (?, ?, 'file', ?, ?, ?, 1, ?, ?)`,
        slug, path, staged.size, mime, staged.sha256, actor, actor
      );
      fileId = Number(ins.lastInsertRowid);
    }
    db.run(
      `INSERT INTO repo_versions (file_id, site_slug, version_no, sha256, size, mime, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      fileId, slug, versionNo, staged.sha256, staged.size, mime, note, actor
    );
    blobRetain(slug, staged.sha256, staged.size);
    const pruned = pruneVersions(slug, fileId, site.repo_max_versions);
    const row = db.query("SELECT * FROM repo_files WHERE id = ?").get(fileId) as FileRow;
    result = { file: toRepoFile(row), created: !existing, new_version: true, pruned_versions: pruned };
  });
  tx();
  gcBlobs(slug);
  syncSiteStats(slug);
  return result;
}

// Convenience for in-memory bytes (text editor, tests, restores).
export async function putRepoFile(slug: string, relPath: string, data: Uint8Array | ArrayBuffer | string, opts: PutOptions = {}): Promise<PutResult> {
  requireRepoSite(slug);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const staged = await stageBlob(slug, bytes, REPO_MAX_FILE_BYTES);
  return commitRepoFile(slug, relPath, staged, opts);
}

// Write a text/markdown file from the in-place editor. Refuses to create
// non-text files (a .html "document" would just be a download anyway).
export async function writeRepoText(slug: string, relPath: string, content: string, opts: PutOptions = {}): Promise<PutResult> {
  const path = normalizeRepoPath(relPath);
  if (typeof content !== "string") throw new Error("content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) throw new Error("Text file exceeds the 10 MB editor limit");
  const mime = mimeForName(path);
  if (!isTextMime(mime)) throw new Error("Only text files (.txt, .md, .csv, .json, …) can be edited in place");
  return putRepoFile(slug, path, content.replace(/\r\n?/g, "\n"), { ...opts, mime });
}

// Drop the oldest versions beyond the per-file cap. Returns how many were removed.
function pruneVersions(slug: string, fileId: number, maxVersions: number): number {
  if (!maxVersions || maxVersions <= 0) return 0;
  const old = db.query(
    "SELECT id, sha256 FROM repo_versions WHERE file_id = ? ORDER BY version_no DESC LIMIT -1 OFFSET ?"
  ).all(fileId, maxVersions) as { id: number; sha256: string }[];
  for (const v of old) {
    db.run("DELETE FROM repo_versions WHERE id = ?", v.id);
    blobRelease(slug, v.sha256);
  }
  return old.length;
}

export function createRepoFolder(slug: string, relPath: string, actor?: string | null): { path: string; created: boolean } {
  requireRepoSite(slug);
  const path = normalizeRepoPath(relPath);
  const existing = liveRow(slug, path);
  if (existing) {
    if (existing.kind !== "dir") throw new Error(`'${path}' exists and is a file`);
    return { path, created: false };
  }
  const who = sanitizeActor(actor);
  const tx = db.transaction(() => {
    ensureParents(slug, path, who);
    db.run("INSERT INTO repo_files (site_slug, path, kind, created_by, updated_by) VALUES (?, ?, 'dir', ?, ?)", slug, path, who, who);
  });
  tx();
  syncSiteStats(slug);
  return { path, created: true };
}

export interface RenameResult { from: string; to: string; kind: "file" | "dir"; moved: number }

// Rename or move a file or a whole folder. Version history follows the file.
export function renameRepoPath(slug: string, fromPath: string, toPath: string, actor?: string | null): RenameResult {
  requireRepoSite(slug);
  const from = normalizeRepoPath(fromPath);
  const to = normalizeRepoPath(toPath);
  if (from === to) throw new Error("Source and destination are the same");
  const src = liveRow(slug, from);
  if (!src) throw new Error(`'${from}' does not exist`);
  if (src.kind === "dir" && (to === from || to.startsWith(from + "/"))) throw new Error("Cannot move a folder inside itself");
  if (liveRow(slug, to)) throw new Error(`'${to}' already exists`);
  const who = sanitizeActor(actor);
  let moved = 0;
  const tx = db.transaction(() => {
    ensureParents(slug, to, who);
    db.run("UPDATE repo_files SET path = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?", to, who, src.id);
    moved = 1;
    if (src.kind === "dir") {
      const children = db.query(
        "SELECT id, path FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL AND path LIKE ? ESCAPE '\\'"
      ).all(slug, escapeLike(from) + "/%") as { id: number; path: string }[];
      for (const c of children) {
        const newPath = to + c.path.slice(from.length);
        db.run("UPDATE repo_files SET path = ? WHERE id = ?", newPath, c.id);
        moved++;
      }
    }
  });
  tx();
  syncSiteStats(slug);
  return { from, to, kind: src.kind, moved };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, ch => "\\" + ch);
}

export interface DeleteResult { deleted: { path: string; kind: "file" | "dir" }[]; }

// Soft-delete: rows move to the trash (deleted_at set) and keep their blobs,
// so a mistaken delete is recoverable until the trash is purged.
export function deleteRepoPaths(slug: string, relPaths: string[], actor?: string | null): DeleteResult {
  requireRepoSite(slug);
  if (!Array.isArray(relPaths) || relPaths.length === 0) throw new Error("No paths given");
  if (relPaths.length > 5000) throw new Error("Too many paths in one request (max 5000)");
  const targets = relPaths.map(p => normalizeRepoPath(p));
  const rows: FileRow[] = [];
  for (const t of targets) {
    const r = liveRow(slug, t);
    if (!r) throw new Error(`'${t}' does not exist`);
    rows.push(r);
  }
  const who = sanitizeActor(actor);
  const deleted: { path: string; kind: "file" | "dir" }[] = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      // Skip anything already trashed by an earlier entry in the same batch
      // (e.g. a folder and one of its files both selected).
      const still = db.query("SELECT deleted_at FROM repo_files WHERE id = ?").get(r.id) as { deleted_at: string | null };
      if (still.deleted_at) continue;
      db.run("UPDATE repo_files SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?", who, r.id);
      if (r.kind === "dir") {
        db.run(
          `UPDATE repo_files SET deleted_at = datetime('now'), deleted_by = ?
           WHERE site_slug = ? AND deleted_at IS NULL AND path LIKE ? ESCAPE '\\'`,
          who, slug, escapeLike(r.path) + "/%"
        );
      }
      deleted.push({ path: r.path, kind: r.kind });
    }
  });
  tx();
  syncSiteStats(slug);
  return { deleted };
}

// --- Trash ---

export function listRepoTrash(slug: string): RepoTrashEntry[] {
  requireRepoSite(slug);
  const rows = db.query(
    "SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, path"
  ).all(slug) as FileRow[];
  return rows.map(r => ({ ...toRepoFile(r), deleted_at: r.deleted_at!, deleted_by: r.deleted_by }));
}

// Bring a trashed entry back. A trashed folder brings back everything that was
// deleted with it (same deleted_at stamp). If the original path is now taken,
// the entry is restored under a "(restored)" name instead.
export function restoreRepoTrash(slug: string, ids: number[], actor?: string | null): { restored: string[] } {
  requireRepoSite(slug);
  if (!Array.isArray(ids) || !ids.length) throw new Error("No entries given");
  const who = sanitizeActor(actor);
  const restored: string[] = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = db.query("SELECT * FROM repo_files WHERE id = ? AND site_slug = ? AND deleted_at IS NOT NULL").get(id, slug) as FileRow | null;
      if (!r) continue;
      let target = r.path;
      if (liveRow(slug, target)) {
        const dot = r.kind === "file" ? target.lastIndexOf(".") : -1;
        const stem = dot > target.lastIndexOf("/") ? target.slice(0, dot) : target;
        const ext = dot > target.lastIndexOf("/") ? target.slice(dot) : "";
        let n = 1;
        do { target = `${stem} (restored${n > 1 ? " " + n : ""})${ext}`; n++; } while (liveRow(slug, target));
      }
      ensureParents(slug, target, who);
      db.run("UPDATE repo_files SET path = ?, deleted_at = NULL, deleted_by = NULL, updated_at = datetime('now'), updated_by = ? WHERE id = ?", target, who, r.id);
      restored.push(target);
      if (r.kind === "dir") {
        const children = db.query(
          "SELECT id, path FROM repo_files WHERE site_slug = ? AND deleted_at = ? AND path LIKE ? ESCAPE '\\'"
        ).all(slug, r.deleted_at, escapeLike(r.path) + "/%") as { id: number; path: string }[];
        for (const c of children) {
          const newPath = target + c.path.slice(r.path.length);
          if (liveRow(slug, newPath)) continue; // leave the conflicting child in the trash
          db.run("UPDATE repo_files SET path = ?, deleted_at = NULL, deleted_by = NULL WHERE id = ?", newPath, c.id);
          restored.push(newPath);
        }
      }
    }
  });
  tx();
  syncSiteStats(slug);
  return { restored };
}

// Permanently remove trashed entries (all of them when ids is omitted),
// releasing their blobs.
export function purgeRepoTrash(slug: string, ids?: number[] | null): { purged: number; freed_blobs: number } {
  requireRepoSite(slug);
  let rows: FileRow[];
  if (ids && ids.length) {
    rows = ids.map(id => db.query("SELECT * FROM repo_files WHERE id = ? AND site_slug = ? AND deleted_at IS NOT NULL").get(id, slug) as FileRow | null)
      .filter((r): r is FileRow => !!r);
  } else {
    rows = db.query("SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NOT NULL").all(slug) as FileRow[];
  }
  let purged = 0;
  const tx = db.transaction(() => {
    for (const r of rows) purged += purgeRow(slug, r);
  });
  tx();
  const freed = gcBlobs(slug);
  syncSiteStats(slug);
  return { purged, freed_blobs: freed };
}

function purgeRow(slug: string, r: FileRow): number {
  let n = 0;
  const targets: FileRow[] = [r];
  if (r.kind === "dir") {
    targets.push(...(db.query(
      "SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NOT NULL AND path LIKE ? ESCAPE '\\'"
    ).all(slug, escapeLike(r.path) + "/%") as FileRow[]));
  }
  for (const t of targets) {
    const versions = db.query("SELECT sha256 FROM repo_versions WHERE file_id = ?").all(t.id) as { sha256: string }[];
    for (const v of versions) blobRelease(slug, v.sha256);
    db.run("DELETE FROM repo_versions WHERE file_id = ?", t.id);
    const del = db.run("DELETE FROM repo_files WHERE id = ?", t.id);
    n += del.changes;
  }
  return n;
}

// Periodic: purge trash entries older than TRASH_TTL_DAYS across every repository.
export function purgeExpiredRepoTrash(days = TRASH_TTL_DAYS): number {
  const slugs = db.query("SELECT slug FROM sites WHERE site_type = 'repository'").all() as { slug: string }[];
  let total = 0;
  for (const { slug } of slugs) {
    const rows = db.query(
      "SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NOT NULL AND deleted_at < datetime('now', ?)"
    ).all(slug, `-${days} days`) as FileRow[];
    if (!rows.length) continue;
    const tx = db.transaction(() => { for (const r of rows) total += purgeRow(slug, r); });
    tx();
    gcBlobs(slug);
    syncSiteStats(slug);
  }
  return total;
}

// --- Versions ---

export function listRepoVersions(slug: string, relPath: string): RepoVersion[] {
  requireRepoSite(slug);
  const path = normalizeRepoPath(relPath);
  const row = liveRow(slug, path);
  if (!row || row.kind !== "file") throw new Error(`'${path}' is not a file`);
  const rows = db.query(
    "SELECT id, version_no, sha256, size, mime, note, created_at, created_by FROM repo_versions WHERE file_id = ? ORDER BY version_no DESC"
  ).all(row.id) as Omit<RepoVersion, "current">[];
  return rows.map(v => ({ ...v, current: v.version_no === row.version_no }));
}

// "Restore version N" = record a new version whose content is version N's
// blob. History is never rewritten, so the restore itself is undoable.
export function restoreRepoVersion(slug: string, relPath: string, versionNo: number, actor?: string | null): PutResult {
  const site = requireRepoSite(slug);
  const path = normalizeRepoPath(relPath);
  const row = liveRow(slug, path);
  if (!row || row.kind !== "file") throw new Error(`'${path}' is not a file`);
  const v = db.query("SELECT * FROM repo_versions WHERE file_id = ? AND version_no = ?").get(row.id, versionNo) as any;
  if (!v) throw new Error(`Version ${versionNo} not found`);
  if (v.sha256 === row.sha256) return { file: toRepoFile(row), created: false, new_version: false, pruned_versions: 0 };
  if (!existsSync(blobPath(slug, v.sha256))) throw new Error("Stored content for that version is missing");
  const who = sanitizeActor(actor);
  let result!: PutResult;
  const tx = db.transaction(() => {
    const newNo = row.version_no + 1;
    db.run(
      "UPDATE repo_files SET size = ?, mime = ?, sha256 = ?, version_no = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?",
      v.size, v.mime, v.sha256, newNo, who, row.id
    );
    db.run(
      "INSERT INTO repo_versions (file_id, site_slug, version_no, sha256, size, mime, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, slug, newNo, v.sha256, v.size, v.mime, `Restored version ${versionNo}`, who
    );
    blobRetain(slug, v.sha256, v.size);
    const pruned = pruneVersions(slug, row.id, site.repo_max_versions);
    const fresh = db.query("SELECT * FROM repo_files WHERE id = ?").get(row.id) as FileRow;
    result = { file: toRepoFile(fresh), created: false, new_version: true, pruned_versions: pruned };
  });
  tx();
  gcBlobs(slug);
  syncSiteStats(slug);
  return result;
}

export function deleteRepoVersion(slug: string, relPath: string, versionNo: number): boolean {
  requireRepoSite(slug);
  const path = normalizeRepoPath(relPath);
  const row = liveRow(slug, path);
  if (!row || row.kind !== "file") throw new Error(`'${path}' is not a file`);
  if (row.version_no === versionNo) throw new Error("The current version can't be deleted; restore another version first");
  const v = db.query("SELECT id, sha256 FROM repo_versions WHERE file_id = ? AND version_no = ?").get(row.id, versionNo) as { id: number; sha256: string } | null;
  if (!v) return false;
  const tx = db.transaction(() => {
    db.run("DELETE FROM repo_versions WHERE id = ?", v.id);
    blobRelease(slug, v.sha256);
  });
  tx();
  gcBlobs(slug);
  syncSiteStats(slug);
  return true;
}

// --- Packaging (zip) ---

// Materialize the selected paths (files and/or folders) into a temp tree and
// zip it. Folder selections keep their structure; the archive's root holds
// the selected items themselves. Blobs are hard-linked when the filesystem
// allows it and copied otherwise.
export async function zipRepoPaths(slug: string, relPaths: string[], archiveName?: string): Promise<{ buffer: Buffer; filename: string }> {
  const site = requireRepoSite(slug);
  if (!Array.isArray(relPaths) || !relPaths.length) throw new Error("No paths given");
  if (relPaths.length > 5000) throw new Error("Too many paths in one request (max 5000)");
  const selected = relPaths.map(p => normalizeRepoPath(p, { allowEmpty: true }));

  // Expand to a flat list of files with the archive-relative path each should get.
  const entries: { archivePath: string; sha256: string }[] = [];
  let totalBytes = 0;
  const addFile = (r: FileRow, base: string) => {
    if (!r.sha256) return;
    const archivePath = base ? r.path.slice(base.length + 1) : r.path;
    entries.push({ archivePath, sha256: r.sha256 });
    totalBytes += r.size;
  };
  for (const p of selected) {
    if (p === "") {
      // whole repository
      for (const r of db.query("SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL AND kind = 'file'").all(slug) as FileRow[]) addFile(r, "");
      continue;
    }
    const row = liveRow(slug, p);
    if (!row) throw new Error(`'${p}' does not exist`);
    const base = parentOf(p);
    if (row.kind === "file") { addFile(row, base); continue; }
    const children = db.query(
      "SELECT * FROM repo_files WHERE site_slug = ? AND deleted_at IS NULL AND kind = 'file' AND path LIKE ? ESCAPE '\\'"
    ).all(slug, escapeLike(p) + "/%") as FileRow[];
    for (const c of children) addFile(c, base);
    if (!children.length) entries.push({ archivePath: (base ? p.slice(base.length + 1) : p) + "/", sha256: "" });
  }
  if (!entries.length) throw new Error("Nothing to package");
  if (totalBytes > MAX_ZIP_BYTES) throw new Error("Selection is too large to package (max 4 GB)");

  const staging = join(tmpdir(), `hoster-repo-zip-${slug}-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  const zipPath = staging + ".zip";
  try {
    const realStaging = realpathSync(staging);
    for (const e of entries) {
      const dest = resolve(staging, e.archivePath);
      if (!(dest === realStaging || dest.startsWith(realStaging + sep)) && !(dest === staging || dest.startsWith(staging + sep))) {
        throw new Error("Path escapes archive root");
      }
      if (!e.sha256) { mkdirSync(dest, { recursive: true }); continue; }
      mkdirSync(dirname(dest), { recursive: true });
      const src = blobPath(slug, e.sha256);
      if (!existsSync(src)) continue;
      try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
    }
    const proc = Bun.spawnSync(["zip", "-r", "-q", zipPath, "."], { cwd: staging, stdout: "ignore", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      const err = proc.stderr ? new TextDecoder().decode(proc.stderr) : "unknown error";
      throw new Error(`Failed to create archive: ${err.trim()}`);
    }
    const buffer = Buffer.from(readFileSync(zipPath));
    const name = safeArchiveName(archiveName) || (entries.length === 1 && selected.length === 1 && selected[0] !== ""
      ? basename(selected[0]).replace(/\.[^.]+$/, "")
      : site.slug);
    return { buffer, filename: `${name}.zip` };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    try { rmSync(zipPath, { force: true }); } catch (_) {}
  }
}

function safeArchiveName(name?: string): string | null {
  if (!name) return null;
  const cleaned = String(name).replace(/[^\w .()-]+/g, "_").trim().slice(0, 80);
  return cleaned || null;
}

// --- Banner ---

const BANNER_TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_BANNER_BYTES = 8 * 1024 * 1024;

function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export function setRepoBanner(slug: string, data: Uint8Array | ArrayBuffer): { banner: string; mime: string } {
  requireRepoSite(slug);
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (bytes.byteLength > MAX_BANNER_BYTES) throw new Error("Banner image must be 8 MB or smaller");
  const mime = sniffImage(bytes);
  if (!mime) throw new Error("Banner must be a PNG, JPEG, WebP, or GIF image");
  ensureRepoDirs(slug);
  clearRepoBanner(slug);
  const name = "banner" + BANNER_TYPES[mime];
  writeFileSync(join(repoDir(slug), name), bytes);
  db.run("UPDATE sites SET repo_banner = ?, updated_at = datetime('now') WHERE slug = ?", name, slug);
  invalidateSiteCache(slug);
  return { banner: name, mime };
}

export function clearRepoBanner(slug: string): void {
  const site = requireRepoSite(slug);
  if (site.repo_banner && /^banner\.[a-z]+$/.test(site.repo_banner)) {
    try { unlinkSync(join(repoDir(slug), site.repo_banner)); } catch (_) {}
  }
  db.run("UPDATE sites SET repo_banner = NULL WHERE slug = ?", slug);
  invalidateSiteCache(slug);
}

export function repoBannerPath(site: Site): { abs: string; mime: string } | null {
  if (site.site_type !== "repository" || !site.repo_banner || !/^banner\.[a-z]+$/.test(site.repo_banner)) return null;
  const abs = join(repoDir(site.slug), site.repo_banner);
  if (!existsSync(abs)) return null;
  const mime = Object.entries(BANNER_TYPES).find(([, ext]) => site.repo_banner!.endsWith(ext))?.[0] || "application/octet-stream";
  return { abs, mime };
}

// --- Backup / restore (per repository) ---
//
// Archive layout (a plain zip):
//   manifest.json            { format: "hoster-repository", version: 1, slug, name, created_at, ... }
//   repository.json          rows of repo_files + repo_versions (metadata, incl. trash)
//   files/<path>             the CURRENT content of every live file — readable without Hoster
//   objects/<sha256>         every blob referenced by any version (history)
//   banner.<ext>             the banner, if any
//
// Restore rebuilds the tables from repository.json and copies objects back;
// files/ is ignored on restore (objects/ is authoritative) but makes the
// archive useful on its own.

export interface RepoBackupManifest {
  format: "hoster-repository";
  version: 1;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  file_count: number;
  version_count: number;
  total_bytes: number;
  quota_bytes: number;
  max_versions: number;
  visibility: RepoVisibility;
}

export async function exportRepoBackup(slug: string): Promise<{ buffer: Buffer; filename: string; manifest: RepoBackupManifest }> {
  const site = requireRepoSite(slug);
  const files = db.query("SELECT * FROM repo_files WHERE site_slug = ? ORDER BY path").all(slug) as FileRow[];
  const versions = db.query("SELECT * FROM repo_versions WHERE site_slug = ? ORDER BY file_id, version_no").all(slug) as any[];
  const blobs = db.query("SELECT sha256, size FROM repo_blobs WHERE site_slug = ? AND refcount > 0").all(slug) as { sha256: string; size: number }[];

  const staging = join(tmpdir(), `hoster-repo-backup-${slug}-${randomBytes(6).toString("hex")}`);
  const zipPath = staging + ".zip";
  mkdirSync(join(staging, "files"), { recursive: true });
  mkdirSync(join(staging, "objects"), { recursive: true });
  try {
    const manifest: RepoBackupManifest = {
      format: "hoster-repository", version: 1, slug, name: site.name, description: site.repo_description,
      created_at: new Date().toISOString(),
      file_count: files.filter(f => f.kind === "file" && !f.deleted_at).length,
      version_count: versions.length,
      total_bytes: blobs.reduce((s, b) => s + b.size, 0),
      quota_bytes: site.repo_quota_bytes, max_versions: site.repo_max_versions, visibility: site.repo_visibility,
    };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(staging, "repository.json"), JSON.stringify({ files, versions }, null, 2));

    const realStaging = realpathSync(staging);
    for (const f of files) {
      if (f.deleted_at) continue;
      const dest = resolve(staging, "files", f.path);
      if (!dest.startsWith(realStaging + sep) && !dest.startsWith(staging + sep)) continue;
      if (f.kind === "dir") { mkdirSync(dest, { recursive: true }); continue; }
      if (!f.sha256) continue;
      const src = blobPath(slug, f.sha256);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
    }
    for (const b of blobs) {
      const src = blobPath(slug, b.sha256);
      if (!existsSync(src)) continue;
      const dest = join(staging, "objects", b.sha256);
      try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
    }
    const banner = repoBannerPath(site);
    if (banner) copyFileSync(banner.abs, join(staging, site.repo_banner!));

    const proc = Bun.spawnSync(["zip", "-r", "-q", zipPath, "."], { cwd: staging, stdout: "ignore", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      const err = proc.stderr ? new TextDecoder().decode(proc.stderr) : "unknown error";
      throw new Error(`Failed to create archive: ${err.trim()}`);
    }
    const buffer = Buffer.from(readFileSync(zipPath));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    return { buffer, filename: `${slug}-repository-${stamp}.zip`, manifest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    try { rmSync(zipPath, { force: true }); } catch (_) {}
  }
}

const MAX_REPO_RESTORE_BYTES = 4 * 1024 * 1024 * 1024;

function stripSymlinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) unlinkSync(full);
    else if (entry.isDirectory()) stripSymlinks(full);
  }
}

// Replace a repository's contents with the archive's. Everything currently
// stored (including trash and history) is discarded first. Admin-only and
// step-up protected at the API layer.
export async function importRepoBackup(slug: string, archive: Buffer, actor?: string | null): Promise<RepoBackupManifest> {
  requireRepoSite(slug);
  if (archive.length > MAX_REPO_RESTORE_BYTES) throw new Error("Archive exceeds the 4 GB restore limit");
  const staging = join(tmpdir(), `hoster-repo-restore-${slug}-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    const zipFile = join(staging, "archive.zip");
    writeFileSync(zipFile, archive);
    const proc = Bun.spawnSync(["unzip", "-o", "-q", zipFile, "manifest.json", "repository.json", "objects/*", "banner.*", "-d", staging], { stdout: "ignore", stderr: "pipe" });
    rmSync(zipFile, { force: true });
    if (proc.exitCode !== 0 && !existsSync(join(staging, "manifest.json"))) {
      throw new Error("Archive could not be read (is it a repository backup?)");
    }
    stripSymlinks(staging);
    const manifestPath = join(staging, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("Not a repository backup: manifest.json is missing");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RepoBackupManifest;
    if (manifest.format !== "hoster-repository") throw new Error("Not a repository backup");
    const dataPath = join(staging, "repository.json");
    if (!existsSync(dataPath)) throw new Error("Archive is missing repository.json");
    const data = JSON.parse(readFileSync(dataPath, "utf8")) as { files: FileRow[]; versions: any[] };
    if (!Array.isArray(data.files) || !Array.isArray(data.versions)) throw new Error("repository.json is malformed");

    // Validate every path and blob reference before touching the live store.
    const objectsSrc = join(staging, "objects");
    const available = new Set<string>(existsSync(objectsSrc) ? readdirSync(objectsSrc).filter(n => /^[a-f0-9]{64}$/.test(n)) : []);
    const idMap = new Map<number, FileRow>();
    for (const f of data.files) {
      if (typeof f.id !== "number" || typeof f.path !== "string") throw new Error("repository.json has an invalid file row");
      if (f.kind !== "file" && f.kind !== "dir") throw new Error(`Invalid entry kind for '${f.path}'`);
      normalizeRepoPath(f.path);
      if (f.kind === "file" && f.sha256 && !available.has(f.sha256)) throw new Error(`Archive is missing content for '${f.path}'`);
      idMap.set(f.id, f);
    }
    for (const v of data.versions) {
      if (!idMap.has(v.file_id)) throw new Error("repository.json references an unknown file");
      if (typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256)) throw new Error("Invalid version hash");
      if (!available.has(v.sha256)) throw new Error(`Archive is missing a stored version of '${idMap.get(v.file_id)!.path}'`);
    }

    // Wipe and rebuild.
    const tx = db.transaction(() => {
      db.run("DELETE FROM repo_versions WHERE site_slug = ?", slug);
      db.run("DELETE FROM repo_files WHERE site_slug = ?", slug);
      db.run("DELETE FROM repo_blobs WHERE site_slug = ?", slug);
      const newIds = new Map<number, number>();
      for (const f of data.files) {
        const ins = db.run(
          `INSERT INTO repo_files (site_slug, path, kind, size, mime, sha256, version_no, created_at, updated_at, created_by, updated_by, deleted_at, deleted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          slug, f.path, f.kind, f.size || 0, f.mime || null, f.kind === "file" ? f.sha256 || null : null, f.version_no || 0,
          f.created_at || new Date().toISOString(), f.updated_at || new Date().toISOString(), f.created_by || null, f.updated_by || null,
          f.deleted_at || null, f.deleted_by || null
        );
        newIds.set(f.id, Number(ins.lastInsertRowid));
      }
      for (const v of data.versions) {
        db.run(
          `INSERT INTO repo_versions (file_id, site_slug, version_no, sha256, size, mime, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newIds.get(v.file_id), slug, v.version_no, v.sha256, v.size || 0, v.mime || null, v.note || null, v.created_at || new Date().toISOString(), v.created_by || null
        );
        blobRetain(slug, v.sha256, v.size || 0);
      }
    });

    // Copy objects in first so the DB never points at missing content.
    const objDir = objectsDir(slug);
    rmSync(objDir, { recursive: true, force: true });
    mkdirSync(objDir, { recursive: true });
    for (const sha of available) {
      const dest = blobPath(slug, sha);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(objectsSrc, sha), dest);
    }
    tx();
    // Fix blob sizes from disk (archive rows are trusted for structure, not for size).
    for (const sha of available) {
      try { db.run("UPDATE repo_blobs SET size = ? WHERE site_slug = ? AND sha256 = ?", statSync(blobPath(slug, sha)).size, slug, sha); } catch (_) {}
    }
    gcBlobs(slug);

    const bannerFile = readdirSync(staging).find(n => /^banner\.(png|jpg|webp|gif)$/.test(n));
    clearRepoBanner(slug);
    if (bannerFile) {
      try { setRepoBanner(slug, readFileSync(join(staging, bannerFile))); } catch (_) {}
    }
    syncSiteStats(slug);
    void actor;
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Used by the platform-wide backup to know which directories to include.
export function listRepositorySlugs(): string[] {
  return (db.query("SELECT slug FROM sites WHERE site_type = 'repository'").all() as { slug: string }[]).map(r => r.slug);
}
