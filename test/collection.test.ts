// Collection sites: card lists, images, the rendered page, and the admin API
// gates. HOSTER_HOME comes from test/preload.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import db from "../src/db";
import { SITES_DIR, createBlankSite, deleteSite, getSite, addHostAlias, checkSiteHealth, toggleSite } from "../src/sites";
import { createRepositorySite, setRepoBanner } from "../src/repo";
import {
  createCollectionSite, planCollectionItems, setCollectionItems, listCollectionItems, listCollectionItemViews,
  setCollectionImage, clearCollectionImage, setCardImage, collectionDir, updateCollectionSettings,
} from "../src/collection";
import { createAdminUser, createSession } from "../src/auth";
import { handleAdminApi } from "../src/admin-api";
import { createServer } from "../src/server";

const IP = "203.0.113.77";
const PW = "correct-horse-battery";
// Smallest valid PNG header the sniffer accepts.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let server: ReturnType<typeof createServer>;
let base = "";
let adminId = 0;
let editorId = 0;

async function api(userId: number, method: string, path: string, body?: any) {
  const { sessionToken, csrfToken } = createSession(IP, userId);
  const isBytes = body instanceof Uint8Array;
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `hoster_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
      "x-real-ip": IP,
      "content-type": isBytes ? "image/png" : "application/json",
    },
    body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
  });
  const res = (await handleAdminApi(req, path))!;
  return { status: res.status, data: await res.json() as any };
}

beforeAll(async () => {
  createBlankSite("coll-web", "Web One");
  createBlankSite("coll-web2", "Web Two");
  createRepositorySite("coll-repo", "Docs", { visibility: "public", description: "All the documents" });
  createRepositorySite("coll-private", "Secret Docs", { visibility: "private", description: "hidden blurb" });
  setRepoBanner("coll-repo", PNG);
  setRepoBanner("coll-private", PNG);
  createCollectionSite("coll-main", "Our Things", { description: "Everything we host", layout: "grid" });
  adminId = await createAdminUser("coll-admin", PW, { isAdmin: true });
  editorId = await createAdminUser("coll-editor", PW, { sites: ["coll-main", "coll-web"] });
  server = createServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  for (const s of ["coll-main", "coll-web", "coll-web2", "coll-repo", "coll-private", "coll-other"]) deleteSite(s);
  db.run("DELETE FROM admin_users WHERE username IN ('coll-admin', 'coll-editor')");
});

describe("collection model", () => {
  test("created as its own site type with defaults", () => {
    const site = getSite("coll-main")!;
    expect(site.site_type).toBe("collection");
    expect(site.coll_layout).toBe("grid");
    expect(site.coll_description).toBe("Everything we host");
    expect(checkSiteHealth("coll-main").status).toBe("ok");
    expect(() => createCollectionSite("coll-main", "dup")).toThrow(/already exists/);
    expect(() => createCollectionSite("coll-bad", "x", { layout: "spiral" as any })).toThrow(/Layout/);
  });

  test("settings validate layout and color", () => {
    updateCollectionSettings("coll-main", { layout: "carousel", bg_color: "#1A2B3C" });
    expect(getSite("coll-main")!.coll_layout).toBe("carousel");
    expect(getSite("coll-main")!.coll_bg_color).toBe("#1a2b3c");
    expect(() => updateCollectionSettings("coll-main", { bg_color: "red; background:url(x)" })).toThrow(/color/);
    updateCollectionSettings("coll-main", { layout: "grid", bg_color: null });
    expect(getSite("coll-main")!.coll_bg_color).toBeNull();
  });

  test("items: order, overrides, and validation", () => {
    const plan = planCollectionItems("coll-main", [
      { slug: "coll-repo" }, { slug: "coll-web", title: "  Custom title ", blurb: "Line one\nLine two" }, { slug: "coll-private" },
    ]);
    expect(plan.added).toEqual(["coll-repo", "coll-web", "coll-private"]);
    setCollectionItems("coll-main", plan.items);
    expect(listCollectionItems("coll-main").map(i => i.item_slug)).toEqual(["coll-repo", "coll-web", "coll-private"]);
    expect(listCollectionItems("coll-main")[1].title).toBe("Custom title");

    expect(() => planCollectionItems("coll-main", [{ slug: "coll-main" }])).toThrow(/itself/);
    expect(() => planCollectionItems("coll-main", [{ slug: "nope" }])).toThrow(/does not exist/);
    expect(() => planCollectionItems("coll-main", [{ slug: "coll-web" }, { slug: "coll-web" }])).toThrow(/more than once/);
    createCollectionSite("coll-other", "Other");
    expect(() => planCollectionItems("coll-main", [{ slug: "coll-other" }])).toThrow(/only sites and repositories/);
    expect(() => planCollectionItems("coll-web", [])).toThrow(/Not a collection/);
  });

  test("card images: kept while the card stays, removed with it", () => {
    setCardImage("coll-main", "coll-web", PNG);
    const file = join(collectionDir("coll-main"), "card-coll-web.png");
    expect(existsSync(file)).toBe(true);
    expect(() => setCardImage("coll-main", "coll-web2", PNG)).toThrow(/isn't in this collection/);
    expect(() => setCardImage("coll-main", "coll-web", new Uint8Array([1, 2, 3]))).toThrow(/PNG/);

    // Reorder: image survives.
    setCollectionItems("coll-main", planCollectionItems("coll-main", [{ slug: "coll-web" }, { slug: "coll-repo" }, { slug: "coll-private" }]).items);
    expect(existsSync(file)).toBe(true);
    const views = listCollectionItemViews("coll-main");
    expect(views.map(v => [v.item_slug, v.has_image])).toEqual([["coll-web", true], ["coll-repo", true], ["coll-private", false]]);

    // Remove the card: image goes too.
    setCollectionItems("coll-main", planCollectionItems("coll-main", [{ slug: "coll-repo" }, { slug: "coll-private" }]).items);
    expect(existsSync(file)).toBe(false);
  });

  test("deleting a listed site drops its card everywhere", () => {
    createBlankSite("coll-temp", "Temp");
    setCollectionItems("coll-main", planCollectionItems("coll-main", [{ slug: "coll-repo" }, { slug: "coll-temp" }]).items);
    setCardImage("coll-main", "coll-temp", PNG);
    deleteSite("coll-temp");
    expect(listCollectionItems("coll-main").map(i => i.item_slug)).toEqual(["coll-repo"]);
    expect(existsSync(join(collectionDir("coll-main"), "card-coll-temp.png"))).toBe(false);
  });
});

describe("public page", () => {
  beforeAll(() => {
    setCollectionItems("coll-main", planCollectionItems("coll-main", [
      { slug: "coll-repo" }, { slug: "coll-web", title: "<b>Tagged</b>" }, { slug: "coll-private" }, { slug: "coll-web2" },
    ]).items);
    toggleSite("coll-web2", false);
  });

  test("grid renders cards in order, escaped, skipping disabled sites", async () => {
    const res = await fetch(`${base}/coll-main/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    const html = await res.text();
    expect(html).toContain("<h1>Our Things</h1>");
    expect(html).toContain('class="grid"');
    expect(html).not.toContain("<script");
    const order = ["/coll-repo/", "/coll-web/", "/coll-private/"].map(h => html.indexOf(`href="${h}"`));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("&lt;b&gt;Tagged&lt;/b&gt;");
    expect(html).not.toContain("<b>Tagged</b>");
    expect(html).not.toContain("/coll-web2/"); // disabled
    expect(html).toContain("All the documents");
    expect(html).not.toContain("hidden blurb"); // private repository's description
  });

  test("/slug redirects to /slug/", async () => {
    const res = await fetch(`${base}/coll-main`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/coll-main/");
  });

  test("public repository banner stands in as a card image; a private one does not", async () => {
    expect((await fetch(`${base}/coll-main/_collection/card/coll-repo`)).status).toBe(200);
    expect((await fetch(`${base}/coll-main/_collection/card/coll-private`)).status).toBe(404);
    expect((await fetch(`${base}/coll-main/_collection/card/coll-web2`)).status).toBe(404);
  });

  test("banner and background images are served and removable", async () => {
    expect((await fetch(`${base}/coll-main/_collection/banner`)).status).toBe(404);
    setCollectionImage("coll-main", "banner", PNG);
    setCollectionImage("coll-main", "background", PNG);
    const img = await fetch(`${base}/coll-main/_collection/banner`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const html = await (await fetch(`${base}/coll-main/`)).text();
    expect(html).toContain('class="banner"');
    expect(html).toContain("has-bg-image");
    clearCollectionImage("coll-main", "banner");
    expect((await fetch(`${base}/coll-main/_collection/banner`)).status).toBe(404);
    clearCollectionImage("coll-main", "background");
  });

  test("carousel layout ships the script with the page's nonce", async () => {
    updateCollectionSettings("coll-main", { layout: "carousel" });
    const res = await fetch(`${base}/coll-main/`);
    const nonce = res.headers.get("content-security-policy")!.match(/'nonce-([^']+)'/)![1];
    const html = await res.text();
    expect(html).toContain('class="cf"');
    expect(html).toContain(`<script nonce="${nonce}">`);
    updateCollectionSettings("coll-main", { layout: "grid" });
  });

  test("cards link to a site's custom domain when it has one", async () => {
    addHostAlias("coll-web.example.test", "coll-web");
    const html = await (await fetch(`${base}/coll-main/`)).text();
    expect(html).toContain('href="https://coll-web.example.test/"');
  });

  test("a card's own link wins over the computed one", async () => {
    const items = listCollectionItems("coll-main").map(i => ({ slug: i.item_slug, title: i.title, blurb: i.blurb, url: i.url }));
    items.find(i => i.slug === "coll-repo")!.url = "https://docs.example.test/start?x=1&y=2";
    setCollectionItems("coll-main", planCollectionItems("coll-main", items).items);
    const html = await (await fetch(`${base}/coll-main/`)).text();
    expect(html).toContain('href="https://docs.example.test/start?x=1&amp;y=2"');
    expect(html).not.toContain('href="/coll-repo/"');
  });

  test("card links must be absolute http(s) URLs", () => {
    const plan = (url: string) => planCollectionItems("coll-main", [{ slug: "coll-web", url }]);
    expect(plan("  ").items[0].url).toBeNull();
    expect(plan("https://app.example.com").items[0].url).toBe("https://app.example.com/");
    expect(() => plan("javascript:alert(1)")).toThrow(/https/);
    expect(() => plan("data:text/html,hi")).toThrow(/https/);
    expect(() => plan("/relative/path")).toThrow(/valid URL/);
    expect(() => plan("https://user:pw@example.com/")).toThrow(/password/);
    expect(() => plan("https://example.com/" + "a".repeat(2001))).toThrow(/2000/);
  });

  test("disabled collections and unknown paths 404; writes are refused", async () => {
    expect((await fetch(`${base}/coll-main/whatever`)).status).toBe(404);
    expect((await fetch(`${base}/coll-main/`, { method: "POST" })).status).toBe(405);
    toggleSite("coll-main", false);
    expect((await fetch(`${base}/coll-main/`)).status).toBe(404);
    toggleSite("coll-main", true);
  });
});

describe("admin API", () => {
  test("administrators create collections; site users cannot", async () => {
    const denied = await api(editorId, "POST", "/_admin/api/sites/collection", { slug: "coll-x" });
    expect(denied.status).toBe(403);
    const ok = await api(adminId, "POST", "/_admin/api/sites/collection", { slug: "coll-x", name: "X", layout: "carousel" });
    expect(ok.status).toBe(200);
    expect(ok.data.site.coll_layout).toBe("carousel");
    deleteSite("coll-x");
  });

  test("site users may keep existing cards but only add sites they manage", async () => {
    const current = listCollectionItems("coll-main").map(i => ({ slug: i.item_slug }));
    // Reordering what an administrator added is fine.
    const reordered = [...current].reverse();
    const r1 = await api(editorId, "PUT", "/_admin/api/sites/coll-main/collection/items", { items: reordered });
    expect(r1.status).toBe(200);
    expect(r1.data.items.map((i: any) => i.item_slug)).toEqual(reordered.map(i => i.slug));
    // Adding a site they don't manage is refused.
    const withOther = current.filter(i => i.slug !== "coll-web2");
    await api(adminId, "PUT", "/_admin/api/sites/coll-main/collection/items", { items: withOther });
    const r2 = await api(editorId, "PUT", "/_admin/api/sites/coll-main/collection/items", { items: [...withOther, { slug: "coll-web2" }] });
    expect(r2.status).toBe(403);
    expect(r2.data.error).toContain("coll-web2");
    // A collection they don't manage is off limits entirely.
    expect((await api(editorId, "GET", "/_admin/api/sites/coll-other/collection/items")).status).toBe(403);
  });

  test("settings and images through the API", async () => {
    const s = await api(adminId, "POST", "/_admin/api/sites/coll-main/settings", { name: "Renamed", collection: { layout: "carousel", bg_color: "#000000", description: "d" } });
    expect(s.status).toBe(200);
    expect(getSite("coll-main")!.name).toBe("Renamed");
    expect(getSite("coll-main")!.coll_layout).toBe("carousel");
    const img = await api(adminId, "POST", "/_admin/api/sites/coll-main/collection/items/coll-repo/image", PNG);
    expect(img.status).toBe(200);
    expect(existsSync(join(SITES_DIR, "coll-main", "_collection", "card-coll-repo.png"))).toBe(true);
    const bad = await api(adminId, "POST", "/_admin/api/sites/coll-main/collection/banner", new Uint8Array([1, 2, 3]));
    expect(bad.status).toBe(400);
    expect((await api(adminId, "GET", "/_admin/api/sites/coll-web/collection/items")).status).toBe(400);
    const list = await api(adminId, "GET", "/_admin/api/sites");
    expect(list.data.sites.find((x: any) => x.slug === "coll-main").collection_count).toBeGreaterThan(0);
  });
});
