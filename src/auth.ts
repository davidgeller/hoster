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
const MIN_PASSWORD_LENGTH = 8;
const ARGON2_OPTS = { algorithm: "argon2id" as const, memoryCost: 65536, timeCost: 3 };

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// --- Accounts ---
//
// Every principal that can sign in to the admin panel is a row in admin_users.
// There are two kinds, distinguished by `is_admin`:
//
//   * Administrators (is_admin = 1) see and control the whole platform: every
//     site, Settings, users, MCP/OAuth, backups. A deployment may have any
//     number of them; the last one can never be demoted or deleted.
//   * Site users (is_admin = 0) are granted specific sites via
//     admin_user_sites and see the full admin UI for those sites only.
//
// Every account — admin or not — owns its own password, optional TOTP, and
// optional passkeys. Before v1.5 the platform had a single anonymous
// "super-admin" whose password/TOTP lived in the config table and who signed
// in with a blank username. migrateLegacyAdmin() below converts that identity
// into an ordinary administrator row (username "admin") the first time the
// new binary starts, carrying sessions and passkeys across so nobody is
// logged out or locked out by the upgrade.
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

// Columns added in v1.5 (multi-admin). Idempotent for existing databases.
try { db.exec("ALTER TABLE admin_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN totp_secret TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN totp_recovery_codes TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN totp_pending_secret TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN webauthn_user_handle TEXT"); } catch (_) {}
// Who performed an audited action. NULL for pre-v1.5 rows and system events.
try { db.exec("ALTER TABLE audit_log ADD COLUMN actor TEXT"); } catch (_) {}
// Which account a pending 2FA token belongs to.
try { db.exec("ALTER TABLE pending_2fa ADD COLUMN user_id INTEGER"); } catch (_) {}

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

function validatePassword(password: string): void {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2_OPTS);
}

// A real Argon2id hash of a random secret, verified against when a login names
// a username that doesn't exist. Keeps the "no such user" path as slow as the
// "wrong password" path so response timing doesn't enumerate usernames.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(randomBytes(32).toString("hex"));
  return dummyHashPromise;
}

export interface Principal {
  userId: number;
  username: string;
  isAdmin: boolean;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  totp_secret: string | null;
  totp_enabled: number;
  totp_recovery_codes: string | null;
  totp_pending_secret: string | null;
  webauthn_user_handle: string | null;
  created_at: string;
  last_login: string | null;
}

function getUserRow(id: number): UserRow | null {
  return db.query("SELECT * FROM admin_users WHERE id = ?").get(id) as UserRow | null;
}

function getUserRowByUsername(username: string): UserRow | null {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  return db.query("SELECT * FROM admin_users WHERE username = ?").get(normalized) as UserRow | null;
}

function toPrincipal(row: UserRow): Principal {
  return { userId: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}

export function getUser(id: number): Principal | null {
  const row = getUserRow(id);
  return row ? toPrincipal(row) : null;
}

export function getUserByUsername(username: string): Principal | null {
  const row = getUserRowByUsername(username);
  return row ? toPrincipal(row) : null;
}

export function countAdmins(): number {
  const row = db.query("SELECT COUNT(*) as cnt FROM admin_users WHERE is_admin = 1").get() as { cnt: number };
  return row.cnt;
}

// The platform is "set up" once at least one administrator exists.
export function isSetup(): boolean {
  return countAdmins() > 0;
}

// --- Legacy super-admin migration (pre-v1.5 databases) ---

function getConfigValue(key: string): string | null {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function deleteConfigValue(key: string): void {
  db.run("DELETE FROM config WHERE key = ?", key);
}

// Convert the anonymous config-table admin into an admin_users row. Runs at
// startup and after a backup restore (older backups still carry the config
// keys). No-op when there's nothing to migrate.
export function migrateLegacyAdmin(): { migrated: boolean; username?: string } {
  const legacyHash = getConfigValue("admin_password_hash");
  if (!legacyHash) return { migrated: false };

  const tx = db.transaction(() => {
    // Prefer "admin"; only fall back if a site user already took that name.
    let username = "admin";
    if (getUserRowByUsername(username)) username = "platform-admin";
    let suffix = 2;
    while (getUserRowByUsername(username)) username = `platform-admin${suffix++}`;

    const result = db.run(
      `INSERT INTO admin_users
         (username, password_hash, is_admin, totp_secret, totp_enabled, totp_recovery_codes, webauthn_user_handle)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      username,
      legacyHash,
      getConfigValue("totp_secret"),
      getConfigValue("totp_enabled") === "1" ? 1 : 0,
      getConfigValue("totp_recovery_codes"),
      getConfigValue("webauthn_user_handle")
    );
    const userId = Number(result.lastInsertRowid);

    // Passkeys, live sessions, and in-flight challenges that belonged to the
    // anonymous admin now belong to this account.
    db.run("UPDATE webauthn_credentials SET user_id = ? WHERE user_id IS NULL", userId);
    db.run("UPDATE sessions SET user_id = ? WHERE user_id IS NULL", userId);
    db.run("UPDATE webauthn_challenges SET user_id = ? WHERE user_id IS NULL", userId);
    db.run("UPDATE pending_2fa SET user_id = ? WHERE user_id IS NULL", userId);

    for (const key of ["admin_password_hash", "totp_secret", "totp_enabled", "totp_recovery_codes", "totp_pending_secret", "webauthn_user_handle"]) {
      deleteConfigValue(key);
    }
    db.run(
      "INSERT INTO audit_log (action, detail, ip, actor) VALUES (?, ?, ?, ?)",
      "legacy_admin_migrated", `Platform admin is now user '${username}'`, "system", null
    );
    return username;
  });
  const username = tx();
  return { migrated: true, username };
}

// The webauthn table may not exist yet when this module loads (webauthn.ts
// creates it), so the migration is invoked from index.ts after every module
// has registered its schema — and again after a restore.

// --- Login rate limiting (per IP) ---

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

// --- Password verification ---

// Sign-in: username + password. Records the attempt against the per-IP
// lockout. Returns the principal on success, null otherwise. Unknown usernames
// still pay for an Argon2 verification so timing doesn't reveal which names
// exist.
export async function verifyUserPassword(username: string, password: string, ip: string): Promise<Principal | null> {
  const user = getUserRowByUsername(username);
  if (!user) {
    await Bun.password.verify(password || "", await dummyHash());
    recordLoginAttempt(ip, false);
    return null;
  }
  const valid = await Bun.password.verify(password, user.password_hash);
  recordLoginAttempt(ip, valid);
  if (!valid) return null;
  db.run("UPDATE admin_users SET last_login = datetime('now') WHERE id = ?", user.id);
  return toPrincipal(user);
}

// Step-up: re-check the password of an already-authenticated account before a
// sensitive change (disable 2FA, add/remove passkey, restore a backup). Failed
// attempts count toward the same per-IP lockout as logins so a hijacked
// session can't brute-force its way through.
export async function verifyPasswordForUser(userId: number, password: string, ip: string): Promise<boolean> {
  const user = getUserRow(userId);
  if (!user) return false;
  const valid = await Bun.password.verify(password || "", user.password_hash);
  recordLoginAttempt(ip, valid);
  return valid;
}

export async function setUserPassword(userId: number, password: string): Promise<void> {
  validatePassword(password);
  const hash = await hashPassword(password);
  db.run("UPDATE admin_users SET password_hash = ? WHERE id = ?", hash, userId);
}

// --- Sessions ---

export function createSession(ip: string, userId: number): { sessionToken: string; csrfToken: string } {
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

// Resolve the account behind a session. Returns null for an invalid or expired
// token, or one whose account has since been deleted (the JOIN drops it).
export function getSessionUser(token: string | undefined): Principal | null {
  if (!token) return null;
  const row = db.query(
    `SELECT u.id, u.username, u.is_admin
     FROM sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token) as { id: number; username: string; is_admin: number } | null;
  if (!row) return null;
  return { userId: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}

// Delete sessions belonging to one account. Used to rotate a principal's
// session on login without evicting other logged-in users.
export function destroySessionsForUser(userId: number): void {
  db.run("DELETE FROM sessions WHERE user_id = ?", userId);
}

export function validateSession(token: string | undefined, ip?: string): boolean {
  if (!token) return false;
  const row = db.query(
    `SELECT s.ip FROM sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token) as { ip: string | null } | null;
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

// Destroy every session — used after a backup restore, which replaces every
// account's credentials.
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

const MAX_AUDIT_DETAIL = 500;

export function auditLog(action: string, detail: string | null, ip: string, actor: string | null = null): void {
  const trimmed = detail && detail.length > MAX_AUDIT_DETAIL ? detail.slice(0, MAX_AUDIT_DETAIL) + "…" : detail;
  db.run("INSERT INTO audit_log (action, detail, ip, actor) VALUES (?, ?, ?, ?)", action, trimmed, ip, actor);
  // Prune entries older than 90 days. SQL-side datetime keeps formats aligned.
  db.run("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')");
}

export function getAuditLog(limit: number = 50): any[] {
  return db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as any[];
}

// --- TOTP 2FA (per account) ---

export function isTotpEnabled(userId: number): boolean {
  const row = db.query("SELECT totp_enabled FROM admin_users WHERE id = ?").get(userId) as { totp_enabled: number } | null;
  return row?.totp_enabled === 1;
}

function totpFor(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

export function generateTotpSecret(label: string = "Admin"): { secret: string; uri: string } {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
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
  // Allow 1 window of drift (±30 seconds)
  const delta = totpFor(secret, "Admin").validate({ token: code, window: 1 });
  return delta !== null;
}

export function getTotpSecret(userId: number): string | null {
  const row = db.query("SELECT totp_secret FROM admin_users WHERE id = ?").get(userId) as { totp_secret: string | null } | null;
  return row?.totp_secret ?? null;
}

export function enableTotp(userId: number, secret: string, recoveryCodes: string[]): void {
  // Store hashed recovery codes — originals are shown to user once, never stored
  const hashed = recoveryCodes.map(c => sha256(c.toLowerCase().replace(/[\s-]/g, "")));
  db.run(
    "UPDATE admin_users SET totp_secret = ?, totp_enabled = 1, totp_recovery_codes = ? WHERE id = ?",
    secret, JSON.stringify(hashed), userId
  );
}

export function disableTotp(userId: number): void {
  db.run(
    `UPDATE admin_users SET totp_secret = NULL, totp_enabled = 0,
       totp_recovery_codes = NULL, totp_pending_secret = NULL WHERE id = ?`,
    userId
  );
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

export function useRecoveryCode(userId: number, code: string): boolean {
  const row = db.query("SELECT totp_recovery_codes FROM admin_users WHERE id = ?").get(userId) as { totp_recovery_codes: string | null } | null;
  if (!row?.totp_recovery_codes) return false;
  const hashes: string[] = JSON.parse(row.totp_recovery_codes);
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
  db.run("UPDATE admin_users SET totp_recovery_codes = ? WHERE id = ?", JSON.stringify(hashes), userId);
  return true;
}

export function getRemainingRecoveryCodes(userId: number): number {
  const row = db.query("SELECT totp_recovery_codes FROM admin_users WHERE id = ?").get(userId) as { totp_recovery_codes: string | null } | null;
  if (!row?.totp_recovery_codes) return 0;
  return JSON.parse(row.totp_recovery_codes).length;
}

// Pending secret during setup (not yet confirmed)
export function setPendingTotpSecret(userId: number, secret: string): void {
  db.run("UPDATE admin_users SET totp_pending_secret = ? WHERE id = ?", secret, userId);
}

export function getPendingTotpSecret(userId: number): string | null {
  const row = db.query("SELECT totp_pending_secret FROM admin_users WHERE id = ?").get(userId) as { totp_pending_secret: string | null } | null;
  return row?.totp_pending_secret ?? null;
}

export function clearPendingTotpSecret(userId: number): void {
  db.run("UPDATE admin_users SET totp_pending_secret = NULL WHERE id = ?", userId);
}

// Verify a TOTP or recovery code for one account. Used by the login 2FA step
// and the OAuth consent screen.
export function verifyTotpOrRecovery(userId: number, code: string): boolean {
  const secret = getTotpSecret(userId);
  if (!secret) return false;
  const cleaned = (code || "").trim().replace(/\s/g, "");
  if (!cleaned) return false;
  return verifyTotpCode(secret, cleaned) || useRecoveryCode(userId, cleaned);
}

// Pending 2FA sessions — password verified but awaiting TOTP code.
// SQL-side datetime keeps expires_at in the same format that the validate/consume
// queries (datetime('now')) produce, so expiry comparisons actually work.
export function createPending2faToken(ip: string, userId: number): string {
  const token = randomBytes(32).toString("hex");
  const hash = sha256(token);
  db.run(
    "INSERT INTO pending_2fa (token_hash, expires_at, ip, user_id) VALUES (?, datetime('now', '+5 minutes'), ?, ?)",
    hash, ip, userId
  );
  return token;
}

// Look up (without consuming) the account a pending token belongs to, so the
// 2FA step can check the code against the right secret.
export function peekPending2faUser(token: string | undefined): number | null {
  if (!token) return null;
  const row = db.query(
    "SELECT user_id FROM pending_2fa WHERE token_hash = ? AND expires_at > datetime('now')"
  ).get(sha256(token)) as { user_id: number | null } | null;
  return row?.user_id ?? null;
}

// Atomically validate and consume — prevents race conditions. Returns the
// account id the token was issued for, or null.
// IP must match the IP that began the login (the password step). Otherwise a
// stolen pending_token could complete 2FA from a different machine.
export function consumePending2faToken(token: string, ip: string): number | null {
  const hash = sha256(token);
  // Select-then-delete in a transaction for atomicity
  const consume = db.transaction(() => {
    const row = db.query(
      "SELECT token_hash, ip, user_id FROM pending_2fa WHERE token_hash = ? AND expires_at > datetime('now')"
    ).get(hash) as { token_hash: string; ip: string | null; user_id: number | null } | null;
    if (!row || row.user_id == null) return null;
    // IP-binding: reject if the consume attempt comes from a different address.
    // 'unknown' on either side is treated as a mismatch (don't authorize without
    // a verifiable IP). This is conservative — legitimate IP changes mid-flow
    // (mobile/Wi-Fi handoff in 5 minutes) require restarting the login.
    if (!row.ip || row.ip === "unknown" || ip === "unknown" || row.ip !== ip) return null;
    db.run("DELETE FROM pending_2fa WHERE token_hash = ?", hash);
    return row.user_id;
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

// --- Account management ---

export interface AdminUser {
  id: number;
  username: string;
  is_admin: boolean;
  totp_enabled: boolean;
  passkey_count: number;
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
    `SELECT u.id, u.username, u.is_admin, u.totp_enabled, u.created_at, u.last_login,
            (SELECT COUNT(*) FROM webauthn_credentials c WHERE c.user_id = u.id) AS passkey_count
     FROM admin_users u ORDER BY u.is_admin DESC, u.username`
  ).all() as Array<{ id: number; username: string; is_admin: number; totp_enabled: number; created_at: string; last_login: string | null; passkey_count: number }>;
  return rows.map(r => ({
    id: r.id,
    username: r.username,
    is_admin: r.is_admin === 1,
    totp_enabled: r.totp_enabled === 1,
    passkey_count: r.passkey_count,
    created_at: r.created_at,
    last_login: r.last_login,
    sites: r.is_admin === 1 ? [] : getUserSiteSlugs(r.id),
  }));
}

// Create an account. The very first administrator is created through the
// unauthenticated setup endpoint; everything after that goes through an admin.
export async function createAdminUser(
  username: string, password: string, opts: { isAdmin?: boolean; sites?: string[] } = {}
): Promise<number> {
  const normalized = validateUsername(username);
  validatePassword(password);
  if (getUserRowByUsername(normalized)) throw new Error(`User '${normalized}' already exists`);
  const hash = await hashPassword(password);
  const result = db.run(
    "INSERT INTO admin_users (username, password_hash, is_admin) VALUES (?, ?, ?)",
    normalized, hash, opts.isAdmin ? 1 : 0
  );
  const userId = Number(result.lastInsertRowid);
  if (!opts.isAdmin) setUserSites(userId, opts.sites || []);
  return userId;
}

export async function updateAdminUser(
  id: number, opts: { password?: string; sites?: string[]; isAdmin?: boolean }
): Promise<boolean> {
  const existing = getUserRow(id);
  if (!existing) return false;
  if (opts.password !== undefined) {
    await setUserPassword(id, opts.password);
  }
  if (opts.isAdmin !== undefined) {
    const wantAdmin = opts.isAdmin ? 1 : 0;
    if (existing.is_admin === 1 && wantAdmin === 0 && countAdmins() <= 1) {
      throw new Error("Cannot remove administrator rights from the last administrator");
    }
    db.run("UPDATE admin_users SET is_admin = ? WHERE id = ?", wantAdmin, id);
    // Administrators see every site; a per-site grant list is meaningless for
    // them and would be stale if they're later demoted.
    if (wantAdmin === 1) db.run("DELETE FROM admin_user_sites WHERE user_id = ?", id);
  }
  const nowAdmin = opts.isAdmin !== undefined ? opts.isAdmin : existing.is_admin === 1;
  if (opts.sites !== undefined && !nowAdmin) {
    setUserSites(id, opts.sites);
  }
  return true;
}

export function deleteAdminUser(id: number): boolean {
  const existing = getUserRow(id);
  if (!existing) return false;
  if (existing.is_admin === 1 && countAdmins() <= 1) {
    throw new Error("Cannot delete the last administrator");
  }
  // admin_user_sites rows cascade via FK. Also drop the user's active sessions,
  // passkeys, and any pending login state.
  destroySessionsForUser(id);
  db.run("DELETE FROM webauthn_credentials WHERE user_id = ?", id);
  db.run("DELETE FROM webauthn_challenges WHERE user_id = ?", id);
  db.run("DELETE FROM pending_2fa WHERE user_id = ?", id);
  const result = db.run("DELETE FROM admin_users WHERE id = ?", id);
  return result.changes > 0;
}

// Can this account act on this site? Admins: always. Site users: only if granted.
export function userCanAccessSite(principal: Principal, slug: string): boolean {
  if (principal.isAdmin) return true;
  const row = db.query("SELECT 1 FROM admin_user_sites WHERE user_id = ? AND site_slug = ?").get(principal.userId, slug);
  return !!row;
}
