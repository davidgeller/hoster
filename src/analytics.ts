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

const insertStmt = db.prepare(`
  INSERT INTO requests (site_slug, path, method, status, response_time_ms, ip, country, city, user_agent, referrer, content_type, accept_language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function logRequest(log: RequestLog): void {
  try {
    insertStmt.run(
      log.site_slug, log.path, log.method, log.status, log.response_time_ms,
      log.ip, log.country, log.city, log.user_agent, log.referrer,
      log.content_type, log.accept_language
    );
  } catch (e) {
    console.error("Failed to log request:", e);
  }
}

export function extractRequestMeta(req: Request) {
  return {
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
    country: req.headers.get("cf-ipcountry") || null,
    city: req.headers.get("cf-ipcity") || null,
    user_agent: req.headers.get("user-agent") || null,
    referrer: req.headers.get("referer") || null,
    accept_language: req.headers.get("accept-language") || null,
  };
}

// --- Dashboard queries ---

export function getOverviewStats(hours: number = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const totals = db.query(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(DISTINCT ip) as unique_visitors,
      COUNT(DISTINCT site_slug) as active_sites,
      ROUND(AVG(response_time_ms), 1) as avg_response_ms
    FROM requests WHERE created_at > ?
  `).get(cutoff) as any;

  return totals;
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

export function getTrafficOverTime(hours: number = 24, bucketMinutes: number = 60) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.query(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00', created_at) as bucket,
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

export function getTopUserAgents(hours: number = 24, limit: number = 10) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.query(`
    SELECT user_agent, COUNT(*) as hits
    FROM requests WHERE created_at > ? AND user_agent IS NOT NULL
    GROUP BY user_agent ORDER BY hits DESC LIMIT ?
  `).all(cutoff, limit);
}

export function getRecentRequests(limit: number = 50) {
  return db.query(`
    SELECT site_slug, path, method, status, response_time_ms, ip, country, city, user_agent, referrer, created_at
    FROM requests ORDER BY id DESC LIMIT ?
  `).all(limit);
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
