// Temporary passwords (v2.2).
//
// An administrator can hand out a generated password and require the account
// to replace it at first sign-in. Until it does, every authenticated surface
// except "change my password" answers 403 — in the admin API and on a
// repository site's own API alike.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import db from "../src/db";
import {
  createAdminUser, updateAdminUser, listAdminUsers, getUserByUsername, getUser,
  createSession, validateSession, generatePassword, setUserPassword,
} from "../src/auth";
import { createBlankSite, deleteSite, listSites } from "../src/sites";
import { createRepositorySite } from "../src/repo";
import { handleAdminApi } from "../src/admin-api";
import { createServer } from "../src/server";

const IP = "203.0.113.42";
const PW = "temporary-pass-1";

function resetAccounts() {
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM pending_2fa");
  db.exec("DELETE FROM login_attempts");
  db.exec("DELETE FROM webauthn_credentials");
  db.exec("DELETE FROM admin_users");
  db.exec("DELETE FROM config");
  for (const s of listSites()) deleteSite(s.slug);
}

async function asUser(userId: number, method: string, path: string, body?: any) {
  const { sessionToken, csrfToken } = createSession(IP, userId);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { cookie: `hoster_session=${sessionToken}`, "x-csrf-token": csrfToken, "x-real-ip": IP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = (await handleAdminApi(req, path))!;
  return { status: res.status, data: await res.json(), sessionToken };
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

describe("generated passwords", () => {
  test("are long, unambiguous, and mixed", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(16);
      expect(pw).toHaveLength(16);
      expect(pw).toMatch(/^[a-zA-Z0-9!@#$%&*?]+$/);
      expect(pw).not.toMatch(/[0O1lI]/);
      expect(pw).toMatch(/[a-z]/); expect(pw).toMatch(/[A-Z]/); expect(pw).toMatch(/[0-9]/); expect(pw).toMatch(/[!@#$%&*?]/);
    }
    expect(generatePassword(4)).toHaveLength(12); // floor
    expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  });

  test("administrators can ask the server for one", async () => {
    resetAccounts();
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const editor = await createAdminUser("editor", PW, { sites: [] });
    const r = await asUser(root, "POST", "/_admin/api/users/generate-password", {});
    expect(r.status).toBe(200);
    expect(r.data.password).toHaveLength(16);
    const denied = await asUser(editor, "POST", "/_admin/api/users/generate-password", {});
    expect(denied.status).toBe(403);
  });
});

describe("must change password", () => {
  beforeEach(resetAccounts);

  test("flag is stored on create and reported to administrators", async () => {
    await createAdminUser("root", PW, { isAdmin: true });
    await createAdminUser("newbie", PW, { sites: [], mustChangePassword: true });
    expect(getUserByUsername("newbie")?.mustChangePassword).toBe(true);
    expect(getUserByUsername("root")?.mustChangePassword).toBe(false);
    const listed = listAdminUsers().find(u => u.username === "newbie")!;
    expect(listed.must_change_password).toBe(true);
  });

  test("admin API: create with the flag, sign-in reports it, everything but change-password is closed", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    createBlankSite("docs", "Docs");
    const created = await asUser(root, "POST", "/_admin/api/users", { username: "newbie", password: PW, is_admin: false, sites: ["docs"], must_change_password: true });
    expect(created.status).toBe(200);
    const newbie = getUserByUsername("newbie")!;
    expect(newbie.mustChangePassword).toBe(true);

    const login = await anon("POST", "/_admin/api/login", { username: "newbie", password: PW });
    expect(login.status).toBe(200);
    expect(login.data.must_change_password).toBe(true);

    // auth-check tells the SPA to show the new-password screen.
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const check = await handleAdminApi(new Request("http://localhost/_admin/api/auth-check", { headers: { cookie, "x-real-ip": IP } }), "/_admin/api/auth-check");
    const checkData = await check!.json();
    expect(checkData.authenticated).toBe(true);
    expect(checkData.must_change_password).toBe(true);

    // Ordinary work is refused with a hint the client can act on.
    const sites = await asUser(newbie.userId, "GET", "/_admin/api/sites");
    expect(sites.status).toBe(403);
    expect(sites.data.must_change_password).toBe(true);
    const totp = await asUser(newbie.userId, "GET", "/_admin/api/totp/status");
    expect(totp.status).toBe(403);

    // The wrong current password doesn't get through.
    const bad = await asUser(newbie.userId, "POST", "/_admin/api/change-password", { current: "nope-nope-nope", password: "my-own-password-9" });
    expect(bad.status).toBe(401);
    expect(getUserByUsername("newbie")?.mustChangePassword).toBe(true);

    // Choosing a new password clears the flag and reopens the account.
    const ok = await asUser(newbie.userId, "POST", "/_admin/api/change-password", { current: PW, password: "my-own-password-9" });
    expect(ok.status).toBe(200);
    expect(getUserByUsername("newbie")?.mustChangePassword).toBe(false);
    const after = await asUser(newbie.userId, "GET", "/_admin/api/sites");
    expect(after.status).toBe(200);
    const relogin = await anon("POST", "/_admin/api/login", { username: "newbie", password: "my-own-password-9" });
    expect(relogin.status).toBe(200);
    expect(relogin.data.must_change_password).toBe(false);
  });

  test("administrators are held to it too", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const peer = await asUser(root, "POST", "/_admin/api/users", { username: "peer", password: PW, is_admin: true, must_change_password: true, confirm_password: PW });
    expect(peer.status).toBe(200);
    const peerId = getUserByUsername("peer")!.userId;
    const users = await asUser(peerId, "GET", "/_admin/api/users");
    expect(users.status).toBe(403);
    expect(users.data.must_change_password).toBe(true);
  });

  test("an administrator's reset can hand out a temporary password, or lift the requirement", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const editorId = await createAdminUser("editor", PW, { sites: [] });
    const { sessionToken } = createSession(IP, editorId);

    const reset = await asUser(root, "PUT", `/_admin/api/users/${editorId}`, { password: "temp-pass-word-2", must_change_password: true });
    expect(reset.status).toBe(200);
    expect(getUser(editorId)?.mustChangePassword).toBe(true);
    expect(validateSession(sessionToken, IP)).toBe(false); // signed out everywhere

    // A plain reset without the flag is a normal password, no forced change.
    const plain = await asUser(root, "PUT", `/_admin/api/users/${editorId}`, { password: "chosen-for-them-3" });
    expect(plain.status).toBe(200);
    expect(getUser(editorId)?.mustChangePassword).toBe(false);

    // The flag can be toggled on its own.
    await asUser(root, "PUT", `/_admin/api/users/${editorId}`, { must_change_password: true });
    expect(getUser(editorId)?.mustChangePassword).toBe(true);
    await asUser(root, "PUT", `/_admin/api/users/${editorId}`, { must_change_password: false });
    expect(getUser(editorId)?.mustChangePassword).toBe(false);
  });

  test("setUserPassword clears the flag unless told it's temporary", async () => {
    const id = await createAdminUser("u", PW, { sites: [], mustChangePassword: true });
    await setUserPassword(id, "another-password-4");
    expect(getUser(id)?.mustChangePassword).toBe(false);
    await setUserPassword(id, "another-password-5", { mustChange: true });
    expect(getUser(id)?.mustChangePassword).toBe(true);
    await updateAdminUser(id, { password: "another-password-6" });
    expect(getUser(id)?.mustChangePassword).toBe(false);
  });
});

describe("repository site: temporary password", () => {
  const PORT = 39811 + Math.floor(Math.random() * 200);
  let server: ReturnType<typeof createServer>;
  const base = () => `http://127.0.0.1:${PORT}`;
  const SITE = "team-docs";
  let cookie = "";
  let csrf = "";

  beforeAll(async () => {
    resetAccounts();
    createRepositorySite(SITE, "Team Docs", { visibility: "private" });
    await createAdminUser("root", PW, { isAdmin: true });
    await createAdminUser("reader", PW, { sites: [SITE], mustChangePassword: true });
    server = createServer(PORT);
  });
  afterAll(() => { server.stop(true); try { deleteSite(SITE); } catch (_) {} });

  const call = (api: string, init: RequestInit = {}) => fetch(`${base()}/${SITE}/_repo/api/${api}`, {
    ...init,
    headers: { "Content-Type": "application/json", cookie, "X-CSRF-Token": csrf, ...(init.headers || {}) },
  });

  test("sign-in reports the requirement; the page is gated until a new password is chosen", async () => {
    const res = await call("auth/login", { method: "POST", body: JSON.stringify({ username: "reader", password: PW }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.must_change_password).toBe(true);
    expect(body.can_write).toBe(false);
    cookie = res.headers.get("set-cookie")!.split(";")[0];
    csrf = body.csrf_token;

    const info = await (await call("info")).json();
    expect(info.auth.authenticated).toBe(true);
    expect(info.auth.must_change_password).toBe(true);
    expect(info.auth.can_read).toBe(false);

    const tree = await call("tree");
    expect(tree.status).toBe(403);
    expect((await tree.json()).must_change_password).toBe(true);

    const wrong = await call("auth/change-password", { method: "POST", body: JSON.stringify({ current: "not-it-not-it", password: "reader-picked-this-7" }) });
    expect(wrong.status).toBe(401);
    const noCsrf = await call("auth/change-password", { method: "POST", headers: { "X-CSRF-Token": "" }, body: JSON.stringify({ current: PW, password: "reader-picked-this-7" }) });
    expect(noCsrf.status).toBe(403);

    const ok = await call("auth/change-password", { method: "POST", body: JSON.stringify({ current: PW, password: "reader-picked-this-7" }) });
    expect(ok.status).toBe(200);
    expect(getUserByUsername("reader")?.mustChangePassword).toBe(false);

    const after = await (await call("info")).json();
    expect(after.auth.must_change_password).toBe(false);
    expect(after.auth.can_write).toBe(true);
    expect((await call("tree")).status).toBe(200);
  });
});
