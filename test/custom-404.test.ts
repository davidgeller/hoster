// A site's own 404.html: served with a real 404 status and the <base href>
// rewrite, instead of the built-in "Not Found" page. Sites without one keep
// the built-in page.
//
// HOSTER_HOME is set in test/preload.ts; see host-aliases.test.ts for why
// cleanup is not done here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { createBlankSite, deleteSite, SITES_DIR } from "../src/sites";
import { createServer } from "../src/server";

describe("custom 404 pages", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const canonical = { Host: "canonical.example.com" };

  beforeAll(() => {
    createBlankSite("with404", "Has a 404 page");
    createBlankSite("plain404", "No 404 page");
    writeFileSync(join(SITES_DIR, "with404", "_current", "404.html"),
      '<!doctype html><html><head><base href="/"><title>Lost</title></head><body><h1>No such page here</h1></body></html>');
    server = createServer(0);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    deleteSite("with404");
    deleteSite("plain404");
    try { server.stop(true); } catch (_) {}
  });

  test("a site's own 404.html is served with status 404", async () => {
    const res = await fetch(`${baseUrl}/with404/p/missing-printer/`, { headers: canonical });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("No such page here");
    // Same <base href> rewrite as any page, so its links resolve under the slug.
    expect(body).toContain('<base href="/with404/">');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });

  test("a stale ETag never turns the 404 page into a 304", async () => {
    const res = await fetch(`${baseUrl}/with404/nope`, { headers: { ...canonical, "If-None-Match": '"anything"' } });
    expect(res.status).toBe(404);
  });

  test("the 404 page itself is still reachable directly", async () => {
    const res = await fetch(`${baseUrl}/with404/404.html`, { headers: canonical });
    expect(res.status).toBe(200);
  });

  test("a site without one gets the built-in page", async () => {
    const res = await fetch(`${baseUrl}/plain404/nope`, { headers: canonical });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("404 &mdash; Not Found");
  });
});
