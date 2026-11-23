// index.htm as a directory index: served for /slug/ and /slug/sub/ when there
// is no index.html (index.html wins when both exist), with text/html, the
// <base href> rewrite, the trailing-slash redirect, extensionless .htm URLs,
// the SPA fallback, and root-directory detection on deploy.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createBlankSite, deleteSite, deploySite, getSite, invalidateSiteCache, SITES_DIR } from "../src/sites";
import { createServer } from "../src/server";
import db from "../src/db";

const page = (t: string) => `<!doctype html><html><head><base href="/"><title>${t}</title></head><body>${t}</body></html>`;

describe("index.htm", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const H = { Host: "canonical.example.com" };

  beforeAll(() => {
    createBlankSite("htm-only", "htm");
    const dir = join(SITES_DIR, "htm-only", "_current");
    rmSync(join(dir, "index.html"));
    writeFileSync(join(dir, "index.htm"), page("HTM ROOT"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "index.htm"), page("HTM SUB"));
    writeFileSync(join(dir, "about.htm"), page("HTM ABOUT"));

    createBlankSite("htm-both", "both");
    writeFileSync(join(SITES_DIR, "htm-both", "_current", "index.htm"), page("SHOULD NOT WIN"));
    server = createServer(0);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    for (const s of ["htm-only", "htm-both", "htm-zip"]) try { deleteSite(s); } catch (_) {}
    try { server.stop(true); } catch (_) {}
  });

  test("the site root serves index.htm as HTML with the base rewrite", async () => {
    const res = await fetch(`${baseUrl}/htm-only/`, { headers: H });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("HTM ROOT");
    expect(body).toContain('<base href="/htm-only/">');
  });

  test("a folder without a trailing slash redirects, then serves its index.htm", async () => {
    const r1 = await fetch(`${baseUrl}/htm-only`, { headers: H, redirect: "manual" });
    expect(r1.status).toBe(301);
    const r2 = await fetch(`${baseUrl}/htm-only/sub`, { headers: H, redirect: "manual" });
    expect(r2.status).toBe(301);
    expect(r2.headers.get("location")).toBe("/htm-only/sub/");
    const r3 = await fetch(`${baseUrl}/htm-only/sub/`, { headers: H });
    expect(await r3.text()).toContain("HTM SUB");
  });

  test("naming the .htm file directly is not redirected", async () => {
    const res = await fetch(`${baseUrl}/htm-only/sub/index.htm`, { headers: H, redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("extensionless URLs find .htm pages", async () => {
    const res = await fetch(`${baseUrl}/htm-only/about`, { headers: H });
    expect(await res.text()).toContain("HTM ABOUT");
  });

  test("index.html wins when both exist", async () => {
    const body = await (await fetch(`${baseUrl}/htm-both/`, { headers: H })).text();
    expect(body).not.toContain("SHOULD NOT WIN");
  });

  test("SPA mode falls back to index.htm", async () => {
    db.run("UPDATE sites SET spa = 1 WHERE slug = 'htm-only'");
    try {
      invalidateSiteCache("htm-only");
      const res = await fetch(`${baseUrl}/htm-only/some/client/route`, { headers: H });
      expect(await res.text()).toContain("HTM ROOT");
    } finally {
      db.run("UPDATE sites SET spa = 0 WHERE slug = 'htm-only'");
      invalidateSiteCache("htm-only");
    }
  });

  test("deploy detects a root directory that holds only index.htm", async () => {
    const tmp = join(SITES_DIR, "..", "htm-zip-src");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, "dist"), { recursive: true });
    writeFileSync(join(tmp, "dist", "index.htm"), page("ZIPPED"));
    // A second top-level entry, so deploy doesn't hoist dist/ to the root.
    writeFileSync(join(tmp, "README.txt"), "build output in dist/");
    const zip = join(tmp, "..", "htm-zip.zip");
    Bun.spawnSync(["zip", "-qr", zip, "dist", "README.txt"], { cwd: tmp });
    await deploySite("htm-zip", "zip", await Bun.file(zip).arrayBuffer());
    expect(getSite("htm-zip")!.root_dir).toBe("dist");
    const body = await (await fetch(`${baseUrl}/htm-zip/`, { headers: H })).text();
    expect(body).toContain("ZIPPED");
    rmSync(tmp, { recursive: true, force: true });
    rmSync(zip, { force: true });
  });
});
