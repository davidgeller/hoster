import db from "./db";
import { mkdirSync, rmSync, existsSync, readdirSync, statSync, symlinkSync, readlinkSync, unlinkSync, realpathSync, lstatSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { dirname } from "path";
const BASE_DIR = process.env.HOSTER_HOME || dirname(process.execPath);
export const SITES_DIR = join(BASE_DIR, "sites");
mkdirSync(SITES_DIR, { recursive: true });

export interface Site {
  id: number;
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
  size_bytes: number;
  file_count: number;
  active: number;
  current_version: string | null;
  root_dir: string | null;  // e.g. "browser" for Angular apps
  spa: number;              // 1 = SPA mode (fallback to index.html)
  mcp_enabled: number;      // 1 = MCP file access enabled
  mcp_read_only: number;    // 1 = MCP can only read, not write/delete
  mcp_auto_commit: number;  // 1 = snapshot current version before first MCP write
}

export interface SiteVersion {
  id: number;
  site_slug: string;
  version: string;
  label: string | null;
  size_bytes: number;
  file_count: number;
  created_at: string;
  mcp_modified: number;     // 1 = at least one MCP write/delete has touched this version
}

// Ensure version tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS site_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_slug TEXT NOT NULL,
    version TEXT NOT NULL,
    label TEXT,
    size_bytes INTEGER DEFAULT 0,
    file_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(site_slug, version),
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );
`);

// Ensure alias table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS site_aliases (
    alias TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );
`);

// Ensure host alias table exists (maps incoming Host header -> site slug)
db.exec(`
  CREATE TABLE IF NOT EXISTS host_aliases (
    host TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );
`);

// Add columns if not present
try { db.exec("ALTER TABLE sites ADD COLUMN current_version TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN root_dir TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN spa INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN mcp_enabled INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN mcp_read_only INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN mcp_auto_commit INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE site_versions ADD COLUMN mcp_modified INTEGER DEFAULT 0"); } catch (_) {}

// --- Site config cache (avoids DB + filesystem hits on every request) ---
const siteCache = new Map<string, { site: Site; ts: number }>();
const SITE_CACHE_TTL = 60_000; // 60 seconds

export function invalidateSiteCache(slug?: string): void {
  if (slug) {
    siteCache.delete(slug);
  } else {
    siteCache.clear();
  }
}

export function listSites(): Site[] {
  return db.query("SELECT * FROM sites ORDER BY name").all() as Site[];
}

export function getSite(slug: string): Site | null {
  const now = Date.now();
  const cached = siteCache.get(slug);
  if (cached && now - cached.ts < SITE_CACHE_TTL) {
    return cached.site;
  }
  const site = db.query("SELECT * FROM sites WHERE slug = ?").get(slug) as Site | null;
  if (site) {
    siteCache.set(slug, { site, ts: now });
  } else {
    siteCache.delete(slug);
  }
  return site;
}

export function listVersions(slug: string): SiteVersion[] {
  return db.query(
    "SELECT * FROM site_versions WHERE site_slug = ? ORDER BY created_at DESC"
  ).all(slug) as SiteVersion[];
}

function calcDirStats(dir: string): { size: number; count: number } {
  let size = 0;
  let count = 0;
  function walk(d: string) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        size += statSync(full).size;
        count++;
      }
    }
  }
  walk(dir);
  return { size, count };
}

function removeSymlinks(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      unlinkSync(full);
    } else if (entry.isDirectory()) {
      removeSymlinks(full);
    }
  }
}

function verifyNoEscape(dir: string): void {
  const realDir = realpathSync(dir);
  function walk(d: string) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      const realPath = realpathSync(full);
      if (!realPath.startsWith(realDir)) {
        rmSync(full, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  }
  walk(dir);
}

// Recursively search for the shallowest directory containing index.html
// Returns the relative path from baseDir, or null if not found
// Prefers well-known directory names at each level (browser, dist, build, etc.)
function findIndexHtmlRoot(baseDir: string, dir: string, maxDepth = 4): string | null {
  if (maxDepth <= 0) return null;
  const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith("_"));

  // Prioritize well-known build output directories
  const preferred = ["browser", "dist", "build", "public", "out", "www"];
  const sorted = entries.sort((a, b) => {
    const ai = preferred.indexOf(a.name);
    const bi = preferred.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  // First pass: check immediate children for index.html
  for (const entry of sorted) {
    const candidate = join(dir, entry.name);
    if (existsSync(join(candidate, "index.html"))) {
      const relative = candidate.slice(baseDir.length + 1); // strip baseDir/ prefix
      return relative;
    }
  }

  // Second pass: recurse into subdirectories
  for (const entry of sorted) {
    const candidate = join(dir, entry.name);
    const found = findIndexHtmlRoot(baseDir, candidate, maxDepth - 1);
    if (found) return found;
  }

  return null;
}

function generateVersion(): string {
  const now = new Date();
  return now.toISOString().replace(/[-:T]/g, "").replace(/\..+/, ""); // 20260311143022
}

function updateCurrentSymlink(slug: string, version: string) {
  const siteDir = join(SITES_DIR, slug);
  const currentLink = join(siteDir, "_current");
  const versionDir = join(siteDir, version);

  if (existsSync(currentLink)) {
    unlinkSync(currentLink);
  }
  symlinkSync(versionDir, currentLink);
}

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

function validateSlug(slug: string): void {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error("Slug must be lowercase alphanumeric with hyphens, not starting/ending with hyphen");
  }
  if (slug.startsWith("_")) {
    throw new Error("Slugs starting with _ are reserved");
  }
}

const BLANK_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Site</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #333; }
    .card { background: #fff; padding: 32px 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); max-width: 520px; text-align: center; }
    h1 { font-weight: 400; margin: 0 0 8px; }
    p { color: #666; line-height: 1.5; margin: 8px 0; }
    code { background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Ready for content</h1>
    <p>This site is blank. Connect an AI tool via MCP to generate its structure, or upload a ZIP to deploy a new version.</p>
  </div>
</body>
</html>
`;

export function createBlankSite(slug: string, name: string): { site: Site; version: SiteVersion } {
  validateSlug(slug);

  if (getSite(slug)) {
    throw new Error(`Site '${slug}' already exists`);
  }

  const version = generateVersion();
  const siteDir = join(SITES_DIR, slug);
  const versionDir = join(siteDir, version);

  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "index.html"), BLANK_INDEX_HTML, "utf-8");

  const stats = { size: Buffer.byteLength(BLANK_INDEX_HTML, "utf-8"), count: 1 };

  db.run(`
    INSERT INTO sites (slug, name, size_bytes, file_count, current_version, root_dir, spa, mcp_enabled, mcp_read_only, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, datetime('now'))
  `, slug, name, stats.size, stats.count, version);

  db.run(`
    INSERT INTO site_versions (site_slug, version, label, size_bytes, file_count)
    VALUES (?, ?, ?, ?, ?)
  `, slug, version, "Blank site", stats.size, stats.count);

  updateCurrentSymlink(slug, version);
  invalidateSiteCache(slug);

  return { site: getSite(slug)!, version: getVersion(slug, version)! };
}

export async function deploySite(slug: string, name: string, zipBuffer: ArrayBuffer, label?: string): Promise<{ site: Site; version: SiteVersion }> {
  validateSlug(slug);
  if (zipBuffer.byteLength > MAX_UPLOAD_SIZE) {
    throw new Error("Upload exceeds maximum size of 500 MB");
  }

  const version = generateVersion();
  const siteDir = join(SITES_DIR, slug);
  const versionDir = join(siteDir, version);
  const stagingDir = join(siteDir, `_staging_${version}`);

  mkdirSync(stagingDir, { recursive: true });

  // Extract zip into staging directory first
  const tmpZip = join(stagingDir, "__upload.zip");
  await Bun.write(tmpZip, zipBuffer);

  const proc = Bun.spawn(["unzip", "-o", tmpZip, "-d", stagingDir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  rmSync(tmpZip);

  // Security: remove any symlinks that might have been in the zip
  removeSymlinks(stagingDir);

  // Security: verify no files escaped the staging directory (zip slip via ../ entries)
  verifyNoEscape(stagingDir);

  // Check if zip contained a single root folder — hoist its contents
  const entries = readdirSync(stagingDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const innerDir = join(stagingDir, entries[0].name);
    const innerEntries = readdirSync(innerDir);
    for (const e of innerEntries) {
      Bun.spawnSync(["mv", join(innerDir, e), join(stagingDir, e)]);
    }
    rmSync(innerDir, { recursive: true });
  }

  // Calculate stats
  const stats = calcDirStats(stagingDir);

  // Validated — move staging to final version directory (atomic rename)
  Bun.spawnSync(["mv", stagingDir, versionDir]);

  // Auto-detect root directory by finding index.html recursively
  // Handles varying zip structures like browser/, dist/browser/, dashboard_pwa/browser/, etc.
  let detectedRoot: string | null = null;
  let detectedSpa = 0;
  const topIndex = join(versionDir, "index.html");
  if (!existsSync(topIndex)) {
    detectedRoot = findIndexHtmlRoot(versionDir, versionDir);
  }

  // Auto-detect SPA: look for JS bundles (Angular, React, Vue)
  if (detectedRoot || existsSync(topIndex)) {
    const checkDir = detectedRoot ? join(versionDir, detectedRoot) : versionDir;
    const files = readdirSync(checkDir);
    const hasJsBundle = files.some(f => /^(main|chunk|polyfills|vendor|runtime)[\w.-]*\.js$/.test(f));
    if (hasJsBundle) detectedSpa = 1;
  }

  // For existing sites: always re-detect root_dir (zip structure may change between versions)
  // but preserve SPA setting since the user may have set it manually
  const existing = getSite(slug);
  const rootDir = detectedRoot;
  const spa = existing?.spa ?? detectedSpa;

  // Upsert site record
  db.run(`
    INSERT INTO sites (slug, name, size_bytes, file_count, current_version, root_dir, spa, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      size_bytes = excluded.size_bytes,
      file_count = excluded.file_count,
      current_version = excluded.current_version,
      root_dir = excluded.root_dir,
      spa = excluded.spa,
      updated_at = datetime('now')
  `, slug, name, stats.size, stats.count, version, rootDir, spa);

  // Insert version record
  db.run(`
    INSERT INTO site_versions (site_slug, version, label, size_bytes, file_count)
    VALUES (?, ?, ?, ?, ?)
  `, slug, version, label || null, stats.size, stats.count);

  // Point _current symlink to this version
  updateCurrentSymlink(slug, version);
  invalidateSiteCache(slug);

  return { site: getSite(slug)!, version: getVersion(slug, version)! };
}

export function getVersion(slug: string, version: string): SiteVersion | null {
  return db.query(
    "SELECT * FROM site_versions WHERE site_slug = ? AND version = ?"
  ).get(slug, version) as SiteVersion | null;
}

export function switchVersion(slug: string, version: string): boolean {
  const v = getVersion(slug, version);
  if (!v) return false;

  const versionDir = join(SITES_DIR, slug, version);
  if (!existsSync(versionDir)) return false;

  updateCurrentSymlink(slug, version);

  const stats = calcDirStats(versionDir);
  db.run(
    "UPDATE sites SET current_version = ?, size_bytes = ?, file_count = ?, updated_at = datetime('now') WHERE slug = ?",
    version, stats.size, stats.count, slug
  );
  invalidateSiteCache(slug);
  return true;
}

// Freeze the current working version (optionally labeling it) and fork a new
// mutable copy. _current is pointed at the new copy so subsequent edits do not
// touch the frozen snapshot.
export function commitVersion(slug: string, label?: string | null): SiteVersion | null {
  const site = getSite(slug);
  if (!site || !site.current_version) return null;

  const currentVersionId = site.current_version;
  const currentDir = join(SITES_DIR, slug, currentVersionId);
  if (!existsSync(currentDir)) return null;

  // Update the label on the version being frozen (only if the caller supplied one).
  if (label && label.trim()) {
    db.run(
      "UPDATE site_versions SET label = ? WHERE site_slug = ? AND version = ?",
      label.trim(), slug, currentVersionId
    );
  }

  // Refresh stats on the frozen version (may have drifted from in-place MCP writes).
  const frozenStats = calcDirStats(currentDir);
  db.run(
    "UPDATE site_versions SET size_bytes = ?, file_count = ? WHERE site_slug = ? AND version = ?",
    frozenStats.size, frozenStats.count, slug, currentVersionId
  );

  // Fork a new version as a copy of the frozen one. Portable across macOS/Linux;
  // sites are small so full copy is acceptable. Optimize to CoW/hardlinks later.
  const newVersion = generateVersion();
  const newDir = join(SITES_DIR, slug, newVersion);
  const cp = Bun.spawnSync(["cp", "-R", currentDir, newDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (cp.exitCode !== 0) {
    const err = cp.stderr ? new TextDecoder().decode(cp.stderr) : "unknown error";
    throw new Error(`Failed to snapshot version: ${err.trim()}`);
  }

  db.run(
    `INSERT INTO site_versions (site_slug, version, label, size_bytes, file_count, mcp_modified)
     VALUES (?, ?, NULL, ?, ?, 0)`,
    slug, newVersion, frozenStats.size, frozenStats.count
  );

  updateCurrentSymlink(slug, newVersion);
  db.run(
    "UPDATE sites SET current_version = ?, updated_at = datetime('now') WHERE slug = ?",
    newVersion, slug
  );
  invalidateSiteCache(slug);

  return getVersion(slug, newVersion);
}

// Set mcp_modified=1 on a specific version. Called after successful MCP writes/deletes.
export function markVersionModified(slug: string, version: string): void {
  db.run(
    "UPDATE site_versions SET mcp_modified = 1 WHERE site_slug = ? AND version = ?",
    slug, version
  );
}

export function deleteVersion(slug: string, version: string): boolean {
  const site = getSite(slug);
  if (!site) return false;

  // Don't delete the current version
  if (site.current_version === version) {
    throw new Error("Cannot delete the active version. Switch to another version first.");
  }

  const versionDir = join(SITES_DIR, slug, version);
  if (existsSync(versionDir)) {
    rmSync(versionDir, { recursive: true });
  }
  db.run("DELETE FROM site_versions WHERE site_slug = ? AND version = ?", slug, version);
  return true;
}

export function deleteSite(slug: string): boolean {
  const site = getSite(slug);
  if (!site) return false;

  const siteDir = join(SITES_DIR, slug);
  if (existsSync(siteDir)) {
    rmSync(siteDir, { recursive: true });
  }
  db.run("DELETE FROM sites WHERE slug = ?", slug);
  db.run("DELETE FROM site_versions WHERE site_slug = ?", slug);
  db.run("DELETE FROM site_aliases WHERE site_slug = ?", slug);
  db.run("DELETE FROM host_aliases WHERE site_slug = ?", slug);
  db.run("DELETE FROM requests WHERE site_slug = ?", slug);
  invalidateSiteCache(slug);
  invalidateHostAliasCache();
  return true;
}

export function toggleSite(slug: string, active: boolean): boolean {
  const result = db.run("UPDATE sites SET active = ? WHERE slug = ?", active ? 1 : 0, slug);
  invalidateSiteCache(slug);
  return result.changes > 0;
}

export function updateSiteSettings(
  slug: string, rootDir: string | null, spa: boolean,
  mcpEnabled?: boolean, mcpReadOnly?: boolean, mcpAutoCommit?: boolean
): boolean {
  if (rootDir) {
    if (rootDir.includes("..") || rootDir.startsWith("/") || rootDir.includes("\0")) {
      throw new Error("Invalid root directory path");
    }
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(rootDir)) {
      throw new Error("Root directory contains invalid characters");
    }
  }
  const result = db.run(
    `UPDATE sites SET root_dir = ?, spa = ?,
      mcp_enabled = COALESCE(?, mcp_enabled),
      mcp_read_only = COALESCE(?, mcp_read_only),
      mcp_auto_commit = COALESCE(?, mcp_auto_commit),
      updated_at = datetime('now')
    WHERE slug = ?`,
    rootDir, spa ? 1 : 0,
    mcpEnabled !== undefined ? (mcpEnabled ? 1 : 0) : null,
    mcpReadOnly !== undefined ? (mcpReadOnly ? 1 : 0) : null,
    mcpAutoCommit !== undefined ? (mcpAutoCommit ? 1 : 0) : null,
    slug
  );
  invalidateSiteCache(slug);
  return result.changes > 0;
}

// Cache resolved real paths for site directories (cleared on deploy/switch/delete)
const realPathCache = new Map<string, { realPath: string; ts: number }>();

function getCachedRealPath(dir: string): string {
  const now = Date.now();
  const cached = realPathCache.get(dir);
  if (cached && now - cached.ts < SITE_CACHE_TTL) return cached.realPath;
  const realPath = realpathSync(dir);
  realPathCache.set(dir, { realPath, ts: now });
  return realPath;
}

export interface ResolvedSite {
  filePath: string;
  version: string | null;
}

export function resolveSitePath(slug: string, filePath: string): ResolvedSite | null {
  const site = getSite(slug);
  if (!site || !site.active) return null;

  const siteDir = join(SITES_DIR, slug, "_current");
  if (!existsSync(siteDir)) return null;

  // If site has a root_dir (e.g. "browser"), serve files from that subdirectory
  const contentDir = site.root_dir ? join(siteDir, site.root_dir) : siteDir;
  if (!existsSync(contentDir)) return null;

  let resolved = resolve(contentDir, filePath);

  // Security: prevent path traversal (check both logical and real paths)
  const realSiteDir = resolve(SITES_DIR, slug);
  if (!resolved.startsWith(realSiteDir)) return null;

  // Cache the realpath of the site dir — it's the same for all files in this site
  const realSiteDirResolved = getCachedRealPath(realSiteDir);

  const ver = site.current_version || null;

  // Try exact file
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    const realPath = realpathSync(resolved);
    if (!realPath.startsWith(realSiteDirResolved)) return null;
    return { filePath: resolved, version: ver };
  }

  // Try with index.html for directories
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const index = join(resolved, "index.html");
    if (existsSync(index)) {
      const realPath = realpathSync(index);
      if (realPath.startsWith(realSiteDirResolved)) return { filePath: index, version: ver };
    }
  }

  // Try appending .html
  const htmlPath = resolved + ".html";
  if (existsSync(htmlPath)) {
    const realPath = realpathSync(htmlPath);
    if (realPath.startsWith(realSiteDirResolved)) return { filePath: htmlPath, version: ver };
  }

  // SPA fallback: serve index.html for any unmatched route
  if (site.spa) {
    const spaIndex = join(contentDir, "index.html");
    if (existsSync(spaIndex)) return { filePath: spaIndex, version: ver };
  }

  return null;
}

// --- File bundle listing ---

export interface SiteFile {
  path: string;
  size: number;
  modified: string;
}

export function listSiteFiles(slug: string): SiteFile[] {
  const site = getSite(slug);
  if (!site || !site.current_version) return [];

  const versionDir = join(SITES_DIR, slug, site.current_version);
  if (!existsSync(versionDir)) return [];

  const files: SiteFile[] = [];
  function walk(dir: string, prefix: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const st = statSync(full);
        files.push({
          path: rel,
          size: st.size,
          modified: st.mtime.toISOString(),
        });
      }
    }
  }
  walk(versionDir, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// --- Reload site from disk (clear all caches, recalculate stats) ---

export function reloadSite(slug: string): boolean {
  const site = getSite(slug);
  if (!site || !site.current_version) return false;

  const versionDir = join(SITES_DIR, slug, site.current_version);
  if (!existsSync(versionDir)) return false;

  // Clear all caches
  invalidateSiteCache(slug);
  // Clear realpath cache entries for this site
  const sitePrefix = join(SITES_DIR, slug);
  for (const key of realPathCache.keys()) {
    if (key.startsWith(sitePrefix)) {
      realPathCache.delete(key);
    }
  }

  // Recalculate stats from disk
  const stats = calcDirStats(versionDir);

  // Update DB with fresh stats
  db.run(
    "UPDATE sites SET size_bytes = ?, file_count = ?, updated_at = datetime('now') WHERE slug = ?",
    stats.size, stats.count, slug
  );

  // Also update the version record
  db.run(
    "UPDATE site_versions SET size_bytes = ?, file_count = ? WHERE site_slug = ? AND version = ?",
    stats.size, stats.count, slug, site.current_version
  );

  // Re-verify the _current symlink points to the right place
  const currentLink = join(SITES_DIR, slug, "_current");
  if (existsSync(currentLink)) {
    try {
      const target = readlinkSync(currentLink);
      const expectedTarget = versionDir;
      // If symlink is broken or points elsewhere, fix it
      if (!existsSync(currentLink) || realpathSync(currentLink) !== realpathSync(expectedTarget)) {
        unlinkSync(currentLink);
        symlinkSync(versionDir, currentLink);
      }
    } catch {
      // Symlink is broken — recreate it
      try { unlinkSync(currentLink); } catch {}
      symlinkSync(versionDir, currentLink);
    }
  } else {
    symlinkSync(versionDir, currentLink);
  }

  // Clear the site cache again so next request gets fresh DB data
  invalidateSiteCache(slug);

  return true;
}

// --- Site aliases ---

export function resolveAlias(slug: string): string {
  const row = db.query("SELECT site_slug FROM site_aliases WHERE alias = ?").get(slug) as { site_slug: string } | null;
  return row ? row.site_slug : slug;
}

export function getAliases(siteSlug: string): string[] {
  const rows = db.query("SELECT alias FROM site_aliases WHERE site_slug = ? ORDER BY alias").all(siteSlug) as { alias: string }[];
  return rows.map(r => r.alias);
}

export function addAlias(alias: string, siteSlug: string): void {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(alias)) {
    throw new Error("Alias must be lowercase alphanumeric with hyphens, not starting/ending with hyphen");
  }
  if (alias.startsWith("_")) {
    throw new Error("Aliases starting with _ are reserved");
  }
  // Don't allow alias that conflicts with an existing site slug
  const existing = getSite(alias);
  if (existing) {
    throw new Error(`Cannot create alias '${alias}' — a site with that slug already exists`);
  }
  db.run("INSERT INTO site_aliases (alias, site_slug) VALUES (?, ?)", alias, siteSlug);
}

export function removeAlias(alias: string, siteSlug: string): boolean {
  const result = db.run("DELETE FROM site_aliases WHERE alias = ? AND site_slug = ?", alias, siteSlug);
  return result.changes > 0;
}

// --- Host aliases (custom domain -> site slug) ---

// Normalize a Host header value: lowercase, strip port, strip IPv6 brackets.
// Returns "" for missing/empty input. Does not validate — that's a separate step.
export function normalizeHost(hostHeader: string | null | undefined): string {
  if (!hostHeader) return "";
  let h = hostHeader.toLowerCase().trim();
  if (!h) return "";
  if (h.startsWith("[")) {
    // IPv6: [::1]:8080 -> ::1, [::1] -> ::1
    const close = h.indexOf("]");
    if (close === -1) return "";
    h = h.substring(1, close);
  } else {
    // host:port -> host. Bare hosts without ":" are unaffected.
    const colon = h.lastIndexOf(":");
    if (colon !== -1) h = h.substring(0, colon);
  }
  return h;
}

// Validate a host alias: lowercase DNS hostname with at least one dot,
// labels start/end with alphanumeric (no leading/trailing hyphens), max 253 chars.
// Bare IPs and "localhost" are rejected by design — host aliases are for custom
// domains, not the canonical hostname.
const HOST_ALIAS_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export function validateHostAlias(host: string): string {
  const normalized = host.toLowerCase().trim();
  if (!normalized) throw new Error("Host is required");
  if (normalized.length > 253) throw new Error("Host exceeds 253 characters");
  if (!HOST_ALIAS_PATTERN.test(normalized)) {
    throw new Error("Host must be a valid domain (e.g. example.com), lowercase, no underscores or leading/trailing hyphens");
  }
  return normalized;
}

// In-memory cache of host -> slug mapping. Invalidated on any write.
let hostAliasCache: Map<string, string> | null = null;
const hostAliasCacheLock = { ts: 0 };
const HOST_ALIAS_CACHE_TTL = 60_000;

function loadHostAliasCache(): Map<string, string> {
  const rows = db.query("SELECT host, site_slug FROM host_aliases").all() as { host: string; site_slug: string }[];
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.host, r.site_slug);
  return map;
}

export function invalidateHostAliasCache(): void {
  hostAliasCache = null;
  hostAliasCacheLock.ts = 0;
}

// Look up a normalized host. Returns the target site slug, or null if no match.
export function resolveHostAlias(host: string): string | null {
  if (!host) return null;
  const now = Date.now();
  if (!hostAliasCache || now - hostAliasCacheLock.ts > HOST_ALIAS_CACHE_TTL) {
    hostAliasCache = loadHostAliasCache();
    hostAliasCacheLock.ts = now;
  }
  return hostAliasCache.get(host) || null;
}

export function listAllHostAliases(): { host: string; site_slug: string; created_at: string }[] {
  return db.query("SELECT host, site_slug, created_at FROM host_aliases ORDER BY host")
    .all() as { host: string; site_slug: string; created_at: string }[];
}

export function getHostAliases(siteSlug: string): string[] {
  const rows = db.query("SELECT host FROM host_aliases WHERE site_slug = ? ORDER BY host")
    .all(siteSlug) as { host: string }[];
  return rows.map(r => r.host);
}

export function addHostAlias(host: string, siteSlug: string): string {
  const normalized = validateHostAlias(host);
  const site = getSite(siteSlug);
  if (!site) {
    throw new Error(`Site '${siteSlug}' does not exist`);
  }
  // Reject collisions across all sites (PRIMARY KEY also enforces this, but a
  // friendlier error tells the admin which site already owns the host).
  const existing = db.query("SELECT site_slug FROM host_aliases WHERE host = ?")
    .get(normalized) as { site_slug: string } | null;
  if (existing) {
    if (existing.site_slug === siteSlug) {
      throw new Error(`Host '${normalized}' is already aliased to this site`);
    }
    throw new Error(`Host '${normalized}' is already aliased to site '${existing.site_slug}'`);
  }
  db.run("INSERT INTO host_aliases (host, site_slug) VALUES (?, ?)", normalized, siteSlug);
  invalidateHostAliasCache();
  return normalized;
}

export function removeHostAlias(host: string, siteSlug: string): boolean {
  const normalized = host.toLowerCase().trim();
  const result = db.run(
    "DELETE FROM host_aliases WHERE host = ? AND site_slug = ?",
    normalized, siteSlug
  );
  if (result.changes > 0) invalidateHostAliasCache();
  return result.changes > 0;
}

// --- Site health: detecting and repairing broken state ---
//
// A site is "broken" when its on-disk layout doesn't match what the DB says.
// Typical causes: a restore that stripped the _current symlink (zip-slip
// defense also strips legitimate _current), a manual rm of a version dir,
// or an interrupted deploy.

export type SiteHealthStatus =
  | "ok"
  | "no_current_version"     // DB has no current_version recorded
  | "missing_version_dir"    // current_version is set but its directory is gone
  | "missing_current_link"   // version dir exists but _current symlink is gone
  | "wrong_current_link";    // _current points at a different version than DB says

export interface SiteHealth {
  slug: string;
  status: SiteHealthStatus;
  current_version: string | null;
  detail: string;
}

// Check whether a site's on-disk state matches the DB. Pure inspection — no writes.
export function checkSiteHealth(slug: string): SiteHealth {
  const site = getSite(slug);
  if (!site) {
    return { slug, status: "missing_version_dir", current_version: null, detail: "site not in database" };
  }
  if (!site.current_version) {
    return { slug, status: "no_current_version", current_version: null, detail: "DB has no current_version recorded" };
  }
  const versionDir = join(SITES_DIR, slug, site.current_version);
  if (!existsSync(versionDir)) {
    return { slug, status: "missing_version_dir", current_version: site.current_version, detail: `version directory missing: ${site.current_version}` };
  }
  const currentLink = join(SITES_DIR, slug, "_current");
  if (!existsSync(currentLink)) {
    return { slug, status: "missing_current_link", current_version: site.current_version, detail: "_current symlink missing" };
  }
  try {
    const target = realpathSync(currentLink);
    const expected = realpathSync(versionDir);
    if (target !== expected) {
      return { slug, status: "wrong_current_link", current_version: site.current_version, detail: `_current points at ${target}, expected ${expected}` };
    }
  } catch {
    return { slug, status: "missing_current_link", current_version: site.current_version, detail: "_current symlink unreadable" };
  }
  return { slug, status: "ok", current_version: site.current_version, detail: "" };
}

export function isSiteBroken(slug: string): boolean {
  return checkSiteHealth(slug).status !== "ok";
}

export interface RebuildResult {
  repaired: string[];        // slugs whose _current was (re)created or corrected
  warnings: string[];        // human-readable messages for sites that can't be repaired
  ok: string[];              // slugs that were already healthy
}

// Walk every site in the DB and (re)create the _current symlink to point at
// the version recorded as current. Idempotent: skips sites that are already
// correct. Use case: after restoreBackup strips all symlinks, after manual
// filesystem fixes, or as a self-heal at startup.
//
// Security: only creates symlinks whose target is a real subdirectory of the
// same site's directory. Never follows or creates anything that escapes
// SITES_DIR/<slug>/. The version name is validated against the directory
// listing — we don't trust the DB value as a free-form path.
export function rebuildCurrentSymlinks(): RebuildResult {
  const result: RebuildResult = { repaired: [], warnings: [], ok: [] };
  const sites = db.query("SELECT slug, current_version FROM sites").all() as { slug: string; current_version: string | null }[];

  for (const row of sites) {
    const { slug, current_version } = row;

    if (!current_version) {
      result.warnings.push(`Site '${slug}': no current version recorded in database`);
      continue;
    }

    const siteDir = join(SITES_DIR, slug);
    if (!existsSync(siteDir)) {
      result.warnings.push(`Site '${slug}': site directory missing entirely`);
      continue;
    }

    // Verify the named version is a real subdirectory — guards against the
    // DB ever storing something like "../etc/passwd". Pull the directory
    // listing and confirm the value is one of its entries.
    const entries = readdirSync(siteDir, { withFileTypes: true });
    const versionEntry = entries.find(e => e.isDirectory() && e.name === current_version);
    if (!versionEntry) {
      result.warnings.push(`Site '${slug}': version directory '${current_version}' is missing on disk`);
      continue;
    }

    const versionDir = join(siteDir, current_version);
    const currentLink = join(siteDir, "_current");

    // Quick health check first so we don't pointlessly re-create a valid link.
    const health = checkSiteHealth(slug);
    if (health.status === "ok") {
      result.ok.push(slug);
      continue;
    }

    // Remove whatever's there (broken symlink, wrong-target symlink, or — in
    // a malicious-archive corner case — a regular file or directory). lstat
    // so we don't follow into the target.
    if (existsSync(currentLink) || (() => { try { lstatSync(currentLink); return true; } catch { return false; } })()) {
      try {
        const st = lstatSync(currentLink);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          rmSync(currentLink, { recursive: true });
        } else {
          unlinkSync(currentLink);
        }
      } catch {
        // Already gone or unreadable; carry on to create fresh symlink.
      }
    }

    try {
      symlinkSync(versionDir, currentLink);
      result.repaired.push(slug);
      invalidateSiteCache(slug);
    } catch (e: any) {
      result.warnings.push(`Site '${slug}': failed to create _current symlink: ${e?.message || e}`);
    }
  }

  return result;
}
