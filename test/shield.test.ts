// Bot shield: trap paths, the 404 limit, rate limiting, AI-crawler refusal,
// and the safety rails (allow-list, admin IPs). HOSTER_HOME comes from
// test/preload.ts. Requests carry X-Real-IP so the shield sees a client IP
// (without it the IP is "unknown", which the shield always exempts).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import db from "../src/db";
import { SITES_DIR, createBlankSite, deleteSite, setSiteBlockAiBots, updateSiteSettings } from "../src/sites";
import { isIpBlocked, getBlockedIps, unblockIp } from "../src/analytics";
import {
  isTrapPath, isFriendlyBot, isAiCrawler, setShieldConfig, getShieldConfig, resetShieldCounters, isValidIp,
} from "../src/shield";
import { createAdminUser } from "../src/auth";
import { createServer } from "../src/server";

const SLUG = "shieldsite";
const SPA = "shieldspa";
let server: ReturnType<typeof createServer>;
let base = "";
let nextIp = 10;

function freshIp(): string {
  return `198.51.100.${nextIp++}`;
}

function get(path: string, ip: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers: { "X-Real-IP": ip, ...headers }, redirect: "manual" });
}

function lastRequest(path: string): any {
  return db.query("SELECT status, flag, site_slug FROM requests WHERE path = ? ORDER BY id DESC LIMIT 1").get(path);
}

const DEFAULTS = {
  traps_enabled: true, trap_threshold: 3, trap_block_hours: 24,
  notfound_enabled: true, notfound_threshold: 30, notfound_window_minutes: 5, notfound_block_hours: 1,
  rate_limit_enabled: false, rate_limit_per_minute: 600, allowlist: [],
};

beforeAll(() => {
  createBlankSite(SLUG, "Shield");
  const dir = join(SITES_DIR, SLUG, "_current");
  writeFileSync(join(dir, "legacy.php"), "<?php // really shipped ?>");
  writeFileSync(join(dir, "about.html"), "<html>about</html>");
  createBlankSite(SPA, "Shield SPA");
  updateSiteSettings(SPA, null, true);
  server = createServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

beforeEach(() => {
  setShieldConfig(DEFAULTS);
  resetShieldCounters();
});

afterAll(() => {
  server?.stop(true);
  for (const b of getBlockedIps() as any[]) unblockIp(b.id);
  setShieldConfig(DEFAULTS);
  deleteSite(SLUG);
  deleteSite(SPA);
});

describe("classification", () => {
  test("scanner paths from real logs are traps", () => {
    for (const p of [
      "/.env", "/website/.env", "/.env.local.orig", "/.env.development", "/backend/.env", "/var/www/html/.env",
      "/.git/config", "/.git/hooks/post-commit", "/wp-content/debug.log", "/wp-content/mysql.sql", "/wp-login.php",
      "/xmlrpc.php", "/uploadfile.aspx", "/FileHandler.ashx", "/redmine/config/secrets.yml", "/appsettings.Local.json",
      "/docker-compose.yml", "/config.toml", "/config.development.json", "/phpinfo.php",
      "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/cgi-bin/luci", "/.aws/credentials", "/id_rsa", "/backup.sql",
      "/phpmyadmin/", "/.DS_Store",
    ]) {
      expect(isTrapPath(p)).toBe(true);
    }
  });

  test("ordinary site paths are not", () => {
    for (const p of [
      "/", "/index.html", "/about/", "/assets/app.4f3a9c1b.js", "/styles.css", "/robots.txt", "/sitemap.xml",
      "/ngsw.json", "/assets/version.json", "/config.json", "/manifest.webmanifest", "/blog/wp-tips.html",
      "/images/environment.png", "/docs/.well-known/x", "/favicon.ico", "/api/data.json", "/envelope.html",
    ]) {
      expect(isTrapPath(p)).toBe(false);
    }
  });

  test("friendly bots and AI crawlers are recognized", () => {
    expect(isFriendlyBot("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")).toBe(true);
    expect(isFriendlyBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isFriendlyBot("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isFriendlyBot("Mozilla/5.0 (Macintosh) Chrome/120")).toBe(false);
    expect(isAiCrawler("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)")).toBe(true);
    expect(isAiCrawler("CCBot/2.0 (https://commoncrawl.org/faq/)")).toBe(true);
    expect(isAiCrawler("Mozilla/5.0 (compatible; ClaudeBot/1.0)")).toBe(true);
    expect(isAiCrawler("Mozilla/5.0 (Macintosh) Safari/605")).toBe(false);
  });

  test("config validation", () => {
    expect(isValidIp("203.0.113.9")).toBe(true);
    expect(isValidIp("2001:db8::1")).toBe(true);
    expect(isValidIp("300.1.1.1")).toBe(false);
    expect(isValidIp("example.com")).toBe(false);
    expect(() => setShieldConfig({ allowlist: "1.2.3.4, nope" })).toThrow(/nope/);
    const cfg = setShieldConfig({ allowlist: "1.2.3.4\n5.6.7.8", trap_threshold: 0, rate_limit_per_minute: 5 });
    expect(cfg.allowlist).toEqual(["1.2.3.4", "5.6.7.8"]);
    expect(cfg.trap_threshold).toBe(1);          // clamped
    expect(cfg.rate_limit_per_minute).toBe(60);  // clamped
    expect(getShieldConfig().allowlist).toEqual(["1.2.3.4", "5.6.7.8"]);
  });
});

describe("trap paths over HTTP", () => {
  test("three probes block the IP; later requests get 403", async () => {
    const ip = freshIp();
    for (const p of [`/${SLUG}/.env`, `/${SLUG}/.git/config`]) {
      const res = await get(p, ip);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
    expect(lastRequest(`/${SLUG}/.git/config`).flag).toBe("trap");
    expect(isIpBlocked(ip)).toBe(false);
    await get(`/${SLUG}/wp-login.php`, ip);
    expect(isIpBlocked(ip)).toBe(true);

    const after = await get(`/${SLUG}/about.html`, ip);
    expect(after.status).toBe(403);
    expect(lastRequest(`/${SLUG}/about.html`).flag).toBe("blocked");

    // Other visitors are unaffected, and so is the admin panel for the blocked IP.
    expect((await get(`/${SLUG}/about.html`, freshIp())).status).toBe(200);
    expect((await get("/_admin/api/auth-check", ip)).status).not.toBe(403);
  });

  test("probes against unknown slugs and the bare host count too", async () => {
    const ip = freshIp();
    await get("/.env", ip);
    await get("/wp-admin/setup-config.php", ip);
    await get("/nonexistent-site/.git/HEAD", ip);
    expect(isIpBlocked(ip)).toBe(true);
  });

  test("a file the site really ships is served, not trapped", async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) {
      const res = await get(`/${SLUG}/legacy.php`, ip);
      expect(res.status).toBe(200);
    }
    expect(isIpBlocked(ip)).toBe(false);
  });

  test("an SPA doesn't answer probes with its index.html", async () => {
    const ip = freshIp();
    const res = await get(`/${SPA}/.env`, ip);
    expect(res.status).toBe(404);
    // Ordinary deep links still fall back to the app.
    expect((await get(`/${SPA}/some/route/`, ip)).status).toBe(200);
  });

  test("allow-listed IPs are never blocked", async () => {
    const ip = freshIp();
    setShieldConfig({ allowlist: [ip] });
    for (let i = 0; i < 5; i++) await get(`/${SLUG}/.env`, ip);
    expect(isIpBlocked(ip)).toBe(false);
  });

  test("an IP with a live administrator session is never blocked", async () => {
    const ip = freshIp();
    const userId = await createAdminUser(`shieldadmin${nextIp}`, "correct-horse-battery", { isAdmin: true });
    db.run("INSERT INTO sessions (token, csrf_token, expires_at, ip, user_id, last_ip) VALUES (?, 'x', datetime('now', '+1 day'), ?, ?, ?)",
      `shield-test-${nextIp}`, ip, userId, ip);
    for (let i = 0; i < 5; i++) await get(`/${SLUG}/.env`, ip);
    expect(isIpBlocked(ip)).toBe(false);
  });

  test("traps can be turned off", async () => {
    setShieldConfig({ traps_enabled: false });
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await get(`/${SLUG}/.env`, ip);
    expect(isIpBlocked(ip)).toBe(false);
  });

  test("unblocking clears the block immediately", async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await get(`/${SLUG}/.env`, ip);
    expect(isIpBlocked(ip)).toBe(true);
    const row = (getBlockedIps() as any[]).find(b => b.ip === ip);
    expect(row.reason).toMatch(/scanner paths/);
    unblockIp(row.id);
    expect(isIpBlocked(ip)).toBe(false);
    expect((await get(`/${SLUG}/about.html`, ip)).status).toBe(200);
  });
});

describe("404 limit", () => {
  test("a burst of 404s blocks the IP", async () => {
    setShieldConfig({ notfound_threshold: 5 });
    const ip = freshIp();
    for (let i = 0; i < 4; i++) expect((await get(`/${SLUG}/missing-${i}.html`, ip)).status).toBe(404);
    expect(isIpBlocked(ip)).toBe(false);
    await get(`/${SLUG}/missing-4.html`, ip);
    expect(isIpBlocked(ip)).toBe(true);
  });

  test("link-preview and search crawlers are exempt", async () => {
    setShieldConfig({ notfound_threshold: 5 });
    const ip = freshIp();
    for (let i = 0; i < 8; i++) await get(`/${SLUG}/gone-${i}.html`, ip, { "User-Agent": "facebookexternalhit/1.1" });
    expect(isIpBlocked(ip)).toBe(false);
  });

  test("missing static assets and admin 404s don't count", async () => {
    setShieldConfig({ notfound_threshold: 5 });
    const ip = freshIp();
    for (let i = 0; i < 8; i++) await get(`/${SLUG}/broken-${i}.js`, ip);
    for (let i = 0; i < 8; i++) await get(`/_admin/api/nope-${i}`, ip);
    expect(isIpBlocked(ip)).toBe(false);
  });
});

describe("rate limit", () => {
  test("off by default; when on, the request past the limit gets 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 70; i++) await get(`/${SLUG}/about.html`, ip);
    setShieldConfig({ rate_limit_enabled: true, rate_limit_per_minute: 60 });
    const ip2 = freshIp();
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await get(`/${SLUG}/about.html`, ip2);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(lastRequest(`/${SLUG}/about.html`).flag).toBe("ratelimited");
    // Rate limiting alone doesn't block the IP.
    expect(isIpBlocked(ip2)).toBe(false);
  });
});

describe("AI crawlers", () => {
  test("refused only on sites that opt in", async () => {
    const ua = { "User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" };
    const ip = freshIp();
    expect((await get(`/${SLUG}/about.html`, ip, ua)).status).toBe(200);
    setSiteBlockAiBots(SLUG, true);
    const res = await get(`/${SLUG}/about.html`, ip, ua);
    expect(res.status).toBe(403);
    expect(lastRequest(`/${SLUG}/about.html`)).toMatchObject({ flag: "ai-bot", site_slug: SLUG });
    expect((await get(`/${SLUG}/about.html`, ip, { "User-Agent": "Mozilla/5.0 Chrome/120" })).status).toBe(200);
    expect(isIpBlocked(ip)).toBe(false);
    setSiteBlockAiBots(SLUG, false);
  });
});
