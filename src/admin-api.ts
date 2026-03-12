import {
  verifyPassword, createSession, destroySession, validateSession,
  getSessionToken, getClientIp, isRateLimited, isSetup, setAdminPassword,
  sessionCookie, cleanExpiredSessions
} from "./auth";
import { listSites, getSite, deploySite, deleteSite, toggleSite, listVersions, switchVersion, deleteVersion, updateSiteSettings } from "./sites";
import {
  getOverviewStats, getTopSites, getTopPaths, getTrafficOverTime,
  getTopCountries, getTopUserAgents, getRecentRequests,
  getStatusCodeBreakdown, getSiteStats
} from "./analytics";

function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

export async function handleAdminApi(req: Request, path: string): Promise<Response | null> {
  const ip = getClientIp(req);

  // --- Setup endpoint (first-time password) ---
  if (path === "/_admin/api/setup" && req.method === "POST") {
    if (isSetup()) return json({ error: "Already configured" }, 400);
    const body = await req.json() as { password?: string };
    if (!body.password || body.password.length < 8) {
      return json({ error: "Password must be at least 8 characters" }, 400);
    }
    await setAdminPassword(body.password);
    const token = createSession(ip);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  // --- Login ---
  if (path === "/_admin/api/login" && req.method === "POST") {
    if (!isSetup()) return json({ error: "Not configured — set up password first" }, 400);
    if (isRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const body = await req.json() as { password?: string };
    if (!body.password) return json({ error: "Password required" }, 400);
    const valid = await verifyPassword(body.password, ip);
    if (!valid) return json({ error: "Invalid password" }, 401);
    const token = createSession(ip);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  // --- Logout ---
  if (path === "/_admin/api/logout" && req.method === "POST") {
    const token = getSessionToken(req);
    if (token) destroySession(token);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("deleted", 0) });
  }

  // --- Auth check ---
  if (path === "/_admin/api/auth-check") {
    const authed = validateSession(getSessionToken(req));
    return json({ authenticated: authed, setup: isSetup() });
  }

  // All remaining admin API routes require auth
  if (!validateSession(getSessionToken(req))) {
    return unauthorized();
  }

  // --- Change password ---
  if (path === "/_admin/api/change-password" && req.method === "POST") {
    const body = await req.json() as { current?: string; password?: string };
    if (!body.current || !body.password) return json({ error: "Both current and new password required" }, 400);
    const valid = await verifyPassword(body.current, ip);
    if (!valid) return json({ error: "Current password is incorrect" }, 401);
    if (body.password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    await setAdminPassword(body.password);
    return json({ ok: true });
  }

  // --- Sites CRUD ---
  if (path === "/_admin/api/sites" && req.method === "GET") {
    return json({ sites: listSites() });
  }

  if (path === "/_admin/api/sites" && req.method === "POST") {
    const formData = await req.formData();
    const slug = (formData.get("slug") as string)?.toLowerCase().trim();
    const name = (formData.get("name") as string)?.trim() || slug;
    const label = (formData.get("label") as string)?.trim() || undefined;
    const file = formData.get("file") as File;

    if (!slug) return json({ error: "Slug is required" }, 400);
    if (!file || !file.name.endsWith(".zip")) return json({ error: "ZIP file is required" }, 400);

    try {
      const result = await deploySite(slug, name, await file.arrayBuffer(), label);
      return json(result);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  const siteMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)$/);
  if (siteMatch) {
    const slug = siteMatch[1];
    if (req.method === "GET") {
      const site = getSite(slug);
      if (!site) return json({ error: "Not found" }, 404);
      const versions = listVersions(slug);
      return json({ site, versions });
    }
    if (req.method === "DELETE") {
      const ok = deleteSite(slug);
      return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
    }
  }

  // --- Toggle active/inactive ---
  const toggleMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/(enable|disable)$/);
  if (toggleMatch && req.method === "POST") {
    const [, slug, action] = toggleMatch;
    const ok = toggleSite(slug, action === "enable");
    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }

  // --- Site settings (root_dir, SPA) ---
  const settingsMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/settings$/);
  if (settingsMatch && req.method === "POST") {
    const slug = settingsMatch[1];
    const body = await req.json() as { root_dir?: string | null; spa?: boolean };
    const ok = updateSiteSettings(slug, body.root_dir ?? null, body.spa ?? false);
    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }

  // --- Version management ---
  const versionSwitchMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/versions\/(\d+)\/activate$/);
  if (versionSwitchMatch && req.method === "POST") {
    const [, slug, version] = versionSwitchMatch;
    const ok = switchVersion(slug, version);
    return ok ? json({ ok: true }) : json({ error: "Version not found" }, 404);
  }

  const versionDeleteMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/versions\/(\d+)$/);
  if (versionDeleteMatch && req.method === "DELETE") {
    const [, slug, version] = versionDeleteMatch;
    try {
      const ok = deleteVersion(slug, version);
      return ok ? json({ ok: true }) : json({ error: "Version not found" }, 404);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Analytics ---
  if (path === "/_admin/api/analytics/overview") {
    const hours = parseInt(new URL(req.url).searchParams.get("hours") || "24");
    return json(getOverviewStats(hours));
  }

  if (path === "/_admin/api/analytics/top-sites") {
    const hours = parseInt(new URL(req.url).searchParams.get("hours") || "24");
    return json(getTopSites(hours));
  }

  if (path === "/_admin/api/analytics/top-paths") {
    const url = new URL(req.url);
    const hours = parseInt(url.searchParams.get("hours") || "24");
    const site = url.searchParams.get("site") || null;
    return json(getTopPaths(site, hours));
  }

  if (path === "/_admin/api/analytics/traffic") {
    const hours = parseInt(new URL(req.url).searchParams.get("hours") || "24");
    return json(getTrafficOverTime(hours));
  }

  if (path === "/_admin/api/analytics/countries") {
    const hours = parseInt(new URL(req.url).searchParams.get("hours") || "24");
    return json(getTopCountries(hours));
  }

  if (path === "/_admin/api/analytics/user-agents") {
    const hours = parseInt(new URL(req.url).searchParams.get("hours") || "24");
    return json(getTopUserAgents(hours));
  }

  if (path === "/_admin/api/analytics/status-codes") {
    const hours = parseInt(new URL(req.url).searchParams.get("hours") || "24");
    return json(getStatusCodeBreakdown(hours));
  }

  if (path === "/_admin/api/analytics/recent") {
    const limit = parseInt(new URL(req.url).searchParams.get("limit") || "50");
    return json(getRecentRequests(limit));
  }

  const siteStatsMatch = path.match(/^\/_admin\/api\/analytics\/site\/([a-z0-9-]+)$/);
  if (siteStatsMatch) {
    const hours = parseInt(new URL(req.url).searchParams.get("hours") || "24");
    return json(getSiteStats(siteStatsMatch[1], hours));
  }

  // --- Session cleanup ---
  if (path === "/_admin/api/cleanup" && req.method === "POST") {
    cleanExpiredSessions();
    return json({ ok: true });
  }

  return null;
}
