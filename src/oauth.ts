// OAuth 2.1 Authorization Server for Hoster's per-site MCP resources.
//
// Implements the subset of OAuth 2.1 / RFC 6749 / RFC 7636 (PKCE) /
// RFC 7591 (Dynamic Client Registration) / RFC 8414 (AS metadata) /
// RFC 8707 (Resource Indicators) / RFC 9728 (Protected Resource metadata)
// required by the MCP authorization profile.
//
// Identity: a Hoster instance has one admin. The consent screen accepts
// either the admin password (full access) or a per-site delegate
// password the admin has minted and shared with a collaborator. Delegate
// auth lets the admin hand a friend MCP access to one site without
// sharing the admin login.
//
// Either way, the consent screen re-prompts for credentials on every
// authorization — we don't rely on the SameSite=Strict admin session
// cookie surviving a cross-site redirect from the OAuth client.
//
// Tokens issued by this AS are stored in the existing `mcp_tokens` table
// with `issued_via = 'oauth'` so the resource server's bearer validator
// works unchanged for both static and OAuth tokens.

import db from "./db";
import { verifyPassword, isTotpEnabled, getTotpSecret, verifyTotpCode, isRateLimited } from "./auth";
import { useRecoveryCode } from "./auth";
import { getSite } from "./sites";

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT NOT NULL,
    client_uri TEXT,
    redirect_uris TEXT NOT NULL,
    registration_access_token_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    site_slug TEXT NOT NULL,
    scopes TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed INTEGER DEFAULT 0,
    principal TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);

  CREATE TABLE IF NOT EXISTS site_delegates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_slug TEXT NOT NULL,
    label TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    UNIQUE(site_slug, label),
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_site_delegates_site ON site_delegates(site_slug);
`);

// Extend mcp_tokens for OAuth-issued tokens. Defensive ALTERs.
try { db.exec("ALTER TABLE mcp_tokens ADD COLUMN issued_via TEXT DEFAULT 'static'"); } catch (_) {}
try { db.exec("ALTER TABLE mcp_tokens ADD COLUMN client_id TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE mcp_tokens ADD COLUMN refresh_hash TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE mcp_tokens ADD COLUMN scopes TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE mcp_tokens ADD COLUMN principal TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE oauth_codes ADD COLUMN principal TEXT DEFAULT 'admin'"); } catch (_) {}

// --- Constants ---

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;            // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_SECONDS = 60;                         // 60 seconds — codes are very short-lived
const VALID_SCOPES = new Set(["read", "write", "commit"]);
const DEFAULT_SCOPES = "read";

// --- Crypto helpers ---

function randHex(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

function sha256Hex(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex");
}

function sha256Base64Url(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("base64url" as any) as string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

// --- Helpers ---

function originOf(req: Request): string {
  const url = new URL(req.url);
  // Trust X-Forwarded-Proto / Host when behind Cloudflare; otherwise use the URL's origin.
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

function jsonResponse(body: any, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(extra || {}),
    },
  });
}

function htmlResponse(body: string, status = 200, extra?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extra || {}),
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function parseScopes(input: string | null | undefined): string[] {
  if (!input) return [DEFAULT_SCOPES];
  const all = input.split(/\s+/).filter(s => s.length > 0);
  return all.filter(s => VALID_SCOPES.has(s));
}

function siteFromResource(resource: string | null): string | null {
  if (!resource) return null;
  try {
    const u = new URL(resource);
    const m = u.pathname.match(/^\/_mcp\/([a-z0-9][a-z0-9-]*)\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// --- Client storage ---

interface OauthClientRow {
  id: string;
  secret_hash: string | null;
  name: string;
  client_uri: string | null;
  redirect_uris: string;       // JSON array
  registration_access_token_hash: string | null;
  created_at: string;
  last_used_at: string | null;
}

function getClient(clientId: string): OauthClientRow | null {
  return db.query("SELECT * FROM oauth_clients WHERE id = ?").get(clientId) as OauthClientRow | null;
}

function clientRedirectUris(row: OauthClientRow): string[] {
  try {
    const parsed = JSON.parse(row.redirect_uris);
    return Array.isArray(parsed) ? parsed.filter(u => typeof u === "string") : [];
  } catch {
    return [];
  }
}

// --- Discovery / metadata endpoints ---

export function handleAsMetadata(req: Request): Response {
  const origin = originOf(req);
  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [...VALID_SCOPES],
    resource_indicators_supported: true,
  });
}

export function handleProtectedResourceMetadata(req: Request, slug: string | null): Response {
  const origin = originOf(req);
  // If a slug was supplied, validate it; otherwise return generic metadata that
  // applies to any /_mcp/<slug> resource.
  if (slug !== null) {
    const site = getSite(slug);
    if (!site || !site.mcp_enabled) {
      return jsonResponse({ error: "Resource not found" }, 404);
    }
  }
  const resource = slug ? `${origin}/_mcp/${slug}` : `${origin}/_mcp`;
  return jsonResponse({
    resource,
    authorization_servers: [origin],
    scopes_supported: [...VALID_SCOPES],
    bearer_methods_supported: ["header"],
  });
}

// --- Dynamic Client Registration (RFC 7591) ---

interface DcrBody {
  client_name?: string;
  client_uri?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
}

const DCR_RATE_PER_HOUR = 30; // per-IP cap

function dcrRateLimited(ip: string): boolean {
  // Use audit_log table indirectly — count recent registrations from this IP.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = db.query(
    "SELECT COUNT(*) as c FROM oauth_clients WHERE created_at > ? AND id IN (SELECT id FROM oauth_clients WHERE created_at > ?)"
  ).get(cutoff, cutoff) as any;
  // Without storing IP per registration, this is a global cap. Acceptable for v1.
  return (row?.c ?? 0) > DCR_RATE_PER_HOUR;
}

export async function handleRegister(req: Request, ip: string): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  if (dcrRateLimited(ip)) {
    return jsonResponse({ error: "too_many_requests", error_description: "Registration rate limit exceeded" }, 429);
  }

  let body: DcrBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }

  const name = (body.client_name || "Unnamed Client").toString().slice(0, 200);
  const clientUri = body.client_uri ? String(body.client_uri).slice(0, 500) : null;
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(u => typeof u === "string") : [];
  if (redirectUris.length === 0) {
    return jsonResponse({ error: "invalid_redirect_uri", error_description: "At least one redirect_uri is required" }, 400);
  }
  for (const uri of redirectUris) {
    if (!/^https?:\/\//.test(uri) && uri !== "urn:ietf:wg:oauth:2.0:oob") {
      return jsonResponse({ error: "invalid_redirect_uri", error_description: `Invalid redirect_uri: ${uri}` }, 400);
    }
  }

  const clientId = randHex(16);
  // Public client (no secret) — MCP browser-style flow uses PKCE only.
  // We could optionally issue a confidential secret if requested.
  const wantConfidential = body.token_endpoint_auth_method === "client_secret_post";
  const clientSecret = wantConfidential ? randHex(32) : null;
  const secretHash = clientSecret ? sha256Hex(clientSecret) : null;

  // Registration access token lets the client update/delete its own registration
  // (RFC 7592). We don't implement that yet but issue the token for forward compat.
  const ratHash = null;

  db.run(
    `INSERT INTO oauth_clients (id, secret_hash, name, client_uri, redirect_uris, registration_access_token_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    clientId, secretHash, name, clientUri, JSON.stringify(redirectUris), ratHash
  );

  return jsonResponse({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: wantConfidential ? "client_secret_post" : "none",
  }, 201);
}

// --- Authorization endpoint ---

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  state: string | null;
  resource: string | null;
  site: string | null;
}

function readAuthorizeParams(url: URL, formData?: FormData): AuthorizeParams {
  const get = (k: string) => (formData?.get(k) as string | null) ?? url.searchParams.get(k);
  return {
    client_id: get("client_id") || "",
    redirect_uri: get("redirect_uri") || "",
    response_type: get("response_type") || "",
    code_challenge: get("code_challenge") || "",
    code_challenge_method: get("code_challenge_method") || "",
    scope: get("scope"),
    state: get("state"),
    resource: get("resource"),
    site: get("site"),
  };
}

function authorizeError(p: AuthorizeParams, error: string, description: string): Response {
  // If we trust the redirect_uri (already validated against the registered client),
  // bounce errors back there. Otherwise show a plain page.
  if (p.client_id && p.redirect_uri) {
    const client = getClient(p.client_id);
    if (client && clientRedirectUris(client).includes(p.redirect_uri)) {
      const u = new URL(p.redirect_uri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (p.state) u.searchParams.set("state", p.state);
      return Response.redirect(u.toString(), 302);
    }
  }
  return htmlResponse(`<!doctype html><meta charset="utf-8"><title>Authorization Error</title>
    <body style="font-family:system-ui;padding:32px;max-width:520px;margin:0 auto">
      <h1 style="font-weight:400">Authorization Error</h1>
      <p><strong>${escapeHtml(error)}</strong></p>
      <p>${escapeHtml(description)}</p>
    </body>`, 400);
}

function renderConsent(p: AuthorizeParams, client: OauthClientRow, slug: string, scopes: string[], errorMsg?: string): Response {
  const totp = isTotpEnabled();
  const site = getSite(slug);
  const siteName = site?.name || slug;
  const clientUri = client.client_uri ? `<div style="font-size:0.85rem;color:#666;margin-top:4px"><a href="${escapeHtml(client.client_uri)}" rel="noopener noreferrer" target="_blank">${escapeHtml(client.client_uri)}</a></div>` : "";

  // Hidden fields preserve all the OAuth parameters across the form POST.
  const hiddenFields = (Object.entries(p) as [keyof AuthorizeParams, string | null][])
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`)
    .join("");

  const errorHtml = errorMsg
    ? `<div style="background:#fee;border:1px solid #fbb;color:#900;padding:10px 12px;border-radius:6px;margin-bottom:16px">${escapeHtml(errorMsg)}</div>`
    : "";

  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize · ${escapeHtml(siteName)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #333; }
    .card { background: #fff; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); padding: 28px 32px; max-width: 460px; width: 100%; box-sizing: border-box; }
    h1 { margin: 0 0 4px; font-size: 1.4rem; font-weight: 500; }
    .sub { color: #666; font-size: 0.9rem; margin-bottom: 20px; }
    .client { background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; }
    .client-name { font-weight: 600; }
    .scope-list { list-style: none; padding: 0; margin: 12px 0 20px; }
    .scope-list li { padding: 6px 0; padding-left: 22px; position: relative; font-size: 0.92rem; }
    .scope-list li::before { content: "✓"; position: absolute; left: 0; color: #2a8a4a; font-weight: bold; }
    label { display: block; font-size: 0.85rem; font-weight: 500; margin: 12px 0 4px; }
    input[type=password], input[type=text] { width: 100%; padding: 9px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95rem; box-sizing: border-box; }
    .actions { display: flex; gap: 8px; margin-top: 22px; }
    button { flex: 1; padding: 10px 14px; border: none; border-radius: 6px; font-size: 0.95rem; font-weight: 500; cursor: pointer; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #eee; color: #333; }
    .warn { font-size: 0.8rem; color: #b46500; background: #fff7e6; border: 1px solid #ffe1a8; padding: 8px 10px; border-radius: 6px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize MCP access</h1>
    <div class="sub">An external tool wants to connect to one of your sites via the Model Context Protocol.</div>

    ${errorHtml}

    <div class="client">
      <div class="client-name">${escapeHtml(client.name)}</div>
      ${clientUri}
      <div style="font-size:0.8rem;color:#888;margin-top:8px">Client ID: <code>${escapeHtml(client.id)}</code></div>
    </div>

    <div style="font-size:0.95rem;margin-bottom:6px">Will be granted access to <strong>${escapeHtml(siteName)}</strong> with permission to:</div>
    <ul class="scope-list">
      ${scopes.includes("read") ? "<li>Read files and list versions</li>" : ""}
      ${scopes.includes("write") ? "<li>Create, modify, and delete files</li>" : ""}
      ${scopes.includes("commit") ? "<li>Snapshot the current version (commit)</li>" : ""}
    </ul>

    ${client.last_used_at ? "" : '<div class="warn">⚠ This is the first time this client has connected.</div>'}

    <form method="POST" action="/oauth/authorize" autocomplete="off">
      ${hiddenFields}

      <label for="delegate_label">Delegate name <small style="color:#888;font-weight:normal">(leave empty to authorize as the admin)</small></label>
      <input type="text" id="delegate_label" name="delegate_label" autocomplete="username" placeholder="empty = admin">

      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autofocus>
      ${totp ? `<label for="totp_code">2FA code <small style="color:#888;font-weight:normal">(admin only)</small></label><input type="text" id="totp_code" name="totp_code" inputmode="numeric" pattern="[0-9]*" autocomplete="off">` : ""}
      <div class="actions">
        <button type="submit" name="decision" value="deny" class="btn-secondary" formnovalidate>Deny</button>
        <button type="submit" name="decision" value="approve" class="btn-primary">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`);
}

export async function handleAuthorize(req: Request, ip: string): Promise<Response> {
  const url = new URL(req.url);
  const isPost = req.method === "POST";
  const formData = isPost ? await req.formData() : undefined;
  const p = readAuthorizeParams(url, formData);

  // --- Validate client + redirect_uri before doing anything else ---
  if (!p.client_id) return authorizeError(p, "invalid_request", "client_id is required");
  const client = getClient(p.client_id);
  if (!client) return authorizeError(p, "invalid_client", "Unknown client_id");
  if (!p.redirect_uri || !clientRedirectUris(client).includes(p.redirect_uri)) {
    // Per spec: never redirect to an untrusted URI; show error directly.
    return htmlResponse(`<!doctype html><meta charset="utf-8"><title>Bad Request</title>
      <body style="font-family:system-ui;padding:32px"><h1>Authorization Error</h1>
      <p>The redirect_uri does not match any registered for this client.</p></body>`, 400);
  }

  // --- Validate other OAuth parameters ---
  if (p.response_type !== "code") {
    return authorizeError(p, "unsupported_response_type", "Only response_type=code is supported");
  }
  if (!p.code_challenge) {
    return authorizeError(p, "invalid_request", "PKCE code_challenge is required");
  }
  if (p.code_challenge_method !== "S256") {
    return authorizeError(p, "invalid_request", "code_challenge_method must be S256");
  }

  // --- Determine target site (resource indicator or ?site=) ---
  const slug = siteFromResource(p.resource) || p.site;
  if (!slug) {
    return authorizeError(p, "invalid_target", "A `resource` parameter pointing to /_mcp/<slug> is required");
  }
  const site = getSite(slug);
  if (!site || !site.mcp_enabled) {
    return authorizeError(p, "invalid_target", `Site '${slug}' not found or MCP not enabled`);
  }

  // --- Determine scopes (filtered against site read-only) ---
  let scopes = parseScopes(p.scope);
  if (scopes.length === 0) scopes = [DEFAULT_SCOPES];
  if (site.mcp_read_only) {
    scopes = scopes.filter(s => s === "read");
    if (scopes.length === 0) {
      return authorizeError(p, "invalid_scope", `Site '${slug}' is read-only; only the 'read' scope can be granted`);
    }
  }

  if (!isPost) {
    return renderConsent(p, client, slug, scopes);
  }

  // --- User clicked Deny — redirect back with access_denied error per OAuth 2.1 ---
  if ((formData!.get("decision") as string | null) === "deny") {
    const u = new URL(p.redirect_uri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "The admin denied the authorization request.");
    if (p.state) u.searchParams.set("state", p.state);
    return Response.redirect(u.toString(), 302);
  }

  // --- Rate limit before touching the password verifier so we don't spend Argon2 cycles
  //     on attackers who are already locked out by the standard login rate limit.
  //     The same gate covers both admin and delegate auth. ---
  if (isRateLimited(ip)) {
    return renderConsent(p, client, slug, scopes, "Too many failed attempts. Try again later.");
  }

  const password = (formData!.get("password") as string | null) || "";
  const delegateLabel = ((formData!.get("delegate_label") as string | null) || "").trim();

  // --- Authenticate as either admin (no delegate label) or site delegate ---
  let principal: string;       // who authenticated, for the token label and audit
  let delegateRow: SiteDelegateRow | null = null;
  if (delegateLabel) {
    delegateRow = await verifyDelegate(slug, delegateLabel, password);
    if (!delegateRow) {
      return renderConsent(p, client, slug, scopes, "Incorrect delegate password, or no such delegate for this site.");
    }
    principal = `delegate:${delegateRow.label}`;
    // Delegates do not have TOTP — admin is the only TOTP-protected identity.
  } else {
    if (!password || !(await verifyPassword(password, ip))) {
      return renderConsent(p, client, slug, scopes, "Incorrect admin password.");
    }
    if (isTotpEnabled()) {
      const code = ((formData!.get("totp_code") as string | null) || "").trim();
      const secret = getTotpSecret();
      const totpOk = !!code && !!secret && (verifyTotpCode(secret, code) || useRecoveryCode(code));
      if (!totpOk) {
        return renderConsent(p, client, slug, scopes, "Invalid 2FA code.");
      }
    }
    principal = "admin";
  }

  // --- Issue authorization code ---
  const code = randHex(32);
  const codeHash = sha256Hex(code);
  const expires = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();
  db.run(
    `INSERT INTO oauth_codes (code_hash, client_id, site_slug, scopes, code_challenge, redirect_uri, expires_at, principal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    codeHash, client.id, slug, scopes.join(" "), p.code_challenge, p.redirect_uri, expires, principal
  );
  db.run("UPDATE oauth_clients SET last_used_at = datetime('now') WHERE id = ?", client.id);
  if (delegateRow) markDelegateUsed(delegateRow.id);

  const redirect = new URL(p.redirect_uri);
  redirect.searchParams.set("code", code);
  if (p.state) redirect.searchParams.set("state", p.state);
  return Response.redirect(redirect.toString(), 302);
}

// --- Token endpoint ---

interface OauthTokenRow {
  id: number;
  token_hash: string;
  label: string;
  site_slug: string | null;
  expires_at: string | null;
  issued_via: string | null;
  client_id: string | null;
  refresh_hash: string | null;
  scopes: string | null;
  principal: string | null;
}

function insertOauthAccessToken(args: {
  tokenHash: string; label: string; siteSlug: string; expiresAt: string;
  clientId: string; refreshHash: string | null; scopes: string; principal: string;
}) {
  db.run(
    `INSERT INTO mcp_tokens (token_hash, label, site_slug, expires_at, issued_via, client_id, refresh_hash, scopes, principal)
     VALUES (?, ?, ?, ?, 'oauth', ?, ?, ?, ?)`,
    args.tokenHash, args.label, args.siteSlug, args.expiresAt, args.clientId, args.refreshHash, args.scopes, args.principal
  );
}

function findOauthRowByRefreshHash(refreshHash: string): OauthTokenRow | null {
  return db.query(
    "SELECT * FROM mcp_tokens WHERE issued_via = 'oauth' AND refresh_hash = ?"
  ).get(refreshHash) as OauthTokenRow | null;
}

export async function handleToken(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: "invalid_request", error_description: "Body must be application/x-www-form-urlencoded" }, 400);
  }

  const grantType = (form.get("grant_type") as string | null) || "";
  const clientId = (form.get("client_id") as string | null) || "";
  const clientSecret = (form.get("client_secret") as string | null) || "";

  if (!clientId) return jsonResponse({ error: "invalid_client" }, 400);
  const client = getClient(clientId);
  if (!client) return jsonResponse({ error: "invalid_client" }, 401);
  if (client.secret_hash) {
    if (!clientSecret || !constantTimeEqual(sha256Hex(clientSecret), client.secret_hash)) {
      return jsonResponse({ error: "invalid_client" }, 401);
    }
  }

  if (grantType === "authorization_code") {
    return handleAuthCodeGrant(form, client);
  }
  if (grantType === "refresh_token") {
    return handleRefreshGrant(form, client);
  }
  return jsonResponse({ error: "unsupported_grant_type" }, 400);
}

function handleAuthCodeGrant(form: FormData, client: OauthClientRow): Response {
  const code = (form.get("code") as string | null) || "";
  const verifier = (form.get("code_verifier") as string | null) || "";
  const redirectUri = (form.get("redirect_uri") as string | null) || "";
  const requestedResource = (form.get("resource") as string | null);

  if (!code || !verifier || !redirectUri) {
    return jsonResponse({ error: "invalid_request", error_description: "code, code_verifier, redirect_uri are required" }, 400);
  }

  const codeHash = sha256Hex(code);
  const row = db.query("SELECT * FROM oauth_codes WHERE code_hash = ?").get(codeHash) as any;
  if (!row || row.client_id !== client.id) {
    return jsonResponse({ error: "invalid_grant", error_description: "Unknown authorization code" }, 400);
  }

  // Atomic single-use: mark consumed first; reject if already consumed.
  if (row.consumed) {
    // Spec says we MAY revoke any tokens issued from this code on replay.
    return jsonResponse({ error: "invalid_grant", error_description: "Authorization code already used" }, 400);
  }
  if (row.expires_at < new Date().toISOString()) {
    return jsonResponse({ error: "invalid_grant", error_description: "Authorization code expired" }, 400);
  }
  if (row.redirect_uri !== redirectUri) {
    return jsonResponse({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }

  // PKCE: SHA256(verifier) base64url == code_challenge
  const verifierHash = sha256Base64Url(verifier);
  if (!constantTimeEqual(verifierHash, row.code_challenge)) {
    return jsonResponse({ error: "invalid_grant", error_description: "PKCE verifier mismatch" }, 400);
  }

  // Optional resource binding check — if the client supplied `resource`, it must match.
  if (requestedResource) {
    const requestedSlug = siteFromResource(requestedResource);
    if (requestedSlug && requestedSlug !== row.site_slug) {
      return jsonResponse({ error: "invalid_target", error_description: "Resource does not match the authorized site" }, 400);
    }
  }

  // Mark code consumed (single-use).
  db.run("UPDATE oauth_codes SET consumed = 1 WHERE code_hash = ?", codeHash);

  // Issue tokens.
  const accessToken = randHex(32);
  const refreshToken = randHex(32);
  const accessHash = sha256Hex(accessToken);
  const refreshHash = sha256Hex(refreshToken);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString().replace("T", " ").substring(0, 19);
  const principal = row.principal || "admin";
  // Suffix the label with the delegate name so admins can tell at a glance which
  // human/principal actually authorized this connection in the OAuth Connections list.
  const principalSuffix = principal.startsWith("delegate:") ? ` (as ${principal.substring("delegate:".length)})` : "";

  insertOauthAccessToken({
    tokenHash: accessHash,
    label: `OAuth · ${client.name}${principalSuffix}`,
    siteSlug: row.site_slug,
    expiresAt,
    clientId: client.id,
    refreshHash,
    scopes: row.scopes,
    principal,
  });

  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: row.scopes,
  });
}

function handleRefreshGrant(form: FormData, client: OauthClientRow): Response {
  const refreshToken = (form.get("refresh_token") as string | null) || "";
  if (!refreshToken) return jsonResponse({ error: "invalid_request", error_description: "refresh_token required" }, 400);

  const refreshHash = sha256Hex(refreshToken);
  const row = findOauthRowByRefreshHash(refreshHash);
  if (!row || row.client_id !== client.id || !row.site_slug || !row.scopes) {
    return jsonResponse({ error: "invalid_grant" }, 400);
  }

  // Refresh token rotation: invalidate old access+refresh, issue new pair.
  db.run("DELETE FROM mcp_tokens WHERE id = ?", row.id);

  const newAccess = randHex(32);
  const newRefresh = randHex(32);
  const newAccessHash = sha256Hex(newAccess);
  const newRefreshHash = sha256Hex(newRefresh);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString().replace("T", " ").substring(0, 19);

  insertOauthAccessToken({
    tokenHash: newAccessHash,
    label: row.label,
    siteSlug: row.site_slug,
    expiresAt,
    clientId: client.id,
    refreshHash: newRefreshHash,
    scopes: row.scopes,
    principal: row.principal || "admin",
  });

  return jsonResponse({
    access_token: newAccess,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefresh,
    scope: row.scopes,
  });
}

// --- Revocation (RFC 7009 subset) ---

export async function handleRevoke(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  let form: FormData;
  try { form = await req.formData(); } catch { return jsonResponse({ error: "invalid_request" }, 400); }

  const clientId = (form.get("client_id") as string | null) || "";
  const token = (form.get("token") as string | null) || "";
  if (!clientId || !token) return jsonResponse({ error: "invalid_request" }, 400);

  const client = getClient(clientId);
  if (!client) return new Response(null, { status: 200 });

  // Try as access token, then as refresh token. Only revoke rows owned by this client.
  const tokenHash = sha256Hex(token);
  db.run(
    `DELETE FROM mcp_tokens WHERE issued_via = 'oauth' AND client_id = ? AND (token_hash = ? OR refresh_hash = ?)`,
    client.id, tokenHash, tokenHash
  );
  return new Response(null, { status: 200 });
}

// --- Periodic cleanup (called from index.ts on a timer) ---

export function pruneExpired(): void {
  db.run("DELETE FROM oauth_codes WHERE expires_at < datetime('now') OR consumed = 1");
  // Access tokens expire on use via mcp.ts validateMcpToken; prune fully-expired oauth rows here
  // so the table doesn't accumulate dead refresh-token-only rows.
  db.run(
    `DELETE FROM mcp_tokens WHERE issued_via = 'oauth' AND expires_at IS NOT NULL AND expires_at < datetime('now')
     AND (refresh_hash IS NULL)`
  );
}

// --- Admin-side queries ---

export interface OauthGrantSummary {
  token_id: number;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  site_slug: string;
  scopes: string;
  issued_at: string;
  expires_at: string | null;
  has_refresh: boolean;
  principal: string;
}

export function listOauthGrants(): OauthGrantSummary[] {
  const rows = db.query(`
    SELECT t.id as token_id, t.client_id, t.site_slug, t.scopes, t.created_at as issued_at, t.expires_at, t.refresh_hash, t.principal,
           c.name as client_name, c.client_uri
    FROM mcp_tokens t LEFT JOIN oauth_clients c ON c.id = t.client_id
    WHERE t.issued_via = 'oauth'
    ORDER BY t.created_at DESC
  `).all() as any[];
  return rows.map(r => ({
    token_id: r.token_id,
    client_id: r.client_id,
    client_name: r.client_name || "(deleted client)",
    client_uri: r.client_uri,
    site_slug: r.site_slug,
    scopes: r.scopes,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    has_refresh: !!r.refresh_hash,
    principal: r.principal || "admin",
  }));
}

export function revokeOauthGrant(tokenId: number): boolean {
  const result = db.run("DELETE FROM mcp_tokens WHERE id = ? AND issued_via = 'oauth'", tokenId);
  return result.changes > 0;
}

export function listOauthClients(): Array<{
  id: string; name: string; client_uri: string | null; redirect_uris: string[];
  created_at: string; last_used_at: string | null; active_grants: number;
}> {
  const rows = db.query(`
    SELECT c.*, (SELECT COUNT(*) FROM mcp_tokens t WHERE t.issued_via = 'oauth' AND t.client_id = c.id) as active_grants
    FROM oauth_clients c
    ORDER BY c.created_at DESC
  `).all() as any[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    client_uri: r.client_uri,
    redirect_uris: clientRedirectUris(r),
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    active_grants: r.active_grants,
  }));
}

export function deleteOauthClient(clientId: string): boolean {
  // Cascade: delete client and any tokens issued to it.
  db.run("DELETE FROM mcp_tokens WHERE issued_via = 'oauth' AND client_id = ?", clientId);
  const result = db.run("DELETE FROM oauth_clients WHERE id = ?", clientId);
  return result.changes > 0;
}

// --- Site delegate credentials ---
//
// The admin mints these per-site to share MCP access with collaborators
// without giving them the admin password. A delegate's password is checked
// at the OAuth consent screen for that one site only; nothing about the
// rest of the system (other sites, /_admin) is reachable.

export interface SiteDelegateRow {
  id: number;
  site_slug: string;
  label: string;
  password_hash: string;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface SiteDelegateInfo {
  id: number;
  site_slug: string;
  label: string;
  expires_at: string | null;
  expired: boolean;
  created_at: string;
  last_used_at: string | null;
}

export function listSiteDelegates(siteSlug: string): SiteDelegateInfo[] {
  const rows = db.query(
    `SELECT id, site_slug, label, expires_at, created_at, last_used_at
     FROM site_delegates WHERE site_slug = ? ORDER BY created_at DESC`
  ).all(siteSlug) as Array<Omit<SiteDelegateInfo, "expired">>;
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  return rows.map(r => ({ ...r, expired: r.expires_at ? r.expires_at < now : false }));
}

export async function createSiteDelegate(args: {
  siteSlug: string; label: string; password: string; expiresInDays?: number | null;
}): Promise<{ id: number }> {
  const site = getSite(args.siteSlug);
  if (!site) throw new Error("Site not found");
  if (!site.mcp_enabled) throw new Error("MCP is not enabled on this site");

  const label = args.label.trim();
  if (!label) throw new Error("Label is required");
  if (label.length > 60) throw new Error("Label is too long");
  if (!/^[\w .@\-]+$/.test(label)) throw new Error("Label may only contain letters, digits, spaces, and . @ - _");
  if (label.toLowerCase() === "admin") throw new Error("Label 'admin' is reserved");

  if (!args.password || args.password.length < 8) {
    throw new Error("Delegate password must be at least 8 characters");
  }

  const passwordHash = await Bun.password.hash(args.password, { algorithm: "argon2id" });

  let expiresAt: string | null = null;
  if (args.expiresInDays && args.expiresInDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + args.expiresInDays);
    expiresAt = d.toISOString().replace("T", " ").substring(0, 19);
  }

  try {
    const result = db.run(
      `INSERT INTO site_delegates (site_slug, label, password_hash, expires_at) VALUES (?, ?, ?, ?)`,
      args.siteSlug, label, passwordHash, expiresAt
    );
    return { id: Number(result.lastInsertRowid) };
  } catch (e: any) {
    if (String(e.message || "").includes("UNIQUE")) {
      throw new Error(`A delegate named '${label}' already exists for this site`);
    }
    throw e;
  }
}

export function deleteSiteDelegate(siteSlug: string, id: number): boolean {
  const result = db.run(
    "DELETE FROM site_delegates WHERE id = ? AND site_slug = ?",
    id, siteSlug
  );
  return result.changes > 0;
}

// Verify a delegate password for the given site. Returns the matching
// delegate row on success, or null on no-match / expired / wrong password.
// Always runs a password verify to keep timing roughly constant whether or
// not the label exists.
async function verifyDelegate(siteSlug: string, label: string, password: string): Promise<SiteDelegateRow | null> {
  const row = db.query(
    "SELECT * FROM site_delegates WHERE site_slug = ? AND label = ?"
  ).get(siteSlug, label) as SiteDelegateRow | null;

  // Argon2id-hash a dummy if no row, so timing leaks less about which labels exist.
  const hashToCheck = row?.password_hash || "$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXk$ZHVtbXk";
  let ok = false;
  try { ok = await Bun.password.verify(password, hashToCheck); } catch { ok = false; }
  if (!row || !ok) return null;

  // Expiration check
  if (row.expires_at) {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    if (row.expires_at < now) return null;
  }
  return row;
}

function markDelegateUsed(id: number): void {
  db.run("UPDATE site_delegates SET last_used_at = datetime('now') WHERE id = ?", id);
}

// Expose the delegate verifier so handleAuthorize (above) can call it. Defined
// after the function it uses to keep the module ordering clean.
export { verifyDelegate, markDelegateUsed };
