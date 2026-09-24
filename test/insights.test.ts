// Analytics insights: human/bot split, page-view filter, breakdowns, and
// site scoping. Rows are inserted straight into the request log under a
// dedicated site slug so other suites' traffic doesn't interfere.

import { beforeAll, describe, expect, test } from "bun:test";
import db from "../src/db";
import { logRequest } from "../src/analytics";
import { getInsights, fillBuckets } from "../src/insights";

const S = "insightsite";
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SCANNER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)"; // parses to "Unknown (Desktop)"

function hit(o: { path: string; ua: string | null; ip: string; country?: string; status?: number; ref?: string; lang?: string; flag?: string; code?: string; site?: string | null }) {
  logRequest({
    site_slug: o.site === undefined ? S : o.site, path: o.path, method: "GET", status: o.status ?? 200, response_time_ms: 1,
    ip: o.ip, country: o.country ?? "US", city: null, user_agent: o.ua, referrer: o.ref ?? null,
    content_type: null, accept_language: o.lang ?? null, request_bytes: 0, response_bytes: 0,
    access_code: o.code ?? null, flag: o.flag ?? null,
  });
}

beforeAll(() => {
  db.run("DELETE FROM requests WHERE site_slug IN (?, ?)", S, "otherinsight");
  hit({ path: `/${S}/`, ua: CHROME_MAC, ip: "10.0.0.1", ref: "https://www.google.com/search?q=x", lang: "en-US,en;q=0.9" });
  hit({ path: `/${S}/`, ua: CHROME_MAC, ip: "10.0.0.1", ref: "https://google.com/", lang: "en-US" });
  hit({ path: `/${S}/`, ua: SAFARI_IPHONE, ip: "10.0.0.2", country: "CA", lang: "fr-ca,fr;q=0.8" });
  hit({ path: `/${S}/about.html`, ua: FIREFOX_WIN, ip: "10.0.0.3", country: "GB", ref: "https://news.ycombinator.com/item?id=1", code: "Board" });
  hit({ path: `/${S}/app.4f3a9c1b.js`, ua: CHROME_MAC, ip: "10.0.0.1" });           // asset: not a page
  hit({ path: `/${S}/ngsw.json`, ua: CHROME_MAC, ip: "10.0.0.1" });                 // polling: not a page
  hit({ path: `/${S}/missing.html`, ua: CHROME_MAC, ip: "10.0.0.1", status: 404 }); // error: not a page view
  hit({ path: `/${S}/`, ua: GOOGLEBOT, ip: "66.249.66.1" });
  hit({ path: `/${S}/.env`, ua: SCANNER, ip: "34.140.132.132", status: 404, flag: "trap" });
  hit({ path: `/${S}/`, ua: SCANNER, ip: "34.140.132.133" });
  hit({ path: "/otherinsight/", ua: CHROME_MAC, ip: "10.9.9.9", site: "otherinsight" });
});

describe("insights", () => {
  test("humans + pages counts real page views only", () => {
    const r = getInsights({ hours: 24, site: S, humans: true, pages: true });
    expect(r.totals.hits).toBe(4);
    expect(r.totals.visitors).toBe(3);
    expect(r.pages.map((p: any) => [p.path, p.hits])).toEqual([[`/${S}/`, 3], [`/${S}/about.html`, 1]]);
    // Bots fetching pages: Googlebot and the unknown-desktop script.
    expect(r.totals.bot_hits).toBe(2);
    expect(r.totals.all_hits).toBe(6);
  });

  test("all traffic includes assets, errors, bots, and scanners", () => {
    const r = getInsights({ hours: 24, site: S, humans: false, pages: false });
    expect(r.totals.hits).toBe(10);
    const botNames = r.bots.map((b: any) => b.name);
    expect(botNames).toContain("Googlebot");
    expect(botNames).toContain("Scanner probes");
    expect(botNames).toContain("Unknown (Desktop)");
  });

  test("breakdowns: countries, browsers, OS, devices, referrers, languages", () => {
    const r = getInsights({ hours: 24, site: S, humans: true, pages: true });
    const kv = (rows: any[]) => Object.fromEntries(rows.map(x => [x.key, x.hits]));
    expect(kv(r.countries)).toEqual({ US: 2, CA: 1, GB: 1 });
    expect(kv(r.browsers)).toEqual({ Chrome: 2, Safari: 1, Firefox: 1 });
    expect(kv(r.os)).toEqual({ macOS: 2, iOS: 1, Windows: 1 });
    expect(kv(r.devices)).toEqual({ Desktop: 3, Mobile: 1 });
    expect(kv(r.referrers)).toEqual({ "google.com": 2, "news.ycombinator.com": 1 });
    expect(r.direct_hits).toBe(1);
    expect(kv(r.languages)).toEqual({ "en-US": 2, "fr-CA": 1 });
    expect(r.heatmap.reduce((n: number, c: any) => n + c.hits, 0)).toBe(4);
    expect(r.traffic.reduce((n: number, c: any) => n + c.hits, 0)).toBe(4);
    expect(r.access_codes).toEqual([expect.objectContaining({ key: "Board", hits: 1 })]);
  });

  test("a single page", () => {
    const r = getInsights({ hours: 24, site: S, path: `/${S}/about.html`, humans: true, pages: true });
    expect(r.totals.hits).toBe(1);
    expect(r.pages).toEqual([]);
    expect(r.statuses).toEqual([{ key: 200, hits: 1 }]);
  });

  test("scoping limits a site user to their sites", () => {
    const mine = getInsights({ hours: 24, slugs: [S], humans: true, pages: true });
    expect(mine.pages.every((p: any) => p.site_slug === S)).toBe(true);
    const none = getInsights({ hours: 24, slugs: [], humans: false, pages: false });
    expect(none.totals.hits).toBe(0);
    const everyone = getInsights({ hours: 24, humans: true, pages: true });
    expect(everyone.pages.some((p: any) => p.site_slug === "otherinsight")).toBe(true);
  });
});

describe("traffic buckets", () => {
  test("fill the whole window with zeros where there's no traffic", () => {
    const now = Date.parse("2026-09-24T19:37:00Z");
    const hourly = fillBuckets(24, [{ bucket: "2026-09-24T19:00:00", hits: 5, visitors: 2 }], now);
    expect(hourly.length).toBe(25);
    expect(hourly[0].bucket).toBe("2026-09-23T19:00:00");
    expect(hourly.at(-1)).toEqual({ bucket: "2026-09-24T19:00:00", hits: 5, visitors: 2 });
    expect(hourly.filter(b => b.hits === 0).length).toBe(24);
    expect(fillBuckets(1, [], now).map(b => b.bucket).slice(0, 2)).toEqual(["2026-09-24T18:35:00", "2026-09-24T18:40:00"]);
    const daily = fillBuckets(720, [], now);
    expect(daily[0].bucket.endsWith("T00:00:00")).toBe(true);
    expect(daily.length).toBe(31);
  });
});
