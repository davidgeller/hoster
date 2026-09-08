// Admin file management: delete / rename / copy / mkdir and the root_dir-aware
// listing. All operations share one containment helper with upload, so the
// traversal and symlink cases below pin that shared behavior.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SITES_DIR,
  createBlankSite, deleteSite, getSite, listVersions, updateSiteSettings,
  uploadFileToSite, deleteSitePaths, renameSitePath, copySitePath, createSiteDirectory,
  listSiteTree, normalizeSitePath,
} from "../src/sites";

const SLUG = "fileops-test";
const enc = (s: string) => new TextEncoder().encode(s).buffer;
const abs = (rel: string) => join(SITES_DIR, SLUG, "_current", rel);

describe("normalizeSitePath", () => {
  test("normalizes and rejects traversal", () => {
    expect(normalizeSitePath("/a//b/./c.txt")).toBe("a/b/c.txt");
    expect(normalizeSitePath("a\\b\\c.txt")).toBe("a/b/c.txt");
    expect(() => normalizeSitePath("../x")).toThrow(/traversal/);
    expect(() => normalizeSitePath("a/../../x")).toThrow(/traversal/);
    expect(() => normalizeSitePath("a\0b")).toThrow(/Invalid/);
    expect(() => normalizeSitePath("")).toThrow(/required/);
    expect(normalizeSitePath("", { allowEmpty: true })).toBe("");
  });
});

describe("file operations", () => {
  createBlankSite(SLUG, "File Ops");
  uploadFileToSite(SLUG, "a.txt", enc("A"));
  uploadFileToSite(SLUG, "docs/one.md", enc("one"));
  uploadFileToSite(SLUG, "docs/sub/two.md", enc("two"));
  uploadFileToSite(SLUG, "img/logo.png", enc("png"));

  afterAll(() => {
    try { deleteSite(SLUG); } catch (_) {}
    try { deleteSite("fileops-root"); } catch (_) {}
    try { deleteSite("fileops-snapshot"); } catch (_) {}
  });

  test("listing includes directories (incl. empty ones) relative to the content dir", () => {
    createSiteDirectory(SLUG, "empty-dir");
    const tree = listSiteTree(SLUG);
    expect(tree.files.map(f => f.path)).toEqual(["a.txt", "docs/one.md", "docs/sub/two.md", "img/logo.png", "index.html"]);
    expect(tree.dirs).toEqual(["docs", "docs/sub", "empty-dir", "img"]);
  });

  test("mkdir is idempotent for directories and refuses files", () => {
    expect(createSiteDirectory(SLUG, "empty-dir").created).toBe(false);
    expect(() => createSiteDirectory(SLUG, "a.txt")).toThrow(/is a file/);
    expect(() => createSiteDirectory(SLUG, "../outside")).toThrow(/traversal/);
  });

  test("rename moves a file across folders and creates the destination folder", () => {
    const r = renameSitePath(SLUG, "a.txt", "moved/renamed.txt");
    expect(r.kind).toBe("file");
    expect(existsSync(abs("a.txt"))).toBe(false);
    expect(readFileSync(abs("moved/renamed.txt"), "utf-8")).toBe("A");
  });

  test("rename refuses to overwrite without replace, and never replaces directories", () => {
    uploadFileToSite(SLUG, "b.txt", enc("B"));
    expect(() => renameSitePath(SLUG, "b.txt", "moved/renamed.txt")).toThrow(/already exists/);
    expect(readFileSync(abs("moved/renamed.txt"), "utf-8")).toBe("A");
    const r = renameSitePath(SLUG, "b.txt", "moved/renamed.txt", { replace: true });
    expect(r.replaced).toBe(true);
    expect(readFileSync(abs("moved/renamed.txt"), "utf-8")).toBe("B");
    // A directory can't be replaced, and a file can't replace a directory.
    uploadFileToSite(SLUG, "c.txt", enc("C"));
    expect(() => renameSitePath(SLUG, "c.txt", "docs", { replace: true })).toThrow(/never replaced/);
    expect(() => renameSitePath(SLUG, "img", "docs", { replace: true })).toThrow(/never replaced/);
  });

  test("rename moves a whole directory but not into itself", () => {
    expect(() => renameSitePath(SLUG, "docs", "docs/sub/inner")).toThrow(/inside itself/);
    const r = renameSitePath(SLUG, "docs", "content/docs");
    expect(r.kind).toBe("dir");
    expect(readFileSync(abs("content/docs/sub/two.md"), "utf-8")).toBe("two");
    expect(existsSync(abs("docs"))).toBe(false);
  });

  test("copy duplicates files and directory trees", () => {
    const f = copySitePath(SLUG, "moved/renamed.txt", "moved/copy.txt");
    expect(f.kind).toBe("file");
    expect(f.bytes).toBe(1);
    expect(readFileSync(abs("moved/copy.txt"), "utf-8")).toBe("B");
    const d = copySitePath(SLUG, "content", "content-backup");
    expect(d.kind).toBe("dir");
    expect(readFileSync(abs("content-backup/docs/one.md"), "utf-8")).toBe("one");
    expect(readFileSync(abs("content/docs/one.md"), "utf-8")).toBe("one"); // source intact
    expect(() => copySitePath(SLUG, "content", "content/nested")).toThrow(/inside itself/);
    expect(() => copySitePath(SLUG, "moved/copy.txt", "moved/renamed.txt")).toThrow(/already exists/);
    expect(() => copySitePath(SLUG, "nope.txt", "x.txt")).toThrow(/does not exist/);
  });

  test("delete removes files and directories, reporting per path", () => {
    const r = deleteSitePaths(SLUG, ["moved/copy.txt", "content-backup"]);
    expect(r.deleted).toBe(2);
    expect(r.results.map(x => x.kind)).toEqual(["file", "dir"]);
    expect(existsSync(abs("moved/copy.txt"))).toBe(false);
    expect(existsSync(abs("content-backup"))).toBe(false);
    // Stats were refreshed on the site row.
    const site = getSite(SLUG)!;
    expect(site.file_count).toBe(listSiteTree(SLUG).files.length);
  });

  test("delete validates the whole batch before touching anything", () => {
    uploadFileToSite(SLUG, "keep.txt", enc("keep"));
    expect(() => deleteSitePaths(SLUG, ["keep.txt", "../escape"])).toThrow(/traversal/);
    expect(() => deleteSitePaths(SLUG, ["keep.txt", "missing.txt"])).toThrow(/does not exist/);
    expect(existsSync(abs("keep.txt"))).toBe(true);
    expect(() => deleteSitePaths(SLUG, [])).toThrow(/No paths/);
    expect(() => deleteSitePaths(SLUG, [""])).toThrow(/required/);
    expect(() => deleteSitePaths(SLUG, ["/"])).toThrow(/required/);
  });

  test("operations refuse to follow a symlink that escapes the site", () => {
    const outside = mkdtempSync(join(tmpdir(), "hoster-escape-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    const link = abs("escape-link");
    if (!existsSync(link)) symlinkSync(outside, link);
    expect(() => deleteSitePaths(SLUG, ["escape-link/secret.txt"])).toThrow(/escapes/);
    expect(() => renameSitePath(SLUG, "keep.txt", "escape-link/keep.txt")).toThrow(/escapes/);
    expect(() => copySitePath(SLUG, "keep.txt", "escape-link/keep.txt")).toThrow(/escapes/);
    expect(existsSync(join(outside, "secret.txt"))).toBe(true);
    expect(existsSync(join(outside, "keep.txt"))).toBe(false);
    // The link itself is refused too (its real path is outside the site) —
    // fail closed rather than reason about what removing it would do.
    expect(() => deleteSitePaths(SLUG, ["escape-link"])).toThrow(/escapes/);
    expect(existsSync(join(outside, "secret.txt"))).toBe(true);
    // The listing never followed it either.
    expect(listSiteTree(SLUG).files.some(f => f.path.startsWith("escape-link"))).toBe(false);
    unlinkSync(link);
  });

  test("operations honor root_dir", () => {
    const slug = "fileops-root";
    createBlankSite(slug, "Root Dir");
    mkdirSync(join(SITES_DIR, slug, "_current", "browser"), { recursive: true });
    updateSiteSettings(slug, "browser", false);
    uploadFileToSite(slug, "app.js", enc("js"));
    expect(listSiteTree(slug).files.map(f => f.path)).toEqual(["app.js"]);
    renameSitePath(slug, "app.js", "main.js");
    expect(existsSync(join(SITES_DIR, slug, "_current", "browser", "main.js"))).toBe(true);
    // The top-level index.html outside root_dir is invisible and unreachable.
    expect(() => deleteSitePaths(slug, ["../index.html"])).toThrow(/traversal/);
  });

  test("auto-snapshot freezes the prior version before the first destructive change", async () => {
    const slug = "fileops-snapshot";
    createBlankSite(slug, "Snapshot");
    updateSiteSettings(slug, null, false, undefined, undefined, true);
    await Bun.sleep(1100); // generateVersion() has one-second resolution
    const before = getSite(slug)!.current_version!;
    const r = deleteSitePaths(slug, ["index.html"]);
    expect(r.snapshot_version).toBe(before);
    expect(listVersions(slug).length).toBe(2);
    // The frozen copy still has the file; the working copy doesn't.
    expect(existsSync(join(SITES_DIR, slug, before, "index.html"))).toBe(true);
    expect(existsSync(join(SITES_DIR, slug, "_current", "index.html"))).toBe(false);
    // Second change: no new snapshot.
    expect(createSiteDirectory(slug, "d").snapshot_version).toBeNull();
    expect(listVersions(slug).length).toBe(2);
  });
});
