// Hoster CMS — global library storage
//
// The CMS JS + CSS lib is stored in SQLite (table `cms_lib_files`) and served
// from a universal URL `/_cms/<file>` that works on every host — canonical or
// host-aliased. All sites with the CMS feature enabled point their template
// pages at this same URL.
//
// Why DB-backed instead of per-site files?
//   • One source of truth — update once, every CMS site picks it up immediately.
//   • Editable from the admin UI without redeploying anything.
//   • Survives binary upgrades; "Reset to defaults" pulls the bundled copy back.
//
// Bootstrap: on first startup (empty table) we seed from the bundled CMS_LIB_JS
// and CMS_LIB_CSS constants. After that the DB is authoritative.

import db from "./db";
import { CMS_LIB_JS, CMS_LIB_CSS, CMS_LIB_VERSION } from "./cms-scaffold";
import { createHash } from "crypto";

db.exec(`
  CREATE TABLE IF NOT EXISTS cms_lib_files (
    path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    version TEXT NOT NULL,
    etag TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

export interface CmsLibFile {
  path: string;
  content: string;
  version: string;
  etag: string;
  updated_at: string;
  size: number;
}

interface CmsLibFileRow {
  path: string;
  content: string;
  version: string;
  etag: string;
  updated_at: string;
}

const CONTENT_TYPES: Record<string, string> = {
  "cms.js": "application/javascript; charset=utf-8",
  "cms.css": "text/css; charset=utf-8",
};

// Files seeded from bundled constants on first run.
interface BundledFile {
  path: string;
  content: string;
}
const BUNDLED: BundledFile[] = [
  { path: "cms.js", content: CMS_LIB_JS },
  { path: "cms.css", content: CMS_LIB_CSS },
];

function computeEtag(content: string, version: string): string {
  const hash = createHash("sha256").update(content).digest("hex").substring(0, 16);
  return `W/"${version}-${hash}"`;
}

function rowToFile(row: CmsLibFileRow): CmsLibFile {
  return {
    path: row.path,
    content: row.content,
    version: row.version,
    etag: row.etag,
    updated_at: row.updated_at,
    size: Buffer.byteLength(row.content, "utf-8"),
  };
}

// One-shot bootstrap. Idempotent — only inserts rows that are missing.
export function bootstrapCmsLib(): void {
  for (const f of BUNDLED) {
    const existing = db.query("SELECT 1 FROM cms_lib_files WHERE path = ?").get(f.path) as { 1: number } | null;
    if (existing) continue;
    const etag = computeEtag(f.content, CMS_LIB_VERSION);
    db.run(
      "INSERT INTO cms_lib_files (path, content, version, etag, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      f.path, f.content, CMS_LIB_VERSION, etag
    );
  }
}

// Run at import time so any cold start has a populated lib.
bootstrapCmsLib();

export function listCmsLibFiles(): CmsLibFile[] {
  const rows = db.query("SELECT * FROM cms_lib_files ORDER BY path").all() as CmsLibFileRow[];
  return rows.map(rowToFile);
}

export function getCmsLibFile(path: string): CmsLibFile | null {
  const row = db.query("SELECT * FROM cms_lib_files WHERE path = ?").get(path) as CmsLibFileRow | null;
  return row ? rowToFile(row) : null;
}

const KNOWN_PATHS = new Set(BUNDLED.map(b => b.path));

// Update one file's content. Path must be one of the known bundled paths —
// arbitrary file creation is not supported (would just inflate URL surface).
// `version` is whatever string the caller wants to stamp it with; the admin
// UI bumps a build number, but any non-empty string works.
export function updateCmsLibFile(path: string, content: string, version?: string): CmsLibFile {
  if (!KNOWN_PATHS.has(path)) {
    throw new Error(`Unknown CMS lib file: ${path}`);
  }
  // Soft cap to keep an accidental paste from filling the DB. 2 MB is far
  // beyond any realistic vanilla-JS lib + plenty of room for embedded data.
  if (Buffer.byteLength(content, "utf-8") > 2 * 1024 * 1024) {
    throw new Error("Content exceeds 2 MB limit");
  }
  const v = (version || CMS_LIB_VERSION).trim() || CMS_LIB_VERSION;
  const etag = computeEtag(content, v);
  db.run(
    "UPDATE cms_lib_files SET content = ?, version = ?, etag = ?, updated_at = datetime('now') WHERE path = ?",
    content, v, etag, path
  );
  return getCmsLibFile(path)!;
}

// Restore the bundled default for a single file (or all if path is omitted).
export function resetCmsLibFile(path?: string): CmsLibFile[] {
  const targets = path ? BUNDLED.filter(b => b.path === path) : BUNDLED;
  if (!targets.length) throw new Error(`Unknown CMS lib file: ${path}`);
  const updated: CmsLibFile[] = [];
  for (const f of targets) {
    const etag = computeEtag(f.content, CMS_LIB_VERSION);
    db.run(
      "UPDATE cms_lib_files SET content = ?, version = ?, etag = ?, updated_at = datetime('now') WHERE path = ?",
      f.content, CMS_LIB_VERSION, etag, f.path
    );
    const file = getCmsLibFile(f.path);
    if (file) updated.push(file);
  }
  return updated;
}

// Build the HTTP response for a `/_cms/<file>` request. Returns 404 if the
// file isn't registered, or 304 if the client's If-None-Match matches.
export function serveCmsLibFile(req: Request, path: string): Response {
  const file = getCmsLibFile(path);
  if (!file) {
    return new Response("Not found", { status: 404 });
  }
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === file.etag) {
    return new Response(null, { status: 304, headers: { "ETag": file.etag } });
  }
  return new Response(file.content, {
    headers: {
      "Content-Type": CONTENT_TYPES[path] || "text/plain; charset=utf-8",
      // The ETag changes whenever content changes; clients revalidate on every
      // request and get a 304 when unchanged. That's the right caching mode
      // for a library that can be hand-edited and needs to pick up edits fast.
      "Cache-Control": "public, max-age=0, must-revalidate",
      "ETag": file.etag,
      "Content-Length": String(file.size),
    },
  });
}

export function cmsLibPaths(): string[] {
  return Array.from(KNOWN_PATHS);
}
