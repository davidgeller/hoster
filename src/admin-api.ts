import {
  verifyPassword, createSession, destroySession, validateSession,
  getSessionToken, getClientIp, isRateLimited, isSetup, setAdminPassword,
  sessionCookie, cleanExpiredSessions, validateCsrf, getCsrfToken,
  isTotpEnabled, generateTotpSecret, getTotpQrDataUrl, verifyTotpCode,
  getTotpSecret, enableTotp, disableTotp, generateRecoveryCodes,
  useRecoveryCode, getRemainingRecoveryCodes,
  setPendingTotpSecret, getPendingTotpSecret, clearPendingTotpSecret,
  createPending2faToken, consumePending2faToken,
  cleanExpiredPending2fa,
  isTotpRateLimited, recordTotpAttempt,
  auditLog, getAuditLog
} from "./auth";
import { listSites, getSite, deploySite, deleteSite, toggleSite, listVersions, switchVersion, deleteVersion, updateSiteSettings, getAliases, addAlias, removeAlias } from "./sites";
import {
  getOverviewStats, getTopSites, getTopPaths, getTrafficOverTime,
  getTopCountries, getTopBrowsers, getRecentRequests,
  getStatusCodeBreakdown, getSiteStats, getBlockedRequests,
  getAllowedCountries, setAllowedCountries
} from "./analytics";
import { createMcpToken, listMcpTokens, deleteMcpToken, getMcpAuditLog } from "./mcp";

function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

function sessionResponse(ip: string): Response {
  const { sessionToken, csrfToken } = createSession(ip);
  return json({ ok: true, csrf_token: csrfToken }, 200, { "Set-Cookie": sessionCookie(sessionToken) });
}

function clampInt(value: string | null, defaultVal: number, min: number, max: number): number {
  const parsed = parseInt(value || String(defaultVal)) || defaultVal;
  return Math.min(Math.max(min, parsed), max);
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
    auditLog("setup", "Initial admin password set", ip);
    return sessionResponse(ip);
  }

  // --- Login ---
  if (path === "/_admin/api/login" && req.method === "POST") {
    if (!isSetup()) return json({ error: "Not configured — set up password first" }, 400);
    if (isRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const body = await req.json() as { password?: string };
    if (!body.password) return json({ error: "Password required" }, 400);
    const valid = await verifyPassword(body.password, ip);
    if (!valid) {
      auditLog("login_failed", null, ip);
      return json({ error: "Invalid credentials" }, 401);
    }

    // If 2FA is enabled, don't create a session yet — issue a pending 2FA token
    if (isTotpEnabled()) {
      const pendingToken = createPending2faToken(ip);
      return json({ requires_2fa: true, pending_token: pendingToken });
    }

    auditLog("login", null, ip);
    return sessionResponse(ip);
  }

  // --- 2FA Verification (during login) ---
  if (path === "/_admin/api/login/2fa" && req.method === "POST") {
    if (isTotpRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const body = await req.json() as { pending_token?: string; code?: string };
    if (!body.pending_token || !body.code) return json({ error: "Token and code required" }, 400);

    const secret = getTotpSecret();
    if (!secret) return json({ error: "2FA not configured" }, 500);

    const code = body.code.trim().replace(/\s/g, "");

    // Try TOTP code first, then recovery code
    if (verifyTotpCode(secret, code) || useRecoveryCode(code)) {
      // Atomically consume the pending token — prevents race conditions
      if (!consumePending2faToken(body.pending_token)) {
        return json({ error: "Session expired. Please log in again." }, 401);
      }
      recordTotpAttempt(ip, true);
      auditLog("login_2fa", null, ip);
      return sessionResponse(ip);
    }

    recordTotpAttempt(ip, false);
    auditLog("login_2fa_failed", null, ip);
    return json({ error: "Invalid code" }, 401);
  }

  // --- Logout ---
  if (path === "/_admin/api/logout" && req.method === "POST") {
    const token = getSessionToken(req);
    if (token) destroySession(token);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("deleted", 0) });
  }

  // --- Auth check ---
  if (path === "/_admin/api/auth-check") {
    const token = getSessionToken(req);
    const authed = validateSession(token, ip);
    const csrf = authed ? getCsrfToken(token) : null;
    return json({ authenticated: authed, setup: isSetup(), totp_enabled: isTotpEnabled(), csrf_token: csrf });
  }

  // All remaining admin API routes require auth
  const sessionToken = getSessionToken(req);
  if (!validateSession(sessionToken, ip)) {
    return unauthorized();
  }

  // CSRF validation for all state-changing requests
  if (req.method !== "GET" && !validateCsrf(req, sessionToken)) {
    return json({ error: "Invalid CSRF token" }, 403);
  }

  // --- Change password ---
  if (path === "/_admin/api/change-password" && req.method === "POST") {
    const body = await req.json() as { current?: string; password?: string };
    if (!body.current || !body.password) return json({ error: "Both current and new password required" }, 400);
    const valid = await verifyPassword(body.current, ip);
    if (!valid) return json({ error: "Current password is incorrect" }, 401);
    if (body.password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    await setAdminPassword(body.password);
    auditLog("password_changed", null, ip);
    return json({ ok: true });
  }

  // --- TOTP 2FA Management ---
  if (path === "/_admin/api/totp/status" && req.method === "GET") {
    return json({
      enabled: isTotpEnabled(),
      recovery_codes_remaining: isTotpEnabled() ? getRemainingRecoveryCodes() : 0,
    });
  }

  if (path === "/_admin/api/totp/setup" && req.method === "POST") {
    if (isTotpEnabled()) return json({ error: "2FA is already enabled" }, 400);
    const { secret, uri } = generateTotpSecret();
    setPendingTotpSecret(secret);
    const qrDataUrl = await getTotpQrDataUrl(uri);
    return json({ secret, qr: qrDataUrl });
  }

  if (path === "/_admin/api/totp/confirm" && req.method === "POST") {
    const body = await req.json() as { code?: string };
    if (!body.code) return json({ error: "Verification code required" }, 400);

    const pendingSecret = getPendingTotpSecret();
    if (!pendingSecret) return json({ error: "No pending 2FA setup. Start setup first." }, 400);

    if (!verifyTotpCode(pendingSecret, body.code.trim())) {
      return json({ error: "Invalid code. Check your authenticator app and try again." }, 400);
    }

    const recoveryCodes = generateRecoveryCodes();
    enableTotp(pendingSecret, recoveryCodes);
    clearPendingTotpSecret();
    auditLog("totp_enabled", null, ip);

    return json({ ok: true, recovery_codes: recoveryCodes });
  }

  if (path === "/_admin/api/totp/disable" && req.method === "POST") {
    const body = await req.json() as { password?: string };
    if (!body.password) return json({ error: "Password required to disable 2FA" }, 400);

    const valid = await verifyPassword(body.password, ip);
    if (!valid) return json({ error: "Invalid password" }, 401);

    disableTotp();
    auditLog("totp_disabled", null, ip);
    return json({ ok: true });
  }

  if (path === "/_admin/api/totp/recovery-codes" && req.method === "POST") {
    const body = await req.json() as { password?: string };
    if (!body.password) return json({ error: "Password required" }, 400);

    const valid = await verifyPassword(body.password, ip);
    if (!valid) return json({ error: "Invalid password" }, 401);

    if (!isTotpEnabled()) return json({ error: "2FA is not enabled" }, 400);

    const secret = getTotpSecret()!;
    const recoveryCodes = generateRecoveryCodes();
    enableTotp(secret, recoveryCodes);

    return json({ recovery_codes: recoveryCodes });
  }

  // --- Sites CRUD ---
  if (path === "/_admin/api/sites" && req.method === "GET") {
    const sites = listSites().map(s => ({ ...s, aliases: getAliases(s.slug) }));
    return json({ sites });
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
      const aliases = getAliases(slug);
      return json({ site, versions, aliases });
    }
    if (req.method === "DELETE") {
      const ok = deleteSite(slug);
      if (ok) auditLog("site_deleted", slug, ip);
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
    const body = await req.json() as { root_dir?: string | null; spa?: boolean; mcp_enabled?: boolean; mcp_read_only?: boolean };
    try {
      const ok = updateSiteSettings(slug, body.root_dir ?? null, body.spa ?? false, body.mcp_enabled, body.mcp_read_only);
      return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Site aliases ---
  const aliasMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/aliases$/);
  if (aliasMatch && req.method === "GET") {
    const slug = aliasMatch[1];
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);
    return json({ aliases: getAliases(slug) });
  }
  if (aliasMatch && req.method === "POST") {
    const slug = aliasMatch[1];
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);
    const body = await req.json() as { alias?: string };
    const alias = body.alias?.toLowerCase().trim();
    if (!alias) return json({ error: "Alias is required" }, 400);
    try {
      addAlias(alias, slug);
      auditLog("alias_added", `${alias} -> ${slug}`, ip);
      return json({ ok: true, aliases: getAliases(slug) });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  const aliasDeleteMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/aliases\/([a-z0-9-]+)$/);
  if (aliasDeleteMatch && req.method === "DELETE") {
    const [, slug, alias] = aliasDeleteMatch;
    const ok = removeAlias(alias, slug);
    if (ok) auditLog("alias_removed", `${alias} -> ${slug}`, ip);
    return ok ? json({ ok: true, aliases: getAliases(slug) }) : json({ error: "Alias not found" }, 404);
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
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getOverviewStats(hours));
  }

  if (path === "/_admin/api/analytics/top-sites") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTopSites(hours));
  }

  if (path === "/_admin/api/analytics/top-paths") {
    const url = new URL(req.url);
    const hours = clampInt(url.searchParams.get("hours"), 24, 1, 8760);
    const site = url.searchParams.get("site") || null;
    return json(getTopPaths(site, hours));
  }

  if (path === "/_admin/api/analytics/traffic") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTrafficOverTime(hours));
  }

  if (path === "/_admin/api/analytics/countries") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTopCountries(hours));
  }

  if (path === "/_admin/api/analytics/browsers") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTopBrowsers(hours));
  }

  if (path === "/_admin/api/analytics/status-codes") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getStatusCodeBreakdown(hours));
  }

  if (path === "/_admin/api/analytics/blocked") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getBlockedRequests(hours));
  }

  if (path === "/_admin/api/analytics/recent") {
    const url = new URL(req.url);
    const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
    const filters = {
      status: url.searchParams.get("status") || undefined,
      country: url.searchParams.get("country") || undefined,
      site: url.searchParams.get("site") || undefined,
      search: url.searchParams.get("search") || undefined,
    };
    return json(getRecentRequests(limit, filters));
  }

  const siteStatsMatch = path.match(/^\/_admin\/api\/analytics\/site\/([a-z0-9-]+)$/);
  if (siteStatsMatch) {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getSiteStats(siteStatsMatch[1], hours));
  }

  // --- Country restriction settings ---
  if (path === "/_admin/api/settings/countries" && req.method === "GET") {
    return json({ countries: getAllowedCountries() });
  }
  if (path === "/_admin/api/settings/countries" && req.method === "POST") {
    const body = await req.json() as { countries?: string[] };
    setAllowedCountries(body.countries || []);
    return json({ ok: true, countries: getAllowedCountries() });
  }

  // --- MCP token management ---
  if (path === "/_admin/api/mcp/tokens" && req.method === "GET") {
    return json({ tokens: listMcpTokens() });
  }
  if (path === "/_admin/api/mcp/tokens" && req.method === "POST") {
    const body = await req.json() as { label?: string; site_slug?: string; expires_in_days?: number };
    const label = body.label?.trim();
    if (!label) return json({ error: "Label is required" }, 400);
    const token = createMcpToken(label, body.site_slug || null, body.expires_in_days || null);
    return json({ token });
  }
  const mcpTokenDeleteMatch = path.match(/^\/_admin\/api\/mcp\/tokens\/(\d+)$/);
  if (mcpTokenDeleteMatch && req.method === "DELETE") {
    const id = parseInt(mcpTokenDeleteMatch[1]);
    const ok = deleteMcpToken(id);
    return ok ? json({ ok: true }) : json({ error: "Token not found" }, 404);
  }

  // --- MCP audit log ---
  if (path === "/_admin/api/mcp/audit" && req.method === "GET") {
    const limit = clampInt(new URL(req.url).searchParams.get("limit"), 50, 1, 500);
    return json({ entries: getMcpAuditLog(limit) });
  }

  // --- Audit log ---
  if (path === "/_admin/api/audit" && req.method === "GET") {
    const limit = clampInt(new URL(req.url).searchParams.get("limit"), 50, 1, 500);
    return json({ entries: getAuditLog(limit) });
  }

  // --- Session cleanup ---
  if (path === "/_admin/api/cleanup" && req.method === "POST") {
    cleanExpiredSessions();
    cleanExpiredPending2fa();
    return json({ ok: true });
  }

  return null;
}
