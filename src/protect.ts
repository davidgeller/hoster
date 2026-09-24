// Protected paths: simple access codes in front of part (or all) of a web site.
//
// A rule is (site, path prefix). "/" covers the whole site; "/docs/private/"
// covers that folder and everything beneath it. Each rule carries any number
// of named codes — hand a different code to each audience and the request log
// shows which one a visitor used. When rules nest, the longest matching prefix
// decides, so a subfolder can have its own codes inside a protected site.
//
// This is deliberately light-weight access control, not account security:
// codes are stored as entered so an admin can look them up and re-share them.
// A correct code earns an HMAC-signed cookie bound to the rule, the code, and
// the code's current value — editing or deleting a code locks out everyone who
// used it, immediately.

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import db from "./db";

db.exec(`
  CREATE TABLE IF NOT EXISTS protect_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_slug TEXT NOT NULL,
    path_prefix TEXT NOT NULL,
    label TEXT,
    session_days INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(site_slug, path_prefix)
  );

  CREATE TABLE IF NOT EXISTS protect_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL REFERENCES protect_rules(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_protect_codes_rule ON protect_codes(rule_id);
`);

export interface ProtectRule {
  id: number;
  site_slug: string;
  path_prefix: string;
  label: string | null;
  session_days: number;
  enabled: number;
  created_at: string;
}

export interface ProtectCode {
  id: number;
  rule_id: number;
  name: string;
  code: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
}

export const CODE_PATTERN = /^[A-Za-z0-9]{4,64}$/;
const MAX_NAME = 80;
const MAX_LABEL = 120;
const COOKIE_PREFIX = "hoster_pa_";

// --- Validation ---

// Normalize an admin-entered prefix to "/a/b/" form: leading and trailing
// slash, no empty / dot segments, lowercase (matching is case-insensitive so a
// case-insensitive filesystem can't be used to side-step a rule).
export function normalizePrefix(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Path is required");
  const segs = raw.trim().split("/").filter(Boolean);
  for (const s of segs) {
    if (s === "." || s === "..") throw new Error("Path can't contain '.' or '..' segments");
    if (/[\s?#%\\]/.test(s)) throw new Error("Path can't contain spaces, '?', '#', '%' or '\\'");
  }
  return segs.length ? `/${segs.join("/").toLowerCase()}/` : "/";
}

function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new Error("Name is required");
  if (name.length > MAX_NAME) throw new Error(`Name must be ${MAX_NAME} characters or fewer`);
  return name;
}

function normalizeCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim() : "";
  if (!CODE_PATTERN.test(code)) throw new Error("Code must be 4–64 letters or digits");
  return code;
}

// Readable random code: no 0/O/1/I/L confusion.
export function generateCode(length = 8): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// --- In-memory index (every hosted request consults it) ---

interface IndexedRule extends ProtectRule { codes: ProtectCode[] }
let index: Map<string, IndexedRule[]> | null = null;

function loadIndex(): Map<string, IndexedRule[]> {
  if (index) return index;
  const rules = db.query("SELECT * FROM protect_rules WHERE enabled = 1").all() as ProtectRule[];
  const codes = db.query("SELECT * FROM protect_codes").all() as ProtectCode[];
  const bySite = new Map<string, IndexedRule[]>();
  for (const r of rules) {
    const entry: IndexedRule = { ...r, codes: codes.filter(c => c.rule_id === r.id) };
    const list = bySite.get(r.site_slug) || [];
    list.push(entry);
    bySite.set(r.site_slug, list);
  }
  // Longest prefix first so the first match is the most specific.
  for (const list of bySite.values()) list.sort((a, b) => b.path_prefix.length - a.path_prefix.length);
  index = bySite;
  return bySite;
}

export function invalidateProtectCache(): void {
  index = null;
}

// The rule governing `sitePath` (a site-relative URL path such as "/" or
// "/docs/a.html"), or null when the path is public.
export function findRule(slug: string, sitePath: string): IndexedRule | null {
  const rules = loadIndex().get(slug);
  if (!rules) return null;
  const p = sitePath.toLowerCase();
  // "/docs" (no trailing slash) is the same folder as "/docs/".
  const withSlash = p.endsWith("/") ? p : p + "/";
  for (const r of rules) {
    if (r.path_prefix === "/" || withSlash.startsWith(r.path_prefix)) return r;
  }
  return null;
}

export function siteHasProtection(slug: string): boolean {
  return (loadIndex().get(slug)?.length || 0) > 0;
}

// --- Cookie signing ---

function secret(): Buffer {
  const row = db.query("SELECT value FROM config WHERE key = 'protect_secret'").get() as { value: string } | null;
  if (row?.value) return Buffer.from(row.value, "hex");
  const fresh = randomBytes(32).toString("hex");
  db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('protect_secret', ?)", fresh);
  const saved = db.query("SELECT value FROM config WHERE key = 'protect_secret'").get() as { value: string };
  return Buffer.from(saved.value, "hex");
}
let secretCache: Buffer | null = null;
function key(): Buffer {
  return (secretCache ??= secret());
}
// Tests / backup restore replace the config table; forget the cached key.
export function resetProtectSecretCache(): void {
  secretCache = null;
}

function sign(ruleId: number, codeId: number, exp: number, code: string): string {
  return createHmac("sha256", key()).update(`${ruleId}|${codeId}|${exp}|${code.toLowerCase()}`).digest("base64url");
}

export function cookieName(ruleId: number): string {
  return `${COOKIE_PREFIX}${ruleId}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Does the request carry a valid pass for this rule? Returns the code used.
export function checkPass(req: Request, rule: IndexedRule): ProtectCode | null {
  const raw = readCookie(req, cookieName(rule.id));
  if (!raw) return null;
  const [codeIdStr, expStr, mac] = raw.split(".");
  const codeId = parseInt(codeIdStr, 10);
  const exp = parseInt(expStr, 10);
  if (!codeId || !exp || !mac || exp < Math.floor(Date.now() / 1000)) return null;
  const code = rule.codes.find(c => c.id === codeId);
  if (!code) return null; // deleted, or belongs to another rule
  const expected = Buffer.from(sign(rule.id, code.id, exp, code.code));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  noteUse(code.id, false);
  return code;
}

export function passCookie(rule: ProtectRule, code: ProtectCode): string {
  const maxAge = Math.max(1, rule.session_days) * 86400;
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const value = `${code.id}.${exp}.${sign(rule.id, code.id, exp, code.code)}`;
  return `${cookieName(rule.id)}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

// Constant-time-ish match of a submitted code against the rule's codes
// (case-insensitive, so "abc123" and "ABC123" both work).
export function matchCode(rule: IndexedRule, submitted: string): ProtectCode | null {
  const given = Buffer.from(submitted.trim().toLowerCase());
  let hit: ProtectCode | null = null;
  for (const c of rule.codes) {
    const want = Buffer.from(c.code.toLowerCase());
    if (want.length === given.length && timingSafeEqual(want, given)) hit = c;
  }
  return hit;
}

// Usage bookkeeping. An unlock always counts; ongoing requests refresh
// last_used_at at most once a minute per code so page views don't each write.
const lastTouch = new Map<number, number>();
export function noteUse(codeId: number, unlocked: boolean): void {
  const now = Date.now();
  if (!unlocked && now - (lastTouch.get(codeId) || 0) < 60_000) return;
  lastTouch.set(codeId, now);
  try {
    if (unlocked) db.run("UPDATE protect_codes SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?", codeId);
    else db.run("UPDATE protect_codes SET last_used_at = datetime('now') WHERE id = ?", codeId);
  } catch (_) {}
}

// --- Failed-attempt throttle (per IP, in memory) ---

const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 10;
const failures = new Map<string, number[]>();

export function isUnlockThrottled(ip: string): boolean {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter(t => now - t < FAIL_WINDOW_MS);
  if (recent.length) failures.set(ip, recent); else failures.delete(ip);
  return recent.length >= FAIL_LIMIT;
}

export function recordUnlockFailure(ip: string): void {
  const list = failures.get(ip) || [];
  list.push(Date.now());
  failures.set(ip, list);
  if (failures.size > 10_000) {
    // Bound memory under a spray of distinct IPs.
    const cutoff = Date.now() - FAIL_WINDOW_MS;
    for (const [k, v] of failures) if (!v.some(t => t > cutoff)) failures.delete(k);
  }
}

export function clearUnlockFailures(): void {
  failures.clear();
}

// --- Gate page ---

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function gatePage(opts: { siteName: string; label: string | null; slug: string; returnTo: string; error?: string }): string {
  const heading = opts.label || "This page is protected";
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(heading)} · ${esc(opts.siteName)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--text:#1d2129;--muted:#667085;--border:#d0d5dd;--accent:#2563eb;--danger:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1b1e25;--text:#e6e8ec;--muted:#98a2b3;--border:#344054;--accent:#6ea8fe;--danger:#f07167}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:360px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
.site{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
h1{font-size:20px;font-weight:600;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted)}
input{width:100%;padding:10px 12px;font:inherit;font-size:16px;letter-spacing:.06em;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{margin-top:12px;width:100%;padding:10px;font:inherit;font-weight:600;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--danger);font-size:14px;margin:10px 0 0}
</style></head><body>
<form class="card" method="post" action="/_hoster/unlock">
<div class="site">${esc(opts.siteName)}</div>
<h1>${esc(heading)}</h1>
<p>Enter your access code to continue.</p>
<input type="hidden" name="site" value="${esc(opts.slug)}">
<input type="hidden" name="return" value="${esc(opts.returnTo)}">
<input name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required autofocus aria-label="Access code" maxlength="64">
<button type="submit">Continue</button>
${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ""}
</form></body></html>`;
}

// Only same-origin absolute paths may be redirected to after unlocking.
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\r\n]/.test(raw)) return "/";
  return raw;
}

// --- Admin CRUD ---

export interface RuleWithCodes extends ProtectRule { codes: ProtectCode[] }

export function listRules(slug: string): RuleWithCodes[] {
  const rules = db.query("SELECT * FROM protect_rules WHERE site_slug = ? ORDER BY path_prefix").all(slug) as ProtectRule[];
  return rules.map(r => ({
    ...r,
    codes: db.query("SELECT * FROM protect_codes WHERE rule_id = ? ORDER BY created_at, id").all(r.id) as ProtectCode[],
  }));
}

export function getRule(slug: string, ruleId: number): ProtectRule | null {
  return db.query("SELECT * FROM protect_rules WHERE id = ? AND site_slug = ?").get(ruleId, slug) as ProtectRule | null;
}

function clampDays(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, Math.round(n)));
}

function normalizeLabel(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length > MAX_LABEL) throw new Error(`Heading must be ${MAX_LABEL} characters or fewer`);
  return s || null;
}

export function createRule(slug: string, input: { path_prefix?: unknown; label?: unknown; session_days?: unknown }): ProtectRule {
  const prefix = normalizePrefix(input.path_prefix);
  const label = normalizeLabel(input.label);
  const days = clampDays(input.session_days, 30);
  if (db.query("SELECT 1 FROM protect_rules WHERE site_slug = ? AND path_prefix = ?").get(slug, prefix)) {
    throw new Error(`${prefix} is already protected`);
  }
  const res = db.run("INSERT INTO protect_rules (site_slug, path_prefix, label, session_days) VALUES (?, ?, ?, ?)", slug, prefix, label, days);
  invalidateProtectCache();
  return getRule(slug, Number(res.lastInsertRowid))!;
}

export function updateRule(slug: string, ruleId: number, input: { path_prefix?: unknown; label?: unknown; session_days?: unknown; enabled?: unknown }): ProtectRule {
  const rule = getRule(slug, ruleId);
  if (!rule) throw new Error("Rule not found");
  const prefix = "path_prefix" in input ? normalizePrefix(input.path_prefix) : rule.path_prefix;
  if (prefix !== rule.path_prefix && db.query("SELECT 1 FROM protect_rules WHERE site_slug = ? AND path_prefix = ?").get(slug, prefix)) {
    throw new Error(`${prefix} is already protected`);
  }
  const label = "label" in input ? normalizeLabel(input.label) : rule.label;
  const days = "session_days" in input ? clampDays(input.session_days, rule.session_days) : rule.session_days;
  const enabled = "enabled" in input ? (input.enabled ? 1 : 0) : rule.enabled;
  db.run("UPDATE protect_rules SET path_prefix = ?, label = ?, session_days = ?, enabled = ? WHERE id = ?", prefix, label, days, enabled, ruleId);
  invalidateProtectCache();
  return getRule(slug, ruleId)!;
}

export function deleteRule(slug: string, ruleId: number): boolean {
  const res = db.run("DELETE FROM protect_rules WHERE id = ? AND site_slug = ?", ruleId, slug);
  invalidateProtectCache();
  return res.changes > 0;
}

export function deleteRulesForSite(slug: string): void {
  db.run("DELETE FROM protect_rules WHERE site_slug = ?", slug);
  invalidateProtectCache();
}

function assertCodeUnique(ruleId: number, code: string, exceptId: number | null): void {
  const clash = db.query("SELECT id FROM protect_codes WHERE rule_id = ? AND lower(code) = lower(?)").get(ruleId, code) as { id: number } | null;
  if (clash && clash.id !== exceptId) throw new Error("That code is already in use on this path");
}

export function addCode(slug: string, ruleId: number, input: { name?: unknown; code?: unknown }): ProtectCode {
  if (!getRule(slug, ruleId)) throw new Error("Rule not found");
  const name = normalizeName(input.name);
  const code = input.code == null || input.code === "" ? generateCode() : normalizeCode(input.code);
  assertCodeUnique(ruleId, code, null);
  const res = db.run("INSERT INTO protect_codes (rule_id, name, code) VALUES (?, ?, ?)", ruleId, name, code);
  invalidateProtectCache();
  return db.query("SELECT * FROM protect_codes WHERE id = ?").get(Number(res.lastInsertRowid)) as ProtectCode;
}

function getCode(slug: string, ruleId: number, codeId: number): ProtectCode | null {
  return db.query(`
    SELECT c.* FROM protect_codes c JOIN protect_rules r ON r.id = c.rule_id
    WHERE c.id = ? AND c.rule_id = ? AND r.site_slug = ?
  `).get(codeId, ruleId, slug) as ProtectCode | null;
}

export function updateCode(slug: string, ruleId: number, codeId: number, input: { name?: unknown; code?: unknown }): ProtectCode {
  const existing = getCode(slug, ruleId, codeId);
  if (!existing) throw new Error("Code not found");
  const name = "name" in input ? normalizeName(input.name) : existing.name;
  const code = "code" in input ? normalizeCode(input.code) : existing.code;
  assertCodeUnique(ruleId, code, codeId);
  db.run("UPDATE protect_codes SET name = ?, code = ? WHERE id = ?", name, code, codeId);
  invalidateProtectCache();
  return getCode(slug, ruleId, codeId)!;
}

export function deleteCode(slug: string, ruleId: number, codeId: number): boolean {
  if (!getCode(slug, ruleId, codeId)) return false;
  db.run("DELETE FROM protect_codes WHERE id = ?", codeId);
  invalidateProtectCache();
  return true;
}
