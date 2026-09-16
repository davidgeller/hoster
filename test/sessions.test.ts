// Session lifecycle: sliding expiry, the per-account session cap, the absence
// of IP pinning, and the admin API's behaviour when a session is gone.
//
// HOSTER_HOME is set in test/preload.ts.

import { beforeEach, describe, expect, test } from "bun:test";
import db from "../src/db";
import { createAdminUser, createSession, validateSession, getSessionUser, pruneSessionsForUser, sessionCookie } from "../src/auth";
import { handleAdminApi } from "../src/admin-api";
import { deleteSite, listSites } from "../src/sites";

const IP = "203.0.113.9";
const OTHER_IP = "198.51.100.4";

function reset() {
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM login_attempts");
  db.exec("DELETE FROM webauthn_credentials");
  db.exec("DELETE FROM admin_users");
  db.exec("DELETE FROM config");
  for (const s of listSites()) deleteSite(s.slug);
}
beforeEach(reset);

const expiresAt = (token: string) => (db.query("SELECT expires_at, last_seen_at, last_ip FROM sessions WHERE token = ?").get(token) as any);

describe("sessions", () => {
  test("a session survives an IP change", async () => {
    const uid = await createAdminUser("roamer", "roamer-pass-123", { isAdmin: true });
    const { sessionToken } = createSession(IP, uid);
    expect(validateSession(sessionToken, IP)).toBe(true);
    expect(validateSession(sessionToken, OTHER_IP)).toBe(true);
    expect(validateSession(sessionToken, "unknown")).toBe(true);
    expect(getSessionUser(sessionToken)?.username).toBe("roamer");
  });

  test("activity slides the expiry forward, bounded by the absolute ceiling", async () => {
    const uid = await createAdminUser("active", "active-pass-123", { isAdmin: true });
    const { sessionToken } = createSession(IP, uid);
    // Age the session artificially: created 2 days ago, last renewed then, about to expire.
    db.run("UPDATE sessions SET created_at = datetime('now', '-2 days'), last_seen_at = datetime('now', '-2 days'), expires_at = datetime('now', '+1 minute') WHERE token = ?", sessionToken);
    const before = expiresAt(sessionToken).expires_at;
    expect(validateSession(sessionToken, OTHER_IP)).toBe(true);
    const after = expiresAt(sessionToken);
    expect(after.expires_at > before).toBe(true);
    // Renewed to roughly now + 7 days (idle window).
    const days = (Date.parse(after.expires_at + "Z") - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(after.last_ip).toBe(OTHER_IP);

    // A session near the 30-day ceiling is renewed only up to that ceiling.
    db.run("UPDATE sessions SET created_at = datetime('now', '-29 days'), last_seen_at = datetime('now', '-1 day'), expires_at = datetime('now', '+1 minute') WHERE token = ?", sessionToken);
    expect(validateSession(sessionToken)).toBe(true);
    const capped = (Date.parse(expiresAt(sessionToken).expires_at + "Z") - Date.now()) / 86_400_000;
    expect(capped).toBeGreaterThan(0.9);
    expect(capped).toBeLessThan(1.1);

    // Renewal is throttled: a request seconds after the last one doesn't rewrite the row.
    const stamp = expiresAt(sessionToken);
    expect(validateSession(sessionToken)).toBe(true);
    expect(expiresAt(sessionToken).expires_at).toBe(stamp.expires_at);
  });

  test("an expired session is rejected and not revived by a request", async () => {
    const uid = await createAdminUser("late", "late-pass-12345", { isAdmin: true });
    const { sessionToken } = createSession(IP, uid);
    db.run("UPDATE sessions SET expires_at = datetime('now', '-1 minute') WHERE token = ?", sessionToken);
    expect(validateSession(sessionToken, IP)).toBe(false);
    expect(validateSession(sessionToken, IP)).toBe(false);
  });

  test("logging in again keeps the account's other sessions", async () => {
    const uid = await createAdminUser("multi", "multi-pass-12345", { isAdmin: true });
    const laptop = createSession(IP, uid).sessionToken;
    const phone = createSession(OTHER_IP, uid).sessionToken;
    pruneSessionsForUser(uid);
    const again = createSession(IP, uid).sessionToken;
    expect(validateSession(laptop)).toBe(true);
    expect(validateSession(phone)).toBe(true);
    expect(validateSession(again)).toBe(true);
  });

  test("the per-account cap drops the least recently used sessions", async () => {
    const uid = await createAdminUser("hoarder", "hoarder-pass-123", { isAdmin: true });
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      const t = createSession(IP, uid).sessionToken;
      // Spread last_seen_at so the ordering is deterministic (oldest first).
      db.run("UPDATE sessions SET last_seen_at = datetime('now', ?), created_at = datetime('now', ?) WHERE token = ?", `-${100 - i} minutes`, `-${100 - i} minutes`, t);
      tokens.push(t);
    }
    pruneSessionsForUser(uid); // makes room for one more (cap 10 → keeps 9)
    const alive = tokens.filter(t => validateSession(t));
    expect(alive.length).toBe(9);
    expect(alive).toEqual(tokens.slice(3));
    // Another account is untouched.
    const other = await createAdminUser("bystander", "bystander-pass-1", { isAdmin: false });
    const theirs = createSession(IP, other).sessionToken;
    pruneSessionsForUser(uid);
    expect(validateSession(theirs)).toBe(true);
  });

  test("cookie lifetime matches the 30-day ceiling", () => {
    expect(sessionCookie("abc")).toContain(`Max-Age=${30 * 86400}`);
    expect(sessionCookie("deleted", 0)).toContain("Max-Age=0");
  });

  test("admin API answers 401 for a dead session and the login flow issues a fresh one", async () => {
    const uid = await createAdminUser("root", "root-pass-12345", { isAdmin: true });
    const { sessionToken, csrfToken } = createSession(IP, uid);
    db.run("DELETE FROM sessions WHERE token = ?", sessionToken);
    const dead = await handleAdminApi(new Request("http://localhost/_admin/api/sites", {
      headers: { cookie: `hoster_session=${sessionToken}`, "x-csrf-token": csrfToken, "x-real-ip": IP },
    }), "/_admin/api/sites");
    expect(dead!.status).toBe(401);

    const first = createSession(IP, uid).sessionToken;
    const login = await handleAdminApi(new Request("http://localhost/_admin/api/login", {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": OTHER_IP },
      body: JSON.stringify({ username: "root", password: "root-pass-12345" }),
    }), "/_admin/api/login");
    expect(login!.status).toBe(200);
    expect(login!.headers.get("set-cookie")).toContain("hoster_session=");
    // The earlier session was not evicted by the new login.
    expect(validateSession(first, IP)).toBe(true);
  });
});
