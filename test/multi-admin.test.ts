// Multi-administrator account model (v1.5).
//
// Covers the account primitives in src/auth.ts, the legacy-admin migration,
// and the authorization gates in src/admin-api.ts (which accounts may reach
// which routes, and where a step-up password is demanded).

import { beforeEach, describe, expect, test } from "bun:test";
import db from "../src/db";
import {
  createAdminUser, updateAdminUser, deleteAdminUser, listAdminUsers,
  verifyUserPassword, verifyPasswordForUser, countAdmins, isSetup,
  migrateLegacyAdmin, getUserByUsername, userCanAccessSite,
  createSession, getSessionUser, validateSession,
  createPending2faToken, peekPending2faUser, consumePending2faToken,
  enableTotp, isTotpEnabled, useRecoveryCode, getRemainingRecoveryCodes,
} from "../src/auth";
import { createBlankSite, deleteSite, listSites } from "../src/sites";
import { handleAdminApi } from "../src/admin-api";

const IP = "203.0.113.9";
const PW = "correct-horse-battery";

function resetAccounts() {
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM pending_2fa");
  db.exec("DELETE FROM login_attempts");
  db.exec("DELETE FROM webauthn_credentials");
  db.exec("DELETE FROM admin_users");
  db.exec("DELETE FROM config");
  for (const s of listSites()) deleteSite(s.slug);
}

beforeEach(resetAccounts);

// Drive the admin API as a given session. Sets the cookie + CSRF header the
// handler expects so tests exercise the real gates, not a shortcut.
async function asUser(userId: number, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const { sessionToken, csrfToken } = createSession(IP, userId);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `hoster_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
      "x-real-ip": IP,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleAdminApi(req, path);
  if (!res) throw new Error(`No route for ${method} ${path}`);
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function anon(method: string, path: string, body?: any) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { "x-real-ip": IP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = (await handleAdminApi(req, path))!;
  return { status: res.status, data: await res.json(), headers: res.headers };
}

describe("accounts", () => {
  test("platform is not set up until an administrator exists", async () => {
    expect(isSetup()).toBe(false);
    await createAdminUser("editor", PW, { sites: [] });
    expect(isSetup()).toBe(false); // a site user is not enough
    await createAdminUser("root", PW, { isAdmin: true });
    expect(isSetup()).toBe(true);
    expect(countAdmins()).toBe(1);
  });

  test("usernames are normalized and validated", async () => {
    const id = await createAdminUser("  Alice.Admin ", PW, { isAdmin: true });
    expect(getUserByUsername("alice.admin")?.userId).toBe(id);
    await expect(createAdminUser("has space", PW, {})).rejects.toThrow(/Username/);
    await expect(createAdminUser("alice.admin", PW, {})).rejects.toThrow(/already exists/);
    await expect(createAdminUser("short", "abc", {})).rejects.toThrow(/at least 8/);
  });

  test("password verification returns the principal and records attempts", async () => {
    await createAdminUser("root", PW, { isAdmin: true });
    const ok = await verifyUserPassword("ROOT", PW, IP);
    expect(ok?.username).toBe("root");
    expect(ok?.isAdmin).toBe(true);
    expect(await verifyUserPassword("root", "wrong-password", IP)).toBeNull();
    expect(await verifyUserPassword("nobody", PW, IP)).toBeNull();
    const failures = db.query("SELECT COUNT(*) as c FROM login_attempts WHERE success = 0").get() as { c: number };
    expect(failures.c).toBe(2);
  });

  test("the last administrator cannot be demoted or deleted", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    await expect(updateAdminUser(root, { isAdmin: false })).rejects.toThrow(/last administrator/);
    expect(() => deleteAdminUser(root)).toThrow(/last administrator/);
    const second = await createAdminUser("second", PW, { isAdmin: true });
    // With a second admin in place, both operations are allowed.
    expect(await updateAdminUser(root, { isAdmin: false })).toBe(true);
    expect(countAdmins()).toBe(1);
    expect(() => deleteAdminUser(second)).toThrow(/last administrator/);
    expect(deleteAdminUser(root)).toBe(true);
  });

  test("promoting a site user clears their site grants; demoting an admin leaves none", async () => {
    createBlankSite("alpha", "Alpha");
    const uid = await createAdminUser("editor", PW, { sites: ["alpha"] });
    await createAdminUser("root", PW, { isAdmin: true });
    expect(listAdminUsers().find(u => u.username === "editor")!.sites).toEqual(["alpha"]);
    await updateAdminUser(uid, { isAdmin: true });
    const promoted = listAdminUsers().find(u => u.username === "editor")!;
    expect(promoted.is_admin).toBe(true);
    expect(promoted.sites).toEqual([]);
    expect(userCanAccessSite(getUserByUsername("editor")!, "alpha")).toBe(true);
    await updateAdminUser(uid, { isAdmin: false });
    expect(userCanAccessSite(getUserByUsername("editor")!, "alpha")).toBe(false);
  });

  test("deleting an account invalidates its sessions", async () => {
    await createAdminUser("root", PW, { isAdmin: true });
    const uid = await createAdminUser("editor", PW, { sites: [] });
    const { sessionToken } = createSession(IP, uid);
    expect(validateSession(sessionToken, IP)).toBe(true);
    expect(getSessionUser(sessionToken)?.username).toBe("editor");
    deleteAdminUser(uid);
    expect(validateSession(sessionToken, IP)).toBe(false);
    expect(getSessionUser(sessionToken)).toBeNull();
  });
});

describe("per-account TOTP", () => {
  test("2FA state, recovery codes, and pending tokens are scoped to one account", async () => {
    const a = await createAdminUser("alpha", PW, { isAdmin: true });
    const b = await createAdminUser("beta", PW, { isAdmin: true });
    enableTotp(a, "JBSWY3DPEHPK3PXP", ["1111-aaaa", "2222-bbbb"]);
    expect(isTotpEnabled(a)).toBe(true);
    expect(isTotpEnabled(b)).toBe(false);
    expect(getRemainingRecoveryCodes(a)).toBe(2);
    expect(useRecoveryCode(b, "1111-aaaa")).toBe(false); // not beta's code
    expect(useRecoveryCode(a, "1111 AAAA")).toBe(true);
    expect(useRecoveryCode(a, "1111-aaaa")).toBe(false); // single use
    expect(getRemainingRecoveryCodes(a)).toBe(1);

    const token = createPending2faToken(IP, a);
    expect(peekPending2faUser(token)).toBe(a);
    expect(consumePending2faToken(token, "198.51.100.7")).toBeNull(); // IP-bound
    expect(consumePending2faToken(token, IP)).toBe(a);
    expect(consumePending2faToken(token, IP)).toBeNull(); // consumed
  });
});

describe("legacy admin migration", () => {
  test("converts the config-table admin into an administrator account", async () => {
    const hash = await Bun.password.hash(PW, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
    db.run("INSERT INTO config (key, value) VALUES ('admin_password_hash', ?)", hash);
    db.run("INSERT INTO config (key, value) VALUES ('totp_enabled', '1')");
    db.run("INSERT INTO config (key, value) VALUES ('totp_secret', 'JBSWY3DPEHPK3PXP')");
    // A pre-existing anonymous session and passkey should follow the account.
    db.run("INSERT INTO sessions (token, csrf_token, expires_at, ip, user_id) VALUES ('abc', 'def', datetime('now', '+1 hour'), ?, NULL)", IP);
    db.run(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, rp_id, label)
       VALUES (NULL, 'cred-1', 'pk', 0, 'admin.example.com', 'Old key')`
    );

    expect(isSetup()).toBe(false);
    const result = migrateLegacyAdmin();
    expect(result.migrated).toBe(true);
    expect(result.username).toBe("admin");
    expect(isSetup()).toBe(true);

    const admin = getUserByUsername("admin")!;
    expect(admin.isAdmin).toBe(true);
    expect(isTotpEnabled(admin.userId)).toBe(true);
    expect(await verifyUserPassword("admin", PW, IP)).not.toBeNull();
    expect(getSessionUser("abc")?.username).toBe("admin");
    const cred = db.query("SELECT user_id FROM webauthn_credentials WHERE credential_id = 'cred-1'").get() as { user_id: number };
    expect(cred.user_id).toBe(admin.userId);
    // Config secrets are gone, and running again is a no-op.
    expect(db.query("SELECT COUNT(*) as c FROM config WHERE key LIKE 'totp_%' OR key = 'admin_password_hash'").get()).toEqual({ c: 0 });
    expect(migrateLegacyAdmin().migrated).toBe(false);
  });

  test("picks a fallback name when 'admin' is already a site user", async () => {
    await createAdminUser("admin", PW, { sites: [] });
    const hash = await Bun.password.hash(PW, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
    db.run("INSERT INTO config (key, value) VALUES ('admin_password_hash', ?)", hash);
    const result = migrateLegacyAdmin();
    expect(result.username).toBe("platform-admin");
    expect(getUserByUsername("admin")!.isAdmin).toBe(false);
    expect(getUserByUsername("platform-admin")!.isAdmin).toBe(true);
  });
});

describe("admin API authorization", () => {
  test("setup creates the first administrator and then closes", async () => {
    const first = await anon("POST", "/_admin/api/setup", { username: "Owner", password: PW });
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("hoster_session=");
    expect(getUserByUsername("owner")!.isAdmin).toBe(true);
    const again = await anon("POST", "/_admin/api/setup", { username: "x", password: PW });
    expect(again.status).toBe(400);
  });

  test("login requires a username and returns a session for the right account", async () => {
    await createAdminUser("root", PW, { isAdmin: true });
    createBlankSite("alpha", "Alpha");
    await createAdminUser("editor", PW, { sites: ["alpha"] });

    const noUser = await anon("POST", "/_admin/api/login", { password: PW });
    expect(noUser.status).toBe(400);
    const bad = await anon("POST", "/_admin/api/login", { username: "editor", password: "nope-nope-nope" });
    expect(bad.status).toBe(401);
    const ok = await anon("POST", "/_admin/api/login", { username: "editor", password: PW });
    expect(ok.status).toBe(200);
    const token = ok.headers.get("set-cookie")!.match(/hoster_session=([a-f0-9]+)/)![1];
    const who = getSessionUser(token)!;
    expect(who.username).toBe("editor");
    expect(who.isAdmin).toBe(false);
  });

  test("auth-check reports the account and admin flag", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const { sessionToken } = createSession(IP, root);
    const req = new Request("http://localhost/_admin/api/auth-check", {
      headers: { cookie: `hoster_session=${sessionToken}`, "x-real-ip": IP },
    });
    const data = await (await handleAdminApi(req, "/_admin/api/auth-check"))!.json();
    expect(data.authenticated).toBe(true);
    expect(data.username).toBe("root");
    expect(data.is_admin).toBe(true);
  });

  test("site users can manage their own credentials but not the platform", async () => {
    await createAdminUser("root", PW, { isAdmin: true });
    createBlankSite("alpha", "Alpha");
    createBlankSite("beta", "Beta");
    const editor = await createAdminUser("editor", PW, { sites: ["alpha"] });

    // Self-service is open to everyone.
    expect((await asUser(editor, "GET", "/_admin/api/totp/status")).status).toBe(200);
    expect((await asUser(editor, "POST", "/_admin/api/change-password", { current: PW, password: "another-long-password" })).status).toBe(200);
    expect(await verifyPasswordForUser(editor, "another-long-password", IP)).toBe(true);

    // Platform surfaces are not.
    expect((await asUser(editor, "GET", "/_admin/api/users")).status).toBe(403);
    expect((await asUser(editor, "GET", "/_admin/api/settings/countries")).status).toBe(403);
    expect((await asUser(editor, "GET", "/_admin/api/audit")).status).toBe(403);

    // Their site: yes. Someone else's: no.
    expect((await asUser(editor, "GET", "/_admin/api/sites/alpha/files")).status).toBe(200);
    expect((await asUser(editor, "GET", "/_admin/api/sites/beta/files")).status).toBe(403);
    expect((await asUser(editor, "DELETE", "/_admin/api/sites/alpha")).status).toBe(403);

    const sites = await asUser(editor, "GET", "/_admin/api/sites");
    expect(sites.data.sites.map((s: any) => s.slug)).toEqual(["alpha"]);
  });

  test("administrator actions on admin accounts need a step-up password", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const peer = await createAdminUser("peer", PW, { isAdmin: true });

    // Creating an admin without confirming: refused. With: allowed.
    let r = await asUser(root, "POST", "/_admin/api/users", { username: "third", password: PW, is_admin: true });
    expect(r.status).toBe(400);
    r = await asUser(root, "POST", "/_admin/api/users", { username: "third", password: PW, is_admin: true, confirm_password: "wrong-wrong-wrong" });
    expect(r.status).toBe(401);
    r = await asUser(root, "POST", "/_admin/api/users", { username: "third", password: PW, is_admin: true, confirm_password: PW });
    expect(r.status).toBe(200);
    expect(getUserByUsername("third")!.isAdmin).toBe(true);

    // Since v2.7 a site user needs the step-up too: every new account is a
    // way back in for a hijacked session.
    r = await asUser(root, "POST", "/_admin/api/users", { username: "editor", password: PW, sites: [] });
    expect(r.status).toBe(400);
    r = await asUser(root, "POST", "/_admin/api/users", { username: "editor", password: PW, sites: [], confirm_password: PW });
    expect(r.status).toBe(200);

    // Setting anyone's password requires it (admin or site user).
    const editor = getUserByUsername("editor")!.userId;
    expect((await asUser(root, "PUT", `/_admin/api/users/${peer}`, { password: "new-peer-password" })).status).toBe(400);
    expect((await asUser(root, "PUT", `/_admin/api/users/${peer}`, { password: "new-peer-password", confirm_password: PW })).status).toBe(200);
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { password: "new-editor-password" })).status).toBe(400);
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { password: "new-editor-password", confirm_password: PW })).status).toBe(200);

    // Granting a site needs it; revoking and "must change password" don't.
    createBlankSite("grantme", "Grant me");
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { sites: ["grantme"] })).status).toBe(400);
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { sites: ["grantme"], confirm_password: PW })).status).toBe(200);
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { sites: [] })).status).toBe(200);
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { must_change_password: true })).status).toBe(200);
    // Stripping 2FA or passkeys from anyone needs it.
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { disable_totp: true })).status).toBe(400);
    expect((await asUser(root, "PUT", `/_admin/api/users/${editor}`, { remove_passkeys: true })).status).toBe(400);

    // Nobody changes their own role or deletes themself.
    expect((await asUser(root, "PUT", `/_admin/api/users/${root}`, { is_admin: false, confirm_password: PW })).status).toBe(400);
    expect((await asUser(root, "DELETE", `/_admin/api/users/${root}`, { confirm_password: PW })).status).toBe(400);

    // Deleting a peer admin: step-up required, then allowed.
    expect((await asUser(root, "DELETE", `/_admin/api/users/${peer}`, {})).status).toBe(400);
    expect((await asUser(root, "DELETE", `/_admin/api/users/${peer}`, { confirm_password: PW })).status).toBe(200);
    expect(getUserByUsername("peer")).toBeNull();

    // Audit entries carry the acting username.
    const row = db.query("SELECT actor FROM audit_log WHERE action = 'admin_user_deleted' ORDER BY id DESC LIMIT 1").get() as { actor: string };
    expect(row.actor).toBe("root");
  });

  test("a session whose account was deleted is rejected", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const doomed = await createAdminUser("doomed", PW, { isAdmin: true });
    const { sessionToken, csrfToken } = createSession(IP, doomed);
    deleteAdminUser(doomed);
    const req = new Request("http://localhost/_admin/api/sites", {
      headers: { cookie: `hoster_session=${sessionToken}`, "x-csrf-token": csrfToken, "x-real-ip": IP },
    });
    expect((await handleAdminApi(req, "/_admin/api/sites"))!.status).toBe(401);
    expect(root).toBeGreaterThan(0);
  });
});

describe("email addresses as usernames", () => {
  test("accepts and normalizes emails, keeps handles, rejects junk", async () => {
    const { validateUsername } = await import("../src/auth");
    expect(validateUsername("Sam.Jones+docs@Example.COM")).toBe("sam.jones+docs@example.com");
    expect(validateUsername("plain_handle-1")).toBe("plain_handle-1");
    expect(() => validateUsername("no spaces@example.com")).toThrow(/handle .* email/);
    expect(() => validateUsername("@example.com")).toThrow();
    expect(() => validateUsername("sam@nodot")).toThrow();
    expect(() => validateUsername("a".repeat(65) + "@example.com")).toThrow();
    const id = await createAdminUser("Pat@Example.org", "pat-password-1", { isAdmin: false, sites: [] });
    expect(getUserByUsername("PAT@example.org")!.userId).toBe(id);
    expect((await verifyUserPassword("pat@EXAMPLE.org", "pat-password-1", "10.0.0.9"))!.userId).toBe(id);
  });
});
