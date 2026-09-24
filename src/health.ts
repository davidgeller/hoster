// System health: what the admin panel can safely show about the database,
// the disk Hoster lives on, and the host itself — plus a few maintenance
// actions. Administrators only. Nothing here exposes secrets: no environment
// variables, config values, tokens, or session data.

import { existsSync, readFileSync, statSync, statfsSync } from "fs";
import { dirname, join } from "path";
import os from "os";
import db from "./db";
import { MAX_LOG_ROWS } from "./analytics";

const BASE_DIR = process.env.HOSTER_HOME || dirname(process.execPath);
const DATA_DIR = join(BASE_DIR, "data");
const DB_PATH = join(DATA_DIR, "hoster.db");
const SITES_DIR = join(BASE_DIR, "sites");

function fileSize(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

export interface DiskInfo {
  path: string;
  total_bytes: number;
  free_bytes: number;       // available to the Hoster process (excludes root-reserved blocks)
  used_bytes: number;
  used_pct: number;
}

export function diskInfo(path = BASE_DIR): DiskInfo | null {
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    // "Used" as df reports it: everything that isn't free for anyone.
    const used = total - s.bfree * s.bsize;
    const pct = total ? Math.round(((used) / (used + free)) * 1000) / 10 : 0;
    return { path, total_bytes: total, free_bytes: free, used_bytes: used, used_pct: pct };
  } catch {
    return null;
  }
}

// Linux: MemAvailable is the honest "free" figure (os.freemem() excludes the
// page cache the kernel would give back). Elsewhere fall back to freemem().
function memoryInfo() {
  const total = os.totalmem();
  let available = os.freemem();
  try {
    if (existsSync("/proc/meminfo")) {
      const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (m) available = parseInt(m[1], 10) * 1024;
    }
  } catch (_) {}
  return { total_bytes: total, available_bytes: available, used_pct: total ? Math.round(((total - available) / total) * 1000) / 10 : 0 };
}

function pragma<T = any>(name: string): T | null {
  try {
    const row = db.query(`PRAGMA ${name}`).get() as Record<string, any> | null;
    return row ? (Object.values(row)[0] as T) : null;
  } catch {
    return null;
  }
}

function tableCounts(): { name: string; rows: number }[] {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(t => {
    try {
      const r = db.query(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number };
      return { name: t.name, rows: r.n };
    } catch {
      return { name: t.name, rows: -1 };
    }
  }).sort((a, b) => b.rows - a.rows);
}

function storageInfo() {
  const q = <T>(sql: string, fallback: T): T => { try { return (db.query(sql).get() as T) ?? fallback; } catch { return fallback; } };
  const live = q<{ n: number; bytes: number }>(`
    SELECT COUNT(*) AS n, COALESCE(SUM(v.size_bytes), 0) AS bytes
    FROM site_versions v JOIN sites s ON s.slug = v.site_slug AND s.current_version = v.version
  `, { n: 0, bytes: 0 });
  const old = q<{ n: number; bytes: number }>(`
    SELECT COUNT(*) AS n, COALESCE(SUM(v.size_bytes), 0) AS bytes
    FROM site_versions v JOIN sites s ON s.slug = v.site_slug
    WHERE s.current_version IS NULL OR s.current_version != v.version
  `, { n: 0, bytes: 0 });
  const repo = q<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM repo_blobs", { n: 0, bytes: 0 });
  const sites = q<{ web: number; repo: number }>(
    "SELECT SUM(site_type = 'web') AS web, SUM(site_type = 'repository') AS repo FROM sites", { web: 0, repo: 0 });
  return {
    web_sites: sites.web || 0,
    repositories: sites.repo || 0,
    live_versions: { count: live.n, bytes: live.bytes },
    older_versions: { count: old.n, bytes: old.bytes },
    repository_blobs: { count: repo.n, bytes: repo.bytes },
  };
}

export function getHealth() {
  const pageSize = pragma<number>("page_size") || 4096;
  const pageCount = pragma<number>("page_count") || 0;
  const freelist = pragma<number>("freelist_count") || 0;
  const reqRange = db.query("SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest, COUNT(*) AS n FROM requests").get() as { oldest: string | null; newest: string | null; n: number };
  const perDay = db.query("SELECT COUNT(*) AS n FROM requests WHERE created_at > datetime('now', '-1 day')").get() as { n: number };

  const database = {
    path: DB_PATH,
    size_bytes: fileSize(DB_PATH),
    wal_bytes: fileSize(DB_PATH + "-wal"),
    shm_bytes: fileSize(DB_PATH + "-shm"),
    page_size: pageSize,
    page_count: pageCount,
    free_pages: freelist,
    reclaimable_bytes: freelist * pageSize,
    journal_mode: pragma<string>("journal_mode"),
    sqlite_version: (db.query("SELECT sqlite_version() AS v").get() as { v: string }).v,
    tables: tableCounts(),
    request_log: {
      rows: reqRange.n,
      cap: MAX_LOG_ROWS,
      oldest: reqRange.oldest,
      newest: reqRange.newest,
      last_24h: perDay.n,
    },
  };

  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const host = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    os_release: os.release(),
    cpu_count: cpus.length,
    cpu_model: cpus[0]?.model?.trim() || null,
    load_avg: os.loadavg().map(n => Math.round(n * 100) / 100),
    uptime_seconds: Math.round(os.uptime()),
    memory: memoryInfo(),
  };
  const proc = {
    pid: process.pid,
    uptime_seconds: Math.round(process.uptime()),
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    bun_version: typeof Bun !== "undefined" ? Bun.version : null,
  };

  const disk = diskInfo();
  const sitesDisk = existsSync(SITES_DIR) ? diskInfo(SITES_DIR) : null;
  const storage = storageInfo();

  // Plain-language findings for the page (and the dashboard banner).
  const warnings: { level: "warn" | "critical"; message: string }[] = [];
  if (disk) {
    if (disk.used_pct >= 95) warnings.push({ level: "critical", message: `The disk is ${disk.used_pct}% full — deploys, uploads, and backups may start failing.` });
    else if (disk.used_pct >= 85) warnings.push({ level: "warn", message: `The disk is ${disk.used_pct}% full.` });
  }
  if (host.memory.used_pct >= 95) warnings.push({ level: "warn", message: `Memory is ${host.memory.used_pct}% used.` });
  if (database.wal_bytes > 256 * 1024 * 1024) warnings.push({ level: "warn", message: "The database write-ahead log is over 256 MB; run a checkpoint." });
  if (database.size_bytes > 0 && database.reclaimable_bytes / database.size_bytes > 0.3 && database.reclaimable_bytes > 32 * 1024 * 1024) {
    warnings.push({ level: "warn", message: "Over 30% of the database file is free space; compacting would reclaim it." });
  }
  if (sitesDisk && disk && sitesDisk.total_bytes !== disk.total_bytes && sitesDisk.used_pct >= 85) {
    warnings.push({ level: sitesDisk.used_pct >= 95 ? "critical" : "warn", message: `The volume holding sites is ${sitesDisk.used_pct}% full.` });
  }

  return {
    generated_at: new Date().toISOString(),
    database,
    disk,
    sites_disk: sitesDisk && disk && sitesDisk.total_bytes !== disk.total_bytes ? sitesDisk : null,
    storage,
    host,
    process: proc,
    warnings,
  };
}

// Just the part the dashboard needs, cheap enough to call on every visit.
export function getHealthSummary() {
  const disk = diskInfo();
  return {
    disk_used_pct: disk?.used_pct ?? null,
    disk_free_bytes: disk?.free_bytes ?? null,
    level: disk && disk.used_pct >= 95 ? "critical" : disk && disk.used_pct >= 85 ? "warn" : "ok",
  };
}

// --- Maintenance ---

export function checkpointWal() {
  const before = fileSize(DB_PATH + "-wal");
  const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number } | null;
  return { busy: !!row?.busy, wal_before_bytes: before, wal_after_bytes: fileSize(DB_PATH + "-wal") };
}

export function quickCheck() {
  const started = performance.now();
  const rows = db.query("PRAGMA quick_check(20)").all() as Record<string, string>[];
  const messages = rows.map(r => Object.values(r)[0]);
  return { ok: messages.length === 1 && messages[0] === "ok", messages, ms: Math.round(performance.now() - started) };
}

export function tableSizes(): { name: string; bytes: number }[] | null {
  try {
    return db.query("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 40").all() as { name: string; bytes: number }[];
  } catch {
    return null; // SQLite built without the dbstat table
  }
}

export function pruneRequests(days: number) {
  const d = Math.max(1, Math.min(3650, Math.round(days)));
  const res = db.run("DELETE FROM requests WHERE created_at < datetime('now', ?)", `-${d} days`);
  return { deleted: res.changes, days: d };
}

// VACUUM rewrites the whole file: it needs roughly the database's size in
// free disk and blocks every other write while it runs.
export function vacuum() {
  const size = fileSize(DB_PATH);
  const disk = diskInfo(DATA_DIR);
  if (disk && disk.free_bytes < size * 2.2) {
    throw new Error(`Not enough free disk to compact safely (needs about ${Math.ceil((size * 2.2) / 1048576)} MB free)`);
  }
  const started = performance.now();
  db.run("VACUUM");
  checkpointWal();
  return { before_bytes: size, after_bytes: fileSize(DB_PATH), ms: Math.round(performance.now() - started) };
}
