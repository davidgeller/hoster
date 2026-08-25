import db from "./db";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const SESSION_DURATION_HOURS = 24;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_TOTP_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const TOTP_ISSUER = "Hoster";
const RECOVERY_CODE_COUNT = 8;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// --- Site-scoped admin users ---
//
// A platform super-admin (the original password, optional TOTP) authenticates
// with a blank username. Site-scoped users have a username + password and are
// granted access to a subset of sites via admin_user_sites. They see the full
// admin UI for their sites only — never the platform Settings screen.
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_user_sites (
    user_id INTEGER NOT NULL,
    site_slug TEXT NOT NULL,
    PRIMARY KEY (user_id, site_slug),
    FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );
`);

const USERNAME_PATTERN = /^[a-z0-9._-]{1,40}$/;

export function normalizeUsername(username: string): string {
  return (username || "").trim().toLowerCase();
}

export function validateUsername(username: string): string {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error("Username is required");
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error("Username must be 1–40 chars: lowercase letters, digits, dot, dash, underscore");
  }
  return normalized;
}

export function getAdminPasswordHash(): string | null {
  const row = db.query("SELECT value FROM config WHERE key = 'admin_password_hash'").get() as { value: string } | null;
  return row?.value ?? null;
}

export async function setAdminPassword(password: string): Promise<void> {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
  db.run(
    "INSERT INTO config (key, value) VALUES ('admin_password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    hash, hash
  );
}

export function isSetup(): boolean {
  return getAdminPasswordHash() !== null;
}

export function isRateLimited(ip: string): boolean {
  // Use SQL-side datetime arithmetic so the comparison stays in SQLite's native
  // YYYY-MM-DD HH:MM:SS format. JS toISOString() produces a different format
  // (T separator + Z) and string-compares incorrectly against datetime('now').
  const row = db.query(
    `SELECT COUNT(*) as cnt FROM login_attempts
     WHERE ip = ? AND created_at > datetime('now', ?) AND success = 0`
  ).get(ip, `-${LOCKOUT_MINUTES} minutes`) as { cnt: number };
  return row.cnt >= MAX_LOGIN_ATTEMPTS;
}

// Exported so the passkey login path can feed the same per-IP lockout that
// guards password logins — one login surface, one attempt counter.
export function recordLoginAttempt(ip: string, success: boolean): void {
  db.run("INSERT INTO login_attempts (ip, success) VALUES (?, ?)", ip, success ? 1 : 0);
  // Clean old attempts (older than 24 hours) — SQL-side datetime keeps formats aligned.
  db.run("DELETE FROM login_attempts WHERE created_at < datetime('now', '-24 hours')");
}

export async function verifyPassword(password: string, ip: string): Promise<boolean> {
  const hash = getAdminPasswordHash();
  if (!hash) return false;

  const valid = await Bun.password.verify(password, hash);
  recordLoginAttempt(ip, valid);
  return valid;
}

export function createSession(ip: string, userId: number | null = null): { sessionToken: string; csrfToken: string } {
  const sessionToken = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  // SQL-side datetime so expires_at is stored in the same format that
  // datetime('now') comparisons (validateSession, getCsrfToken, cleanExpiredSessions)
  // produce. Mixing toISOString() with datetime('now') silently breaks expiry.
  db.run(
    `INSERT INTO sessions (token, csrf_token, expires_at, ip, user_id)
     VALUES (?, ?, datetime('now', ?), ?, ?)`,
    sessionToken, csrfToken, `+${SESSION_DURATION_HOURS} hours`, ip, userId
  );
  return { sessionToken, csrfToken };
}

// Resolve the principal behind a session. Returns null for an invalid/expired
// token. userId === null means the platform super-admin; otherwise it's the
// admin_users.id of a site-scoped user.
export function getSessionUser(token: string | undefined): { userId: number | null; isSuperAdmin: boolean } | null {
  if (!token) return null;
  const row = db.query(
    "SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token) as { user_id: number | null } | null;
  if (!row) return null;
  return { userId: row.user_id ?? null, isSuperAdmin: row.user_id == null };
}

// Delete sessions belonging to one principal (super-admin when userId is null).
// Used to rotate a single principal's session on login without evicting other
// logged-in users (unlike destroyAllSessions).
export function destroySessionsForUser(userId: number | null): void {
  if (userId == null) {
    db.run("DELETE FROM sessions WHERE user_id IS NULL");
  } else {
    db.run("DELETE FROM sessions WHERE user_id = ?", userId);
  }
}

export function validateSession(token: string | undefined, ip?: string): boolean {
  if (!token) return false;
  const row = db.query(
    "SELECT token, ip FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token) as { token: string; ip: string | null } | null;
  if (!row) return false;
  // If IP is provided and session has a recorded IP, verify they match
  if (ip && row.ip && row.ip !== "unknown" && ip !== "unknown" && row.ip !== ip) {
    return false;
  }
  return true;
}

export function getCsrfToken(sessionToken: string | undefined): string | null {
  if (!sessionToken) return null;
  const row = db.query(
    "SELECT csrf_token FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(sessionToken) as { csrf_token: string } | null;
  return row?.csrf_token ?? null;
}

export function validateCsrf(req: Request, sessionToken: string | undefined): boolean {
  const expected = getCsrfToken(sessionToken);
  if (!expected) return false;
  const provided = req.headers.get("x-csrf-token");
  if (!provided) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function destroySession(token: string): void {
  db.run("DELETE FROM sessions WHERE token = ?", token);
}

// Destroy every session — used on successful login and password change so a
// previously-stolen-but-quietly-held cookie is invalidated. Hoster is single-
// admin, so there's no other principal whose sessions we'd preserve.
export function destroyAllSessions(): void {
  db.run("DELETE FROM sessions");
}

export function cleanExpiredSessions(): void {
  db.run("DELETE FROM sessions WHERE expires_at < datetime('now')");
}

// Only trust proxy headers when a real remote address is also available,
// indicating the request came through an infrastructure proxy (e.g. Cloudflare).
// Bun.serve provides req.headers but not a socket address directly on Request,
// so we check for Cloudflare-specific headers as a trust signal: if cf-ipcountry
// is present, the request came through Cloudflare and cf-connecting-ip is reliable.
export function getClientIp(req: Request): string {
  const hasCfSignal = req.headers.get("cf-ipcountry");
  if (hasCfSignal) {
    const cfIp = req.headers.get("cf-connecting-ip");
    if (cfIp) return cfIp;
  }
  // Outside Cloudflare, x-forwarded-for is untrusted — ignore it
  return req.headers.get("x-real-ip") || "unknown";
}

export function getSessionToken(req: Request): string | undefined {
  const cookie = req.headers.get("cookie");
  if (!cookie) return undefined;
  const match = cookie.match(/hoster_session=([a-f0-9]+)/);
  return match?.[1];
}

export function sessionCookie(token: string, maxAge: number = SESSION_DURATION_HOURS * 3600): string {
  return `hoster_session=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAge}`;
}

// --- Audit Logging ---

export function auditLog(action: string, detail: string | null, ip: string): void {
  db.run("INSERT INTO audit_log (action, detail, ip) VALUES (?, ?, ?)", action, detail, ip);
  // Prune entries older than 90 days. SQL-side datetime keeps formats aligned.
  db.run("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')");
}

export function getAuditLog(limit: number = 50): any[] {
  return db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as any[];
}

// --- TOTP 2FA ---

function getConfigValue(key: string): string | null {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function setConfigValue(key: string, value: string | null): void {
  if (value === null) {
    db.run("DELETE FROM config WHERE key = ?", key);
  } else {
    db.run("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?", key, value, value);
  }
}

export function isTotpEnabled(): boolean {
  return getConfigValue("totp_enabled") === "1";
}

export function generateTotpSecret(): { secret: string; uri: string } {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: "Admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });
  return { secret: totp.secret.base32, uri: totp.toString() };
}

export async function getTotpQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { width: 256, margin: 2 });
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: "Admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  // Allow 1 window of drift (±30 seconds)
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

export function getTotpSecret(): string | null {
  return getConfigValue("totp_secret");
}

export function enableTotp(secret: string, recoveryCodes: string[]): void {
  setConfigValue("totp_secret", secret);
  setConfigValue("totp_enabled", "1");
  // Store hashed recovery codes — originals are shown to user once, never stored
  const hashed = recoveryCodes.map(c => sha256(c.toLowerCase().replace(/[\s-]/g, "")));
  setConfigValue("totp_recovery_codes", JSON.stringify(hashed));
}

export function disableTotp(): void {
  setConfigValue("totp_secret", null);
  setConfigValue("totp_enabled", null);
  setConfigValue("totp_recovery_codes", null);
  setConfigValue("totp_pending_secret", null);
}

export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // 8-character hex codes, formatted as xxxx-xxxx for readability
    const raw = randomBytes(4).toString("hex");
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function useRecoveryCode(code: string): boolean {
  const raw = getConfigValue("totp_recovery_codes");
  if (!raw) return false;
  const hashes: string[] = JSON.parse(raw);
  const incoming = sha256(code.toLowerCase().replace(/[\s-]/g, ""));
  const incomingBuf = Buffer.from(incoming, "hex");
  // Constant-time comparison against all stored hashes
  let foundIndex = -1;
  for (let i = 0; i < hashes.length; i++) {
    const storedBuf = Buffer.from(hashes[i], "hex");
    if (incomingBuf.length === storedBuf.length && timingSafeEqual(incomingBuf, storedBuf)) {
      foundIndex = i;
    }
  }
  if (foundIndex === -1) return false;
  // Remove used code
  hashes.splice(foundIndex, 1);
  setConfigValue("totp_recovery_codes", JSON.stringify(hashes));
  return true;
}

export function getRemainingRecoveryCodes(): number {
  const raw = getConfigValue("totp_recovery_codes");
  if (!raw) return 0;
  return JSON.parse(raw).length;
}

// Pending secret during setup (not yet confirmed)
export function setPendingTotpSecret(secret: string): void {
  setConfigValue("totp_pending_secret", secret);
}

export function getPendingTotpSecret(): string | null {
  return getConfigValue("totp_pending_secret");
}

export function clearPendingTotpSecret(): void {
  setConfigValue("totp_pending_secret", null);
}

// Pending 2FA sessions — password verified but awaiting TOTP code.
// SQL-side datetime keeps expires_at in the same format that the validate/consume
// queries (datetime('now')) produce, so expiry comparisons actually work.
export function createPending2faToken(ip: string): string {
  const token = randomBytes(32).toString("hex");
  const hash = sha256(token);
  db.run(
    "INSERT INTO pending_2fa (token_hash, expires_at, ip) VALUES (?, datetime('now', '+5 minutes'), ?)",
    hash, ip
  );
  return token;
}

export function validatePending2faToken(token: string | undefined): boolean {
  if (!token) return false;
  const hash = sha256(token);
  const row = db.query(
    "SELECT token_hash FROM pending_2fa WHERE token_hash = ? AND expires_at > datetime('now')"
  ).get(hash) as { token_hash: string } | null;
  return row !== null;
}

// Atomically validate and consume — prevents race conditions.
// IP must match the IP that began the login (the password step). Otherwise a
// stolen pending_token could complete 2FA from a different machine.
export function consumePending2faToken(token: string, ip: string): boolean {
  const hash = sha256(token);
  // Select-then-delete in a transaction for atomicity
  const consume = db.transaction(() => {
    const row = db.query(
      "SELECT token_hash, ip FROM pending_2fa WHERE token_hash = ? AND expires_at > datetime('now')"
    ).get(hash) as { token_hash: string; ip: string | null } | null;
    if (!row) return false;
    // IP-binding: reject if the consume attempt comes from a different address.
    // 'unknown' on either side is treated as a mismatch (don't authorize without
    // a verifiable IP). This is conservative — legitimate IP changes mid-flow
    // (mobile/Wi-Fi handoff in 5 minutes) require restarting the login.
    if (!row.ip || row.ip === "unknown" || ip === "unknown" || row.ip !== ip) return false;
    db.run("DELETE FROM pending_2fa WHERE token_hash = ?", hash);
    return true;
  });
  return consume();
}

export function cleanExpiredPending2fa(): void {
  db.run("DELETE FROM pending_2fa WHERE expires_at < datetime('now')");
}

// --- TOTP Rate Limiting ---

export function isTotpRateLimited(ip: string): boolean {
  const row = db.query(
    `SELECT COUNT(*) as cnt FROM totp_attempts
     WHERE ip = ? AND created_at > datetime('now', ?) AND success = 0`
  ).get(ip, `-${LOCKOUT_MINUTES} minutes`) as { cnt: number };
  return row.cnt >= MAX_TOTP_ATTEMPTS;
}

export function recordTotpAttempt(ip: string, success: boolean): void {
  db.run("INSERT INTO totp_attempts (ip, success) VALUES (?, ?)", ip, success ? 1 : 0);
  db.run("DELETE FROM totp_attempts WHERE created_at < datetime('now', '-24 hours')");
}

// --- Admin user management (site-scoped accounts) ---

export interface AdminUser {
  id: number;
  username: string;
  created_at: string;
  last_login: string | null;
  sites: string[];
}

export function getUserSiteSlugs(userId: number): string[] {
  const rows = db.query(
    "SELECT site_slug FROM admin_user_sites WHERE user_id = ? ORDER BY site_slug"
  ).all(userId) as { site_slug: string }[];
  return rows.map(r => r.site_slug);
}

export function setUserSites(userId: number, slugs: string[]): void {
  const unique = Array.from(new Set((slugs || []).map(s => s.trim()).filter(Boolean)));
  const tx = db.transaction(() => {
    db.run("DELETE FROM admin_user_sites WHERE user_id = ?", userId);
    for (const slug of unique) {
      // Only assign slugs that correspond to a real site.
      const exists = db.query("SELECT 1 FROM sites WHERE slug = ?").get(slug);
      if (exists) db.run("INSERT INTO admin_user_sites (user_id, site_slug) VALUES (?, ?)", userId, slug);
    }
  });
  tx();
}

export function listAdminUsers(): AdminUser[] {
  const rows = db.query(
    "SELECT id, username, created_at, last_login FROM admin_users ORDER BY username"
  ).all() as Omit<AdminUser, "sites">[];
  return rows.map(r => ({ ...r, sites: getUserSiteSlugs(r.id) }));
}

export function getAdminUserByUsername(username: string): { id: number; username: string; password_hash: string } | null {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  return db.query(
    "SELECT id, username, password_hash FROM admin_users WHERE username = ?"
  ).get(normalized) as { id: number; username: string; password_hash: string } | null;
}

export async function createAdminUser(username: string, password: string, slugs: string[]): Promise<number> {
  const normalized = validateUsername(username);
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters");
  if (getAdminUserByUsername(normalized)) throw new Error(`User '${normalized}' already exists`);
  const hash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
  const result = db.run("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)", normalized, hash);
  const userId = Number(result.lastInsertRowid);
  setUserSites(userId, slugs || []);
  return userId;
}

export async function updateAdminUser(id: number, opts: { password?: string; sites?: string[] }): Promise<boolean> {
  const existing = db.query("SELECT id FROM admin_users WHERE id = ?").get(id) as { id: number } | null;
  if (!existing) return false;
  if (opts.password !== undefined) {
    if (opts.password.length < 8) throw new Error("Password must be at least 8 characters");
    const hash = await Bun.password.hash(opts.password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
    db.run("UPDATE admin_users SET password_hash = ? WHERE id = ?", hash, id);
  }
  if (opts.sites !== undefined) {
    setUserSites(id, opts.sites);
  }
  return true;
}

export function deleteAdminUser(id: number): boolean {
  // admin_user_sites rows cascade via FK. Also drop the user's active sessions.
  destroySessionsForUser(id);
  const result = db.run("DELETE FROM admin_users WHERE id = ?", id);
  return result.changes > 0;
}

// Verify a site-user's credentials. Records the attempt against the shared
// per-IP login rate limiter (same as the super-admin path). Returns the user
// id on success, or null on failure.
export async function verifyUserPassword(username: string, password: string, ip: string): Promise<number | null> {
  const user = getAdminUserByUsername(username);
  if (!user) {
    recordLoginAttempt(ip, false);
    return null;
  }
  const valid = await Bun.password.verify(password, user.password_hash);
  recordLoginAttempt(ip, valid);
  if (!valid) return null;
  db.run("UPDATE admin_users SET last_login = datetime('now') WHERE id = ?", user.id);
  return user.id;
}
