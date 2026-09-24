// Bot shield: cheap, in-memory defenses against vulnerability scanners.
//
// Scanners walk a list of well-known secret and admin paths (/.env,
// /.git/config, /wp-login.php, …) and collect 404s. None of those requests
// ever come from a real visitor, so:
//
//   • Trap paths — a request for one of those paths that doesn't exist on the
//     target site is answered with a 404 immediately (no disk walk, no SPA
//     fallback) and counts as a strike. A few strikes block the IP.
//   • 404 limit — any IP collecting a burst of 404s is blocked for a while.
//     Link-preview and search crawlers are exempt (they follow stale links).
//   • Rate limit — optional per-IP requests-per-minute ceiling (429).
//   • AI crawlers — sites can refuse known AI-training crawlers (403).
//
// Every counter lives in memory, so none of this adds a database query to a
// normal request; only an actual block writes (to blocked_ips).

import db from "./db";
import { blockIp, isIpBlocked } from "./analytics";

export interface ShieldConfig {
  traps_enabled: boolean;
  trap_threshold: number;          // trap hits (within an hour) before blocking
  trap_block_hours: number;        // 0 = permanent
  notfound_enabled: boolean;
  notfound_threshold: number;      // 404s within the window before blocking
  notfound_window_minutes: number;
  notfound_block_hours: number;
  rate_limit_enabled: boolean;
  rate_limit_per_minute: number;
  allowlist: string[];             // IPs that are never blocked or limited
}

const DEFAULTS: ShieldConfig = {
  traps_enabled: true,
  trap_threshold: 3,
  trap_block_hours: 24,
  notfound_enabled: true,
  notfound_threshold: 30,
  notfound_window_minutes: 5,
  notfound_block_hours: 1,
  rate_limit_enabled: false,
  rate_limit_per_minute: 600,
  allowlist: [],
};

const TRAP_WINDOW_MS = 60 * 60_000;

let configCache: ShieldConfig | null = null;

export function getShieldConfig(): ShieldConfig {
  if (configCache) return configCache;
  const row = db.query("SELECT value FROM config WHERE key = 'shield_config'").get() as { value: string } | null;
  let parsed: Partial<ShieldConfig> = {};
  try { if (row?.value) parsed = JSON.parse(row.value); } catch (_) {}
  configCache = { ...DEFAULTS, ...parsed, allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [] };
  return configCache;
}

const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i;

export function isValidIp(ip: string): boolean {
  if (!IP_PATTERN.test(ip)) return false;
  if (ip.includes(".")) return ip.split(".").every(o => Number(o) <= 255);
  return ip.includes(":");
}

function clamp(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function setShieldConfig(input: Partial<Record<keyof ShieldConfig, unknown>>): ShieldConfig {
  const cur = getShieldConfig();
  const bool = (k: keyof ShieldConfig) => (k in input ? !!input[k] : (cur[k] as boolean));
  let allowlist = cur.allowlist;
  if ("allowlist" in input) {
    const raw = Array.isArray(input.allowlist) ? input.allowlist : String(input.allowlist ?? "").split(/[\s,]+/);
    allowlist = [...new Set(raw.map(s => String(s).trim().toLowerCase()).filter(Boolean))];
    const bad = allowlist.find(ip => !isValidIp(ip));
    if (bad) throw new Error(`'${bad}' isn't an IP address`);
    if (allowlist.length > 200) throw new Error("At most 200 allow-listed IPs");
  }
  const next: ShieldConfig = {
    traps_enabled: bool("traps_enabled"),
    trap_threshold: clamp(input.trap_threshold, cur.trap_threshold, 1, 100),
    trap_block_hours: clamp(input.trap_block_hours, cur.trap_block_hours, 0, 8760),
    notfound_enabled: bool("notfound_enabled"),
    notfound_threshold: clamp(input.notfound_threshold, cur.notfound_threshold, 5, 10000),
    notfound_window_minutes: clamp(input.notfound_window_minutes, cur.notfound_window_minutes, 1, 1440),
    notfound_block_hours: clamp(input.notfound_block_hours, cur.notfound_block_hours, 0, 8760),
    rate_limit_enabled: bool("rate_limit_enabled"),
    rate_limit_per_minute: clamp(input.rate_limit_per_minute, cur.rate_limit_per_minute, 60, 100000),
    allowlist,
  };
  const value = JSON.stringify(next);
  db.run("INSERT INTO config (key, value) VALUES ('shield_config', ?) ON CONFLICT(key) DO UPDATE SET value = ?", value, value);
  configCache = next;
  return next;
}

export function invalidateShieldConfig(): void {
  configCache = null;
}

// --- Classification ---

// Paths no legitimate visitor to a static site asks for. Matched against the
// site-relative path, lowercased. A trap only fires when the file doesn't
// actually exist on the site, so a site that really ships one of these is
// served normally.
const TRAP_PATTERNS: RegExp[] = [
  /(^|\/)\.env([.\-_][^/]*)?$/,                      // .env, .env.local, .env.prod.bak
  /(^|\/)\.(git|svn|hg|bzr)(\/|$)/,                 // VCS metadata
  /(^|\/)\.(aws|ssh|docker|kube|config)\//,          // credential dirs
  /(^|\/)\.(htpasswd|htaccess|npmrc|pypirc|netrc|pgpass|bash_history|ds_store)$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(php\d?|phtml|asp|aspx|ashx|asmx|axd|jsp|jspx|cgi|pl|cfm|do|action)$/,
  /(^|\/)(wp-admin|wp-includes|wp-content|wp-json)(\/|$)/,
  /(^|\/)(wp-login|wp-config|xmlrpc|wlwmanifest)[^/]*$/,
  /(^|\/)(phpmyadmin|pma|myadmin|adminer|phpinfo)(\/|$|\.)/,
  /(^|\/)(cgi-bin|vendor\/phpunit|actuator|solr|jenkins|manager\/html|boaform|hnap1|owa|autodiscover|ecp)(\/|$)/,
  /(^|\/)(secrets?|credentials|database|db|settings\.local|appsettings(\.[a-z]+)?|docker-compose(\.[a-z]+)?|web\.config|local\.settings)\.(ya?ml|json|xml|config|ini|toml)$/,
  /(^|\/)(config|configuration)\.(toml|ya?ml|ini|development\.json|local\.json|production\.json|staging\.json)$/,
  /\.(sql|sqlite|sqlite3|db|bak|old|orig|swp|save|tar|tar\.gz|tgz|7z|rar|pem|key|p12|pfx|kdbx)$/,
  /(^|\/)(server-status|server-info|telescope|_profiler|_ignition|debug\/default\/view)(\/|$)/,
];

export function isTrapPath(sitePath: string): boolean {
  const p = sitePath.toLowerCase();
  return TRAP_PATTERNS.some(re => re.test(p));
}

// Crawlers whose 404s are expected (stale links, sitemap guesses) and which
// power link previews — exempt from the 404 limit, never from trap paths.
const FRIENDLY_BOTS = /googlebot|google-inspectiontool|adsbot-google|bingbot|duckduckbot|yandex|baiduspider|applebot|facebookexternalhit|facebookcatalog|meta-externalfetcher|twitterbot|slackbot|slack-imgproxy|linkedinbot|discordbot|whatsapp|telegrambot|skypeuripreview|pinterest|redditbot|embedly|iframely|mastodon|bluesky|cardyb|snapchat|vkshare|uptimerobot|betteruptime|pingdom/i;

export function isFriendlyBot(ua: string | null): boolean {
  return !!ua && FRIENDLY_BOTS.test(ua);
}

// Known AI-training / AI-answer crawlers (user agents that honour robots.txt
// tokens of the same names).
const AI_CRAWLERS = /gptbot|chatgpt-user|oai-searchbot|ccbot|claudebot|claude-web|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|bytespider|amazonbot|meta-externalagent|cohere-ai|cohere-training|diffbot|imagesiftbot|omgili|youbot|timpibot|ai2bot|google-cloudvertexbot|petalbot|mistralai-user|duckassistbot/i;

export function isAiCrawler(ua: string | null): boolean {
  return !!ua && AI_CRAWLERS.test(ua);
}

// --- Strike bookkeeping ---

const trapHits = new Map<string, number[]>();
const notFounds = new Map<string, number[]>();
const rateWindows = new Map<string, { start: number; count: number }>();

function pushHit(map: Map<string, number[]>, ip: string, windowMs: number): number {
  const now = Date.now();
  const list = (map.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  map.set(ip, list);
  if (map.size > 20_000) {
    for (const [k, v] of map) if (!v.some(t => now - t < windowMs)) map.delete(k);
  }
  return list.length;
}

function exempt(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  return getShieldConfig().allowlist.includes(ip.toLowerCase());
}

// Never block the address an administrator is currently signed in from — an
// admin clicking through a half-deployed site shouldn't lock themselves out.
function isAdminIp(ip: string): boolean {
  try {
    return !!db.query(`
      SELECT 1 FROM sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE u.is_admin = 1 AND s.expires_at > datetime('now') AND (s.last_ip = ? OR s.ip = ?) LIMIT 1
    `).get(ip, ip);
  } catch {
    return false;
  }
}

function block(ip: string, reason: string, hours: number): boolean {
  if (isIpBlocked(ip) || isAdminIp(ip)) return false;
  blockIp(ip, reason, hours);
  trapHits.delete(ip);
  notFounds.delete(ip);
  console.log(`  Shield: blocked ${ip} — ${reason}`);
  return true;
}

// A trap path was requested. Returns true when this hit got the IP blocked.
export function recordTrapHit(ip: string, path: string): boolean {
  const cfg = getShieldConfig();
  if (!cfg.traps_enabled || exempt(ip)) return false;
  const n = pushHit(trapHits, ip, TRAP_WINDOW_MS);
  if (n >= cfg.trap_threshold) {
    return block(ip, `Shield: probed ${n} scanner paths (last: ${path.slice(0, 120)})`, cfg.trap_block_hours);
  }
  return false;
}

// A request ended in 404. Returns true when this one got the IP blocked.
export function recordNotFound(ip: string, ua: string | null): boolean {
  const cfg = getShieldConfig();
  if (!cfg.notfound_enabled || exempt(ip) || isFriendlyBot(ua)) return false;
  const n = pushHit(notFounds, ip, cfg.notfound_window_minutes * 60_000);
  if (n >= cfg.notfound_threshold) {
    return block(ip, `Shield: ${n} not-found requests in ${cfg.notfound_window_minutes} min`, cfg.notfound_block_hours);
  }
  return false;
}

// Fixed one-minute window per IP. Returns seconds until the window resets
// when the IP is over its limit, else 0.
export function checkRateLimit(ip: string): number {
  const cfg = getShieldConfig();
  if (!cfg.rate_limit_enabled || exempt(ip)) return 0;
  const now = Date.now();
  let w = rateWindows.get(ip);
  if (!w || now - w.start >= 60_000) {
    w = { start: now, count: 0 };
    rateWindows.set(ip, w);
    if (rateWindows.size > 20_000) {
      for (const [k, v] of rateWindows) if (now - v.start >= 60_000) rateWindows.delete(k);
    }
  }
  w.count++;
  if (w.count > cfg.rate_limit_per_minute) return Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000));
  return 0;
}

// Forget an IP's strikes (after an admin unblocks it) or everything (tests).
export function resetShieldCounters(ip?: string): void {
  if (ip) { trapHits.delete(ip); notFounds.delete(ip); rateWindows.delete(ip); return; }
  trapHits.clear(); notFounds.clear(); rateWindows.clear();
}
