// System health: the report's shape, maintenance actions, and the
// administrators-only gate. HOSTER_HOME comes from test/preload.ts.

import { describe, expect, test } from "bun:test";
import db from "../src/db";
import { createSession, createAdminUser } from "../src/auth";
import { createBlankSite, deleteSite } from "../src/sites";
import { handleAdminApi } from "../src/admin-api";
import { getHealth, getHealthSummary, diskInfo, pruneRequests, quickCheck, checkpointWal, vacuum } from "../src/health";

const IP = "192.0.2.77";

async function asUser(userId: number, method: string, path: string, body?: any) {
  const { sessionToken, csrfToken } = createSession(IP, userId);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `hoster_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
      "x-real-ip": IP,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleAdminApi(req, path);
  return { status: res!.status, data: await res!.json() };
}

describe("health report", () => {
  test("covers the database, disk, storage, host, and process", () => {
    const h = getHealth();
    expect(h.database.size_bytes).toBeGreaterThan(0);
    expect(h.database.journal_mode).toBe("wal");
    expect(h.database.sqlite_version).toMatch(/^3\./);
    expect(h.database.tables.map(t => t.name)).toContain("requests");
    expect(h.database.request_log.cap).toBe(500_000);
    expect(h.disk!.total_bytes).toBeGreaterThan(0);
    expect(h.disk!.used_pct).toBeGreaterThanOrEqual(0);
    expect(h.disk!.used_pct).toBeLessThanOrEqual(100);
    expect(h.host.cpu_count).toBeGreaterThan(0);
    expect(h.host.memory.total_bytes).toBeGreaterThan(0);
    expect(h.process.rss_bytes).toBeGreaterThan(0);
    expect(h.storage).toHaveProperty("older_versions");
    expect(Array.isArray(h.warnings)).toBe(true);
    // Nothing secret leaks into the report.
    const text = JSON.stringify(h);
    expect(text).not.toContain("protect_secret");
    expect(text).not.toContain("password");
  });

  test("summary is a cheap disk check", () => {
    const s = getHealthSummary();
    expect(["ok", "warn", "critical"]).toContain(s.level);
    expect(diskInfo("/definitely/not/a/path")).toBeNull();
  });

  test("storage separates live and older site versions", () => {
    createBlankSite("healthsite", "Health");
    const before = getHealth().storage;
    db.run("INSERT INTO site_versions (site_slug, version, label, size_bytes, file_count) VALUES ('healthsite', 'old-v', 'old', 5000, 1)");
    const after = getHealth().storage;
    expect(after.older_versions.bytes - before.older_versions.bytes).toBe(5000);
    expect(after.live_versions.count).toBe(before.live_versions.count);
    deleteSite("healthsite");
  });
});

describe("client IP detection", () => {
  test("warns when most traffic has no client IP", () => {
    for (let i = 0; i < 30; i++) db.run("INSERT INTO requests (path, status, ip) VALUES ('/ipcheck', 200, 'unknown')");
    const h = getHealth();
    if (h.client_ips.unknown / h.client_ips.requests > 0.5) {
      expect(h.warnings.some(w => /client IP/.test(w.message))).toBe(true);
    }
    db.run("DELETE FROM requests WHERE path = '/ipcheck'");
  });
});

describe("maintenance", () => {
  test("prune deletes only old request rows", () => {
    db.run("INSERT INTO requests (path, status, ip, created_at) VALUES ('/prune-old', 200, 'x', datetime('now', '-200 days'))");
    db.run("INSERT INTO requests (path, status, ip, created_at) VALUES ('/prune-new', 200, 'x', datetime('now', '-2 days'))");
    const r = pruneRequests(90);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT COUNT(*) AS n FROM requests WHERE path = '/prune-old'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM requests WHERE path = '/prune-new'").get()).toEqual({ n: 1 });
    expect(pruneRequests(0).days).toBe(1); // clamped
  });

  test("integrity check, checkpoint, and vacuum run", () => {
    const c = quickCheck();
    expect(c.ok).toBe(true);
    expect(c.messages).toEqual(["ok"]);
    const w = checkpointWal();
    expect(w.busy).toBe(false);
    const v = vacuum();
    expect(v.after_bytes).toBeGreaterThan(0);
  });
});

describe("access", () => {
  test("administrators only", async () => {
    const adminId = await createAdminUser("healthadmin", "correct-horse-battery", { isAdmin: true });
    const siteUserId = await createAdminUser("healthsiteuser", "correct-horse-battery", { isAdmin: false });
    const ok = await asUser(adminId, "GET", "/_admin/api/system/health");
    expect(ok.status).toBe(200);
    expect(ok.data.database).toBeTruthy();
    for (const [m, p] of [["GET", "/_admin/api/system/health"], ["GET", "/_admin/api/system/summary"], ["POST", "/_admin/api/system/db/vacuum"]] as const) {
      const denied = await asUser(siteUserId, m, p);
      expect(denied.status).toBe(403);
    }
    const pruned = await asUser(adminId, "POST", "/_admin/api/system/db/prune", { days: 365 });
    expect(pruned.status).toBe(200);
    expect(pruned.data.days).toBe(365);
  });
});
