// Repository sites: content-addressed storage, per-file versioning, quota,
// trash, packaging, backup/restore, and the public HTTP surface (auth,
// visibility, CSRF, safe content serving).
//
// HOSTER_HOME is set in test/preload.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createRepositorySite, putRepoFile, writeRepoText, listRepoTree, readRepoContent, listRepoVersions, restoreRepoVersion,
  deleteRepoVersion, createRepoFolder, renameRepoPath, deleteRepoPaths, listRepoTrash, restoreRepoTrash, purgeRepoTrash,
  repoStats, repoUsedBytes, zipRepoPaths, exportRepoBackup, importRepoBackup, setRepoBanner, repoBannerPath,
  normalizeRepoPath, mimeForName, previewKind, repoDir, purgeExpiredRepoTrash, moveRepoPaths, copyRepoPaths,
} from "../src/repo";
import { getSite, deleteSite, updateRepoSettings, setSiteAllowedCountries, deploySite, createBlankSite, checkSiteHealth, rebuildCurrentSymlinks } from "../src/sites";
import { createAdminUser } from "../src/auth";
import { isCountryAllowed, setAllowedCountries } from "../src/analytics";
import { createServer } from "../src/server";
import db from "../src/db";

const SLUG = "docs-test";
const text = (s: string) => new TextEncoder().encode(s);
// unzip can't read from stdin; list an in-memory archive via a temp file.
function zipListing(buffer: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "hoster-ziplist-"));
  const file = join(dir, "a.zip");
  writeFileSync(file, buffer);
  return Bun.spawnSync(["unzip", "-Z1", file]).stdout.toString();
}

describe("repository storage", () => {
  beforeAll(() => { createRepositorySite(SLUG, "Docs", { quota_bytes: 10_000, max_versions: 3 }); });
  afterAll(() => { try { deleteSite(SLUG); } catch (_) {} });

  test("creates a repository site with no versioned tree", () => {
    const site = getSite(SLUG)!;
    expect(site.site_type).toBe("repository");
    expect(site.current_version).toBeNull();
    expect(site.repo_visibility).toBe("private");
    expect(existsSync(join(repoDir(SLUG), "objects"))).toBe(true);
    expect(checkSiteHealth(SLUG).status).toBe("ok");
    // The symlink self-heal leaves repositories alone (no warning, no _current).
    const rebuild = rebuildCurrentSymlinks();
    expect(rebuild.warnings.some(w => w.includes(SLUG))).toBe(false);
    expect(existsSync(join(repoDir(SLUG), "..", "_current"))).toBe(false);
  });

  test("web-site operations refuse a repository slug", async () => {
    await expect(deploySite(SLUG, "x", new ArrayBuffer(10))).rejects.toThrow(/repository site/);
    expect(() => createBlankSite(SLUG, "x")).toThrow(/already exists/);
  });

  test("path normalization", () => {
    expect(normalizeRepoPath("/a//b/./c.txt")).toBe("a/b/c.txt");
    expect(() => normalizeRepoPath("../x")).toThrow(/traversal/);
    expect(() => normalizeRepoPath("ab")).toThrow(/control/);
    expect(() => normalizeRepoPath("_repo")).toThrow(/reserved/);
    expect(mimeForName("Report.PDF")).toBe("application/pdf");
    expect(mimeForName("notes.md")).toBe("text/markdown");
    expect(previewKind("image/svg+xml")).toBe("image");
    expect(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("none");
  });

  test("upload creates files, parents, and version 1; identical bytes are a no-op", async () => {
    const r1 = await putRepoFile(SLUG, "reports/q1/summary.txt", text("hello"), { actor: "alice" });
    expect(r1.created).toBe(true);
    expect(r1.file.version_no).toBe(1);
    expect(r1.file.created_by).toBe("alice");
    const tree = listRepoTree(SLUG);
    expect(tree.dirs.map(d => d.path)).toEqual(["reports", "reports/q1"]);
    expect(tree.files.map(f => f.path)).toEqual(["reports/q1/summary.txt"]);
    const r2 = await putRepoFile(SLUG, "reports/q1/summary.txt", text("hello"), { actor: "bob" });
    expect(r2.new_version).toBe(false);
    expect(getSite(SLUG)!.file_count).toBe(1);
    expect(getSite(SLUG)!.size_bytes).toBe(5);
  });

  test("new content makes a new version; content is deduplicated across files", async () => {
    const r = await putRepoFile(SLUG, "reports/q1/summary.txt", text("hello v2"), { actor: "alice", note: "second draft" });
    expect(r.file.version_no).toBe(2);
    const versions = listRepoVersions(SLUG, "reports/q1/summary.txt");
    expect(versions.map(v => v.version_no)).toEqual([2, 1]);
    expect(versions[0].note).toBe("second draft");
    expect(versions[0].current).toBe(true);
    // Same bytes under another name reuse the blob: no extra storage.
    const before = repoUsedBytes(SLUG);
    await putRepoFile(SLUG, "copy.txt", text("hello v2"));
    expect(repoUsedBytes(SLUG)).toBe(before);
    expect(readdirSync(join(repoDir(SLUG), "objects")).length).toBeGreaterThan(0);
  });

  test("old versions can be read and restored; restore records a new version", async () => {
    const v1 = readRepoContent(SLUG, "reports/q1/summary.txt", 1)!;
    expect(await Bun.file(v1.abs).text()).toBe("hello");
    const cur = readRepoContent(SLUG, "reports/q1/summary.txt")!;
    expect(await Bun.file(cur.abs).text()).toBe("hello v2");
    const r = restoreRepoVersion(SLUG, "reports/q1/summary.txt", 1, "alice");
    expect(r.file.version_no).toBe(3);
    expect(await Bun.file(readRepoContent(SLUG, "reports/q1/summary.txt")!.abs).text()).toBe("hello");
    expect(listRepoVersions(SLUG, "reports/q1/summary.txt")[0].note).toMatch(/Restored version 1/);
  });

  test("per-file version cap prunes the oldest versions and frees their blobs", async () => {
    // max_versions = 3, currently at v3; two more pushes v1 and v2 out.
    await putRepoFile(SLUG, "reports/q1/summary.txt", text("v4"));
    const r = await putRepoFile(SLUG, "reports/q1/summary.txt", text("v5"));
    expect(r.file.version_no).toBe(5);
    expect(listRepoVersions(SLUG, "reports/q1/summary.txt").map(v => v.version_no)).toEqual([5, 4, 3]);
    expect(readRepoContent(SLUG, "reports/q1/summary.txt", 1)).toBeNull();
    // "hello v2" is still referenced by copy.txt so its blob survives; "v4" is only in history.
    expect(await Bun.file(readRepoContent(SLUG, "copy.txt")!.abs).text()).toBe("hello v2");
    expect(() => deleteRepoVersion(SLUG, "reports/q1/summary.txt", 5)).toThrow(/current version/);
    expect(deleteRepoVersion(SLUG, "reports/q1/summary.txt", 4)).toBe(true);
    expect(listRepoVersions(SLUG, "reports/q1/summary.txt").map(v => v.version_no)).toEqual([5, 3]);
  });

  test("quota is enforced against live blob bytes", async () => {
    const big = new Uint8Array(9_990);
    await expect(putRepoFile(SLUG, "big.bin", big)).rejects.toThrow(/Not enough space/);
    expect(listRepoTree(SLUG).files.some(f => f.path === "big.bin")).toBe(false);
    updateRepoSettings(SLUG, { quota_bytes: 50_000 });
    await putRepoFile(SLUG, "big.bin", big);
    expect(repoStats(SLUG).used_bytes).toBeGreaterThanOrEqual(9_990);
    expect(() => updateRepoSettings(SLUG, { max_versions: -1 })).toThrow();
    expect(() => updateRepoSettings(SLUG, { visibility: "everyone" as any })).toThrow();
  });

  test("text editor writes text files only", async () => {
    const r = await writeRepoText(SLUG, "notes/readme.md", "# Hi\r\nthere", { actor: "alice" });
    expect(r.file.mime).toBe("text/markdown");
    expect(await Bun.file(readRepoContent(SLUG, "notes/readme.md")!.abs).text()).toBe("# Hi\nthere");
    await expect(writeRepoText(SLUG, "page.html", "<b>x</b>")).rejects.toThrow(/text files/);
    await expect(writeRepoText(SLUG, "notes/readme.md", "again", { replace: false })).rejects.toThrow(/already exists/);
  });

  test("folders: mkdir, rename moves descendants, cannot nest into itself", () => {
    expect(createRepoFolder(SLUG, "empty").created).toBe(true);
    expect(createRepoFolder(SLUG, "empty").created).toBe(false);
    expect(() => createRepoFolder(SLUG, "copy.txt")).toThrow(/is a file/);
    expect(() => renameRepoPath(SLUG, "reports", "reports/q1/inner")).toThrow(/inside itself/);
    const r = renameRepoPath(SLUG, "reports", "archive/reports");
    expect(r.kind).toBe("dir");
    expect(r.moved).toBe(3); // reports, reports/q1, reports/q1/summary.txt
    const tree = listRepoTree(SLUG);
    expect(tree.files.map(f => f.path)).toContain("archive/reports/q1/summary.txt");
    expect(tree.dirs.map(d => d.path)).toContain("archive");
    // History followed the file.
    expect(listRepoVersions(SLUG, "archive/reports/q1/summary.txt").length).toBe(2);
    expect(() => renameRepoPath(SLUG, "copy.txt", "big.bin")).toThrow(/already exists/);
  });

  test("move keeps names and history; copy shares blobs and auto-renames on conflict", async () => {
    createRepoFolder(SLUG, "inbox");
    await putRepoFile(SLUG, "inbox/a.txt", text("A1"));
    await putRepoFile(SLUG, "inbox/a.txt", text("A2"));
    createRepoFolder(SLUG, "outbox");
    const mv = moveRepoPaths(SLUG, ["inbox/a.txt", "empty"], "outbox", "alice");
    expect(mv.moved.map(m => m.to)).toEqual(["outbox/a.txt", "outbox/empty"]);
    expect(listRepoVersions(SLUG, "outbox/a.txt").length).toBe(2);
    expect(() => moveRepoPaths(SLUG, ["outbox"], "outbox/empty")).toThrow(/inside itself/);
    expect(() => moveRepoPaths(SLUG, ["outbox/a.txt"], "nope")).toThrow(/does not exist/);
    // Move to the root.
    moveRepoPaths(SLUG, ["outbox/empty"], "");
    expect(listRepoTree(SLUG).dirs.some(d => d.path === "empty")).toBe(true);

    const before = repoUsedBytes(SLUG);
    const cp = copyRepoPaths(SLUG, ["outbox/a.txt", "outbox"], "inbox", "alice");
    expect(cp.copied.map(c => c.to)).toEqual(["inbox/a.txt", "inbox/outbox"]);
    expect(cp.files).toBe(2);
    expect(repoUsedBytes(SLUG)).toBe(before); // same blob, no new bytes
    expect(await Bun.file(readRepoContent(SLUG, "inbox/outbox/a.txt")!.abs).text()).toBe("A2");
    expect(listRepoVersions(SLUG, "inbox/a.txt").length).toBe(1);
    expect(listRepoVersions(SLUG, "inbox/a.txt")[0].note).toMatch(/Copied from outbox\/a.txt/);
    // Same-folder copy gets a "copy" suffix; a second one "copy 2".
    expect(copyRepoPaths(SLUG, ["outbox/a.txt"], "outbox").copied[0].to).toBe("outbox/a copy.txt");
    expect(copyRepoPaths(SLUG, ["outbox/a.txt"], "outbox").copied[0].to).toBe("outbox/a copy 2.txt");
    expect(() => copyRepoPaths(SLUG, ["outbox"], "outbox")).toThrow(/into itself/);
    // The copied file is independent: editing it doesn't touch the original.
    await putRepoFile(SLUG, "inbox/a.txt", text("A3"));
    expect(await Bun.file(readRepoContent(SLUG, "outbox/a.txt")!.abs).text()).toBe("A2");
    deleteRepoPaths(SLUG, ["inbox", "outbox"]);
    purgeRepoTrash(SLUG);
  });

  test("delete is soft: trash, restore (with conflict renaming), purge frees space", async () => {
    const before = repoUsedBytes(SLUG);
    const r = deleteRepoPaths(SLUG, ["archive", "copy.txt"], "alice");
    expect(r.deleted.map(d => d.path)).toEqual(["archive", "copy.txt"]);
    expect(listRepoTree(SLUG).files.map(f => f.path)).not.toContain("copy.txt");
    expect(repoUsedBytes(SLUG)).toBe(before); // trash still holds the bytes
    const trash = listRepoTrash(SLUG);
    expect(trash.some(t => t.path === "archive/reports/q1/summary.txt")).toBe(true);
    // Recreate copy.txt, then restore the trashed one — it comes back renamed.
    await putRepoFile(SLUG, "copy.txt", text("new copy"));
    const copyEntry = trash.find(t => t.path === "copy.txt")!;
    const archiveEntry = trash.find(t => t.path === "archive")!;
    const restored = restoreRepoTrash(SLUG, [copyEntry.id, archiveEntry.id]);
    expect(restored.restored).toContain("copy (restored).txt");
    expect(restored.restored).toContain("archive/reports/q1/summary.txt");
    expect(listRepoTree(SLUG).files.map(f => f.path)).toContain("archive/reports/q1/summary.txt");
    expect(listRepoTrash(SLUG).length).toBe(0);
    // Purge for real.
    deleteRepoPaths(SLUG, ["big.bin"]);
    const purge = purgeRepoTrash(SLUG);
    expect(purge.purged).toBe(1);
    expect(purge.freed_blobs).toBe(1);
    expect(repoUsedBytes(SLUG)).toBeLessThan(before);
    expect(repoStats(SLUG).trash_count).toBe(0);
  });

  test("expired trash is purged by the periodic job", () => {
    deleteRepoPaths(SLUG, ["copy (restored).txt"]);
    db.run("UPDATE repo_files SET deleted_at = datetime('now', '-40 days') WHERE site_slug = ? AND deleted_at IS NOT NULL", SLUG);
    expect(purgeExpiredRepoTrash(30)).toBe(1);
    expect(listRepoTrash(SLUG).length).toBe(0);
  });

  test("zip packages files and folders with their structure", async () => {
    const { buffer, filename } = await zipRepoPaths(SLUG, ["archive/reports", "notes/readme.md"]);
    expect(filename).toBe(`${SLUG}.zip`);
    const listing = zipListing(buffer);
    expect(listing).toContain("reports/q1/summary.txt");
    expect(listing).toContain("readme.md");
    await expect(zipRepoPaths(SLUG, ["nope"])).rejects.toThrow(/does not exist/);
    const single = await zipRepoPaths(SLUG, ["notes/readme.md"]);
    expect(single.filename).toBe("readme.zip");
  });

  test("banner accepts real images only", () => {
    expect(() => setRepoBanner(SLUG, text("<svg/>"))).toThrow(/PNG, JPEG/);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(setRepoBanner(SLUG, png).banner).toBe("banner.png");
    expect(repoBannerPath(getSite(SLUG)!)!.mime).toBe("image/png");
  });

  test("backup archive round-trips files, history, trash and banner", async () => {
    const statsBefore = repoStats(SLUG);
    const { buffer, manifest } = await exportRepoBackup(SLUG);
    expect(manifest.format).toBe("hoster-repository");
    expect(manifest.file_count).toBe(statsBefore.file_count);
    const listing = zipListing(buffer);
    expect(listing).toContain("files/archive/reports/q1/summary.txt");
    expect(listing).toContain("repository.json");
    expect(listing).toContain("banner.png");

    // Restore into a fresh repository and compare.
    createRepositorySite("docs-restore", "Restored");
    try {
      await putRepoFile("docs-restore", "junk.txt", text("to be replaced"));
      const m = await importRepoBackup("docs-restore", buffer);
      expect(m.slug).toBe(SLUG);
      const tree = listRepoTree("docs-restore");
      expect(tree.files.map(f => f.path)).toEqual(listRepoTree(SLUG).files.map(f => f.path));
      expect(tree.files.some(f => f.path === "junk.txt")).toBe(false);
      expect(listRepoVersions("docs-restore", "archive/reports/q1/summary.txt").map(v => v.version_no)).toEqual([5, 3]);
      expect(await Bun.file(readRepoContent("docs-restore", "archive/reports/q1/summary.txt", 3)!.abs).text()).toBe("hello");
      expect(repoStats("docs-restore").used_bytes).toBe(statsBefore.used_bytes);
      expect(repoBannerPath(getSite("docs-restore")!)).not.toBeNull();
      await expect(importRepoBackup("docs-restore", Buffer.from("not a zip"))).rejects.toThrow();
    } finally {
      deleteSite("docs-restore");
    }
  });

  test("deleting the site removes the repository directory and rows", () => {
    createRepositorySite("docs-gone", "Gone");
    deleteSite("docs-gone");
    expect(existsSync(repoDir("docs-gone"))).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM repo_files WHERE site_slug = 'docs-gone'").get()).toEqual({ n: 0 });
  });
});

describe("per-site country restrictions", () => {
  beforeAll(() => { createBlankSite("geo-web", "Geo"); setAllowedCountries([]); });
  afterAll(() => { setAllowedCountries([]); deleteSite("geo-web"); });

  test("inherit / override / allow-all semantics", () => {
    setAllowedCountries(["US"]);
    expect(isCountryAllowed("US", "geo-web")).toBe(true);
    expect(isCountryAllowed("CA", "geo-web")).toBe(false);
    expect(isCountryAllowed("CA", null)).toBe(false);
    // Site opens itself to everyone.
    setSiteAllowedCountries("geo-web", []);
    expect(getSite("geo-web")!.allowed_countries).toBe("");
    expect(isCountryAllowed("CA", "geo-web")).toBe(true);
    expect(isCountryAllowed(null, "geo-web")).toBe(true);
    expect(isCountryAllowed("CA", null)).toBe(false); // global unchanged
    // Site restricts itself while the world is open.
    setAllowedCountries([]);
    setSiteAllowedCountries("geo-web", ["ca", "GB"]);
    expect(getSite("geo-web")!.allowed_countries).toBe("CA,GB");
    expect(isCountryAllowed("US", "geo-web")).toBe(false);
    expect(isCountryAllowed("gb", "geo-web")).toBe(true);
    expect(isCountryAllowed("US", "other-site")).toBe(true);
    expect(() => setSiteAllowedCountries("geo-web", ["ZZ"])).toThrow(/Unknown country/);
    // Back to inheriting.
    setSiteAllowedCountries("geo-web", null);
    expect(getSite("geo-web")!.allowed_countries).toBeNull();
  });
});

describe("repository HTTP surface", () => {
  const PORT = 39611 + Math.floor(Math.random() * 200);
  let server: ReturnType<typeof createServer>;
  const base = () => `http://127.0.0.1:${PORT}`;
  const SITE = "pub-docs";
  let adminCookie = "";
  let adminCsrf = "";

  beforeAll(async () => {
    createRepositorySite(SITE, "Public Docs", { visibility: "public" });
    await putRepoFile(SITE, "hello.txt", text("hello world"));
    await putRepoFile(SITE, "evil.html", text("<script>alert(1)</script>"));
    await putRepoFile(SITE, "media/pic.svg", text("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"));
    await putRepoFile(SITE, "doc.docx", text("PK...fake"));
    try { await createAdminUser("repoadmin", "repoadmin-pass-1", { isAdmin: true }); } catch (_) {}
    try { await createAdminUser("repouser", "repouser-pass-1", { isAdmin: false, sites: [] }); } catch (_) {}
    server = createServer(PORT);
    // Sign in through the repository's own login endpoint.
    const res = await fetch(`${base()}/${SITE}/_repo/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "repoadmin", password: "repoadmin-pass-1" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    adminCsrf = body.csrf_token;
    adminCookie = res.headers.get("set-cookie")!.split(";")[0];
  });
  afterAll(() => { server.stop(true); try { deleteSite(SITE); } catch (_) {} });

  test("/slug redirects to /slug/ and serves the built-in UI with a rewritten base", async () => {
    const r1 = await fetch(`${base()}/${SITE}`, { redirect: "manual" });
    expect(r1.status).toBe(301);
    expect(r1.headers.get("location")).toBe(`/${SITE}/`);
    const r2 = await fetch(`${base()}/${SITE}/`);
    expect(r2.status).toBe(200);
    const html = await r2.text();
    expect(html).toContain(`<base href="/${SITE}/">`);
    expect(r2.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(r2.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const css = await fetch(`${base()}/${SITE}/_repo/ui/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const nope = await fetch(`${base()}/${SITE}/_repo/ui/..%2F..%2Fapp.js`, { redirect: "manual" });
    expect(nope.status).not.toBe(200);
  });

  test("public repository: anonymous can read tree and download; cannot write", async () => {
    const info = await (await fetch(`${base()}/${SITE}/_repo/api/info`)).json();
    expect(info.auth.can_read).toBe(true);
    expect(info.auth.can_write).toBe(false);
    expect(info.auth.csrf_token).toBeNull();
    const tree = await (await fetch(`${base()}/${SITE}/_repo/api/tree`)).json();
    expect(tree.files.map((f: any) => f.path)).toContain("hello.txt");
    const raw = await fetch(`${base()}/${SITE}/_repo/api/file?path=hello.txt`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("hello world");
    expect(raw.headers.get("content-disposition")).toMatch(/^inline/);
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    const up = await fetch(`${base()}/${SITE}/_repo/api/upload?path=x.txt`, { method: "POST", body: "x" });
    expect(up.status).toBe(401);
    const mk = await fetch(`${base()}/${SITE}/_repo/api/mkdir`, { method: "POST", body: JSON.stringify({ path: "d" }) });
    expect(mk.status).toBe(401);
  });

  test("active content is never served executable on the site origin", async () => {
    const html = await fetch(`${base()}/${SITE}/_repo/api/file?path=evil.html`);
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(html.headers.get("content-type")).toContain("text/html");
    const svg = await fetch(`${base()}/${SITE}/_repo/api/file?path=media/pic.svg`);
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
    // Unknown/office types are always attachments; ?dl=1 forces a download for anything.
    const docx = await fetch(`${base()}/${SITE}/_repo/api/file?path=doc.docx`);
    expect(docx.headers.get("content-disposition")).toMatch(/^attachment/);
    const dl = await fetch(`${base()}/${SITE}/_repo/api/file?path=hello.txt&dl=1`);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="hello.txt"/);
    // Range requests work for media players.
    const range = await fetch(`${base()}/${SITE}/_repo/api/file?path=hello.txt`, { headers: { Range: "bytes=6-" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("world");
    expect(range.headers.get("content-range")).toBe("bytes 6-10/11");
    // Strong ETag = content hash → 304 on revalidation.
    const etag = dl.headers.get("etag")!;
    const cached = await fetch(`${base()}/${SITE}/_repo/api/file?path=hello.txt`, { headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);
  });

  test("writers need a session AND the CSRF token", async () => {
    const noCsrf = await fetch(`${base()}/${SITE}/_repo/api/mkdir`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify({ path: "d" }),
    });
    expect(noCsrf.status).toBe(403);
    const ok = await fetch(`${base()}/${SITE}/_repo/api/mkdir`, {
      method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf, "Content-Type": "application/json" }, body: JSON.stringify({ path: "d" }),
    });
    expect(ok.status).toBe(200);
    // Raw-body upload streams to a new version.
    const up = await fetch(`${base()}/${SITE}/_repo/api/upload?path=d/new.txt`, {
      method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf }, body: "streamed bytes",
    });
    const upBody = await up.json();
    expect(up.status).toBe(200);
    expect(upBody.file.path).toBe("d/new.txt");
    expect(upBody.file.updated_by).toBe("repoadmin");
    const again = await fetch(`${base()}/${SITE}/_repo/api/upload?path=d/new.txt&replace=0`, {
      method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf }, body: "other",
    });
    expect(again.status).toBe(400);
    // Text editor + versions + zip packaging.
    const txt = await fetch(`${base()}/${SITE}/_repo/api/text`, {
      method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "d/new.txt", content: "edited in place" }),
    });
    expect((await txt.json()).file.version_no).toBe(2);
    const versions = await (await fetch(`${base()}/${SITE}/_repo/api/versions?path=d/new.txt`)).json();
    expect(versions.versions.length).toBe(2);
    const zip = await fetch(`${base()}/${SITE}/_repo/api/zip`, {
      method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf, "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["d", "hello.txt"] }),
    });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const trash = await fetch(`${base()}/${SITE}/_repo/api/trash`);
    expect(trash.status).toBe(403); // anonymous can't see the trash even on a public repo
    // Move and copy endpoints.
    const mv = await fetch(`${base()}/${SITE}/_repo/api/move`, {
      method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf, "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["hello.txt"], to: "d" }),
    });
    expect((await mv.json()).moved[0].to).toBe("d/hello.txt");
    const cp = await fetch(`${base()}/${SITE}/_repo/api/copy`, {
      method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf, "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["d/hello.txt"], to: "" }),
    });
    expect((await cp.json()).copied[0].to).toBe("hello.txt");
    const anonMove = await fetch(`${base()}/${SITE}/_repo/api/move`, { method: "POST", body: JSON.stringify({ paths: ["hello.txt"], to: "d" }) });
    expect(anonMove.status).toBe(401);
  });

  test("a site user without a grant can sign in but not write; private repos hide everything", async () => {
    const login = await fetch(`${base()}/${SITE}/_repo/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "repouser", password: "repouser-pass-1" }),
    });
    const body = await login.json();
    expect(body.can_write).toBe(false);
    expect(body.can_read).toBe(true);
    const userCookie = login.headers.get("set-cookie")!.split(";")[0];
    const mk = await fetch(`${base()}/${SITE}/_repo/api/mkdir`, {
      method: "POST", headers: { Cookie: userCookie, "X-CSRF-Token": body.csrf_token, "Content-Type": "application/json" }, body: JSON.stringify({ path: "nope" }),
    });
    expect(mk.status).toBe(403);
    updateRepoSettings(SITE, { visibility: "private" });
    const anon = await fetch(`${base()}/${SITE}/_repo/api/tree`);
    expect(anon.status).toBe(401);
    const anonFile = await fetch(`${base()}/${SITE}/_repo/api/file?path=hello.txt`);
    expect(anonFile.status).toBe(401);
    const user = await fetch(`${base()}/${SITE}/_repo/api/tree`, { headers: { Cookie: userCookie } });
    expect(user.status).toBe(403);
    const admin = await fetch(`${base()}/${SITE}/_repo/api/tree`, { headers: { Cookie: adminCookie } });
    expect(admin.status).toBe(200);
    const bad = await fetch(`${base()}/${SITE}/_repo/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "repouser", password: "wrong" }),
    });
    expect(bad.status).toBe(401);
  });

  test("per-site country override is enforced on the wire", async () => {
    setAllowedCountries(["US"]);
    try {
      const blocked = await fetch(`${base()}/${SITE}/`, { headers: { "cf-ipcountry": "DE", "cf-connecting-ip": "203.0.113.9" } });
      expect(blocked.status).toBe(403);
      setSiteAllowedCountries(SITE, ["DE"]);
      const allowed = await fetch(`${base()}/${SITE}/`, { headers: { "cf-ipcountry": "DE", "cf-connecting-ip": "203.0.113.9" } });
      expect(allowed.status).toBe(200);
      const usNow = await fetch(`${base()}/${SITE}/`, { headers: { "cf-ipcountry": "US", "cf-connecting-ip": "203.0.113.9" } });
      expect(usNow.status).toBe(403);
      // Admin panel is never geo-gated.
      const admin = await fetch(`${base()}/_admin/api/auth-check`, { headers: { "cf-ipcountry": "DE" } });
      expect(admin.status).toBe(200);
    } finally {
      setAllowedCountries([]);
      setSiteAllowedCountries(SITE, null);
    }
  });

  test("admin API: create, stats, backup, settings, restore", async () => {
    const h = { Cookie: adminCookie, "X-CSRF-Token": adminCsrf, "Content-Type": "application/json" };
    const create = await fetch(`${base()}/_admin/api/sites/repository`, { method: "POST", headers: h, body: JSON.stringify({ slug: "api-made", name: "API Made", quota_bytes: 5000, visibility: "public" }) });
    expect(create.status).toBe(200);
    expect((await create.json()).site.site_type).toBe("repository");
    try {
      const list = await (await fetch(`${base()}/_admin/api/sites`, { headers: { Cookie: adminCookie } })).json();
      const made = list.sites.find((s: any) => s.slug === "api-made");
      expect(made.site_type).toBe("repository");
      expect(made.repo_quota_bytes).toBe(5000);
      expect(made.health).toBe("ok");
      const settings = await fetch(`${base()}/_admin/api/sites/api-made/settings`, {
        method: "POST", headers: h,
        body: JSON.stringify({ name: "Renamed", allowed_countries: ["US"], repo: { quota_bytes: 7000, max_versions: 2, visibility: "private", description: "Team docs" } }),
      });
      expect(settings.status).toBe(200);
      const site = getSite("api-made")!;
      expect(site.name).toBe("Renamed");
      expect(site.allowed_countries).toBe("US");
      expect(site.repo_quota_bytes).toBe(7000);
      expect(site.repo_description).toBe("Team docs");
      const stats = await (await fetch(`${base()}/_admin/api/sites/api-made/repo/stats`, { headers: { Cookie: adminCookie } })).json();
      expect(stats.quota_bytes).toBe(7000);
      // Backup of the main repo, restored into the new one (step-up required).
      const backup = await fetch(`${base()}/_admin/api/sites/${SITE}/repo/backup`, { headers: { Cookie: adminCookie } });
      expect(backup.headers.get("content-type")).toBe("application/zip");
      const archive = new Uint8Array(await backup.arrayBuffer());
      const form = new FormData();
      form.append("file", new Blob([archive], { type: "application/zip" }), "backup.zip");
      form.append("confirm_password", "wrong");
      const denied = await fetch(`${base()}/_admin/api/sites/api-made/repo/restore`, { method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf }, body: form });
      expect(denied.status).toBe(401);
      const form2 = new FormData();
      form2.append("file", new Blob([archive], { type: "application/zip" }), "backup.zip");
      form2.append("confirm_password", "repoadmin-pass-1");
      const restored = await fetch(`${base()}/_admin/api/sites/api-made/repo/restore`, { method: "POST", headers: { Cookie: adminCookie, "X-CSRF-Token": adminCsrf }, body: form2 });
      expect(restored.status).toBe(200);
      expect(listRepoTree("api-made").files.map(f => f.path)).toContain("hello.txt");
      // Countries endpoint is available to any signed-in account.
      const countries = await (await fetch(`${base()}/_admin/api/countries`, { headers: { Cookie: adminCookie } })).json();
      expect(countries.countries.some((c: any) => c.code === "US")).toBe(true);
    } finally {
      await fetch(`${base()}/_admin/api/sites/api-made`, { method: "DELETE", headers: h });
    }
  });
});
