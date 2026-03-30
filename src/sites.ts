import db from "./db";
import { mkdirSync, rmSync, existsSync, readdirSync, statSync, symlinkSync, readlinkSync, unlinkSync, realpathSync, lstatSync } from "fs";
import { join, resolve } from "path";

import { dirname } from "path";
const BASE_DIR = dirname(process.execPath);
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
}

export interface SiteVersion {
  id: number;
  site_slug: string;
  version: string;
  label: string | null;
  size_bytes: number;
  file_count: number;
  created_at: string;
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

// Add columns if not present
try { db.exec("ALTER TABLE sites ADD COLUMN current_version TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN root_dir TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN spa INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN mcp_enabled INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sites ADD COLUMN mcp_read_only INTEGER DEFAULT 0"); } catch (_) {}

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

export async function deploySite(slug: string, name: string, zipBuffer: ArrayBuffer, label?: string): Promise<{ site: Site; version: SiteVersion }> {
  // Validate slug
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error("Slug must be lowercase alphanumeric with hyphens, not starting/ending with hyphen");
  }
  if (slug.startsWith("_")) {
    throw new Error("Slugs starting with _ are reserved");
  }
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

function getVersion(slug: string, version: string): SiteVersion | null {
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
  db.run("DELETE FROM requests WHERE site_slug = ?", slug);
  invalidateSiteCache(slug);
  return true;
}

export function toggleSite(slug: string, active: boolean): boolean {
  const result = db.run("UPDATE sites SET active = ? WHERE slug = ?", active ? 1 : 0, slug);
  invalidateSiteCache(slug);
  return result.changes > 0;
}

export function updateSiteSettings(
  slug: string, rootDir: string | null, spa: boolean,
  mcpEnabled?: boolean, mcpReadOnly?: boolean
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
      updated_at = datetime('now')
    WHERE slug = ?`,
    rootDir, spa ? 1 : 0,
    mcpEnabled !== undefined ? (mcpEnabled ? 1 : 0) : null,
    mcpReadOnly !== undefined ? (mcpReadOnly ? 1 : 0) : null,
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
