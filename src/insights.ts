// Analytics insights: the breakdowns behind the Analytics page — top pages
// per site, and for any filter (a site, a single page, humans only, page
// views only) the countries, browsers, operating systems, devices,
// referrers, languages, hour-of-week pattern, and bots behind the traffic.
//
// Everything is derived from columns the request log already has, so the
// existing history gets the new breakdowns too — no backfill:
//   • human vs bot: parseUserAgent() stores "Browser (Device)" for real
//     browsers and a bare name ("Googlebot", "curl", "Bot") for everything
//     else. "Unknown (Desktop)" — a desktop UA no browser rule matched — is
//     almost always a script, so it counts as a bot; the shield's flag marks
//     scanners regardless of what they claim to be.
//   • operating system: matched from the stored user agent.

import db from "./db";

// Most insight queries filter by site and time window together.
try { db.exec("CREATE INDEX IF NOT EXISTS idx_requests_site_created ON requests(site_slug, created_at)"); } catch (_) {}

export interface InsightFilter {
  hours: number;
  slugs?: string[] | null;   // scope for site users (null = everything)
  site?: string | null;
  path?: string | null;
  humans?: boolean;          // exclude bots, tools, and shield-flagged requests
  pages?: boolean;           // only successful GETs of HTML pages
}

export const HUMAN_SQL = `(browser LIKE '%(Desktop)' OR browser LIKE '%(Mobile)' OR browser LIKE '%(Tablet)') AND browser != 'Unknown (Desktop)' AND flag IS NULL`;

// The last path segment ("" for a trailing slash).
const LAST_SEGMENT = `substr(path, length(rtrim(path, replace(path, '/', ''))) + 1)`;
export const PAGE_SQL = `site_slug IS NOT NULL AND method = 'GET' AND status IN (200, 304) AND (${LAST_SEGMENT} = '' OR ${LAST_SEGMENT} NOT LIKE '%.%' OR ${LAST_SEGMENT} LIKE '%.html' OR ${LAST_SEGMENT} LIKE '%.htm')`;

const OS_SQL = `CASE
  WHEN user_agent IS NULL THEN 'Unknown'
  WHEN user_agent LIKE '%iPhone%' OR user_agent LIKE '%iPod%' THEN 'iOS'
  WHEN user_agent LIKE '%iPad%' THEN 'iPadOS'
  WHEN user_agent LIKE '%Android%' THEN 'Android'
  WHEN user_agent LIKE '%Windows%' THEN 'Windows'
  WHEN user_agent LIKE '%CrOS%' THEN 'ChromeOS'
  WHEN user_agent LIKE '%Macintosh%' OR user_agent LIKE '%Mac OS X%' THEN 'macOS'
  WHEN user_agent LIKE '%Linux%' THEN 'Linux'
  ELSE 'Other' END`;

const DEVICE_SQL = `CASE
  WHEN browser LIKE '%(Mobile)' THEN 'Mobile'
  WHEN browser LIKE '%(Tablet)' THEN 'Tablet'
  WHEN browser LIKE '%(Desktop)' AND browser != 'Unknown (Desktop)' THEN 'Desktop'
  ELSE 'Bot / script' END`;

const BROWSER_NAME_SQL = `CASE WHEN instr(browser, ' (') > 0 THEN substr(browser, 1, instr(browser, ' (') - 1) ELSE browser END`;

export function bucketExpression(hours: number): string {
  if (hours <= 1) return `strftime('%Y-%m-%dT%H:', created_at) || printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / 5) * 5) || ':00'`;
  if (hours <= 6) return `strftime('%Y-%m-%dT%H:', created_at) || printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / 15) * 15) || ':00'`;
  if (hours <= 48) return `strftime('%Y-%m-%dT%H:00:00', created_at)`;
  return `strftime('%Y-%m-%dT00:00:00', created_at)`;
}

// Every bucket in the window, zeros included, so quiet stretches show as
// gaps in the chart instead of being squeezed out. Keys match
// bucketExpression()'s UTC "YYYY-MM-DDTHH:MM:00" strings.
export function fillBuckets(hours: number, rows: { bucket: string; hits: number; visitors: number }[], now = Date.now()) {
  const stepMin = hours <= 1 ? 5 : hours <= 6 ? 15 : hours <= 48 ? 60 : 1440;
  const step = stepMin * 60_000;
  const floor = (t: number) => stepMin === 1440 ? Math.floor(t / 86_400_000) * 86_400_000 : Math.floor(t / step) * step;
  const key = (t: number) => new Date(t).toISOString().slice(0, 16) + ":00";
  const byKey = new Map(rows.map(r => [r.bucket, r]));
  const out: { bucket: string; hits: number; visitors: number }[] = [];
  for (let t = floor(now - hours * 3_600_000); t <= now && out.length < 800; t += step) {
    const k = key(t);
    out.push(byKey.get(k) ?? { bucket: k, hits: 0, visitors: 0 });
  }
  return out;
}

function buildWhere(f: InsightFilter, opts: { humans?: boolean | "bots" } = {}): { where: string; params: any[] } {
  const parts = ["created_at > datetime('now', ?)"];
  const params: any[] = [`-${f.hours} hours`];
  if (f.slugs != null) {
    if (f.slugs.length === 0) parts.push("1=0");
    else { parts.push(`site_slug IN (${f.slugs.map(() => "?").join(",")})`); params.push(...f.slugs); }
  }
  if (f.site) { parts.push("site_slug = ?"); params.push(f.site); }
  if (f.path) { parts.push("path = ?"); params.push(f.path); }
  if (f.pages) parts.push(PAGE_SQL);
  const humans = opts.humans ?? f.humans;
  if (humans === "bots") parts.push(`NOT (${HUMAN_SQL})`);
  else if (humans) parts.push(HUMAN_SQL);
  return { where: parts.join(" AND "), params };
}

function domainOf(ref: string): string | null {
  try {
    const u = new URL(ref);
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

// "en-US,en;q=0.9" -> "en-US"
function primaryLanguage(raw: string): string | null {
  const first = raw.split(",")[0]?.split(";")[0]?.trim();
  if (!first || first === "*" || first.length > 20) return null;
  const [lang, region] = first.split("-");
  return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
}

function topMerged(rows: { key: string | null; hits: number }[], limit: number) {
  const m = new Map<string, number>();
  for (const r of rows) if (r.key) m.set(r.key, (m.get(r.key) || 0) + r.hits);
  return [...m.entries()].map(([key, hits]) => ({ key, hits })).sort((a, b) => b.hits - a.hits).slice(0, limit);
}

export function getInsights(f: InsightFilter) {
  const { where, params } = buildWhere(f);
  const all = (sql: string, ...extra: any[]) => db.query(sql).all(...params, ...extra) as any[];

  const totals = db.query(`SELECT COUNT(*) AS hits, COUNT(DISTINCT ip) AS visitors FROM requests WHERE ${where}`).get(...params) as { hits: number; visitors: number };

  // Bot share of the same slice, ignoring the humans toggle.
  const everyone = buildWhere(f, { humans: false });
  const everyoneTotal = (db.query(`SELECT COUNT(*) AS n FROM requests WHERE ${everyone.where}`).get(...everyone.params) as { n: number }).n;
  const botSlice = buildWhere(f, { humans: "bots" });
  const botRows = db.query(`
    SELECT CASE flag
             WHEN 'trap' THEN 'Scanner probes'
             WHEN 'blocked' THEN 'Blocked IPs'
             WHEN 'ratelimited' THEN 'Rate-limited'
             WHEN 'ai-bot' THEN 'AI crawlers (refused)'
             WHEN 'geo' THEN 'Geo-blocked visitors'
             ELSE COALESCE(NULLIF(browser, 'Unknown'), 'No user agent') END AS name,
           COUNT(*) AS hits, COUNT(DISTINCT ip) AS ips
    FROM requests WHERE ${botSlice.where} GROUP BY name ORDER BY hits DESC LIMIT 12
  `).all(...botSlice.params) as { name: string; hits: number; ips: number }[];
  const botTotal = (db.query(`SELECT COUNT(*) AS n FROM requests WHERE ${botSlice.where}`).get(...botSlice.params) as { n: number }).n;

  const pages = f.path ? [] : all(`
    SELECT site_slug, path, COUNT(*) AS hits, COUNT(DISTINCT ip) AS visitors
    FROM requests WHERE ${where} GROUP BY site_slug, path ORDER BY hits DESC LIMIT 50
  `);

  const countries = all(`SELECT country AS key, COUNT(*) AS hits, COUNT(DISTINCT ip) AS visitors FROM requests WHERE ${where} AND country IS NOT NULL GROUP BY country ORDER BY hits DESC LIMIT 15`);
  const browsers = all(`SELECT ${BROWSER_NAME_SQL} AS key, COUNT(*) AS hits FROM requests WHERE ${where} AND browser IS NOT NULL GROUP BY key ORDER BY hits DESC LIMIT 12`);
  const os = all(`SELECT ${OS_SQL} AS key, COUNT(*) AS hits FROM requests WHERE ${where} GROUP BY key ORDER BY hits DESC LIMIT 10`);
  const devices = all(`SELECT ${DEVICE_SQL} AS key, COUNT(*) AS hits FROM requests WHERE ${where} GROUP BY key ORDER BY hits DESC`);

  const refRows = all(`SELECT referrer, COUNT(*) AS hits FROM requests WHERE ${where} AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY hits DESC LIMIT 1000`);
  const referrers = topMerged(refRows.map(r => ({ key: domainOf(r.referrer), hits: r.hits })), 12);
  const directHits = (db.query(`SELECT COUNT(*) AS n FROM requests WHERE ${where} AND (referrer IS NULL OR referrer = '')`).get(...params) as { n: number }).n;

  const langRows = all(`SELECT accept_language AS raw, COUNT(*) AS hits FROM requests WHERE ${where} AND accept_language IS NOT NULL GROUP BY accept_language ORDER BY hits DESC LIMIT 1000`);
  const languages = topMerged(langRows.map(r => ({ key: primaryLanguage(r.raw), hits: r.hits })), 12);

  // UTC day-of-week (0 = Sunday) × hour; the browser shifts it to local time.
  const heatmap = all(`
    SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dow, CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS hits
    FROM requests WHERE ${where} GROUP BY dow, hour
  `);

  const traffic = fillBuckets(f.hours, all(`
    SELECT ${bucketExpression(f.hours)} AS bucket, COUNT(*) AS hits, COUNT(DISTINCT ip) AS visitors
    FROM requests WHERE ${where} GROUP BY bucket ORDER BY bucket
  `));

  const statuses = all(`SELECT status AS key, COUNT(*) AS hits FROM requests WHERE ${where} GROUP BY status ORDER BY hits DESC LIMIT 10`);
  const accessCodes = all(`SELECT access_code AS key, COUNT(*) AS hits, COUNT(DISTINCT ip) AS visitors, MAX(created_at) AS last_seen FROM requests WHERE ${where} AND access_code IS NOT NULL GROUP BY access_code ORDER BY hits DESC LIMIT 20`);

  return {
    filter: { hours: f.hours, site: f.site ?? null, path: f.path ?? null, humans: !!f.humans, pages: !!f.pages },
    totals: { ...totals, all_hits: everyoneTotal, bot_hits: botTotal },
    pages,
    countries,
    browsers,
    os,
    devices,
    referrers,
    direct_hits: directHits,
    languages,
    heatmap,
    traffic,
    statuses,
    access_codes: accessCodes,
    bots: botRows,
  };
}
