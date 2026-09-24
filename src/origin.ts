// Origin isolation: serve the admin panel on its own hostname.
//
// Path-routed sites (https://<host>/<slug>/) share one browser origin with
// everything else on that host. When /_admin lives on the same host, any
// script on any hosted site can call the admin API with a signed-in
// administrator's cookie and read the responses (CSRF tokens included) —
// cookie flags and CSRF tokens can't stop same-origin script. The only fix is
// a different origin, so when an admin hostname is configured:
//
//   • The admin panel/API and the OAuth consent screen are served only on
//     the admin hostname. Elsewhere /_admin redirects there (the API 404s)
//     and /oauth/authorize redirects there.
//   • The admin hostname serves no hosted sites: site paths redirect to the
//     sites hostname.
//   • Bearer-token endpoints (/_mcp, /oauth/token|register|revoke, OAuth
//     discovery) keep working on every host that served them before, so
//     existing MCP connectors and OAuth grants carry on unchanged. They carry
//     no cookies, so sharing an origin with hosted sites grants nothing.
//
// The session cookie is host-only (no Domain attribute), so a session made on
// the admin hostname is never sent to the sites hostname at all.

import { randomBytes } from "crypto";
import db from "./db";

export interface OriginConfig {
  admin_host: string | null;  // "admin.example.com" (optionally ":port")
  sites_host: string | null;  // where path-routed sites are served
}

let cache: OriginConfig | null = null;

function read(key: string): string | null {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ? row.value : null;
}

export function getOriginConfig(): OriginConfig {
  if (!cache) cache = { admin_host: read("admin_host"), sites_host: read("sites_host") };
  return cache;
}

export function invalidateOriginConfig(): void {
  cache = null;
}

// Lowercased hostname without port, for comparing against a request's Host.
export function hostOnly(hostPort: string): string {
  const h = hostPort.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  const i = h.lastIndexOf(":");
  return i > -1 && /^\d+$/.test(h.slice(i + 1)) ? h.slice(0, i) : h;
}

const HOST_RE = /^(?=.{1,253}(?::\d{1,5})?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

// Accepts "admin.example.com", "admin.example.com:8443", or a pasted URL.
export function normalizeHostSetting(raw: unknown, field: string): string | null {
  if (raw == null) return null;
  let v = String(raw).trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!HOST_RE.test(v)) throw new Error(`${field} must be a hostname like admin.example.com`);
  return v;
}

function isLocalHost(hostPort: string): boolean {
  const h = hostOnly(hostPort);
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

// https everywhere except loopback development hosts.
export function originFor(hostPort: string): string {
  return `${isLocalHost(hostPort) ? "http" : "https"}://${hostPort}`;
}

export function adminOrigin(): string | null {
  const { admin_host } = getOriginConfig();
  return admin_host ? originFor(admin_host) : null;
}

export function sitesOrigin(): string | null {
  const { sites_host } = getOriginConfig();
  return sites_host ? originFor(sites_host) : null;
}

export function setOriginConfig(input: { admin_host?: unknown; sites_host?: unknown }, opts: { hostAliases: string[] }): OriginConfig {
  const admin = normalizeHostSetting(input.admin_host, "Admin hostname");
  let sites = normalizeHostSetting(input.sites_host, "Sites hostname");
  if (admin) {
    if (!sites) throw new Error("Enter the hostname your sites are served on (usually the address you're using now)");
    if (hostOnly(admin) === hostOnly(sites)) throw new Error("The admin hostname must be different from the sites hostname — that's the point");
    const aliases = new Set(opts.hostAliases.map(h => hostOnly(h)));
    if (aliases.has(hostOnly(admin))) throw new Error(`${admin} is a custom domain for a site; pick a hostname no site uses`);
    if (aliases.has(hostOnly(sites))) throw new Error(`${sites} is a custom domain for a site; use the shared hostname your /<slug>/ URLs live on`);
  } else {
    sites = null; // isolation off: nothing to remember
  }
  const upsert = db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const del = db.prepare("DELETE FROM config WHERE key = ?");
  db.transaction(() => {
    if (admin) upsert.run("admin_host", admin); else del.run("admin_host");
    if (sites) upsert.run("sites_host", sites); else del.run("sites_host");
  })();
  invalidateOriginConfig();
  return getOriginConfig();
}

// A random, non-secret id for this installation. Before switching, the
// server fetches it through the prospective admin hostname to prove that
// hostname really reaches this server (otherwise the switch would lock
// everyone out of the panel).
export function instanceId(): string {
  let id = read("instance_id");
  if (!id) {
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('instance_id', ?)", randomBytes(12).toString("hex"));
    id = read("instance_id")!;
  }
  return id;
}

// --- Request classification (used by server.ts) ---

// Surfaces that authenticate with the admin session cookie or collect an
// administrator's password: these must live only on the admin hostname.
export function isAdminOnlyPath(path: string): boolean {
  return path === "/_admin" || path.startsWith("/_admin/") || path === "/oauth/authorize";
}

// Cookie-less, bearer-token infrastructure that may be served on any
// non-alias host.
export function isSharedInfraPath(path: string): boolean {
  return path === "/_mcp" || path.startsWith("/_mcp/") ||
    path === "/oauth/token" || path === "/oauth/register" || path === "/oauth/revoke" ||
    path.startsWith("/.well-known/oauth-") ||
    path.startsWith("/_cms/") || path === "/_hoster/instance";
}

// Does `hostPort` reach this installation? Fetches its /_hoster/instance the
// way a browser would (through DNS / Cloudflare) and compares ids.
export async function verifyReachesThisServer(hostPort: string, timeoutMs = 6000): Promise<{ ok: boolean; reason?: string }> {
  const url = `${originFor(hostPort)}/_hoster/instance`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, reason: `${url} answered HTTP ${res.status}` };
    const text = (await res.text()).slice(0, 1000);
    let id: unknown = null;
    try { id = JSON.parse(text).instance; } catch (_) {}
    if (id !== instanceId()) return { ok: false, reason: `${hostPort} reaches a different server (or a different Hoster installation)` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `couldn't reach ${url} from this server (${e?.name === "TimeoutError" ? "timed out" : e?.message || "network error"})` };
  }
}
