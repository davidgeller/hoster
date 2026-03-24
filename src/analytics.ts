import db from "./db";

export interface RequestLog {
  site_slug: string | null;
  path: string;
  method: string;
  status: number;
  response_time_ms: number;
  ip: string;
  country: string | null;
  city: string | null;
  user_agent: string | null;
  referrer: string | null;
  content_type: string | null;
  accept_language: string | null;
}

// --- Extensions to track parsed browser info ---
try { db.exec("ALTER TABLE requests ADD COLUMN browser TEXT"); } catch (_) {}

const insertStmt = db.prepare(`
  INSERT INTO requests (site_slug, path, method, status, response_time_ms, ip, country, city, user_agent, referrer, content_type, accept_language, browser)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// --- File extensions we DON'T want to track ---
const SKIP_EXTENSIONS = new Set([
  ".js", ".css", ".map", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".ico", ".svg",
]);

export function shouldTrack(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  // Skip admin assets
  if (path.startsWith("/_admin/") && path !== "/_admin/") return false;
  return true;
}

// --- User Agent Parsing ---
export function parseUserAgent(ua: string | null): string {
  if (!ua) return "Unknown";

  // Bots
  if (/googlebot/i.test(ua)) return "Googlebot";
  if (/bingbot/i.test(ua)) return "Bingbot";
  if (/yandexbot/i.test(ua)) return "YandexBot";
  if (/baiduspider/i.test(ua)) return "Baidu Spider";
  if (/duckduckbot/i.test(ua)) return "DuckDuckBot";
  if (/slurp/i.test(ua)) return "Yahoo Slurp";
  if (/facebookexternalhit/i.test(ua)) return "Facebook Bot";
  if (/twitterbot/i.test(ua)) return "Twitter Bot";
  if (/linkedinbot/i.test(ua)) return "LinkedIn Bot";
  if (/bot|crawl|spider|scrape/i.test(ua)) return "Bot";
  if (/curl/i.test(ua)) return "curl";
  if (/wget/i.test(ua)) return "wget";
  if (/python-requests|python-urllib/i.test(ua)) return "Python";
  if (/Go-http-client/i.test(ua)) return "Go HTTP";

  // Device
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const isTablet = /iPad|Tablet/i.test(ua);
  const device = isTablet ? "Tablet" : isMobile ? "Mobile" : "Desktop";

  // Browser detection (order matters — check specific before generic)
  let browser = "Unknown";
  if (/EdgA?\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Brave/.test(ua)) browser = "Brave";
  else if (/Vivaldi/.test(ua)) browser = "Vivaldi";
  else if (/SamsungBrowser/.test(ua)) browser = "Samsung Browser";
  else if (/CriOS/.test(ua)) browser = "Chrome (iOS)";
  else if (/FxiOS/.test(ua)) browser = "Firefox (iOS)";
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = "Safari";
  else if (/MSIE|Trident/.test(ua)) browser = "IE";

  return `${browser} (${device})`;
}

const MAX_LOG_ROWS = 500_000;
let logCount = 0;
let lastPruneCheck = 0;

export function logRequest(log: RequestLog): void {
  try {
    const browser = parseUserAgent(log.user_agent);
    insertStmt.run(
      log.site_slug, log.path, log.method, log.status, log.response_time_ms,
      log.ip, log.country, log.city, log.user_agent, log.referrer,
      log.content_type, log.accept_language, browser
    );

    // Periodically prune old logs to prevent unbounded growth
    logCount++;
    const now = Date.now();
    if (logCount >= 1000 || now - lastPruneCheck > 3600_000) {
      logCount = 0;
      lastPruneCheck = now;
      const count = (db.query("SELECT COUNT(*) as cnt FROM requests").get() as any).cnt;
      if (count > MAX_LOG_ROWS) {
        db.run(`DELETE FROM requests WHERE id IN (
          SELECT id FROM requests ORDER BY id ASC LIMIT ?
        )`, count - MAX_LOG_ROWS);
      }
    }
  } catch (e) {
    console.error("Failed to log request:", e);
  }
}

export function extractRequestMeta(req: Request) {
  // Only trust proxy headers when Cloudflare signal is present
  const hasCfSignal = req.headers.get("cf-ipcountry");
  const ip = hasCfSignal
    ? (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown")
    : (req.headers.get("x-real-ip") || "unknown");
  return {
    ip,
    country: req.headers.get("cf-ipcountry") || null,
    city: req.headers.get("cf-ipcity") || null,
    user_agent: req.headers.get("user-agent") || null,
    referrer: req.headers.get("referer") || null,
    accept_language: req.headers.get("accept-language") || null,
  };
}

// --- Country restriction ---
export function getAllowedCountries(): string[] {
  const row = db.query("SELECT value FROM config WHERE key = 'allowed_countries'").get() as { value: string } | null;
  if (!row || !row.value) return []; // empty = allow all
  return row.value.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
}

export function setAllowedCountries(countries: string[]): void {
  const value = countries.map(c => c.trim().toUpperCase()).filter(Boolean).join(",");
  db.run(
    "INSERT INTO config (key, value) VALUES ('allowed_countries', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    value, value
  );
}

export function isCountryAllowed(country: string | null): boolean {
  const allowed = getAllowedCountries();
  if (allowed.length === 0) return true; // no restriction
  if (!country) return false; // unknown country blocked when restrictions are active
  return allowed.includes(country.toUpperCase());
}

// --- Dashboard queries ---

export function getOverviewStats(hours: number = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const requestStats = db.query(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(DISTINCT ip) as unique_visitors,
      ROUND(AVG(response_time_ms), 1) as avg_response_ms,
      ROUND(MIN(response_time_ms), 1) as min_response_ms,
      ROUND(MAX(response_time_ms), 1) as max_response_ms
    FROM requests WHERE created_at > ?
  `).get(cutoff) as any;

  // Active sites from the sites table, not requests
  const siteCount = db.query("SELECT COUNT(*) as count FROM sites WHERE active = 1").get() as any;

  return { ...requestStats, active_sites: siteCount.count };
}

export function getTopSites(hours: number = 24, limit: number = 10) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.query(`
    SELECT site_slug, COUNT(*) as hits, COUNT(DISTINCT ip) as visitors
    FROM requests WHERE created_at > ? AND site_slug IS NOT NULL
    GROUP BY site_slug ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);
}

export function getTopPaths(siteSlug: string | null, hours: number = 24, limit: number = 20) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  if (siteSlug) {
    return db.query(`
      SELECT path, COUNT(*) as hits FROM requests
      WHERE created_at > ? AND site_slug = ?
      GROUP BY path ORDER BY hits DESC LIMIT ?
    `).all(cutoff, siteSlug, limit);
  }
  return db.query(`
    SELECT path, COUNT(*) as hits FROM requests
    WHERE created_at > ?
    GROUP BY path ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);
}

export function getTrafficOverTime(hours: number = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Adaptive bucket sizing: finer granularity for shorter time ranges
  let bucketExpr: string;
  if (hours <= 1) {
    // 5-minute buckets for last hour
    bucketExpr = `strftime('%Y-%m-%dT%H:', created_at) || printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / 5) * 5) || ':00'`;
  } else if (hours <= 6) {
    // 15-minute buckets for up to 6 hours
    bucketExpr = `strftime('%Y-%m-%dT%H:', created_at) || printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / 15) * 15) || ':00'`;
  } else if (hours <= 48) {
    // 1-hour buckets for up to 2 days
    bucketExpr = `strftime('%Y-%m-%dT%H:00:00', created_at)`;
  } else {
    // Daily buckets for longer ranges
    bucketExpr = `strftime('%Y-%m-%dT00:00:00', created_at)`;
  }

  return db.query(`
    SELECT
      ${bucketExpr} as bucket,
      COUNT(*) as hits,
      COUNT(DISTINCT ip) as visitors
    FROM requests WHERE created_at > ?
    GROUP BY bucket ORDER BY bucket
  `).all(cutoff);
}

export function getTopCountries(hours: number = 24, limit: number = 15) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.query(`
    SELECT country, COUNT(*) as hits, COUNT(DISTINCT ip) as visitors
    FROM requests WHERE created_at > ? AND country IS NOT NULL
    GROUP BY country ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);
}

export function getTopBrowsers(hours: number = 24, limit: number = 10) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.query(`
    SELECT browser, COUNT(*) as hits
    FROM requests WHERE created_at > ? AND browser IS NOT NULL
    GROUP BY browser ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);
}

export function getRecentRequests(limit: number = 50, filters: {
  status?: string;
  country?: string;
  site?: string;
  search?: string;
} = {}) {
  let where = "1=1";
  const params: any[] = [];

  if (filters.status === "blocked") { where += " AND status = 403"; }
  else if (filters.status === "4xx") { where += " AND status >= 400 AND status < 500"; }
  else if (filters.status === "5xx") { where += " AND status >= 500"; }
  else if (filters.status === "2xx") { where += " AND status >= 200 AND status < 300"; }
  else if (filters.status === "3xx") { where += " AND status >= 300 AND status < 400"; }

  if (filters.country) { where += " AND country = ?"; params.push(filters.country.toUpperCase()); }
  if (filters.site) { where += " AND site_slug = ?"; params.push(filters.site); }
  if (filters.search) {
    const escaped = filters.search.replace(/[%_\\]/g, "\\$&");
    where += " AND path LIKE ? ESCAPE '\\'";
    params.push(`%${escaped}%`);
  }

  return db.query(`
    SELECT site_slug, path, method, status, response_time_ms, ip, country, city, browser, referrer, created_at
    FROM requests WHERE ${where} ORDER BY id DESC LIMIT ?
  `).all(...params, limit);
}

export function getStatusCodeBreakdown(hours: number = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.query(`
    SELECT
      CASE
        WHEN status >= 200 AND status < 300 THEN '2xx'
        WHEN status >= 300 AND status < 400 THEN '3xx'
        WHEN status >= 400 AND status < 500 THEN '4xx'
        WHEN status >= 500 THEN '5xx'
        ELSE 'other'
      END as status_group,
      COUNT(*) as count
    FROM requests WHERE created_at > ?
    GROUP BY status_group ORDER BY status_group
  `).all(cutoff);
}

export function getBlockedRequests(hours: number = 24, limit: number = 10) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const totalBlocked = db.query(`
    SELECT COUNT(*) as count FROM requests WHERE created_at > ? AND status = 403
  `).get(cutoff) as any;

  const blockedCountries = db.query(`
    SELECT country, COUNT(*) as hits, COUNT(DISTINCT ip) as ips
    FROM requests WHERE created_at > ? AND status = 403 AND country IS NOT NULL
    GROUP BY country ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);

  const blockedPaths = db.query(`
    SELECT path, COUNT(*) as hits, COUNT(DISTINCT ip) as ips
    FROM requests WHERE created_at > ? AND status = 403
    GROUP BY path ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);

  const blockedIps = db.query(`
    SELECT ip, country, COUNT(*) as hits
    FROM requests WHERE created_at > ? AND status = 403
    GROUP BY ip ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);

  return { total: totalBlocked.count, countries: blockedCountries, paths: blockedPaths, ips: blockedIps };
}

export function getSiteStats(slug: string, hours: number = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const overview = db.query(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(DISTINCT ip) as unique_visitors,
      ROUND(AVG(response_time_ms), 1) as avg_response_ms
    FROM requests WHERE created_at > ? AND site_slug = ?
  `).get(cutoff, slug);

  const paths = db.query(`
    SELECT path, COUNT(*) as hits FROM requests
    WHERE created_at > ? AND site_slug = ?
    GROUP BY path ORDER BY hits DESC LIMIT 20
  `).all(cutoff, slug);

  const countries = db.query(`
    SELECT country, COUNT(*) as hits FROM requests
    WHERE created_at > ? AND site_slug = ? AND country IS NOT NULL
    GROUP BY country ORDER BY hits DESC LIMIT 10
  `).all(cutoff, slug);

  const traffic = db.query(`
    SELECT strftime('%Y-%m-%dT%H:00:00', created_at) as bucket, COUNT(*) as hits
    FROM requests WHERE created_at > ? AND site_slug = ?
    GROUP BY bucket ORDER BY bucket
  `).all(cutoff, slug);

  return { overview, paths, countries, traffic };
}

// --- Auto-block configuration ---

interface AutoBlockConfig {
  enabled: boolean;
  threshold: number;       // number of blocked requests to trigger
  window_minutes: number;  // time window to count within
  duration_hours: number;  // how long to block (0 = permanent)
}

const AUTOBLOCK_DEFAULTS: AutoBlockConfig = {
  enabled: false,
  threshold: 20,
  window_minutes: 10,
  duration_hours: 24,
};

export function getAutoBlockConfig(): AutoBlockConfig {
  const row = db.query("SELECT value FROM config WHERE key = 'autoblock_config'").get() as { value: string } | null;
  if (!row?.value) return { ...AUTOBLOCK_DEFAULTS };
  try {
    return { ...AUTOBLOCK_DEFAULTS, ...JSON.parse(row.value) };
  } catch {
    return { ...AUTOBLOCK_DEFAULTS };
  }
}

export function setAutoBlockConfig(config: Partial<AutoBlockConfig>): AutoBlockConfig {
  const current = getAutoBlockConfig();
  const updated = { ...current, ...config };
  // Enforce sensible bounds
  updated.threshold = Math.max(1, Math.min(updated.threshold, 10000));
  updated.window_minutes = Math.max(1, Math.min(updated.window_minutes, 1440));
  updated.duration_hours = Math.max(0, Math.min(updated.duration_hours, 8760));
  const value = JSON.stringify(updated);
  db.run(
    "INSERT INTO config (key, value) VALUES ('autoblock_config', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    value, value
  );
  return updated;
}

// --- Blocked IP management ---

export function isIpBlocked(ip: string): boolean {
  const now = new Date().toISOString();
  const row = db.query(
    "SELECT id FROM blocked_ips WHERE ip = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).get(ip, now) as any;
  return !!row;
}

export function getBlockedIps(): any[] {
  const now = new Date().toISOString();
  // Clean expired entries
  db.run("DELETE FROM blocked_ips WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
  return db.query(
    "SELECT id, ip, reason, blocked_at, expires_at FROM blocked_ips ORDER BY blocked_at DESC"
  ).all();
}

export function unblockIp(id: number): void {
  db.run("DELETE FROM blocked_ips WHERE id = ?", id);
}

export function blockIp(ip: string, reason: string, durationHours: number): void {
  const expiresAt = durationHours > 0
    ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString()
    : null;
  db.run(
    "INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason = ?, blocked_at = datetime('now'), expires_at = ?",
    ip, reason, expiresAt, reason, expiresAt
  );
}

export function checkAndAutoBlock(ip: string): boolean {
  const config = getAutoBlockConfig();
  if (!config.enabled || !ip || ip === "unknown") return false;

  // Already blocked?
  if (isIpBlocked(ip)) return true;

  // Count recent 403s for this IP
  const cutoff = new Date(Date.now() - config.window_minutes * 60 * 1000).toISOString();
  const row = db.query(
    "SELECT COUNT(*) as cnt FROM requests WHERE ip = ? AND status = 403 AND created_at > ?"
  ).get(ip, cutoff) as { cnt: number };

  if (row.cnt >= config.threshold) {
    blockIp(ip, `Auto-blocked: ${row.cnt} blocked requests in ${config.window_minutes}min`, config.duration_hours);
    return true;
  }
  return false;
}
