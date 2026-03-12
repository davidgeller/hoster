import db from "./db";
import { randomBytes } from "crypto";

const SESSION_DURATION_HOURS = 72;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

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
  const cutoff = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const row = db.query(
    "SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND created_at > ? AND success = 0"
  ).get(ip, cutoff) as { cnt: number };
  return row.cnt >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginAttempt(ip: string, success: boolean): void {
  db.run("INSERT INTO login_attempts (ip, success) VALUES (?, ?)", ip, success ? 1 : 0);
  // Clean old attempts
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.run("DELETE FROM login_attempts WHERE created_at < ?", cutoff);
}

export async function verifyPassword(password: string, ip: string): Promise<boolean> {
  const hash = getAdminPasswordHash();
  if (!hash) return false;

  const valid = await Bun.password.verify(password, hash);
  recordLoginAttempt(ip, valid);
  return valid;
}

export function createSession(ip: string): string {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();
  db.run("INSERT INTO sessions (token, expires_at, ip) VALUES (?, ?, ?)", token, expires, ip);
  return token;
}

export function validateSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = db.query(
    "SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token) as { token: string } | null;
  return row !== null;
}

export function destroySession(token: string): void {
  db.run("DELETE FROM sessions WHERE token = ?", token);
}

export function cleanExpiredSessions(): void {
  db.run("DELETE FROM sessions WHERE expires_at < datetime('now')");
}

export function getClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
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
