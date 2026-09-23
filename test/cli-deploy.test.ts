// `hoster deploy <slug> <zip>`: local, credential-free updates of an existing
// web site, with the guard rails that make up for having no login.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCli, type CliIO } from "../src/cli";
import { createBlankSite, deleteSite, getSite, listVersions } from "../src/sites";
import { createRepositorySite } from "../src/repo";
import { getAuditLog } from "../src/auth";

const SLUG = "cli-deploy-test";
const REPO_SLUG = "cli-deploy-repo";
const work = mkdtempSync(join(tmpdir(), "hoster-cli-"));

function makeZip(name: string, files: Record<string, string>): string {
  const src = join(work, `src-${name}`);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(src, rel, ".."), { recursive: true });
    writeFileSync(join(src, rel), body);
  }
  const zip = join(work, `${name}.zip`);
  const proc = Bun.spawnSync(["zip", "-r", "-q", zip, "."], { cwd: src });
  if (proc.exitCode !== 0) throw new Error("zip failed");
  return zip;
}

function io(opts: { tty?: boolean; answer?: boolean; uid?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    confirm: () => opts.answer ?? false,
    isTTY: opts.tty ?? false,
    getuid: opts.uid === undefined ? process.getuid?.bind(process) : () => opts.uid!,
  };
  return { cli, out: () => out.join("\n"), err: () => err.join("\n") };
}

describe("hoster deploy", () => {
  createBlankSite(SLUG, "CLI Deploy");
  createRepositorySite(REPO_SLUG, "CLI Repo");
  const good = makeZip("good", { "index.html": "<h1>v2</h1>", "css/site.css": "body{}" });

  afterAll(() => {
    try { deleteSite(SLUG); } catch (_) {}
    try { deleteSite(REPO_SLUG); } catch (_) {}
    rmSync(work, { recursive: true, force: true });
  });

  test("deploys a new version, keeps the old one, and audits it", async () => {
    const before = getSite(SLUG)!.current_version!;
    const t = io();
    expect(await runCli(["deploy", SLUG, good, "--yes", "--notes", "From CI"], t.cli)).toBe(0);

    const site = getSite(SLUG)!;
    expect(site.current_version).not.toBe(before);
    const versions = listVersions(SLUG);
    expect(versions.map(v => v.version)).toContain(before);
    const fresh = versions.find(v => v.version === site.current_version)!;
    expect(fresh.label).toBe("CLI: good.zip");
    expect(fresh.notes).toBe("From CI");
    expect(t.out()).toContain(`Previous version ${before} is kept`);

    const entry = getAuditLog(20).find(e => e.action === "site_updated_cli");
    expect(entry.ip).toBe("local-cli");
    expect(entry.detail).toContain(`${SLUG} -> ${site.current_version} from good.zip sha256:`);
    expect(entry.actor).toBeTruthy();
  });

  test("never creates a site, and never touches repository sites", async () => {
    let t = io();
    expect(await runCli(["deploy", "no-such-site", good, "--yes"], t.cli)).toBe(1);
    expect(t.err()).toContain("only updates existing sites");
    expect(getSite("no-such-site")).toBeNull();

    t = io();
    expect(await runCli(["deploy", REPO_SLUG, good, "--yes"], t.cli)).toBe(1);
    expect(t.err()).toContain("repository site");
  });

  test("refuses root and accounts that do not own the database", async () => {
    let t = io({ uid: 0 });
    expect(await runCli(["deploy", SLUG, good, "--yes"], t.cli)).toBe(1);
    expect(t.err()).toContain("root");

    t = io({ uid: 987654 });
    expect(await runCli(["deploy", SLUG, good, "--yes"], t.cli)).toBe(1);
    expect(t.err()).toContain("does not own");
  });

  test("validates the ZIP before changing anything", async () => {
    const before = listVersions(SLUG).length;
    const notZip = join(work, "fake.zip");
    writeFileSync(notZip, "not a zip at all");
    const link = join(work, "link.zip");
    symlinkSync(good, link);
    const noIndex = makeZip("noindex", { "about.html": "<p>hi</p>" });

    const cases: [string, string][] = [
      ["relative/site.zip", "must be absolute"],
      [join(work, "missing.zip"), "File not found"],
      [link, "symbolic link"],
      [work, "Not a regular file"],
      [notZip, "bad file signature"],
      [noIndex, "no index.html"],
    ];
    for (const [path, message] of cases) {
      const t = io();
      expect(await runCli(["deploy", SLUG, path, "--yes"], t.cli)).toBe(1);
      expect(t.err()).toContain(message);
    }
    expect(listVersions(SLUG).length).toBe(before);
  });

  test("requires confirmation, and --dry-run changes nothing", async () => {
    const before = listVersions(SLUG).length;

    let t = io({ tty: false });
    expect(await runCli(["deploy", SLUG, good], t.cli)).toBe(1);
    expect(t.err()).toContain("--yes");

    t = io({ tty: true, answer: false });
    expect(await runCli(["deploy", SLUG, good], t.cli)).toBe(1);
    expect(t.out()).toContain("Aborted");

    t = io();
    expect(await runCli(["deploy", SLUG, good, "--dry-run"], t.cli)).toBe(0);
    expect(t.out()).toContain("Dry run");
    expect(t.out()).toMatch(/SHA-256:\s+[0-9a-f]{64}/);

    expect(listVersions(SLUG).length).toBe(before);
  });

  test("rejects bad arguments", async () => {
    let t = io();
    expect(await runCli(["deploy", SLUG], t.cli)).toBe(1);
    expect(t.err()).toContain("exactly two arguments");
    t = io();
    expect(await runCli(["deploy", SLUG, good, "--force"], t.cli)).toBe(1);
    expect(t.err()).toContain("Unknown option");
    t = io();
    expect(await runCli(["frobnicate"], t.cli)).toBe(1);
  });
});
