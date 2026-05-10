// Tests for host alias support — incoming Host header maps to a site slug.
//
// HOSTER_HOME is set in test/preload.ts (see bunfig.toml) so this test file
// runs against an isolated temp directory. Reading process.env.HOSTER_HOME
// here is safe because preload runs before any test file evaluates. Cleanup
// of HOSTER_HOME is also handled in preload — don't tear down here, since
// the temp dir is shared across all test files in the suite.

import { afterAll, describe, expect, test } from "bun:test";
import {
  SITES_DIR,
  createBlankSite,
  deleteSite,
  normalizeHost,
  validateHostAlias,
  addHostAlias,
  removeHostAlias,
  getHostAliases,
  resolveHostAlias,
  invalidateHostAliasCache,
  listAllHostAliases,
} from "../src/sites";
import { createServer } from "../src/server";

const TEST_HOME = process.env.HOSTER_HOME!;

describe("normalizeHost", () => {
  test("returns empty for missing input", () => {
    expect(normalizeHost(null)).toBe("");
    expect(normalizeHost(undefined)).toBe("");
    expect(normalizeHost("")).toBe("");
  });

  test("lowercases", () => {
    expect(normalizeHost("Spryly.COM")).toBe("spryly.com");
  });

  test("strips port", () => {
    expect(normalizeHost("spryly.com:3500")).toBe("spryly.com");
    expect(normalizeHost("spryly.com:80")).toBe("spryly.com");
  });

  test("handles bare host without port", () => {
    expect(normalizeHost("spryly.com")).toBe("spryly.com");
  });

  test("strips IPv6 brackets and port", () => {
    expect(normalizeHost("[::1]:8080")).toBe("::1");
    expect(normalizeHost("[2001:db8::1]")).toBe("2001:db8::1");
  });

  test("trims whitespace", () => {
    expect(normalizeHost("  spryly.com  ")).toBe("spryly.com");
  });
});

describe("validateHostAlias", () => {
  test("accepts valid domains", () => {
    expect(validateHostAlias("spryly.com")).toBe("spryly.com");
    expect(validateHostAlias("www.spryly.com")).toBe("www.spryly.com");
    expect(validateHostAlias("a.b")).toBe("a.b");
    expect(validateHostAlias("my-site.example.co.uk")).toBe("my-site.example.co.uk");
    expect(validateHostAlias("123.example.com")).toBe("123.example.com");
  });

  test("lowercases input before validating", () => {
    expect(validateHostAlias("Spryly.COM")).toBe("spryly.com");
  });

  test("rejects empty", () => {
    expect(() => validateHostAlias("")).toThrow();
    expect(() => validateHostAlias("   ")).toThrow();
  });

  test("rejects host without dot", () => {
    expect(() => validateHostAlias("localhost")).toThrow();
    expect(() => validateHostAlias("spryly")).toThrow();
  });

  test("rejects underscores", () => {
    expect(() => validateHostAlias("my_site.com")).toThrow();
  });

  test("rejects leading/trailing hyphens in labels", () => {
    expect(() => validateHostAlias("-spryly.com")).toThrow();
    expect(() => validateHostAlias("spryly-.com")).toThrow();
    expect(() => validateHostAlias("spryly.-com")).toThrow();
    expect(() => validateHostAlias("spryly.com-")).toThrow();
  });

  test("rejects host longer than 253 chars", () => {
    const long = "a." + "b".repeat(252);
    expect(() => validateHostAlias(long)).toThrow();
  });
});

describe("host alias CRUD", () => {
  test("add, list, resolve, remove roundtrip", () => {
    createBlankSite("alpha", "Alpha");
    try {
      expect(getHostAliases("alpha")).toEqual([]);

      const normalized = addHostAlias("Alpha.Example.com", "alpha");
      expect(normalized).toBe("alpha.example.com");
      expect(getHostAliases("alpha")).toEqual(["alpha.example.com"]);
      expect(resolveHostAlias("alpha.example.com")).toBe("alpha");

      // Cache hit on second call
      expect(resolveHostAlias("alpha.example.com")).toBe("alpha");
      // Unknown host returns null
      expect(resolveHostAlias("unknown.example.com")).toBeNull();
      // Empty/falsy returns null
      expect(resolveHostAlias("")).toBeNull();

      const ok = removeHostAlias("alpha.example.com", "alpha");
      expect(ok).toBe(true);
      expect(getHostAliases("alpha")).toEqual([]);
      expect(resolveHostAlias("alpha.example.com")).toBeNull();
    } finally {
      deleteSite("alpha");
    }
  });

  test("rejects when target site does not exist", () => {
    expect(() => addHostAlias("ghost.example.com", "nonexistent-site")).toThrow(/does not exist/);
  });

  test("rejects duplicate host alias on same site", () => {
    createBlankSite("beta", "Beta");
    try {
      addHostAlias("beta.example.com", "beta");
      expect(() => addHostAlias("beta.example.com", "beta")).toThrow(/already aliased to this site/);
    } finally {
      deleteSite("beta");
    }
  });

  test("rejects host already aliased to different site", () => {
    createBlankSite("gamma1", "Gamma1");
    createBlankSite("gamma2", "Gamma2");
    try {
      addHostAlias("shared.example.com", "gamma1");
      expect(() => addHostAlias("shared.example.com", "gamma2"))
        .toThrow(/already aliased to site 'gamma1'/);
    } finally {
      deleteSite("gamma1");
      deleteSite("gamma2");
    }
  });

  test("removeHostAlias returns false for non-existent entry", () => {
    expect(removeHostAlias("never-added.example.com", "any-slug")).toBe(false);
  });

  test("deleting a site removes its host aliases", () => {
    createBlankSite("delta", "Delta");
    addHostAlias("delta1.example.com", "delta");
    addHostAlias("delta2.example.com", "delta");
    expect(getHostAliases("delta").length).toBe(2);

    deleteSite("delta");

    invalidateHostAliasCache();
    expect(getHostAliases("delta")).toEqual([]);
    expect(resolveHostAlias("delta1.example.com")).toBeNull();
    expect(resolveHostAlias("delta2.example.com")).toBeNull();
  });

  test("listAllHostAliases returns rows across sites", () => {
    createBlankSite("epsilon", "Epsilon");
    createBlankSite("zeta", "Zeta");
    try {
      addHostAlias("e.example.com", "epsilon");
      addHostAlias("z.example.com", "zeta");
      const all = listAllHostAliases();
      const hosts = all.map(a => a.host).sort();
      expect(hosts).toContain("e.example.com");
      expect(hosts).toContain("z.example.com");
    } finally {
      deleteSite("epsilon");
      deleteSite("zeta");
    }
  });
});

describe("server routing", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  // Bring the server up once for the whole describe block. createBlankSite
  // produces a real index.html on disk, which the server can serve.
  // We also seed an admin password so the server's auth gating is in a
  // realistic state, though host-aliased reqs don't need it.
  createBlankSite("widgets", "Widgets");
  addHostAlias("widgets.example.com", "widgets");

  server = createServer(0); // 0 = pick a free port
  baseUrl = `http://127.0.0.1:${server.port}`;

  afterAll(() => {
    deleteSite("widgets");
    try { server.stop(true); } catch (_) {}
  });

  test("host-aliased root serves the site index", async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { Host: "widgets.example.com" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    // Blank-site index doesn't contain "<base href>" so no rewrite happens,
    // but we should not see "/widgets/" injected anywhere either.
    expect(body).not.toContain('<base href="/widgets/">');
  });

  test("host-aliased /index.html serves the site index", async () => {
    const res = await fetch(`${baseUrl}/index.html`, { headers: { Host: "widgets.example.com" } });
    expect(res.status).toBe(200);
  });

  test("host-aliased request with port in Host header still resolves", async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { Host: "widgets.example.com:8080" } });
    expect(res.status).toBe(200);
  });

  test("host-aliased /_admin returns 404 (canonical-only surface)", async () => {
    const res = await fetch(`${baseUrl}/_admin`, { headers: { Host: "widgets.example.com" } });
    expect(res.status).toBe(404);
  });

  test("host-aliased /_admin/api/version returns 404 (canonical-only)", async () => {
    const res = await fetch(`${baseUrl}/_admin/api/version`, { headers: { Host: "widgets.example.com" } });
    expect(res.status).toBe(404);
  });

  test("host-aliased /oauth/register returns 404", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { Host: "widgets.example.com", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("host-aliased /_mcp returns 404", async () => {
    const res = await fetch(`${baseUrl}/_mcp`, { headers: { Host: "widgets.example.com" } });
    expect(res.status).toBe(404);
  });

  test("host-aliased /.well-known/oauth-authorization-server returns 404", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
      headers: { Host: "widgets.example.com" },
    });
    expect(res.status).toBe(404);
  });

  test("non-aliased host with root path redirects to /_admin", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Host: "canonical.example.com" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_admin");
  });

  test("non-aliased host can still access /widgets/ via path routing", async () => {
    const res = await fetch(`${baseUrl}/widgets/`, { headers: { Host: "canonical.example.com" } });
    expect(res.status).toBe(200);
  });

  test("base href is rewritten to /widgets/ on path-routed requests", async () => {
    // Seed a fresh HTML file in the site that contains <base href="/"> so
    // we can observe the rewrite. Use createBlankSite then directly write.
    const { writeFileSync, readdirSync } = await import("fs");
    const { join } = await import("path");
    const siteDir = join(SITES_DIR, "widgets");
    const versions = readdirSync(siteDir).filter(n => n !== "_current");
    const indexPath = join(siteDir, versions[0], "index.html");
    writeFileSync(indexPath, '<!DOCTYPE html><html><head><base href="/"></head><body>hi</body></html>');

    // Path-routed: base href -> /widgets/
    const res1 = await fetch(`${baseUrl}/widgets/`, { headers: { Host: "canonical.example.com" } });
    const body1 = await res1.text();
    expect(body1).toContain('<base href="/widgets/">');

    // Host-aliased: base href stays /
    const res2 = await fetch(`${baseUrl}/`, { headers: { Host: "widgets.example.com" } });
    const body2 = await res2.text();
    expect(body2).toContain('<base href="/">');
    expect(body2).not.toContain('<base href="/widgets/">');
  });

  test("subpath on host-aliased request resolves under the site", async () => {
    // /sub/page.html on widgets.example.com → /widgets/sub/page.html
    const { writeFileSync, mkdirSync, readdirSync } = await import("fs");
    const { join } = await import("path");
    const siteDir = join(SITES_DIR, "widgets");
    const versions = readdirSync(siteDir).filter(n => n !== "_current");
    const subDir = join(siteDir, versions[0], "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "page.html"), '<!DOCTYPE html><html><body>sub-page</body></html>');

    const res = await fetch(`${baseUrl}/sub/page.html`, { headers: { Host: "widgets.example.com" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("sub-page");
  });

  test("unknown host falls through to path routing (no host alias match)", async () => {
    const res = await fetch(`${baseUrl}/widgets/`, { headers: { Host: "stranger.example.com" } });
    expect(res.status).toBe(200);
  });
});
