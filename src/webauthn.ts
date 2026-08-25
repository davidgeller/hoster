import db from "./db";
import { randomBytes } from "crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

// --- Passkeys (WebAuthn) ---
//
// A passkey is a standalone login for the platform super-admin: one tap on
// Touch ID / Windows Hello / a security key replaces password + TOTP entirely.
// Password (and TOTP, if enabled) stay available as the fallback — a passkey
// must never be the only way in, because the admin panel is also reachable
// over plain HTTP on a LAN address where WebAuthn cannot run at all.
//
// Two properties of WebAuthn shape the schema below:
//
//   1. A credential is bound to an "RP ID" — the hostname of the page that
//      created it. Hoster sits behind whatever proxy the operator chose
//      (Cloudflare Tunnel, Caddy, nginx) and can answer on several hostnames,
//      so the RP ID is derived per-request from the Origin header and stored
//      with the credential. A passkey registered at admin.example.com is
//      simply not offered at another hostname; register one per host you use.
//   2. WebAuthn only runs in a secure context: HTTPS, or localhost. There is
//      no workaround for http://<lan-ip>:3500 — getRpContext() returns null
//      there and the UI hides the passkey affordances.

const CHALLENGE_TTL_MINUTES = 5;
const RP_NAME = "Hoster";
const MAX_LABEL_LENGTH = 60;

db.exec(`
  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    rp_id TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_used TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_webauthn_rp ON webauthn_credentials(rp_id);

  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    user_id INTEGER,
    rp_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

export interface StoredCredential {
  id: number;
  user_id: number | null;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  rp_id: string;
  label: string;
  created_at: string;
  last_used: string | null;
}

export interface RpContext {
  rpId: string;
  origin: string;
}

// Resolve the relying-party identity for this request. Returns null when the
// request did not arrive over a WebAuthn-capable origin, which is the same
// condition under which the browser would refuse the API anyway.
//
// The Origin header is authoritative: browsers send it on every POST, and
// whatever it says is also what the authenticator signs into clientDataJSON.
// The Host fallback only matters for non-browser callers; if it guesses the
// scheme wrong the origin comparison fails closed during verification.
export function getRpContext(req: Request): RpContext | null {
  const originHeader = req.headers.get("origin");
  let url: URL;
  if (originHeader) {
    try { url = new URL(originHeader); } catch { return null; }
  } else {
    const host = req.headers.get("host");
    if (!host) return null;
    const looksLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    const proto = looksLocal ? "http" : (req.headers.get("x-forwarded-proto") || "https");
    try { url = new URL(`${proto}://${host}`); } catch { return null; }
  }

  const hostname = url.hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  // Secure-context rule: HTTPS anywhere, or plain HTTP on loopback only.
  if (url.protocol !== "https:" && !isLocal) return null;
  return { rpId: hostname, origin: url.origin };
}

// Stable, non-PII user handle for the super-admin, generated once and reused
// so every passkey registered across hostnames belongs to the same account in
// the authenticator's UI.
function getSuperAdminUserHandle(): Uint8Array {
  const row = db.query("SELECT value FROM config WHERE key = 'webauthn_user_handle'").get() as { value: string } | null;
  if (row?.value) return new Uint8Array(Buffer.from(row.value, "hex"));
  const handle = randomBytes(32).toString("hex");
  db.run("INSERT INTO config (key, value) VALUES ('webauthn_user_handle', ?)", handle);
  return new Uint8Array(Buffer.from(handle, "hex"));
}

function userHandleFor(userId: number | null): Uint8Array {
  if (userId == null) return getSuperAdminUserHandle();
  // Site-scoped users don't have passkeys yet; derive deterministically so the
  // column stays meaningful if that changes.
  return new Uint8Array(Buffer.from(`user-${userId}`.padEnd(32, "\0"), "utf8"));
}

function sanitizeLabel(label: string | undefined, fallback: string): string {
  // Strip control characters; the label is rendered back into the settings UI.
  const cleaned = Array.from(label || "")
    .filter(ch => { const c = ch.codePointAt(0)!; return c >= 32 && c !== 127; })
    .join("")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, MAX_LABEL_LENGTH);
}

export function listCredentials(userId: number | null = null): StoredCredential[] {
  return db.query(
    `SELECT * FROM webauthn_credentials
     WHERE user_id IS ? ORDER BY created_at DESC`
  ).all(userId) as StoredCredential[];
}

function credentialsForRp(rpId: string, userId: number | null): StoredCredential[] {
  return db.query(
    "SELECT * FROM webauthn_credentials WHERE rp_id = ? AND user_id IS ?"
  ).all(rpId, userId) as StoredCredential[];
}

// Does this hostname have at least one passkey the login screen can offer?
export function hasCredentialsForRp(rpId: string, userId: number | null = null): boolean {
  const row = db.query(
    "SELECT COUNT(*) as cnt FROM webauthn_credentials WHERE rp_id = ? AND user_id IS ?"
  ).get(rpId, userId) as { cnt: number };
  return row.cnt > 0;
}

export function deleteCredential(id: number, userId: number | null = null): boolean {
  const result = db.run("DELETE FROM webauthn_credentials WHERE id = ? AND user_id IS ?", id, userId);
  return result.changes > 0;
}

// --- Challenge storage ---
//
// Challenges are single-use and IP-bound, mirroring pending_2fa: a challenge
// handed to one client cannot be completed from another address.

function storeChallenge(challenge: string, purpose: "register" | "login", userId: number | null, rp: RpContext, ip: string): void {
  db.run(
    `INSERT INTO webauthn_challenges (challenge, purpose, user_id, rp_id, origin, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    challenge, purpose, userId, rp.rpId, rp.origin, ip, `+${CHALLENGE_TTL_MINUTES} minutes`
  );
}

// Atomically fetch and delete — a challenge is valid exactly once.
function consumeChallenge(challenge: string, purpose: "register" | "login", ip: string): { rp_id: string; origin: string; user_id: number | null } | null {
  const consume = db.transaction(() => {
    const row = db.query(
      `SELECT rp_id, origin, user_id, ip FROM webauthn_challenges
       WHERE challenge = ? AND purpose = ? AND expires_at > datetime('now')`
    ).get(challenge, purpose) as { rp_id: string; origin: string; user_id: number | null; ip: string | null } | null;
    if (!row) return null;
    // IP-binding: the challenge must be completed from the address that
    // requested it. Deliberately weaker than consumePending2faToken, which
    // rejects an unverifiable ("unknown") address outright: a pending 2FA
    // token is a bearer credential, so holding it plus a code is enough to get
    // in. A WebAuthn challenge is not — completing it requires a signature
    // from the private key. Treating "unknown" as fatal here would only make
    // passkeys impossible on every deployment that doesn't sit behind a proxy
    // setting cf-connecting-ip or x-real-ip, localhost included, while buying
    // no security. Differing addresses are still refused.
    if ((row.ip || "unknown") !== ip) return null;
    db.run("DELETE FROM webauthn_challenges WHERE challenge = ?", challenge);
    return { rp_id: row.rp_id, origin: row.origin, user_id: row.user_id };
  });
  return consume();
}

export function cleanExpiredChallenges(): void {
  db.run("DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')");
}

// --- Registration ---

export async function beginRegistration(rp: RpContext, ip: string, userId: number | null = null): Promise<any> {
  const existing = credentialsForRp(rp.rpId, userId);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpId,
    userID: userHandleFor(userId),
    userName: userId == null ? "admin" : `user-${userId}`,
    userDisplayName: userId == null ? "Hoster Admin" : `Hoster user ${userId}`,
    attestationType: "none",
    // Don't let the same authenticator register twice for this hostname.
    excludeCredentials: existing.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: {
      // Discoverable credential: required so the login screen can offer the
      // passkey without the user typing anything first.
      residentKey: "required",
      // User verification required so the passkey is multi-factor on its own
      // (device possession + biometric/PIN) and can stand in for password+TOTP.
      userVerification: "required",
    },
  });
  storeChallenge(options.challenge, "register", userId, rp, ip);
  return options;
}

export async function finishRegistration(
  rp: RpContext,
  ip: string,
  response: any,
  label: string | undefined,
  userId: number | null = null
): Promise<StoredCredential> {
  if (!response?.id) throw new Error("Malformed registration response");
  const challenge = response?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")).challenge
    : null;
  if (!challenge) throw new Error("Malformed registration response");

  const stored = consumeChallenge(challenge, "register", ip);
  if (!stored) throw new Error("Registration expired or IP changed. Please try again.");
  if (stored.user_id !== userId) throw new Error("Registration does not belong to this account");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: stored.origin,
    expectedRPID: stored.rp_id,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey could not be verified");
  }

  const { credential } = verification.registrationInfo;
  const transports = response.response?.transports ?? credential.transports ?? null;
  const defaultLabel = `Passkey on ${stored.rp_id}`;

  db.run(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, transports, rp_id, label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId,
    credential.id,
    Buffer.from(credential.publicKey).toString("base64url"),
    credential.counter,
    transports ? JSON.stringify(transports) : null,
    stored.rp_id,
    sanitizeLabel(label, defaultLabel)
  );

  return db.query("SELECT * FROM webauthn_credentials WHERE credential_id = ?")
    .get(credential.id) as StoredCredential;
}

// --- Authentication ---

export async function beginLogin(rp: RpContext, ip: string): Promise<any> {
  if (!hasCredentialsForRp(rp.rpId, null)) {
    throw new Error("No passkeys registered for this address");
  }
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    // Discoverable credentials — the browser picks, we identify the account
    // from the credential ID in the assertion. Omitting allowCredentials also
    // avoids leaking which passkeys exist to an unauthenticated caller.
    userVerification: "required",
  });
  storeChallenge(options.challenge, "login", null, rp, ip);
  return options;
}

// Verifies an assertion and returns the credential it authenticated, or throws.
// The caller creates the session — this function never mints one itself.
export async function finishLogin(rp: RpContext, ip: string, response: any): Promise<StoredCredential> {
  if (!response?.id) throw new Error("Malformed passkey response");
  const challenge = response?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")).challenge
    : null;
  if (!challenge) throw new Error("Malformed passkey response");

  const stored = consumeChallenge(challenge, "login", ip);
  if (!stored) throw new Error("Sign-in expired or IP changed. Please try again.");

  const credential = db.query(
    "SELECT * FROM webauthn_credentials WHERE credential_id = ? AND rp_id = ?"
  ).get(response.id, stored.rp_id) as StoredCredential | null;
  if (!credential) throw new Error("Unrecognized passkey");

  // Only the super-admin has passkeys today; refuse anything else outright
  // rather than silently minting a session for an unexpected principal.
  if (credential.user_id !== null) throw new Error("Unrecognized passkey");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: stored.origin,
    expectedRPID: stored.rp_id,
    requireUserVerification: true,
    credential: {
      id: credential.credential_id,
      publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64url")),
      counter: credential.counter,
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    },
  });

  if (!verification.verified) throw new Error("Passkey could not be verified");

  // Persist the signature counter — verifyAuthenticationResponse throws on a
  // regression, which is how cloned authenticators are caught.
  db.run(
    "UPDATE webauthn_credentials SET counter = ?, last_used = datetime('now') WHERE id = ?",
    verification.authenticationInfo.newCounter, credential.id
  );

  return { ...credential, counter: verification.authenticationInfo.newCounter };
}
