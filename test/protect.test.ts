// Protected paths: access-code rules, the gate page, the unlock flow, and
// cookie-scoped passes. HOSTER_HOME comes from test/preload.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import db from "../src/db";
import { SITES_DIR, createBlankSite, deleteSite, addHostAlias, invalidateHostAliasCache } from "../src/sites";
import {
  normalizePrefix, createRule, updateRule, deleteRule, addCode, updateCode, deleteCode,
  listRules, findRule, clearUnlockFailures, generateCode,
} from "../src/protect";
import { createServer } from "../src/server";

const SLUG = "protsite";
let server: ReturnType<typeof createServer>;
let base = "";

function writeSiteFile(rel: string, body: string) {
  const file = join(SITES_DIR, SLUG, "_current", rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

async function unlock(code: string, returnTo: string, host?: string) {
  const form = new URLSearchParams({ site: SLUG, return: returnTo, code });
  return fetch(`${base}/_hoster/unlock`, {
    method: "POST",
    body: form,
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(host ? { Host: host } : {}) },
  });
}

function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

beforeAll(() => {
  createBlankSite(SLUG, "Protected Site");
  writeSiteFile("index.html", "<html><body>home</body></html>");
  writeSiteFile("members/index.html", "<html><body>members only</body></html>");
  writeSiteFile("members/app.abcdef1234.js", "console.log(1)");
  writeSiteFile("members/board/index.html", "<html><body>board</body></html>");
  server = createServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  deleteSite(SLUG);
});

describe("rule and code validation", () => {
  test("prefixes normalize to /a/b/ form", () => {
    expect(normalizePrefix("/")).toBe("/");
    expect(normalizePrefix("")).toBe("/");
    expect(normalizePrefix("foo/Bar")).toBe("/foo/bar/");
    expect(normalizePrefix("//foo//bar//")).toBe("/foo/bar/");
    expect(() => normalizePrefix("/foo/../bar")).toThrow();
    expect(() => normalizePrefix("/foo bar/")).toThrow();
    expect(() => normalizePrefix(42)).toThrow();
  });

  test("codes must be alphanumeric, unique per rule (case-insensitive)", () => {
    const rule = createRule(SLUG, { path_prefix: "/tmp-rule/" });
    expect(() => addCode(SLUG, rule.id, { name: "x", code: "ab" })).toThrow(/4–64/);
    expect(() => addCode(SLUG, rule.id, { name: "x", code: "abc-123" })).toThrow();
    expect(() => addCode(SLUG, rule.id, { name: "", code: "abcd1234" })).toThrow(/Name/);
    addCode(SLUG, rule.id, { name: "One", code: "Abcd1234" });
    expect(() => addCode(SLUG, rule.id, { name: "Two", code: "ABCD1234" })).toThrow(/already in use/);
    const generated = addCode(SLUG, rule.id, { name: "Auto" });
    expect(generated.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(() => createRule(SLUG, { path_prefix: "tmp-rule" })).toThrow(/already protected/);
    expect(deleteRule(SLUG, rule.id)).toBe(true);
    // Codes cascade with their rule.
    expect((db.query("SELECT COUNT(*) AS n FROM protect_codes WHERE rule_id = ?").get(rule.id) as any).n).toBe(0);
  });

  test("generateCode avoids look-alike characters", () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).not.toMatch(/[01OIL]/);
  });

  test("longest prefix wins", () => {
    const site = createRule(SLUG, { path_prefix: "/" });
    const sub = createRule(SLUG, { path_prefix: "/members/board/" });
    expect(findRule(SLUG, "/")!.id).toBe(site.id);
    expect(findRule(SLUG, "/members/x.html")!.id).toBe(site.id);
    expect(findRule(SLUG, "/members/board")!.id).toBe(sub.id);
    expect(findRule(SLUG, "/MEMBERS/Board/index.html")!.id).toBe(sub.id);
    expect(findRule(SLUG, "/members/boardroom.html")!.id).toBe(site.id);
    deleteRule(SLUG, site.id);
    deleteRule(SLUG, sub.id);
    expect(findRule(SLUG, "/members/board/")).toBeNull();
  });
});

describe("HTTP gate", () => {
  let ruleId = 0;
  let codeId = 0;

  beforeAll(() => {
    const rule = createRule(SLUG, { path_prefix: "/members/", label: "Members area" });
    ruleId = rule.id;
    codeId = addCode(SLUG, rule.id, { name: "Board members", code: "OPEN4ME" }).id;
    addCode(SLUG, rule.id, { name: "Contractors", code: "BUILD2026" });
  });

  test("public pages are untouched", async () => {
    const res = await fetch(`${base}/${SLUG}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("home");
  });

  test("protected page shows the gate; assets get a bare 401", async () => {
    const res = await fetch(`${base}/${SLUG}/members/`, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Members area");
    expect(html).toContain('action="/_hoster/unlock"');
    expect(html).not.toContain("members only");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");

    const asset = await fetch(`${base}/${SLUG}/members/app.abcdef1234.js`, { headers: { Accept: "*/*" } });
    expect(asset.status).toBe(401);
    expect(await asset.text()).toBe("Access code required");

    // Missing files under a protected prefix don't reveal whether they exist.
    const missing = await fetch(`${base}/${SLUG}/members/nope.html`, { headers: { Accept: "text/html" } });
    expect(missing.status).toBe(401);
  });

  test("double slashes and case changes don't bypass the rule", async () => {
    for (const p of [`/${SLUG}//members/`, `/${SLUG}/MEMBERS/`, `/${SLUG}/members`]) {
      const res = await fetch(`${base}${p}`, { headers: { Accept: "text/html" }, redirect: "manual" });
      expect(res.status).toBe(401);
    }
  });

  test("wrong code re-shows the gate with an error", async () => {
    clearUnlockFailures();
    const res = await unlock("WRONG123", `/${SLUG}/members/`);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Check it and try again");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("right code (any case) sets a pass and redirects back", async () => {
    clearUnlockFailures();
    const res = await unlock("open4me", `/${SLUG}/members/?x=1`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${SLUG}/members/?x=1`);
    const cookie = cookieFrom(res);
    expect(cookie).toStartWith(`hoster_pa_${ruleId}=`);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");

    const page = await fetch(`${base}/${SLUG}/members/`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("members only");
    expect(page.headers.get("cache-control")).toContain("private");

    // Content-hashed assets are normally public+immutable; behind a code they must be private.
    const asset = await fetch(`${base}/${SLUG}/members/app.abcdef1234.js`, { headers: { Cookie: cookie } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("private");
    expect(asset.headers.get("cache-control")).not.toContain("public");

    const row = db.query("SELECT use_count, last_used_at FROM protect_codes WHERE id = ?").get(codeId) as any;
    expect(row.use_count).toBeGreaterThanOrEqual(1);
    expect(row.last_used_at).toBeTruthy();
  });

  test("requests are logged with the code's name", async () => {
    clearUnlockFailures();
    const cookie = cookieFrom(await unlock("BUILD2026", `/${SLUG}/members/`));
    await fetch(`${base}/${SLUG}/members/?logcheck=1`, { headers: { Cookie: cookie } });
    const row = db.query("SELECT access_code, site_slug, status FROM requests WHERE path = ? ORDER BY id DESC LIMIT 1").get(`/${SLUG}/members/`) as any;
    expect(row.access_code).toBe("Contractors");
    expect(row.site_slug).toBe(SLUG);
    expect(row.status).toBe(200);
  });

  test("a tampered, expired, or foreign cookie is rejected", async () => {
    clearUnlockFailures();
    const cookie = cookieFrom(await unlock("OPEN4ME", `/${SLUG}/members/`));
    const [name, value] = cookie.split("=");
    const [cid, exp, mac] = value.split(".");
    const variants = [
      `${name}=${cid}.${Number(exp) + 1000}.${mac}`,     // extended expiry
      `${name}=${cid}.${Math.floor(Date.now() / 1000) - 10}.${mac}`, // expired
      `${name}=${cid}.${exp}.${mac.slice(0, -2)}xx`,       // forged MAC
      `hoster_pa_99999=${value}`,                          // another rule's cookie name
    ];
    for (const c of variants) {
      const res = await fetch(`${base}/${SLUG}/members/`, { headers: { Cookie: c, Accept: "text/html" } });
      expect(res.status).toBe(401);
    }
  });

  test("changing or deleting a code locks out its holders immediately", async () => {
    clearUnlockFailures();
    const tmp = addCode(SLUG, ruleId, { name: "Temp", code: "TEMP1234" });
    const cookie = cookieFrom(await unlock("TEMP1234", `/${SLUG}/members/`));
    expect((await fetch(`${base}/${SLUG}/members/`, { headers: { Cookie: cookie } })).status).toBe(200);

    updateCode(SLUG, ruleId, tmp.id, { code: "TEMP5678" });
    expect((await fetch(`${base}/${SLUG}/members/`, { headers: { Cookie: cookie } })).status).toBe(401);

    const cookie2 = cookieFrom(await unlock("TEMP5678", `/${SLUG}/members/`));
    expect((await fetch(`${base}/${SLUG}/members/`, { headers: { Cookie: cookie2 } })).status).toBe(200);
    deleteCode(SLUG, ruleId, tmp.id);
    expect((await fetch(`${base}/${SLUG}/members/`, { headers: { Cookie: cookie2 } })).status).toBe(401);
  });

  test("a nested rule needs its own code", async () => {
    clearUnlockFailures();
    const board = createRule(SLUG, { path_prefix: "/members/board/" });
    addCode(SLUG, board.id, { name: "Chair", code: "CHAIR001" });
    const membersCookie = cookieFrom(await unlock("OPEN4ME", `/${SLUG}/members/`));
    const blocked = await fetch(`${base}/${SLUG}/members/board/`, { headers: { Cookie: membersCookie, Accept: "text/html" } });
    expect(blocked.status).toBe(401);
    // The members code doesn't open the board rule.
    expect((await unlock("OPEN4ME", `/${SLUG}/members/board/`)).status).toBe(401);
    const boardCookie = cookieFrom(await unlock("CHAIR001", `/${SLUG}/members/board/`));
    const ok = await fetch(`${base}/${SLUG}/members/board/`, { headers: { Cookie: boardCookie } });
    expect(ok.status).toBe(200);
    deleteRule(SLUG, board.id);
  });

  test("disabling a rule opens the path", async () => {
    updateRule(SLUG, ruleId, { enabled: false });
    expect((await fetch(`${base}/${SLUG}/members/`)).status).toBe(200);
    updateRule(SLUG, ruleId, { enabled: true });
    expect((await fetch(`${base}/${SLUG}/members/`, { headers: { Accept: "text/html" } })).status).toBe(401);
  });

  test("repeated wrong codes are throttled per IP", async () => {
    clearUnlockFailures();
    for (let i = 0; i < 10; i++) await unlock(`BAD${i}XYZ`, `/${SLUG}/members/`);
    const res = await unlock("OPEN4ME", `/${SLUG}/members/`);
    expect(res.status).toBe(429);
    clearUnlockFailures();
  });

  test("unlock only redirects to same-origin paths", async () => {
    clearUnlockFailures();
    for (const evil of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      const res = await unlock("OPEN4ME", evil);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const get = await fetch(`${base}/_hoster/unlock`);
    expect(get.status).toBe(405);
  });

  test("works on a host-aliased custom domain", async () => {
    clearUnlockFailures();
    addHostAlias("members.example.test", SLUG);
    invalidateHostAliasCache();
    const gate = await fetch(`${base}/members/`, { headers: { Host: "members.example.test", Accept: "text/html" } });
    expect(gate.status).toBe(401);
    const res = await unlock("OPEN4ME", "/members/", "members.example.test");
    expect(res.status).toBe(303);
    const cookie = cookieFrom(res);
    const page = await fetch(`${base}/members/`, { headers: { Host: "members.example.test", Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("members only");
  });

  test("whole-site rule covers the root", async () => {
    clearUnlockFailures();
    const whole = createRule(SLUG, { path_prefix: "/" });
    addCode(SLUG, whole.id, { name: "Everyone", code: "WHOLE123" });
    const res = await fetch(`${base}/${SLUG}/`, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(401);
    const cookie = cookieFrom(await unlock("WHOLE123", `/${SLUG}/`));
    expect((await fetch(`${base}/${SLUG}/`, { headers: { Cookie: cookie } })).status).toBe(200);
    deleteRule(SLUG, whole.id);
  });

  test("listRules returns codes for the admin UI; site deletion clears rules", () => {
    const rules = listRules(SLUG);
    expect(rules.find(r => r.path_prefix === "/members/")!.codes.map(c => c.name).sort()).toEqual(["Board members", "Contractors"]);
    createBlankSite("protsite-gone", "Gone");
    const r = createRule("protsite-gone", { path_prefix: "/" });
    addCode("protsite-gone", r.id, { name: "x", code: "GONE1234" });
    deleteSite("protsite-gone");
    expect(listRules("protsite-gone")).toEqual([]);
    expect((db.query("SELECT COUNT(*) AS n FROM protect_codes WHERE rule_id = ?").get(r.id) as any).n).toBe(0);
  });
});
