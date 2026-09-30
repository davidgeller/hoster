// Version ids are second-resolution timestamps. Several versions of one site
// created within the same second must still get distinct ids, and those
// suffixed ids must work everywhere a version id is accepted.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createBlankSite, deleteSite, deploySite, commitVersion, getSite, listVersions } from "../src/sites";
import { createAdminUser, createSession, deleteAdminUser, getUserByUsername } from "../src/auth";
import { handleAdminApi } from "../src/admin-api";

const SLUG = "version-ids-test";
const IP = "203.0.113.44";
const work = mkdtempSync(join(tmpdir(), "hoster-verids-"));

function zipBytes(): ArrayBuffer {
  writeFileSync(join(work, "index.html"), "<h1>hi</h1>");
  const zip = join(work, "site.zip");
  if (Bun.spawnSync(["zip", "-q", "-o", zip, "index.html"], { cwd: work }).exitCode !== 0) throw new Error("zip failed");
  const buf = readFileSync(zip);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("version ids", () => {
  afterAll(() => {
    try { deleteSite(SLUG); } catch (_) {}
    const u = getUserByUsername("verids-admin");
    if (u) try { deleteAdminUser(u.userId); } catch (_) {}
    rmSync(work, { recursive: true, force: true });
  });

  test("versions created within the same second get distinct ids, newest first", async () => {
    createBlankSite(SLUG, "Version IDs");
    const zip = zipBytes();
    const a = (await deploySite(SLUG, "Version IDs", zip)).version.version;
    const b = (await deploySite(SLUG, "Version IDs", zip)).version.version;
    const c = commitVersion(SLUG)!.version;

    const ids = listVersions(SLUG).map(v => v.version);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 3)).toEqual([c, b, a]);
    expect(getSite(SLUG)!.current_version).toBe(c);
    // At least one of these landed in an already-used second and was suffixed.
    expect(ids.some(v => /^\d{14}-\d+$/.test(v))).toBe(true);
  });

  test("suffixed ids can be activated, annotated, and deleted through the API", async () => {
    const adminId = await createAdminUser("verids-admin", "correct-horse-battery", { isAdmin: true });
    const call = async (method: string, path: string, body?: any) => {
      const { sessionToken, csrfToken } = createSession(IP, adminId);
      const req = new Request(`http://localhost${path}`, {
        method,
        headers: {
          cookie: `hoster_session=${sessionToken}`, "x-csrf-token": csrfToken,
          "x-real-ip": IP, "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await handleAdminApi(req, path))!.status;
    };

    const suffixed = listVersions(SLUG).find(v => v.version.includes("-"))!.version;
    const base = `/_admin/api/sites/${SLUG}/versions/${suffixed}`;
    expect(await call("POST", `${base}/activate`)).toBe(200);
    expect(getSite(SLUG)!.current_version).toBe(suffixed);
    expect(await call("POST", `${base}/meta`, { label: "suffixed" })).toBe(200);

    // Switch away so the suffixed version isn't live, then delete it.
    const other = listVersions(SLUG).find(v => v.version !== suffixed)!.version;
    expect(await call("POST", `/_admin/api/sites/${SLUG}/versions/${other}/activate`)).toBe(200);
    expect(await call("DELETE", base)).toBe(200);
    expect(listVersions(SLUG).some(v => v.version === suffixed)).toBe(false);
  });
});
