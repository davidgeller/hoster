// Tests for the default landing page — what "/" on the canonical host does,
// and the admin footer bar injected over the default site's pages.
//
// HOSTER_HOME is set in test/preload.ts; see host-aliases.test.ts for why
// cleanup is not done here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createBlankSite,
  deleteSite,
  addHostAlias,
  addAlias,
  getDefaultSite,
  setDefaultSite,
  normalizeDefaultSiteTarget,
  getDefaultSiteFooterSlug,
} from "../src/sites";
import { createServer } from "../src/server";

describe("default site config", () => {
  beforeAll(() => {
    createBlankSite("landing", "David's Landing");
    setDefaultSite({ target: "", footer: true });
  });
  afterAll(() => {
    setDefaultSite({ target: "", footer: true });
    deleteSite("landing");
  });

  test("defaults to admin sign-in with footer on", () => {
    expect(getDefaultSite()).toEqual({ target: "", footer: true });
    expect(getDefaultSiteFooterSlug()).toBeNull();
  });

  test("accepts an existing slug", () => {
    expect(normalizeDefaultSiteTarget("landing")).toBe("landing");
    expect(normalizeDefaultSiteTarget("  landing  ")).toBe("landing");
  });

  test("rejects an unknown slug", () => {
    expect(() => normalizeDefaultSiteTarget("nope")).toThrow(/does not exist/);
  });

  test("rejects malformed targets", () => {
    expect(() => normalizeDefaultSiteTarget("Not A Slug")).toThrow();
    expect(() => normalizeDefaultSiteTarget("javascript:alert(1)")).toThrow();
    expect(() => normalizeDefaultSiteTarget("ftp://example.com")).toThrow();
    expect(() => normalizeDefaultSiteTarget("https://user:pw@example.com/")).toThrow(/credentials/);
    expect(() => normalizeDefaultSiteTarget("http://")).toThrow(/not valid/);
  });

  test("accepts and normalizes an http(s) URL", () => {
    expect(normalizeDefaultSiteTarget("https://example.com")).toBe("https://example.com/");
    expect(normalizeDefaultSiteTarget("HTTP://Example.com/path?q=1")).toBe("http://example.com/path?q=1");
  });

  test("setDefaultSite persists and merges partial updates", () => {
    setDefaultSite({ target: "landing" });
    expect(getDefaultSite()).toEqual({ target: "landing", footer: true });
    setDefaultSite({ footer: false });
    expect(getDefaultSite()).toEqual({ target: "landing", footer: false });
    expect(getDefaultSiteFooterSlug()).toBeNull();
    setDefaultSite({ footer: true });
    expect(getDefaultSiteFooterSlug()).toBe("landing");
  });

  test("footer slug resolves path aliases to the primary slug", () => {
    addAlias("home", "landing");
    setDefaultSite({ target: "home", footer: true });
    expect(getDefaultSite().target).toBe("home");
    expect(getDefaultSiteFooterSlug()).toBe("landing");
  });

  test("external URL target never carries a footer", () => {
    setDefaultSite({ target: "https://example.com/", footer: true });
    expect(getDefaultSiteFooterSlug()).toBeNull();
  });

  test("deleting the default site falls back to admin", () => {
    createBlankSite("temp-default", "Temp");
    setDefaultSite({ target: "temp-default" });
    deleteSite("temp-default");
    expect(getDefaultSite().target).toBe("");
  });
});

describe("root routing with a default site", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const canonical = { Host: "canonical.example.com" };

  beforeAll(() => {
    createBlankSite("landing", "David's Landing");
    createBlankSite("other", "Other");
    addHostAlias("landing.example.com", "landing");
    setDefaultSite({ target: "", footer: true });
    server = createServer(0);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    setDefaultSite({ target: "", footer: true });
    deleteSite("landing");
    deleteSite("other");
    try { server.stop(true); } catch (_) {}
  });

  test("root redirects to admin when unset", async () => {
    const res = await fetch(`${baseUrl}/`, { headers: canonical, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_admin");
  });

  test("root redirects to the default site, keeping the query string", async () => {
    setDefaultSite({ target: "landing" });
    const res = await fetch(`${baseUrl}/?ref=x`, { headers: canonical, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/landing/?ref=x");
  });

  test("root redirects to an external URL", async () => {
    setDefaultSite({ target: "https://example.com/hello" });
    const res = await fetch(`${baseUrl}/`, { headers: canonical, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/hello");
  });

  test("default site pages carry the admin footer on the canonical host", async () => {
    setDefaultSite({ target: "landing", footer: true });
    const res = await fetch(`${baseUrl}/landing/`, { headers: canonical });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="hoster-admin-footer"');
    expect(body).toContain('href="/_admin"');
    // Injected before </body>, not appended after </html>.
    expect(body.indexOf("hoster-admin-footer")).toBeLessThan(body.indexOf("</body>"));
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  });

  test("footer ETag differs from the plain page ETag", async () => {
    setDefaultSite({ target: "landing", footer: false });
    const plain = await fetch(`${baseUrl}/landing/`, { headers: canonical });
    expect(await plain.text()).not.toContain("hoster-admin-footer");
    setDefaultSite({ target: "landing", footer: true });
    const withFooter = await fetch(`${baseUrl}/landing/`, { headers: canonical });
    await withFooter.text();
    expect(withFooter.headers.get("etag")).not.toBe(plain.headers.get("etag"));
    // A client holding the old ETag must get a fresh 200, not a 304.
    const revalidate = await fetch(`${baseUrl}/landing/`, {
      headers: { ...canonical, "If-None-Match": plain.headers.get("etag")! },
    });
    expect(revalidate.status).toBe(200);
  });

  test("other sites do not get the footer", async () => {
    setDefaultSite({ target: "landing", footer: true });
    const res = await fetch(`${baseUrl}/other/`, { headers: canonical });
    expect(await res.text()).not.toContain("hoster-admin-footer");
  });

  test("footer is off when disabled", async () => {
    setDefaultSite({ target: "landing", footer: false });
    const res = await fetch(`${baseUrl}/landing/`, { headers: canonical });
    expect(await res.text()).not.toContain("hoster-admin-footer");
  });

  test("host-aliased requests never get the footer", async () => {
    setDefaultSite({ target: "landing", footer: true });
    const res = await fetch(`${baseUrl}/`, { headers: { Host: "landing.example.com" } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("hoster-admin-footer");
  });
});
