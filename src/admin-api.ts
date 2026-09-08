import {
  createSession, destroySession, destroyAllSessions, validateSession,
  getSessionToken, getClientIp, isRateLimited, isSetup,
  sessionCookie, cleanExpiredSessions, validateCsrf, getCsrfToken,
  isTotpEnabled, generateTotpSecret, getTotpQrDataUrl, verifyTotpCode,
  enableTotp, disableTotp, generateRecoveryCodes, getRemainingRecoveryCodes,
  setPendingTotpSecret, getPendingTotpSecret, clearPendingTotpSecret,
  getTotpSecret, verifyTotpOrRecovery,
  createPending2faToken, consumePending2faToken, peekPending2faUser,
  cleanExpiredPending2fa,
  isTotpRateLimited, recordTotpAttempt,
  recordLoginAttempt,
  auditLog, getAuditLog,
  getSessionUser, destroySessionsForUser, verifyUserPassword, verifyPasswordForUser,
  setUserPassword, getUser,
  getUserSiteSlugs, listAdminUsers, createAdminUser, updateAdminUser, deleteAdminUser,
  type Principal,
} from "./auth";
import {
  listSites, getSite, deploySite, createBlankSite, deleteSite, toggleSite,
  listVersions, switchVersion, deleteVersion, commitVersion, setVersionMeta, updateSiteSettings,
  setSitePinned, renameSite, zipCurrentVersion,
  getAliases, addAlias, removeAlias,
  getHostAliases, addHostAlias, removeHostAlias, listAllHostAliases,
  listSiteTree, reloadSite, uploadFileToSite,
  deleteSitePaths, renameSitePath, copySitePath, createSiteDirectory,
  checkSiteHealth, rebuildCurrentSymlinks,
  getCmsStatus, cmsInit,
} from "./sites";
import {
  listCmsLibFiles, getCmsLibFile, updateCmsLibFile, resetCmsLibFile,
} from "./cms-lib";
import {
  getOverviewStats, getTopSites, getTopPaths, getTrafficOverTime,
  getBandwidthOverTime,
  getTopCountries, getTopBrowsers, getRecentRequests,
  getStatusCodeBreakdown, getSiteStats, getBlockedRequests,
  getAllowedCountries, setAllowedCountries,
  getAutoBlockConfig, setAutoBlockConfig, getBlockedIps, unblockIp
} from "./analytics";
import { listCountries } from "./countries";
import { createMcpToken, listMcpTokens, deleteMcpToken, getMcpAuditLog } from "./mcp";
import {
  listOauthGrants, revokeOauthGrant, listOauthClients, deleteOauthClient,
  listSiteDelegates, createSiteDelegate, deleteSiteDelegate,
} from "./oauth";
import { createBackup, previewBackup, restoreBackup } from "./backup";
import {
  getRpContext, beginRegistration, finishRegistration,
  beginLogin as beginPasskeyLogin, finishLogin as finishPasskeyLogin,
  listCredentials, deleteCredential, hasCredentialsForRp,
} from "./webauthn";

function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Parse a JSON request body without letting a malformed/empty body escalate to
// an unhandled 500. Returns null on any parse failure so callers can answer a
// clean 400 instead. (A raw `await req.json()` throws SyntaxError on bad input,
// which the top-level handler would otherwise surface as "Internal Server Error".)
async function readJsonBody<T = any>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// Variant for endpoints where an empty body is legitimate (optional params).
async function readJsonBodyOrEmpty<T = any>(req: Request): Promise<T> {
  return ((await readJsonBody<T>(req)) ?? {}) as T;
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

function sessionResponse(ip: string, userId: number): Response {
  // Rotate sessions on every successful login: invalidate any previously-issued
  // cookie for THIS account (stolen, leaked, or just stale). Scoped to the
  // logging-in account so signing in as one user doesn't evict the others.
  destroySessionsForUser(userId);
  const { sessionToken, csrfToken } = createSession(ip, userId);
  return json({ ok: true, csrf_token: csrfToken }, 200, { "Set-Cookie": sessionCookie(sessionToken) });
}

function clampInt(value: string | null, defaultVal: number, min: number, max: number): number {
  const parsed = parseInt(value || String(defaultVal)) || defaultVal;
  return Math.min(Math.max(min, parsed), max);
}

export async function handleAdminApi(req: Request, path: string): Promise<Response | null> {
  const ip = getClientIp(req);

  // --- Setup endpoint (first administrator) ---
  if (path === "/_admin/api/setup" && req.method === "POST") {
    if (isSetup()) return json({ error: "Already configured" }, 400);
    const body = await readJsonBody<{ username?: string; password?: string }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.password || body.password.length < 8) {
      return json({ error: "Password must be at least 8 characters" }, 400);
    }
    const username = (body.username || "admin").trim();
    try {
      const userId = await createAdminUser(username, body.password, { isAdmin: true });
      auditLog("setup", `Initial administrator '${username.toLowerCase()}' created`, ip, username.toLowerCase());
      return sessionResponse(ip, userId);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Login (username + password) ---
  if (path === "/_admin/api/login" && req.method === "POST") {
    if (!isSetup()) return json({ error: "Not configured — create the first administrator" }, 400);
    if (isRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const body = await readJsonBody<{ username?: string; password?: string }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    const username = (body.username || "").trim();
    if (!username || !body.password) return json({ error: "Username and password required" }, 400);

    const user = await verifyUserPassword(username, body.password, ip);
    if (!user) {
      auditLog("login_failed", `user:${username.toLowerCase()}`, ip, null);
      return json({ error: "Invalid credentials" }, 401);
    }

    // If 2FA is enabled on this account, don't create a session yet — issue a
    // pending 2FA token bound to the account and the IP.
    if (isTotpEnabled(user.userId)) {
      const pendingToken = createPending2faToken(ip, user.userId);
      return json({ requires_2fa: true, pending_token: pendingToken });
    }

    auditLog("login", null, ip, user.username);
    return sessionResponse(ip, user.userId);
  }

  // --- 2FA Verification (during login) ---
  if (path === "/_admin/api/login/2fa" && req.method === "POST") {
    if (isTotpRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const body = await readJsonBody<{ pending_token?: string; code?: string }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.pending_token || !body.code) return json({ error: "Token and code required" }, 400);

    const userId = peekPending2faUser(body.pending_token);
    if (userId == null) return json({ error: "Session expired. Please log in again." }, 401);
    const user = getUser(userId);
    if (!user) return json({ error: "Session expired. Please log in again." }, 401);

    // Try TOTP code first, then recovery code
    if (verifyTotpOrRecovery(userId, body.code)) {
      // Atomically consume the pending token — prevents race conditions.
      // Also enforces IP-binding: the consume must come from the same IP that
      // began the login flow. Refuses to complete 2FA across an IP change.
      const consumedFor = consumePending2faToken(body.pending_token, ip);
      if (consumedFor == null || consumedFor !== userId) {
        return json({ error: "Session expired or IP changed. Please log in again." }, 401);
      }
      recordTotpAttempt(ip, true);
      auditLog("login_2fa", null, ip, user.username);
      return sessionResponse(ip, userId);
    }

    recordTotpAttempt(ip, false);
    auditLog("login_2fa_failed", null, ip, user.username);
    return json({ error: "Invalid code" }, 401);
  }

  // --- Passkey login (standalone, no password) ---
  //
  // A passkey is possession + user verification in one step, so it stands in
  // for the whole password+TOTP flow rather than bolting onto it. The
  // credential identifies the account, so no username is typed first.
  if (path === "/_admin/api/login/passkey/options" && req.method === "POST") {
    if (!isSetup()) return json({ error: "Not configured — create the first administrator" }, 400);
    if (isRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const rp = getRpContext(req);
    if (!rp) return json({ error: "Passkeys require HTTPS (or localhost)" }, 400);
    try {
      return json(await beginPasskeyLogin(rp, ip));
    } catch (e: any) {
      return json({ error: e?.message || "Could not start passkey sign-in" }, 400);
    }
  }

  if (path === "/_admin/api/login/passkey/verify" && req.method === "POST") {
    if (!isSetup()) return json({ error: "Not configured — create the first administrator" }, 400);
    if (isRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const rp = getRpContext(req);
    if (!rp) return json({ error: "Passkeys require HTTPS (or localhost)" }, 400);
    const body = await readJsonBody<{ response?: any }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.response) return json({ error: "Passkey response required" }, 400);
    try {
      const credential = await finishPasskeyLogin(rp, ip, body.response);
      const owner = credential.user_id != null ? getUser(credential.user_id) : null;
      if (!owner) throw new Error("Unrecognized passkey");
      recordLoginAttempt(ip, true);
      auditLog("login_passkey", credential.label, ip, owner.username);
      return sessionResponse(ip, owner.userId);
    } catch (e: any) {
      recordLoginAttempt(ip, false);
      auditLog("login_passkey_failed", e?.message || null, ip, null);
      return json({ error: e?.message || "Passkey sign-in failed" }, 401);
    }
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
    const who = authed ? getSessionUser(token) : null;
    // Passkeys are hostname-scoped, so both flags are answered for the host
    // this request arrived on: `passkey_supported` is whether WebAuthn can run
    // here at all (HTTPS/localhost), `passkey_enabled` whether any account has
    // one enrolled for this host (that's what the anonymous login screen needs).
    const rp = getRpContext(req);
    return json({
      authenticated: authed && !!who,
      setup: isSetup(),
      csrf_token: csrf,
      is_super_admin: !!who && who.isAdmin,
      is_admin: !!who && who.isAdmin,
      username: who?.username ?? null,
      totp_enabled: who ? isTotpEnabled(who.userId) : false,
      passkey_supported: rp !== null,
      passkey_enabled: rp !== null && hasCredentialsForRp(rp.rpId),
      rp_id: rp?.rpId ?? null,
    });
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

  // --- Authorization: resolve the account and gate access ---
  // Administrators see everything. Site users may only touch their assigned
  // sites and are blocked from platform-wide surfaces.
  const principal: Principal | null = getSessionUser(sessionToken);
  if (!principal) return unauthorized(); // account deleted while session alive
  const isSuper = principal.isAdmin;
  const actor = principal.username;
  const allowedSlugs: Set<string> | null = isSuper ? null : new Set(getUserSiteSlugs(principal.userId));
  const canSite = (slug: string) => isSuper || allowedSlugs!.has(slug);
  const forbidden = () => json({ error: "Forbidden" }, 403);
  const audit = (action: string, detail: string | null) => auditLog(action, detail, ip, actor);

  if (!isSuper) {
    // 1) Platform-only surfaces — administrator required. Account self-service
    //    (change-password, totp/*, webauthn/*) is deliberately NOT here: every
    //    account manages its own credentials.
    const isPlatformPath =
      path.startsWith("/_admin/api/settings/") ||
      path.startsWith("/_admin/api/mcp/") ||
      path.startsWith("/_admin/api/oauth/") ||
      path === "/_admin/api/audit" ||
      path === "/_admin/api/cleanup" ||
      path.startsWith("/_admin/api/config/") ||
      path === "/_admin/api/cms-lib" || path.startsWith("/_admin/api/cms-lib/") ||
      path === "/_admin/api/host-aliases" ||
      path === "/_admin/api/users" || path.startsWith("/_admin/api/users/") ||
      path === "/_admin/api/sites/repair" ||
      path === "/_admin/api/sites/blank" ||
      (path === "/_admin/api/sites" && req.method === "POST");
    if (isPlatformPath) return forbidden();

    // Creating/deleting whole sites is a provisioning action — administrators only.
    const siteRootDelete = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)$/);
    if (siteRootDelete && req.method === "DELETE") return forbidden();

    // 2) Per-site surfaces — must own the slug. The reserved words blank/repair
    // are handled by the platform list above; everything else is a real slug.
    const siteScoped = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)(?:\/|$)/);
    if (siteScoped) {
      const slug = siteScoped[1];
      if (slug !== "blank" && slug !== "repair" && !canSite(slug)) return forbidden();
    }
    const analyticsSite = path.match(/^\/_admin\/api\/analytics\/site\/([a-z0-9-]+)$/);
    if (analyticsSite && !canSite(analyticsSite[1])) return forbidden();
  }

  // Slugs to scope global analytics to, or null for the full (administrator) view.
  const scopeSlugs: string[] | null = isSuper ? null : Array.from(allowedSlugs!);

  // Step-up: re-verify the acting account's own password. Used before any
  // change that would give a hijacked session a durable foothold.
  const stepUp = async (password: string | undefined): Promise<Response | null> => {
    if (!password) return json({ error: "Your password is required to confirm this action" }, 400);
    if (isRateLimited(ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    if (!(await verifyPasswordForUser(principal.userId, password, ip))) {
      audit("step_up_failed", path);
      return json({ error: "Incorrect password" }, 401);
    }
    return null;
  };

  // --- Account: change own password ---
  if (path === "/_admin/api/change-password" && req.method === "POST") {
    const body = await readJsonBody<{ current?: string; password?: string }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    if (!body.current || !body.password) return json({ error: "Both current and new password required" }, 400);
    const valid = await verifyPasswordForUser(principal.userId, body.current, ip);
    if (!valid) return json({ error: "Current password is incorrect" }, 401);
    try {
      await setUserPassword(principal.userId, body.password);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
    audit("password_changed", null);
    return json({ ok: true });
  }

  // --- Account: TOTP 2FA ---
  if (path === "/_admin/api/totp/status" && req.method === "GET") {
    const enabled = isTotpEnabled(principal.userId);
    return json({
      enabled,
      recovery_codes_remaining: enabled ? getRemainingRecoveryCodes(principal.userId) : 0,
    });
  }

  if (path === "/_admin/api/totp/setup" && req.method === "POST") {
    if (isTotpEnabled(principal.userId)) return json({ error: "2FA is already enabled" }, 400);
    const { secret, uri } = generateTotpSecret(principal.username);
    setPendingTotpSecret(principal.userId, secret);
    const qrDataUrl = await getTotpQrDataUrl(uri);
    return json({ secret, qr: qrDataUrl });
  }

  if (path === "/_admin/api/totp/confirm" && req.method === "POST") {
    const body = await readJsonBodyOrEmpty<{ code?: string }>(req);
    if (!body.code) return json({ error: "Verification code required" }, 400);

    const pendingSecret = getPendingTotpSecret(principal.userId);
    if (!pendingSecret) return json({ error: "No pending 2FA setup. Start setup first." }, 400);

    if (!verifyTotpCode(pendingSecret, body.code.trim())) {
      return json({ error: "Invalid code. Check your authenticator app and try again." }, 400);
    }

    const recoveryCodes = generateRecoveryCodes();
    enableTotp(principal.userId, pendingSecret, recoveryCodes);
    clearPendingTotpSecret(principal.userId);
    audit("totp_enabled", null);

    return json({ ok: true, recovery_codes: recoveryCodes });
  }

  if (path === "/_admin/api/totp/disable" && req.method === "POST") {
    const body = await readJsonBodyOrEmpty<{ password?: string }>(req);
    const denied = await stepUp(body.password);
    if (denied) return denied;
    disableTotp(principal.userId);
    audit("totp_disabled", null);
    return json({ ok: true });
  }

  if (path === "/_admin/api/totp/recovery-codes" && req.method === "POST") {
    const body = await readJsonBodyOrEmpty<{ password?: string }>(req);
    const denied = await stepUp(body.password);
    if (denied) return denied;
    if (!isTotpEnabled(principal.userId)) return json({ error: "2FA is not enabled" }, 400);

    const secret = getTotpSecret(principal.userId)!;
    const recoveryCodes = generateRecoveryCodes();
    enableTotp(principal.userId, secret, recoveryCodes);
    audit("totp_recovery_codes_regenerated", null);

    return json({ recovery_codes: recoveryCodes });
  }

  // --- Account: passkeys ---
  //
  // Enrolling or removing a passkey re-checks the password, matching the bar
  // set by TOTP disable / recovery-code regeneration: a hijacked session must
  // not be able to mint itself a durable second way in.
  if (path === "/_admin/api/webauthn/credentials" && req.method === "GET") {
    const rp = getRpContext(req);
    return json({
      supported: rp !== null,
      rp_id: rp?.rpId ?? null,
      credentials: listCredentials(principal.userId).map(c => ({
        id: c.id,
        label: c.label,
        rp_id: c.rp_id,
        created_at: c.created_at,
        last_used: c.last_used,
        current_host: rp !== null && c.rp_id === rp.rpId,
      })),
    });
  }

  if (path === "/_admin/api/webauthn/register/options" && req.method === "POST") {
    const rp = getRpContext(req);
    if (!rp) return json({ error: "Passkeys require HTTPS (or localhost)" }, 400);
    const body = await readJsonBodyOrEmpty<{ password?: string }>(req);
    const denied = await stepUp(body.password);
    if (denied) return denied;
    try {
      return json(await beginRegistration(rp, ip, principal.userId));
    } catch (e: any) {
      return json({ error: e?.message || "Could not start passkey registration" }, 400);
    }
  }

  if (path === "/_admin/api/webauthn/register/verify" && req.method === "POST") {
    const rp = getRpContext(req);
    if (!rp) return json({ error: "Passkeys require HTTPS (or localhost)" }, 400);
    const body = await readJsonBodyOrEmpty<{ response?: any; label?: string }>(req);
    if (!body.response) return json({ error: "Passkey response required" }, 400);
    try {
      const credential = await finishRegistration(rp, ip, body.response, body.label, principal.userId);
      audit("passkey_added", `${credential.label} (${credential.rp_id})`);
      return json({ ok: true, credential: { id: credential.id, label: credential.label, rp_id: credential.rp_id } });
    } catch (e: any) {
      return json({ error: e?.message || "Passkey registration failed" }, 400);
    }
  }

  const passkeyDelete = path.match(/^\/_admin\/api\/webauthn\/credentials\/(\d+)$/);
  if (passkeyDelete && req.method === "DELETE") {
    const body = await readJsonBodyOrEmpty<{ password?: string }>(req);
    const denied = await stepUp(body.password);
    if (denied) return denied;
    const removed = deleteCredential(parseInt(passkeyDelete[1]), principal.userId);
    if (!removed) return json({ error: "Passkey not found" }, 404);
    audit("passkey_removed", `id:${passkeyDelete[1]}`);
    return json({ ok: true });
  }

  // --- Sites CRUD ---
  if (path === "/_admin/api/sites" && req.method === "GET") {
    const sites = listSites()
      .filter(s => isSuper || allowedSlugs!.has(s.slug))
      .map(s => {
        const health = checkSiteHealth(s.slug);
        return {
          ...s,
          aliases: getAliases(s.slug),
          host_aliases: getHostAliases(s.slug),
          health: health.status,
          health_detail: health.status === "ok" ? null : health.detail,
        };
      });
    return json({ sites });
  }

  if (path === "/_admin/api/sites" && req.method === "POST") {
    let formData: FormData;
    try { formData = await req.formData(); }
    catch { return json({ error: "Invalid multipart body" }, 400); }
    const slug = (formData.get("slug") as string)?.toLowerCase().trim();
    const name = (formData.get("name") as string)?.trim() || slug;
    const label = (formData.get("label") as string)?.trim() || undefined;
    const notes = (formData.get("notes") as string) || undefined;
    const file = formData.get("file") as File;

    if (!slug) return json({ error: "Slug is required" }, 400);
    if (!file || !file.name.endsWith(".zip")) return json({ error: "ZIP file is required" }, 400);

    try {
      const existed = !!getSite(slug);
      const result = await deploySite(slug, name, await file.arrayBuffer(), label, notes);
      audit(existed ? "site_updated" : "site_created", `${slug} -> ${result.version.version}${notes ? " (with notes)" : ""}`);
      return json(result);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Create blank site (no ZIP — AI tools populate via MCP) ---
  if (path === "/_admin/api/sites/blank" && req.method === "POST") {
    const body = await readJsonBodyOrEmpty<{ slug?: string; name?: string }>(req);
    const slug = body.slug?.toLowerCase().trim();
    const name = body.name?.trim() || slug;
    if (!slug) return json({ error: "Slug is required" }, 400);
    try {
      const result = createBlankSite(slug, name!);
      audit("site_created_blank", slug);
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
      const host_aliases = getHostAliases(slug);
      return json({ site, versions, aliases, host_aliases });
    }
    if (req.method === "DELETE") {
      const ok = deleteSite(slug);
      if (ok) audit("site_deleted", slug);
      return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
    }
  }

  // --- Toggle active/inactive ---
  const toggleMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/(enable|disable)$/);
  if (toggleMatch && req.method === "POST") {
    const [, slug, action] = toggleMatch;
    const ok = toggleSite(slug, action === "enable");
    if (ok) audit(action === "enable" ? "site_enabled" : "site_disabled", slug);
    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }

  // --- Pin/unpin (sorts to top of site listings, shared across admins) ---
  const pinMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/(pin|unpin)$/);
  if (pinMatch && req.method === "POST") {
    const [, slug, action] = pinMatch;
    const ok = setSitePinned(slug, action === "pin");
    if (ok) audit(action === "pin" ? "site_pinned" : "site_unpinned", slug);
    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }

  // --- Site settings (root_dir, SPA, MCP, CMS, display name) ---
  const settingsMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/settings$/);
  if (settingsMatch && req.method === "POST") {
    const slug = settingsMatch[1];
    const body = await readJsonBody<{ name?: string; root_dir?: string | null; spa?: boolean; mcp_enabled?: boolean; mcp_read_only?: boolean; mcp_auto_commit?: boolean; cms_enabled?: boolean }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    try {
      // Rename the display name if a (changed) name was provided.
      if (typeof body.name === "string" && body.name.trim()) {
        const site = getSite(slug);
        if (site && body.name.trim() !== site.name) {
          renameSite(slug, body.name);
          audit("site_renamed", `${slug} -> ${body.name.trim()}`);
        }
      }
      const ok = updateSiteSettings(slug, body.root_dir ?? null, body.spa ?? false, body.mcp_enabled, body.mcp_read_only, body.mcp_auto_commit, body.cms_enabled);
      if (ok) audit("site_settings_updated", slug);
      return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- CMS status / init / upgrade-lib ---
  const cmsStatusMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/cms\/status$/);
  if (cmsStatusMatch && req.method === "GET") {
    const slug = cmsStatusMatch[1];
    if (!getSite(slug)) return json({ error: "Not found" }, 404);
    return json(getCmsStatus(slug));
  }
  const cmsInitMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/cms\/init$/);
  if (cmsInitMatch && req.method === "POST") {
    const slug = cmsInitMatch[1];
    try {
      const result = cmsInit(slug);
      audit("cms_initialized", `${slug} (${result.scaffolded_files.length} files)`);
      return json({ ok: true, ...result, status: getCmsStatus(slug) });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }
  // --- Global CMS library (editable JS + CSS shared by every CMS-enabled site) ---
  if (path === "/_admin/api/cms-lib" && req.method === "GET") {
    // Strip the content from the list endpoint — it can be large and the index
    // view doesn't need it. /cms-lib/:path returns content.
    const files = listCmsLibFiles().map(f => ({
      path: f.path, version: f.version, etag: f.etag,
      updated_at: f.updated_at, size: f.size,
    }));
    return json({ files });
  }
  const cmsLibFileMatch = path.match(/^\/_admin\/api\/cms-lib\/([a-z0-9._-]+)$/);
  if (cmsLibFileMatch && req.method === "GET") {
    const file = getCmsLibFile(cmsLibFileMatch[1]);
    if (!file) return json({ error: "Not found" }, 404);
    return json(file);
  }
  if (cmsLibFileMatch && req.method === "PUT") {
    const filePath = cmsLibFileMatch[1];
    const body = await readJsonBody<{ content?: string; version?: string }>(req);
    if (!body || typeof body.content !== "string") {
      return json({ error: "content is required" }, 400);
    }
    try {
      const file = updateCmsLibFile(filePath, body.content, body.version);
      audit("cms_lib_updated", `${filePath} -> v${file.version} (${file.size} bytes)`);
      return json(file);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }
  if (path === "/_admin/api/cms-lib/reset" && req.method === "POST") {
    const body = await readJsonBodyOrEmpty<{ path?: string }>(req);
    try {
      const updated = resetCmsLibFile(body.path);
      audit("cms_lib_reset", body.path || "all");
      return json({ files: updated });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Commit current working version (freeze + fork new mutable copy) ---
  const commitMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/commit$/);
  if (commitMatch && req.method === "POST") {
    const slug = commitMatch[1];
    const body = await readJsonBodyOrEmpty<{ label?: string; notes?: string }>(req);
    try {
      const result = commitVersion(slug, body.label || null, body.notes || null);
      if (!result) return json({ error: "Site not found or has no current version" }, 404);
      audit("version_committed", `${slug} -> ${result.version}${body.label ? ` (${body.label})` : ""}${body.notes ? " (with notes)" : ""}`);
      return json({ ok: true, version: result });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Site file listing (root_dir-relative; includes directories) ---
  const filesMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/files$/);
  if (filesMatch && req.method === "GET") {
    const slug = filesMatch[1];
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);
    const tree = listSiteTree(slug);
    return json({
      files: tree.files, dirs: tree.dirs,
      version: site.current_version, root_dir: site.root_dir,
      auto_snapshot: !!site.mcp_auto_commit,
    });
  }

  // --- File management: delete / rename / copy / mkdir ---
  //
  // All four operate on the current version's content directory with the same
  // containment rules as upload (see sites.ts). Every call is audit-logged with
  // the acting account, and honors the site's auto-snapshot setting.
  const fileOpMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/files\/(delete|rename|copy|mkdir)$/);
  if (fileOpMatch && req.method === "POST") {
    const [, slug, op] = fileOpMatch;
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);
    const body = await readJsonBody<{ paths?: unknown; from?: unknown; to?: unknown; replace?: unknown; path?: unknown }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    try {
      if (op === "delete") {
        const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
        if (!paths.length) return json({ error: "paths is required" }, 400);
        const result = deleteSitePaths(slug, paths);
        const okPaths = result.results.filter(r => r.ok).map(r => r.path);
        audit("files_deleted", `${slug}: ${okPaths.length} item(s) — ${okPaths.slice(0, 20).join(", ")}${okPaths.length > 20 ? ", …" : ""}`);
        return json({ ok: result.results.every(r => r.ok), ...result });
      }
      if (op === "mkdir") {
        if (typeof body.path !== "string") return json({ error: "path is required" }, 400);
        const result = createSiteDirectory(slug, body.path);
        if (result.created) audit("directory_created", `${slug}:${result.path}`);
        return json({ ok: true, ...result });
      }
      if (typeof body.from !== "string" || typeof body.to !== "string") {
        return json({ error: "from and to are required" }, 400);
      }
      const replace = body.replace === true;
      if (op === "rename") {
        const result = renameSitePath(slug, body.from, body.to, { replace });
        audit("file_renamed", `${slug}: ${result.from} -> ${result.to}${result.replaced ? " (replaced)" : ""}`);
        return json({ ok: true, ...result });
      }
      const result = copySitePath(slug, body.from, body.to, { replace });
      audit("file_copied", `${slug}: ${result.from} -> ${result.to}${result.replaced ? " (replaced)" : ""}`);
      return json({ ok: true, ...result });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Download the current version as a ZIP (only the active version) ---
  const downloadMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/download$/);
  if (downloadMatch && req.method === "GET") {
    const slug = downloadMatch[1];
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);
    if (!site.current_version) return json({ error: "Site has no current version" }, 400);
    try {
      const result = await zipCurrentVersion(slug);
      if (!result) return json({ error: "Nothing to download" }, 404);
      audit("site_downloaded", `${slug} (${site.current_version})`);
      return new Response(result.buffer, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Content-Length": String(result.buffer.length),
        },
      });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // --- Site reload (clear caches, recalculate from disk) ---
  const reloadMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/reload$/);
  if (reloadMatch && req.method === "POST") {
    const slug = reloadMatch[1];
    const ok = reloadSite(slug);
    if (ok) audit("site_reloaded", slug);
    return ok ? json({ ok: true }) : json({ error: "Not found or no active version" }, 404);
  }

  // --- Upload a single file into a site (admin) ---
  // multipart fields: file (required), path (optional dest path), replace ("true"/"false")
  // If `path` is empty or ends with "/", the uploaded file's own name is appended.
  const uploadFileMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/upload-file$/);
  if (uploadFileMatch && req.method === "POST") {
    const slug = uploadFileMatch[1];
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);

    // Cap single-file uploads to prevent an admin (or hijacked session) from
    // filling the host disk via one POST. Full-site ZIP deploys use a separate
    // endpoint and code path.
    const MAX_UPLOAD_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
    const declared = parseInt(req.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_UPLOAD_FILE_SIZE) {
      return json({ error: `Upload exceeds ${MAX_UPLOAD_FILE_SIZE / (1024 * 1024)} MB limit` }, 413);
    }

    let formData: FormData;
    try { formData = await req.formData(); }
    catch { return json({ error: "Invalid multipart body" }, 400); }

    const file = formData.get("file");
    if (!file || !(file instanceof File)) return json({ error: "File is required" }, 400);
    if (file.size > MAX_UPLOAD_FILE_SIZE) {
      return json({ error: `File exceeds ${MAX_UPLOAD_FILE_SIZE / (1024 * 1024)} MB limit` }, 413);
    }

    const rawPath = ((formData.get("path") as string) || "").trim();
    const replace = (formData.get("replace") as string) === "true";

    // If no path or trailing slash, append the original filename
    let destPath = rawPath;
    if (!destPath || destPath.endsWith("/")) {
      destPath = destPath + (file.name || "upload.bin");
    }

    try {
      const result = uploadFileToSite(slug, destPath, await file.arrayBuffer(), { replace });
      audit("file_uploaded", `${slug}:${result.path}${result.replaced ? " (replaced)" : ""}`);
      return json({ ok: true, ...result });
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
    const body = await readJsonBodyOrEmpty<{ alias?: string }>(req);
    const alias = body.alias?.toLowerCase().trim();
    if (!alias) return json({ error: "Alias is required" }, 400);
    try {
      addAlias(alias, slug);
      audit("alias_added", `${alias} -> ${slug}`);
      return json({ ok: true, aliases: getAliases(slug) });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  const aliasDeleteMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/aliases\/([a-z0-9-]+)$/);
  if (aliasDeleteMatch && req.method === "DELETE") {
    const [, slug, alias] = aliasDeleteMatch;
    const ok = removeAlias(alias, slug);
    if (ok) audit("alias_removed", `${alias} -> ${slug}`);
    return ok ? json({ ok: true, aliases: getAliases(slug) }) : json({ error: "Alias not found" }, 404);
  }

  // --- Host aliases (custom domain -> site slug) ---
  if (path === "/_admin/api/host-aliases" && req.method === "GET") {
    return json({ host_aliases: listAllHostAliases() });
  }

  const hostAliasMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/host-aliases$/);
  if (hostAliasMatch && req.method === "GET") {
    const slug = hostAliasMatch[1];
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);
    return json({ host_aliases: getHostAliases(slug) });
  }
  if (hostAliasMatch && req.method === "POST") {
    const slug = hostAliasMatch[1];
    const site = getSite(slug);
    if (!site) return json({ error: "Not found" }, 404);
    const body = await readJsonBodyOrEmpty<{ host?: string }>(req);
    const host = body.host?.trim();
    if (!host) return json({ error: "Host is required" }, 400);
    try {
      const normalized = addHostAlias(host, slug);
      audit("host_alias_added", `${normalized} -> ${slug}`);
      return json({ ok: true, host_aliases: getHostAliases(slug) });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // Host segments contain dots, so the param regex is more permissive than slug-only routes.
  const hostAliasDeleteMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/host-aliases\/([a-z0-9.\-]+)$/);
  if (hostAliasDeleteMatch && req.method === "DELETE") {
    const [, slug, host] = hostAliasDeleteMatch;
    const ok = removeHostAlias(decodeURIComponent(host), slug);
    if (ok) audit("host_alias_removed", `${host} -> ${slug}`);
    return ok ? json({ ok: true, host_aliases: getHostAliases(slug) }) : json({ error: "Host alias not found" }, 404);
  }

  // --- Version management ---
  const versionSwitchMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/versions\/(\d+)\/activate$/);
  if (versionSwitchMatch && req.method === "POST") {
    const [, slug, version] = versionSwitchMatch;
    const ok = switchVersion(slug, version);
    if (ok) audit("version_activated", `${slug} -> ${version}`);
    return ok ? json({ ok: true }) : json({ error: "Version not found" }, 404);
  }

  // Edit a version's label and/or release notes. Fields left out are untouched;
  // an empty string clears the field.
  const versionMetaMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/versions\/(\d+)\/meta$/);
  if (versionMetaMatch && req.method === "POST") {
    const [, slug, version] = versionMetaMatch;
    const body = await readJsonBody<{ label?: string | null; notes?: string | null }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    const meta: { label?: string | null; notes?: string | null } = {};
    if ("label" in body) meta.label = body.label == null ? null : String(body.label);
    if ("notes" in body) meta.notes = body.notes == null ? null : String(body.notes);
    if (!("label" in meta) && !("notes" in meta)) return json({ error: "Nothing to update" }, 400);
    try {
      const updated = setVersionMeta(slug, version, meta);
      if (!updated) return json({ error: "Version not found" }, 404);
      audit("version_notes_updated", `${slug} ${version}`);
      return json({ ok: true, version: updated });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  const versionDeleteMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9-]+)\/versions\/(\d+)$/);
  if (versionDeleteMatch && req.method === "DELETE") {
    const [, slug, version] = versionDeleteMatch;
    try {
      const ok = deleteVersion(slug, version);
      if (ok) audit("version_deleted", `${slug} ${version}`);
      return ok ? json({ ok: true }) : json({ error: "Version not found" }, 404);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Analytics ---
  // Site users see only their sites' data (scopeSlugs); administrators (null) see all.
  if (path === "/_admin/api/analytics/overview") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getOverviewStats(hours, scopeSlugs));
  }

  if (path === "/_admin/api/analytics/top-sites") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTopSites(hours, 10, scopeSlugs));
  }

  if (path === "/_admin/api/analytics/top-paths") {
    const url = new URL(req.url);
    const hours = clampInt(url.searchParams.get("hours"), 24, 1, 8760);
    const site = url.searchParams.get("site") || null;
    // A scoped user may only query a site they own; without a site they get nothing
    // (top-paths can't aggregate across multiple sites).
    if (!isSuper) {
      if (site && !canSite(site)) return forbidden();
      if (!site) return json([]);
    }
    return json(getTopPaths(site, hours));
  }

  if (path === "/_admin/api/analytics/traffic") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTrafficOverTime(hours, scopeSlugs));
  }

  if (path === "/_admin/api/analytics/bandwidth") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getBandwidthOverTime(hours, scopeSlugs));
  }

  if (path === "/_admin/api/analytics/countries") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTopCountries(hours, 15, scopeSlugs));
  }

  if (path === "/_admin/api/analytics/browsers") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getTopBrowsers(hours, 10, scopeSlugs));
  }

  if (path === "/_admin/api/analytics/status-codes") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getStatusCodeBreakdown(hours, scopeSlugs));
  }

  if (path === "/_admin/api/analytics/blocked") {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getBlockedRequests(hours, 10, scopeSlugs));
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
    return json(getRecentRequests(limit, filters, scopeSlugs));
  }

  const siteStatsMatch = path.match(/^\/_admin\/api\/analytics\/site\/([a-z0-9-]+)$/);
  if (siteStatsMatch) {
    const hours = clampInt(new URL(req.url).searchParams.get("hours"), 24, 1, 8760);
    return json(getSiteStats(siteStatsMatch[1], hours));
  }

  // --- Country restriction settings ---
  // The full code→name list drives the admin picker; the same list validates
  // what gets saved, so a typo can't silently block the whole world.
  if (path === "/_admin/api/settings/countries/list" && req.method === "GET") {
    return json({ countries: listCountries() });
  }
  if (path === "/_admin/api/settings/countries" && req.method === "GET") {
    return json({ countries: getAllowedCountries() });
  }
  if (path === "/_admin/api/settings/countries" && req.method === "POST") {
    const body = await readJsonBody<{ countries?: string[] }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    try {
      setAllowedCountries(body.countries || []);
      const saved = getAllowedCountries();
      audit("countries_updated", saved.length ? saved.join(",") : "all allowed");
      return json({ ok: true, countries: saved });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Auto-block settings ---
  if (path === "/_admin/api/settings/autoblock" && req.method === "GET") {
    return json(getAutoBlockConfig());
  }
  if (path === "/_admin/api/settings/autoblock" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object") return json({ error: "Invalid request body" }, 400);
    const updated = setAutoBlockConfig(body);
    audit("autoblock_updated", JSON.stringify(updated));
    return json({ ok: true, config: updated });
  }

  // --- Blocked IPs management ---
  if (path === "/_admin/api/settings/blocked-ips" && req.method === "GET") {
    return json({ ips: getBlockedIps() });
  }
  const unblockMatch = path.match(/^\/_admin\/api\/settings\/blocked-ips\/(\d+)$/);
  if (unblockMatch && req.method === "DELETE") {
    unblockIp(parseInt(unblockMatch[1]));
    audit("ip_unblocked", `id:${unblockMatch[1]}`);
    return json({ ok: true });
  }

  // --- MCP token management ---
  if (path === "/_admin/api/mcp/tokens" && req.method === "GET") {
    return json({ tokens: listMcpTokens() });
  }
  if (path === "/_admin/api/mcp/tokens" && req.method === "POST") {
    const body = await readJsonBodyOrEmpty<{ label?: string; site_slug?: string; expires_in_days?: number }>(req);
    const label = body.label?.trim();
    if (!label) return json({ error: "Label is required" }, 400);
    const token = createMcpToken(label, body.site_slug || null, body.expires_in_days || null);
    audit("mcp_token_created", `${label}${body.site_slug ? ` (${body.site_slug})` : ""}`);
    return json({ token });
  }
  const mcpTokenDeleteMatch = path.match(/^\/_admin\/api\/mcp\/tokens\/(\d+)$/);
  if (mcpTokenDeleteMatch && req.method === "DELETE") {
    const id = parseInt(mcpTokenDeleteMatch[1]);
    const ok = deleteMcpToken(id);
    if (ok) audit("mcp_token_revoked", `id:${id}`);
    return ok ? json({ ok: true }) : json({ error: "Token not found" }, 404);
  }

  // --- MCP audit log ---
  if (path === "/_admin/api/mcp/audit" && req.method === "GET") {
    const limit = clampInt(new URL(req.url).searchParams.get("limit"), 50, 1, 500);
    return json({ entries: getMcpAuditLog(limit) });
  }

  // --- OAuth grants (active access tokens issued via OAuth) ---
  if (path === "/_admin/api/oauth/grants" && req.method === "GET") {
    return json({ grants: listOauthGrants() });
  }
  const oauthGrantDeleteMatch = path.match(/^\/_admin\/api\/oauth\/grants\/(\d+)$/);
  if (oauthGrantDeleteMatch && req.method === "DELETE") {
    const id = parseInt(oauthGrantDeleteMatch[1]);
    const ok = revokeOauthGrant(id);
    if (ok) audit("oauth_grant_revoked", `grant ${id}`);
    return ok ? json({ ok: true }) : json({ error: "Grant not found" }, 404);
  }

  // --- Per-site delegate credentials (used at the OAuth consent screen) ---
  const siteDelegateMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9][a-z0-9-]*)\/delegates$/);
  if (siteDelegateMatch && req.method === "GET") {
    return json({ delegates: listSiteDelegates(siteDelegateMatch[1]) });
  }
  if (siteDelegateMatch && req.method === "POST") {
    const slug = siteDelegateMatch[1];
    const body = await readJsonBodyOrEmpty<{ label?: string; password?: string; expires_in_days?: number | null }>(req);
    try {
      const result = await createSiteDelegate({
        siteSlug: slug,
        label: body.label || "",
        password: body.password || "",
        expiresInDays: body.expires_in_days ?? null,
      });
      audit("site_delegate_created", `${slug}/${body.label}`);
      return json({ ok: true, id: result.id });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }
  const siteDelegateDeleteMatch = path.match(/^\/_admin\/api\/sites\/([a-z0-9][a-z0-9-]*)\/delegates\/(\d+)$/);
  if (siteDelegateDeleteMatch && req.method === "DELETE") {
    const slug = siteDelegateDeleteMatch[1];
    const id = parseInt(siteDelegateDeleteMatch[2]);
    const ok = deleteSiteDelegate(slug, id);
    if (ok) audit("site_delegate_deleted", `${slug}/${id}`);
    return ok ? json({ ok: true }) : json({ error: "Delegate not found" }, 404);
  }

  // --- OAuth registered clients ---
  if (path === "/_admin/api/oauth/clients" && req.method === "GET") {
    return json({ clients: listOauthClients() });
  }
  const oauthClientDeleteMatch = path.match(/^\/_admin\/api\/oauth\/clients\/([a-f0-9]+)$/);
  if (oauthClientDeleteMatch && req.method === "DELETE") {
    const ok = deleteOauthClient(oauthClientDeleteMatch[1]);
    if (ok) audit("oauth_client_deleted", oauthClientDeleteMatch[1]);
    return ok ? json({ ok: true }) : json({ error: "Client not found" }, 404);
  }

  // --- Audit log ---
  if (path === "/_admin/api/audit" && req.method === "GET") {
    const limit = clampInt(new URL(req.url).searchParams.get("limit"), 50, 1, 500);
    return json({ entries: getAuditLog(limit) });
  }

  // --- User management (administrators only; gated above) ---
  //
  // Anything that touches an administrator account — creating one, granting or
  // revoking admin rights, resetting an admin's password, or disabling an
  // admin's 2FA/passkeys — requires the acting admin's own password
  // (`confirm_password`). Otherwise a briefly hijacked admin session could
  // mint or take over a peer account and keep access after the session dies.
  // Changes to plain site users don't carry that risk and need no step-up.
  if (path === "/_admin/api/users" && req.method === "GET") {
    return json({ users: listAdminUsers() });
  }
  if (path === "/_admin/api/users" && req.method === "POST") {
    const body = await readJsonBodyOrEmpty<{ username?: string; password?: string; sites?: string[]; is_admin?: boolean; confirm_password?: string }>(req);
    const makeAdmin = body.is_admin === true;
    if (makeAdmin) {
      const denied = await stepUp(body.confirm_password);
      if (denied) return denied;
    }
    try {
      const id = await createAdminUser(body.username || "", body.password || "", { isAdmin: makeAdmin, sites: body.sites || [] });
      audit("admin_user_created", `${(body.username || "").toLowerCase()} (${makeAdmin ? "administrator" : `${(body.sites || []).length} sites`})`);
      return json({ ok: true, id, users: listAdminUsers() });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }
  const userMatch = path.match(/^\/_admin\/api\/users\/(\d+)$/);
  if (userMatch && req.method === "PUT") {
    const id = parseInt(userMatch[1]);
    const target = getUser(id);
    if (!target) return json({ error: "User not found" }, 404);
    const body = await readJsonBodyOrEmpty<{
      password?: string; sites?: string[]; is_admin?: boolean;
      disable_totp?: boolean; remove_passkeys?: boolean; confirm_password?: string;
    }>(req);

    const changesRole = typeof body.is_admin === "boolean" && body.is_admin !== target.isAdmin;
    if (id === principal.userId && changesRole) {
      return json({ error: "Use another administrator account to change your own role" }, 400);
    }
    // Step-up when the target is (or becomes) an administrator.
    const sensitive = target.isAdmin || body.is_admin === true;
    if (sensitive) {
      const denied = await stepUp(body.confirm_password);
      if (denied) return denied;
    }
    try {
      const opts: { password?: string; sites?: string[]; isAdmin?: boolean } = {};
      if (typeof body.password === "string" && body.password.length) opts.password = body.password;
      if (Array.isArray(body.sites)) opts.sites = body.sites;
      if (typeof body.is_admin === "boolean") opts.isAdmin = body.is_admin;
      const ok = await updateAdminUser(id, opts);
      if (!ok) return json({ error: "User not found" }, 404);
      const changed: string[] = [];
      if (opts.password) { destroySessionsForUser(id); changed.push("password reset"); }
      if (opts.sites) changed.push(`${opts.sites.length} sites`);
      if (changesRole) changed.push(body.is_admin ? "promoted to administrator" : "demoted to site user");
      if (body.disable_totp === true) { disableTotp(id); changed.push("2FA disabled"); }
      if (body.remove_passkeys === true) {
        for (const c of listCredentials(id)) deleteCredential(c.id, id);
        changed.push("passkeys removed");
      }
      audit("admin_user_updated", `${target.username}: ${changed.join(", ") || "no changes"}`);
      return json({ ok: true, users: listAdminUsers() });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }
  if (userMatch && req.method === "DELETE") {
    const id = parseInt(userMatch[1]);
    const target = getUser(id);
    if (!target) return json({ error: "User not found" }, 404);
    if (id === principal.userId) return json({ error: "You cannot delete your own account" }, 400);
    if (target.isAdmin) {
      const body = await readJsonBodyOrEmpty<{ confirm_password?: string }>(req);
      const denied = await stepUp(body.confirm_password);
      if (denied) return denied;
    }
    try {
      const ok = deleteAdminUser(id);
      if (ok) audit("admin_user_deleted", target.username);
      return ok ? json({ ok: true, users: listAdminUsers() }) : json({ error: "User not found" }, 404);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Session cleanup ---
  if (path === "/_admin/api/cleanup" && req.method === "POST") {
    cleanExpiredSessions();
    cleanExpiredPending2fa();
    return json({ ok: true });
  }

  // --- Configuration backup/restore ---
  if (path === "/_admin/api/config/export" && req.method === "POST") {
    try {
      const body = await readJsonBodyOrEmpty<{ password?: string; all_versions?: boolean }>(req);
      const buffer = await createBackup(body.password || undefined, !!body.all_versions);
      audit("config_exported", body.password ? "encrypted" : "unencrypted");
      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="hoster-backup-${new Date().toISOString().slice(0, 10)}.hoster"`,
          "Content-Length": String(buffer.length),
        },
      });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/_admin/api/config/preview" && req.method === "POST") {
    try {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      const password = (formData.get("password") as string) || undefined;
      if (!file) return json({ error: "Backup file is required" }, 400);
      const buffer = Buffer.from(await file.arrayBuffer());
      const manifest = await previewBackup(buffer, password);
      return json({ manifest });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  if (path === "/_admin/api/config/import" && req.method === "POST") {
    try {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      const password = (formData.get("password") as string) || undefined;
      const adminPassword = (formData.get("admin_password") as string) || "";
      const confirm = formData.get("confirm") as string;
      if (!file) return json({ error: "Backup file is required" }, 400);
      if (confirm !== "yes") return json({ error: "Confirmation required" }, 400);

      // Restoring a backup replaces every account, password hash, and TOTP
      // secret — equivalent privilege to taking over the platform. Require the
      // acting admin's password as a step-up so a brief session compromise
      // can't do it.
      if (!adminPassword) {
        return json({ error: "Your password is required to import a backup" }, 400);
      }
      const denied = await stepUp(adminPassword);
      if (denied) {
        audit("config_import_denied", "wrong password");
        return denied;
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const manifest = await restoreBackup(buffer, password);
      // Restore replaces every account — invalidate every session including
      // this one so a stale cookie in another tab can't keep using the (now
      // possibly different) credentials.
      destroyAllSessions();
      const auditDetail = `${manifest.site_count} sites restored, ` +
        `${manifest.repaired.length} _current symlink(s) rebuilt, ` +
        `${manifest.warnings.length} warning(s)`;
      audit("config_imported", auditDetail);
      return json({ ok: true, manifest });
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // --- Manual repair: walk every site and (re)create _current from DB ---
  // Same logic that runs at startup and after restore; exposed so an admin
  // can fix a broken site without restarting the server.
  if (path === "/_admin/api/sites/repair" && req.method === "POST") {
    const result = rebuildCurrentSymlinks();
    if (result.repaired.length > 0 || result.warnings.length > 0) {
      audit("sites_repaired", `repaired ${result.repaired.length}, ${result.warnings.length} warning(s)`);
    }
    return json({ ok: true, ...result });
  }

  return null;
}
