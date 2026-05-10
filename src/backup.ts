import db from "./db";
import { SITES_DIR } from "./sites";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "fs";
import { join, dirname, resolve } from "path";
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from "crypto";

const BASE_DIR = process.env.HOSTER_HOME || dirname(process.execPath);
const DATA_DIR = join(BASE_DIR, "data");
const BACKUP_STAGING = join(DATA_DIR, "_backup_staging");

const MAX_BACKUP_SIZE = 500 * 1024 * 1024; // 500 MB

const ENCRYPTION_HEADER = "HOSTER_ENC_V1";
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

interface Manifest {
  version: 1;
  created_at: string;
  hoster_version: string;
  site_count: number;
  encrypted: boolean;
  all_versions: boolean;
  description: string;
}

function getHosterVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(BASE_DIR, "package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

function encrypt(data: Buffer, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const header = Buffer.from(ENCRYPTION_HEADER, "utf8");
  // header | salt (32) | iv (12) | authTag (16) | encrypted data
  return Buffer.concat([header, salt, iv, authTag, encrypted]);
}

function decrypt(data: Buffer, password: string): Buffer {
  const headerLen = Buffer.from(ENCRYPTION_HEADER, "utf8").length;
  const header = data.subarray(0, headerLen).toString("utf8");
  if (header !== ENCRYPTION_HEADER) {
    throw new Error("File is not encrypted or has an invalid format");
  }

  let offset = headerLen;
  const salt = data.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
  const iv = data.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
  const authTag = data.subarray(offset, offset + 16); offset += 16;
  const encrypted = data.subarray(offset);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("Incorrect password or corrupted file");
  }
}

function exportDatabase(): Record<string, any[]> {
  const tables: Record<string, any[]> = {};

  // Config (password hash, TOTP, country restrictions, autoblock, etc.)
  tables.config = db.prepare("SELECT key, value FROM config").all();

  // Sites metadata
  tables.sites = db.prepare("SELECT * FROM sites").all();

  // Site versions
  tables.site_versions = db.prepare("SELECT * FROM site_versions").all();

  // Site aliases
  tables.site_aliases = db.prepare("SELECT * FROM site_aliases").all();

  // MCP tokens (hashed tokens — can't recover raw, but preserves config)
  tables.mcp_tokens = db.prepare("SELECT * FROM mcp_tokens").all();

  // Blocked IPs
  tables.blocked_ips = db.prepare("SELECT * FROM blocked_ips").all();

  return tables;
}

function importDatabase(tables: Record<string, any[]>) {
  const tx = db.transaction(() => {
    // Clear existing data in import order (respecting foreign keys)
    db.exec("DELETE FROM site_aliases");
    db.exec("DELETE FROM site_versions");
    db.exec("DELETE FROM mcp_tokens");
    db.exec("DELETE FROM blocked_ips");
    db.exec("DELETE FROM sites");
    db.exec("DELETE FROM config");
    // Clear ephemeral tables too
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM pending_2fa");
    db.exec("DELETE FROM login_attempts");
    db.exec("DELETE FROM totp_attempts");

    // Import config
    if (tables.config) {
      const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
      for (const row of tables.config) stmt.run(row.key, row.value);
    }

    // Import sites
    if (tables.sites) {
      const cols = ["slug", "name", "created_at", "updated_at", "size_bytes", "file_count", "active", "current_version", "root_dir", "spa", "mcp_enabled", "mcp_read_only"];
      const placeholders = cols.map(() => "?").join(", ");
      const stmt = db.prepare(`INSERT INTO sites (${cols.join(", ")}) VALUES (${placeholders})`);
      for (const row of tables.sites) {
        stmt.run(...cols.map(c => row[c] ?? null));
      }
    }

    // Import site versions
    if (tables.site_versions) {
      const cols = ["site_slug", "version", "label", "size_bytes", "file_count", "created_at"];
      const placeholders = cols.map(() => "?").join(", ");
      const stmt = db.prepare(`INSERT INTO site_versions (${cols.join(", ")}) VALUES (${placeholders})`);
      for (const row of tables.site_versions) {
        stmt.run(...cols.map(c => row[c] ?? null));
      }
    }

    // Import site aliases
    if (tables.site_aliases) {
      const stmt = db.prepare("INSERT INTO site_aliases (alias, site_slug, created_at) VALUES (?, ?, ?)");
      for (const row of tables.site_aliases) {
        stmt.run(row.alias, row.site_slug, row.created_at);
      }
    }

    // Import MCP tokens
    if (tables.mcp_tokens) {
      const cols = ["token_hash", "label", "site_slug", "expires_at", "created_at"];
      const placeholders = cols.map(() => "?").join(", ");
      const stmt = db.prepare(`INSERT INTO mcp_tokens (${cols.join(", ")}) VALUES (${placeholders})`);
      for (const row of tables.mcp_tokens) {
        stmt.run(...cols.map(c => row[c] ?? null));
      }
    }

    // Import blocked IPs
    if (tables.blocked_ips) {
      const stmt = db.prepare("INSERT INTO blocked_ips (ip, reason, blocked_at, expires_at) VALUES (?, ?, ?, ?)");
      for (const row of tables.blocked_ips) {
        stmt.run(row.ip, row.reason, row.blocked_at, row.expires_at);
      }
    }
  });

  tx();
}

export async function createBackup(password?: string, allVersions = false): Promise<Buffer> {
  // Small staging dir for metadata files only — site files are zipped in place
  if (existsSync(BACKUP_STAGING)) rmSync(BACKUP_STAGING, { recursive: true });
  mkdirSync(BACKUP_STAGING, { recursive: true });

  const zipPath = join(DATA_DIR, "_backup.zip");
  if (existsSync(zipPath)) rmSync(zipPath);

  try {
    // Export database tables
    const dbData = exportDatabase();

    // If not saving all versions, filter site_versions to only current ones
    if (!allVersions && dbData.sites && dbData.site_versions) {
      const currentVersions = new Set(
        dbData.sites.map((s: any) => `${s.slug}:${s.current_version}`).filter((v: string) => !v.endsWith(":null"))
      );
      dbData.site_versions = dbData.site_versions.filter(
        (v: any) => currentVersions.has(`${v.site_slug}:${v.version}`)
      );
    }

    writeFileSync(join(BACKUP_STAGING, "database.json"), JSON.stringify(dbData, null, 2));

    // Count sites
    const siteCount = (dbData.sites || []).length;

    // Write manifest
    const manifest: Manifest = {
      version: 1,
      created_at: new Date().toISOString(),
      hoster_version: getHosterVersion(),
      site_count: siteCount,
      encrypted: !!password,
      all_versions: allVersions,
      description: `Hoster backup — ${siteCount} site${siteCount !== 1 ? "s" : ""}`,
    };
    writeFileSync(join(BACKUP_STAGING, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Step 1: zip the metadata files
    const zipMeta = Bun.spawn(["zip", zipPath, "manifest.json", "database.json"], {
      cwd: BACKUP_STAGING,
      stdout: "ignore",
      stderr: "pipe",
    });
    await zipMeta.exited;

    // Step 2: add site files directly from SITES_DIR (no copy step)
    if (existsSync(SITES_DIR) && readdirSync(SITES_DIR).length > 0) {
      if (allVersions) {
        // Include everything
        const zipSites = Bun.spawn(["zip", "-r", "-y", zipPath, "sites"], {
          cwd: dirname(SITES_DIR),
          stdout: "ignore",
          stderr: "pipe",
        });
        await zipSites.exited;
      } else {
        // Only include _current symlink and current version directory per site
        const siteSlugs = readdirSync(SITES_DIR);
        for (const slug of siteSlugs) {
          const siteDir = join(SITES_DIR, slug);
          if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) continue;

          // Find current version from DB data
          const siteRecord = dbData.sites?.find((s: any) => s.slug === slug);
          const currentVersion = siteRecord?.current_version;

          const includes: string[] = [];

          // Add the _current symlink
          const currentLink = join("sites", slug, "_current");
          includes.push(currentLink);

          // Add the current version directory
          if (currentVersion && existsSync(join(siteDir, currentVersion))) {
            includes.push(join("sites", slug, currentVersion));
          }

          if (includes.length > 0) {
            const zipSite = Bun.spawn(["zip", "-r", "-y", zipPath, ...includes], {
              cwd: dirname(SITES_DIR),
              stdout: "ignore",
              stderr: "pipe",
            });
            await zipSite.exited;
          }
        }
      }
    }

    let zipBuffer = Buffer.from(readFileSync(zipPath));

    // Encrypt if password provided
    if (password) {
      zipBuffer = encrypt(zipBuffer, password);
    }

    return zipBuffer;
  } finally {
    if (existsSync(BACKUP_STAGING)) rmSync(BACKUP_STAGING, { recursive: true });
    if (existsSync(zipPath)) rmSync(zipPath);
  }
}

export async function previewBackup(fileBuffer: Buffer, password?: string): Promise<Manifest> {
  if (fileBuffer.length > MAX_BACKUP_SIZE) {
    throw new Error("Backup file exceeds maximum size of 500 MB");
  }

  let zipBuffer = fileBuffer;

  // Check if encrypted
  const headerLen = Buffer.from(ENCRYPTION_HEADER, "utf8").length;
  const possibleHeader = fileBuffer.subarray(0, headerLen).toString("utf8");
  const isEncrypted = possibleHeader === ENCRYPTION_HEADER;

  if (isEncrypted && !password) {
    throw new Error("This backup is encrypted. Please provide the password.");
  }

  if (isEncrypted) {
    zipBuffer = decrypt(fileBuffer, password!);
  } else if (password) {
    // Password provided but file isn't encrypted — that's fine, just ignore
  }

  // Extract to temp dir to read manifest
  const previewDir = join(DATA_DIR, "_backup_preview");
  if (existsSync(previewDir)) rmSync(previewDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });

  try {
    const tmpZip = join(previewDir, "backup.zip");
    writeFileSync(tmpZip, zipBuffer);

    // Only extract manifest.json
    const proc = Bun.spawn(["unzip", "-o", tmpZip, "manifest.json", "-d", previewDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    await proc.exited;

    const manifestPath = join(previewDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("Invalid backup file: missing manifest");
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    manifest.encrypted = isEncrypted;
    return manifest;
  } finally {
    if (existsSync(previewDir)) rmSync(previewDir, { recursive: true });
  }
}

// Recursively remove symlinks from a directory tree
function removeSymlinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      unlinkSync(fullPath);
    } else if (entry.isDirectory()) {
      removeSymlinks(fullPath);
    }
  }
}

// Verify no extracted files escaped the target directory (zip slip protection)
function verifyNoEscape(dir: string): void {
  const realDir = resolve(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const realPath = resolve(fullPath);
    if (!realPath.startsWith(realDir)) {
      throw new Error(`Security: path escape detected: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      verifyNoEscape(fullPath);
    }
  }
}

export async function restoreBackup(fileBuffer: Buffer, password?: string): Promise<Manifest> {
  if (fileBuffer.length > MAX_BACKUP_SIZE) {
    throw new Error("Backup file exceeds maximum size of 500 MB");
  }

  let zipBuffer = fileBuffer;

  // Check if encrypted
  const headerLen = Buffer.from(ENCRYPTION_HEADER, "utf8").length;
  const possibleHeader = fileBuffer.subarray(0, headerLen).toString("utf8");
  const isEncrypted = possibleHeader === ENCRYPTION_HEADER;

  if (isEncrypted && !password) {
    throw new Error("This backup is encrypted. Please provide the password.");
  }

  if (isEncrypted) {
    zipBuffer = decrypt(fileBuffer, password!);
  }

  // Extract to staging
  const restoreDir = join(DATA_DIR, "_backup_restore");
  if (existsSync(restoreDir)) rmSync(restoreDir, { recursive: true });
  mkdirSync(restoreDir, { recursive: true });

  try {
    const tmpZip = join(restoreDir, "backup.zip");
    writeFileSync(tmpZip, zipBuffer);

    const proc = Bun.spawn(["unzip", "-o", tmpZip, "-d", restoreDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    await proc.exited;
    rmSync(tmpZip);

    // Security: remove any symlinks that might have been in the archive
    removeSymlinks(restoreDir);

    // Security: verify no files escaped the restore directory (zip slip)
    verifyNoEscape(restoreDir);

    // Validate manifest
    const manifestPath = join(restoreDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("Invalid backup file: missing manifest");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

    // Validate database.json
    const dbPath = join(restoreDir, "database.json");
    if (!existsSync(dbPath)) {
      throw new Error("Invalid backup file: missing database");
    }
    const tables = JSON.parse(readFileSync(dbPath, "utf8"));

    // Restore database
    importDatabase(tables);

    // Restore site files
    const restoreSitesDir = join(restoreDir, "sites");
    if (existsSync(restoreSitesDir)) {
      // Remove existing sites directory contents
      if (existsSync(SITES_DIR)) {
        for (const entry of readdirSync(SITES_DIR)) {
          rmSync(join(SITES_DIR, entry), { recursive: true });
        }
      } else {
        mkdirSync(SITES_DIR, { recursive: true });
      }

      // Copy restored sites (no -a flag, symlinks already stripped)
      const entries = readdirSync(restoreSitesDir);
      if (entries.length > 0) {
        const cpProc = Bun.spawn(["cp", "-r", ...entries.map(e => join(restoreSitesDir, e)), SITES_DIR], {
          stdout: "ignore",
          stderr: "pipe",
        });
        await cpProc.exited;
      }
    }

    return manifest;
  } finally {
    if (existsSync(restoreDir)) rmSync(restoreDir, { recursive: true });
  }
}
