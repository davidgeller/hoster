// Origin isolation: with an admin hostname configured, the admin panel/API
// and the OAuth consent screen are served only there, that hostname serves no
// sites, and bearer-token infrastructure keeps working everywhere it did.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import db from "../src/db";
import { SITES_DIR, createBlankSite, deleteSite, addHostAlias, invalidateHostAliasCache, updateSiteSettings } from "../src/sites";
import { createSession, createAdminUser } from "../src/auth";
import { handleAdminApi } from "../src/admin-api";
import { createServer } from "../src/server";
import { runCli } from "../src/cli";
import {
  getOriginConfig, setOriginConfig, normalizeHostSetting, verifyReachesThisServer, hostOnly, originFor, instanceId, isAdminOnlyPath, isSharedInfraPath,
} from "../src/origin";

const ADMIN = "admin.example.test";
const SITES = "hoster.example.test";
const SLUG = "isosite";
let server: ReturnType<typeof createServer>;
let base = "";

function get(path: string, host: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, redirect: "manual", headers: { Host: host, ...(init.headers as any || {}) } });
}

beforeAll(() => {
  createBlankSite(SLUG, "Iso");
  writeFileSync(join(SITES_DIR, SLUG, "_current", "index.html"), "<html><body>iso site</body></html>");
  addHostAlias("custom.example.test", SLUG);
  invalidateHostAliasCache();
  server = createServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  setOriginConfig({ admin_host: null }, { hostAliases: [] });
  server?.stop(true);
  deleteSite(SLUG);
});

describe("settings validation", () => {
  test("hostnames are normalized and checked", () => {
    expect(normalizeHostSetting("https://Admin.Example.com/_admin", "x")).toBe("admin.example.com");
    expect(normalizeHostSetting("admin.example.com:8443", "x")).toBe("admin.example.com:8443");
    expect(normalizeHostSetting("", "x")).toBeNull();
    expect(() => normalizeHostSetting("not a host", "x")).toThrow();
    expect(() => normalizeHostSetting("-bad.example.com", "x")).toThrow();
    expect(hostOnly("admin.example.com:8443")).toBe("admin.example.com");
    expect(originFor("admin.example.com")).toBe("https://admin.example.com");
    expect(originFor("localhost:3577")).toBe("http://localhost:3577");
  });

  test("admin and sites hostnames must differ and can't be custom domains", () => {
    expect(() => setOriginConfig({ admin_host: ADMIN }, { hostAliases: [] })).toThrow(/sites/i);
    expect(() => setOriginConfig({ admin_host: ADMIN, sites_host: ADMIN + ":443" }, { hostAliases: [] })).toThrow(/different/);
    expect(() => setOriginConfig({ admin_host: "custom.example.test", sites_host: SITES }, { hostAliases: ["custom.example.test"] })).toThrow(/custom domain/);
    expect(() => setOriginConfig({ admin_host: ADMIN, sites_host: "custom.example.test" }, { hostAliases: ["custom.example.test"] })).toThrow(/custom domain/);
    expect(getOriginConfig().admin_host).toBeNull();
  });

  test("turning it off forgets both hostnames", () => {
    setOriginConfig({ admin_host: ADMIN, sites_host: SITES }, { hostAliases: [] });
    expect(getOriginConfig()).toEqual({ admin_host: ADMIN, sites_host: SITES });
    setOriginConfig({ admin_host: null, sites_host: SITES }, { hostAliases: [] });
    expect(getOriginConfig()).toEqual({ admin_host: null, sites_host: null });
  });

  test("path classes", () => {
    for (const p of ["/_admin", "/_admin/", "/_admin/api/sites", "/oauth/authorize"]) expect(isAdminOnlyPath(p)).toBe(true);
    for (const p of ["/_mcp", "/_mcp/x", "/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/oauth-authorization-server", "/_cms/cms.js", "/_hoster/instance"]) {
      expect(isSharedInfraPath(p)).toBe(true);
      expect(isAdminOnlyPath(p)).toBe(false);
    }
    expect(isAdminOnlyPath("/_administrator/")).toBe(false);
  });
});

describe("with isolation off (default)", () => {
  test("admin and sites share any host, as before", async () => {
    expect((await get("/_admin/api/auth-check", SITES)).status).toBe(200);
    expect((await get(`/${SLUG}/`, ADMIN)).status).toBe(200);
  });
});

describe("with an admin hostname", () => {
  beforeAll(() => setOriginConfig({ admin_host: ADMIN, sites_host: SITES }, { hostAliases: [] }));
  afterAll(() => setOriginConfig({ admin_host: null }, { hostAliases: [] }));

  test("the sites host no longer answers the admin API — the attack in the audit", async () => {
    const res = await get("/_admin/api/auth-check", SITES);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("csrf_token");
    // Every other API path too, whatever the method.
    expect((await get("/_admin/api/sites", SITES, { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("admin pages and the OAuth consent screen redirect to the admin host", async () => {
    const page = await get("/_admin/", SITES);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`https://${ADMIN}/_admin/`);
    const consent = await get("/oauth/authorize?client_id=x&state=y", SITES);
    expect(consent.status).toBe(302);
    expect(consent.headers.get("location")).toBe(`https://${ADMIN}/oauth/authorize?client_id=x&state=y`);
  });

  test("the admin host serves the panel and API", async () => {
    const res = await get("/_admin/api/auth-check", ADMIN);
    expect(res.status).toBe(200);
    expect((await res.json()).sites_origin).toBe(`https://${SITES}`);
    // (The test home has no admin/index.html, so only check it isn't bounced.)
    expect([302, 404]).not.toContain((await get("/_admin/", ADMIN)).status);
  });

  test("the admin host serves no sites", async () => {
    const site = await get(`/${SLUG}/?a=1`, ADMIN);
    expect(site.status).toBe(302);
    expect(site.headers.get("location")).toBe(`https://${SITES}/${SLUG}/?a=1`);
    const root = await get("/", ADMIN);
    expect(root.headers.get("location")).toBe("/_admin");
    // Unlock posts and scanner probes don't run there either.
    expect((await get("/_hoster/unlock", ADMIN, { method: "POST" })).status).toBe(302);
    expect((await get("/.env", ADMIN)).status).toBe(302);
  });

  test("sites keep working on the sites host and custom domains", async () => {
    const res = await get(`/${SLUG}/`, SITES);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("iso site");
    expect((await get("/", "custom.example.test")).status).toBe(200);
    // Custom domains still never expose admin surfaces.
    expect((await get("/_admin/api/auth-check", "custom.example.test")).status).toBe(404);
  });

  test("bearer-token infrastructure works on both hosts", async () => {
    updateSiteSettings(SLUG, null, false, true);
    for (const host of [SITES, ADMIN]) {
      const mcp = await get(`/_mcp/${SLUG}`, host, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(mcp.status).toBe(401); // reached the MCP handler, which wants a token
      const meta = await get("/.well-known/oauth-authorization-server", host);
      expect(meta.status).toBe(200);
      const m = await meta.json();
      expect(m.authorization_endpoint).toBe(`https://${ADMIN}/oauth/authorize`);
      expect(m.token_endpoint).toContain(host);
      expect((await get("/oauth/token", host, { method: "POST" })).status).not.toBe(404);
    }
    updateSiteSettings(SLUG, null, false, false);
  });

  test("loopback keeps full access (deploy checks, SSH-tunnel break-glass)", async () => {
    expect((await get("/_admin/api/version", "127.0.0.1:3500")).status).toBe(200);
    expect((await get("/_admin/api/auth-check", "localhost:3500")).status).toBe(200);
    // The version endpoint stays public everywhere, as before.
    expect((await get("/_admin/api/version", SITES)).status).toBe(200);
  });

  test("the root of the sites host sends visitors to the admin host when no landing page is set", async () => {
    const res = await get("/", SITES);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://${ADMIN}/_admin`);
  });

  test("the instance id is served on every host for the pre-switch check", async () => {
    for (const host of [ADMIN, SITES]) expect((await (await get("/_hoster/instance", host)).json()).instance).toBe(instanceId());
  });
});

describe("admin API", () => {
  async function asUser(userId: number, method: string, body?: any) {
    const { sessionToken, csrfToken } = createSession("192.0.2.90", userId);
    const req = new Request("http://localhost/_admin/api/settings/origin", {
      method,
      headers: { cookie: `hoster_session=${sessionToken}`, "x-csrf-token": csrfToken, "x-real-ip": "192.0.2.90", "content-type": "application/json", host: SITES },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handleAdminApi(req, "/_admin/api/settings/origin");
    return { status: res!.status, data: await res!.json() };
  }

  test("requires an administrator and their password", async () => {
    const admin = await createAdminUser("originadmin", "correct-horse-battery", { isAdmin: true });
    const siteUser = await createAdminUser("originsiteuser", "correct-horse-battery", { isAdmin: false });
    expect((await asUser(siteUser, "GET")).status).toBe(403);
    const got = await asUser(admin, "GET");
    expect(got.data.instance_id).toBe(instanceId());
    expect(got.data.current_host).toBe(SITES);
    expect((await asUser(admin, "POST", { admin_host: ADMIN, sites_host: SITES })).status).toBe(400);
    expect((await asUser(admin, "POST", { admin_host: ADMIN, sites_host: SITES, confirm_password: "wrong-password" })).status).toBe(401);
    // The new hostname doesn't resolve here, so the reachability check refuses…
    const unverified = await asUser(admin, "POST", { admin_host: ADMIN, sites_host: SITES, confirm_password: "correct-horse-battery" });
    expect(unverified.status).toBe(409);
    expect(unverified.data.unverified).toBe(true);
    expect(getOriginConfig().admin_host).toBeNull();
    // …unless the admin insists.
    const ok = await asUser(admin, "POST", { admin_host: ADMIN, sites_host: SITES, confirm_password: "correct-horse-battery", force: true });
    expect(ok.status).toBe(200);
    expect(ok.data.admin_origin).toBe(`https://${ADMIN}`);
    // Switching ends every existing session.
    expect((db.query("SELECT COUNT(*) AS n FROM sessions").get() as any).n).toBe(0);
    const audit = db.query("SELECT detail FROM audit_log WHERE action = 'origin_isolation_updated' ORDER BY id DESC LIMIT 1").get() as any;
    expect(audit.detail).toContain(ADMIN);
    const off = await asUser(admin, "POST", { admin_host: null, confirm_password: "correct-horse-battery" });
    expect(off.data.admin_host).toBeNull();
  });
});

describe("reachability check", () => {
  test("recognizes this installation and rejects anything else", async () => {
    const self = await verifyReachesThisServer(`127.0.0.1:${server.port}`);
    expect(self.ok).toBe(true);
    const nowhere = await verifyReachesThisServer("127.0.0.1:1", 2000);
    expect(nowhere.ok).toBe(false);
    const other = Bun.serve({ port: 0, fetch: () => Response.json({ instance: "someone-else" }) });
    const mismatch = await verifyReachesThisServer(`127.0.0.1:${other.port}`);
    other.stop(true);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toContain("different");
  });
});

describe("CLI", () => {
  test("hoster admin-host shows and clears the setting", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push("ERR " + l), confirm: () => true, isTTY: false };
    setOriginConfig({ admin_host: ADMIN, sites_host: SITES }, { hostAliases: [] });
    expect(await runCli(["admin-host"], io)).toBe(0);
    expect(out.join("\n")).toContain(ADMIN);
    expect(await runCli(["admin-host", "--clear"], io)).toBe(0);
    expect(getOriginConfig().admin_host).toBeNull();
    expect(await runCli(["admin-host", "--bogus"], io)).toBe(1);
  });
});
