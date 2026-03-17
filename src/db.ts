import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

import { dirname } from "path";
const BASE_DIR = dirname(process.execPath);
const DATA_DIR = join(BASE_DIR, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "hoster.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    size_bytes INTEGER DEFAULT 0,
    file_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    csrf_token TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_slug TEXT,
    path TEXT,
    method TEXT DEFAULT 'GET',
    status INTEGER,
    response_time_ms REAL,
    ip TEXT,
    country TEXT,
    city TEXT,
    user_agent TEXT,
    referrer TEXT,
    content_type TEXT,
    accept_language TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_requests_site ON requests(site_slug);
  CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_requests_ip ON requests(ip);

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    success INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_login_ip_created ON login_attempts(ip, created_at);

  CREATE TABLE IF NOT EXISTS pending_2fa (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS totp_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    success INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_totp_attempts_ip_created ON totp_attempts(ip, created_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

// Add columns if not present (for existing databases)
try { db.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT"); } catch (_) {}

export default db;
