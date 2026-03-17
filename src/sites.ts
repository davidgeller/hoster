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
    stdout: "pipe",
    stderr: "pipe",
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

  // Auto-detect root directory: look for subdirectory containing index.html
  // Common patterns: browser/ (Angular), dist/ , build/ , public/ , out/
  let detectedRoot: string | null = null;
  let detectedSpa = 0;
  const topIndex = join(versionDir, "index.html");
  if (!existsSync(topIndex)) {
    // No top-level index.html — look for one in subdirectories
    const candidates = ["browser", "dist", "build", "public", "out", "www"];
    for (const dir of candidates) {
      if (existsSync(join(versionDir, dir, "index.html"))) {
        detectedRoot = dir;
        break;
      }
    }
    // If not a known name, scan for any subdir with index.html
    if (!detectedRoot) {
      for (const entry of readdirSync(versionDir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(versionDir, entry.name, "index.html"))) {
          detectedRoot = entry.name;
          break;
        }
      }
    }
  }

  // Auto-detect SPA: look for JS bundles (Angular, React, Vue)
  if (detectedRoot || existsSync(topIndex)) {
    const checkDir = detectedRoot ? join(versionDir, detectedRoot) : versionDir;
    const files = readdirSync(checkDir);
    const hasJsBundle = files.some(f => /^(main|chunk|polyfills|vendor|runtime)[\w.-]*\.js$/.test(f));
    if (hasJsBundle) detectedSpa = 1;
  }

  // Preserve existing root_dir/spa if site already exists (user may have overridden)
  const existing = getSite(slug);
  const rootDir = existing?.root_dir ?? detectedRoot;
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

export function resolveSitePath(slug: string, filePath: string): string | null {
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

  // Try exact file
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    const realPath = realpathSync(resolved);
    if (!realPath.startsWith(realSiteDirResolved)) return null;
    return resolved;
  }

  // Try with index.html for directories
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const index = join(resolved, "index.html");
    if (existsSync(index)) {
      const realPath = realpathSync(index);
      if (realPath.startsWith(realSiteDirResolved)) return index;
    }
  }

  // Try appending .html
  const htmlPath = resolved + ".html";
  if (existsSync(htmlPath)) {
    const realPath = realpathSync(htmlPath);
    if (realPath.startsWith(realSiteDirResolved)) return htmlPath;
  }

  // SPA fallback: serve index.html for any unmatched route
  if (site.spa) {
    const spaIndex = join(contentDir, "index.html");
    if (existsSync(spaIndex)) return spaIndex;
  }

  return null;
}
