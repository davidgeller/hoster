// Tests for uploadFileToSite — the admin single-file upload helper.
//
// HOSTER_HOME is set in test/preload.ts (see bunfig.toml) so this test file
// runs against an isolated temp directory. Cleanup is handled in preload.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SITES_DIR,
  createBlankSite,
  deleteSite,
  uploadFileToSite,
  updateSiteSettings,
  listVersions,
  getSite,
} from "../src/sites";

const SLUG = "upload-test";

function content(slug: string, relPath: string): string {
  return readFileSync(join(SITES_DIR, slug, "_current", relPath), "utf-8");
}

describe("uploadFileToSite", () => {
  createBlankSite(SLUG, "Upload Test");

  afterAll(() => {
    try { deleteSite(SLUG); } catch (_) {}
    try { deleteSite("upload-root-test"); } catch (_) {}
    try { deleteSite("upload-snapshot-test"); } catch (_) {}
  });

  test("writes a file at the root of the site", () => {
    const buf = new TextEncoder().encode("hello world").buffer;
    const result = uploadFileToSite(SLUG, "hello.txt", buf);
    expect(result.path).toBe("hello.txt");
    expect(result.replaced).toBe(false);
    expect(content(SLUG, "hello.txt")).toBe("hello world");
  });

  test("creates subdirectories as needed", () => {
    const buf = new TextEncoder().encode("nested").buffer;
    const result = uploadFileToSite(SLUG, "assets/img/logo.svg", buf);
    expect(result.path).toBe("assets/img/logo.svg");
    expect(content(SLUG, "assets/img/logo.svg")).toBe("nested");
  });

  test("rejects overwrite without replace flag", () => {
    expect(() => {
      uploadFileToSite(SLUG, "hello.txt", new TextEncoder().encode("nope").buffer);
    }).toThrow(/already exists/);
    expect(content(SLUG, "hello.txt")).toBe("hello world");
  });

  test("overwrites when replace=true", () => {
    const result = uploadFileToSite(
      SLUG,
      "hello.txt",
      new TextEncoder().encode("replaced").buffer,
      { replace: true }
    );
    expect(result.replaced).toBe(true);
    expect(content(SLUG, "hello.txt")).toBe("replaced");
  });

  test("rejects path traversal", () => {
    const buf = new TextEncoder().encode("x").buffer;
    expect(() => uploadFileToSite(SLUG, "../escape.txt", buf)).toThrow();
    expect(() => uploadFileToSite(SLUG, "a/../../escape.txt", buf)).toThrow();
  });

  test("strips leading slashes (absolute-looking paths land at site root)", () => {
    const result = uploadFileToSite(
      SLUG,
      "/from-absolute.txt",
      new TextEncoder().encode("x").buffer
    );
    expect(result.path).toBe("from-absolute.txt");
    expect(existsSync(join(SITES_DIR, SLUG, "_current", "from-absolute.txt"))).toBe(true);
  });

  test("rejects writes into a symlinked subdirectory that escapes the site", () => {
    // Manually plant a symlink under _current that points outside the site dir.
    // The deploy pipeline strips symlinks, but defense-in-depth: the upload
    // function should still refuse a write whose parent realpath escapes.
    const escapeTarget = mkdtempSync(join(tmpdir(), "hoster-escape-"));
    const link = join(SITES_DIR, SLUG, "_current", "escape-dir");
    if (!existsSync(link)) symlinkSync(escapeTarget, link);
    expect(() =>
      uploadFileToSite(SLUG, "escape-dir/pwned.txt", new TextEncoder().encode("x").buffer)
    ).toThrow(/escapes site directory/);
    expect(existsSync(join(escapeTarget, "pwned.txt"))).toBe(false);
  });

  test("rejects null bytes", () => {
    expect(() =>
      uploadFileToSite(SLUG, "bad\0name.txt", new TextEncoder().encode("x").buffer)
    ).toThrow();
  });

  test("rejects empty filename", () => {
    expect(() => uploadFileToSite(SLUG, "", new TextEncoder().encode("x").buffer)).toThrow();
    expect(() => uploadFileToSite(SLUG, "/", new TextEncoder().encode("x").buffer)).toThrow();
  });

  test("respects root_dir when set", () => {
    const slug = "upload-root-test";
    createBlankSite(slug, "Upload Root Test");
    // Promote `subroot/` to be the content directory
    const versionDir = join(SITES_DIR, slug, "_current");
    // Pre-create a subdir on disk so root_dir validation passes
    require("fs").mkdirSync(join(versionDir, "subroot"), { recursive: true });
    updateSiteSettings(slug, "subroot", false);

    const result = uploadFileToSite(slug, "in-root.txt", new TextEncoder().encode("scoped").buffer);
    expect(result.path).toBe("in-root.txt");
    expect(existsSync(join(SITES_DIR, slug, "_current", "subroot", "in-root.txt"))).toBe(true);
    expect(existsSync(join(SITES_DIR, slug, "_current", "in-root.txt"))).toBe(false);
  });

  test("auto-snapshot creates a frozen prior version when mcp_auto_commit is on", async () => {
    // Use a dedicated slug so the current version starts at mcp_modified=0.
    const slug = "upload-snapshot-test";
    createBlankSite(slug, "Snapshot Test");
    updateSiteSettings(slug, null, false, undefined, undefined, true);
    // Wait past one-second-resolution timestamp collision in generateVersion()
    await Bun.sleep(1100);

    const before = listVersions(slug);
    const beforeVersion = getSite(slug)!.current_version!;

    const result = uploadFileToSite(
      slug,
      "after-snapshot.txt",
      new TextEncoder().encode("after").buffer
    );

    const after = listVersions(slug);
    // First mutation under auto_commit freezes the prior version and forks a new one.
    expect(result.snapshot_version).toBe(beforeVersion);
    expect(after.length).toBe(before.length + 1);
    expect(getSite(slug)!.current_version).not.toBe(beforeVersion);
  });
});
