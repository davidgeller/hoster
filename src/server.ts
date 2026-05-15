import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { handleAdminApi } from "./admin-api";
import { handleMcp } from "./mcp";
import {
  handleAsMetadata, handleProtectedResourceMetadata,
  handleRegister, handleAuthorize, handleToken, handleRevoke,
} from "./oauth";
import { logRequest, extractRequestMeta, shouldTrack, isCountryAllowed, isIpBlocked, checkAndAutoBlock } from "./analytics";
import { resolveSitePath, resolveAlias, resolveHostAlias, normalizeHost } from "./sites";
import { serveCmsLibFile } from "./cms-lib";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

import { dirname } from "path";
const BASE_DIR = process.env.HOSTER_HOME || dirname(process.execPath);
const ADMIN_DIR = join(BASE_DIR, "admin");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".map": "application/json",
};

function addSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

function getMime(path: string): string {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

// Generate a weak ETag from file mtime + size, optionally scoped to a deployment version
// Including the version ensures ETags always change on redeployment, even if
// the file's mtime is preserved from the zip and its size hasn't changed.
function generateEtag(filePath: string, version?: string | null): string | null {
  try {
    const stat = statSync(filePath);
    const base = `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`;
    return version ? `W/"${version}-${base}"` : `W/"${base}"`;
  } catch {
    return null;
  }
}

// Check If-None-Match header — return 304 if ETag matches
function checkNotModified(req: Request, etag: string | null): Response | null {
  if (!etag) return null;
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { "ETag": etag } });
  }
  return null;
}

async function serveHtml(filePath: string, basePath: string, req: Request, version?: string | null): Promise<Response> {
  try {
    const etag = generateEtag(filePath, version);
    const notModified = checkNotModified(req, etag);
    if (notModified) return notModified;

    const file = Bun.file(filePath);
    let html = await file.text();
    // Rewrite <base href="/"> so relative asset paths resolve under the
    // serving prefix. For path-routed sites this is "/<slug>/"; for
    // host-aliased requests the site IS the host root, so it stays "/".
    html = html.replace(/<base\s+href="\/"\s*\/?>/i, `<base href="${basePath}">`);
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      // Explicit Content-Length so the request log can record bytes-out
      // without consuming the response body. Byte length, not character count.
      "Content-Length": String(Buffer.byteLength(html)),
    };
    if (etag) headers["ETag"] = etag;
    return new Response(html, { headers });
  } catch (e: any) {
    console.error("serveHtml error:", filePath, e?.message);
    return new Response("File error", { status: 500 });
  }
}

function serveFile(filePath: string, req: Request, cacheMode: "revalidate" | "nocache" | "immutable" = "revalidate", version?: string | null): Response {
  try {
    let stat;
    try { stat = statSync(filePath); } catch { stat = null; }
    const etag = stat
      ? (() => {
          const base = `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`;
          return version ? `W/"${version}-${base}"` : `W/"${base}"`;
        })()
      : null;

    if (cacheMode !== "nocache") {
      const notModified = checkNotModified(req, etag);
      if (notModified) return notModified;
    }

    // Use Bun.file() — Bun streams this via sendfile, zero-copy
    const file = Bun.file(filePath);
    const cacheControl =
      cacheMode === "nocache" ? "no-cache, no-store, must-revalidate" :
      cacheMode === "immutable" ? "public, max-age=31536000, immutable" :
      "no-cache"; // "revalidate" — browser must check ETag every time
    const headers: Record<string, string> = {
      "Content-Type": getMime(filePath),
      "Cache-Control": cacheControl,
    };
    if (etag) headers["ETag"] = etag;
    // Set Content-Length from stat so the request log records bytes-out
    // (Bun adds this on the wire automatically, but it isn't on the Response
    // object's headers — we read it back from there at log time).
    if (stat) headers["Content-Length"] = String(stat.size);
    return new Response(file, { headers });
  } catch (e: any) {
    console.error("serveFile error:", filePath, e?.message);
    return new Response("File error", { status: 500 });
  }
}

export function createServer(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const start = performance.now();
      const url = new URL(req.url);
      const path = url.pathname;
      const meta = extractRequestMeta(req);
      let status = 200;
      let siteSlug: string | null = null;

      // Resolve host alias once. If the incoming Host header maps to a site,
      // every non-reserved request on this host is served from that site,
      // and reserved paths (admin/oauth/mcp/well-known) return 404 — those
      // surfaces are only valid on the canonical hostname.
      const hostAliasSlug = resolveHostAlias(normalizeHost(req.headers.get("host")));

      try {
        // The global CMS library at `/_cms/<file>` serves every site's blog
        // templates and MUST be reachable on every host — canonical and
        // host-aliased — because the templates load it via an absolute URL.
        // Match it first, before the infra-path 404 below.
        const cmsLibMatch = path.match(/^\/_cms\/([a-z0-9._-]+)$/);
        if (cmsLibMatch) {
          const res = serveCmsLibFile(req, cmsLibMatch[1]);
          status = res.status;
          logReq(res);
          return addSecurityHeaders(res);
        }

        // Paths that opt out of the country/IP gating below: admin UI/API, MCP
        // endpoints (any /_mcp variant), OAuth endpoints, and OAuth/MCP discovery.
        const isInfraPath =
          path.startsWith("/_admin") ||
          path === "/_mcp" || path.startsWith("/_mcp/") ||
          path.startsWith("/oauth/") ||
          path.startsWith("/.well-known/oauth-");

        // Block reserved infra paths on host-aliased hostnames. Admin, OAuth,
        // and MCP must only be reachable via the canonical hostname so an
        // external custom domain never accidentally exposes them. The CMS
        // library carve-out above runs first, so it stays reachable.
        if (hostAliasSlug && isInfraPath) {
          status = 404;
          logReq();
          return new Response("Not found", { status: 404 });
        }

        // --- Version check (no auth needed) ---
        if (path === "/_admin/api/version") {
          const { VERSION } = await import("./index");
          return new Response(JSON.stringify({ version: VERSION }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
          });
        }

        // --- IP auto-block check (skip for infra paths) ---
        if (!isInfraPath) {
          if (isIpBlocked(meta.ip)) {
            status = 403;
            const res = new Response("Access denied", { status: 403 });
            logReq(res);
            return res;
          }
        }

        // --- Country restriction (skip for infra paths) ---
        if (!isInfraPath) {
          if (!isCountryAllowed(meta.country)) {
            status = 403;
            const res = new Response("Access denied", { status: 403 });
            logReq(res);
            checkAndAutoBlock(meta.ip);
            return res;
          }
        }

        // --- OAuth Authorization Server discovery ---
        if (path === "/.well-known/oauth-authorization-server") {
          const res = handleAsMetadata(req);
          status = res.status;
          logReq(res);
          return addSecurityHeaders(res);
        }

        // --- OAuth Protected Resource discovery (per-site or generic) ---
        if (path === "/.well-known/oauth-protected-resource" ||
            path.startsWith("/.well-known/oauth-protected-resource/_mcp/") ||
            path === "/.well-known/oauth-protected-resource/_mcp") {
          const m = path.match(/^\/\.well-known\/oauth-protected-resource\/_mcp\/([a-z0-9][a-z0-9-]*)\/?$/);
          const slug = m ? m[1] : null;
          const res = handleProtectedResourceMetadata(req, slug);
          status = res.status;
          logReq(res);
          return addSecurityHeaders(res);
        }

        // --- OAuth endpoints ---
        if (path === "/oauth/register") {
          const res = await handleRegister(req, meta.ip);
          status = res.status;
          logReq(res);
          return addSecurityHeaders(res);
        }
        if (path === "/oauth/authorize") {
          const res = await handleAuthorize(req, meta.ip);
          status = res.status;
          logReq(res);
          return addSecurityHeaders(res);
        }
        if (path === "/oauth/token") {
          const res = await handleToken(req);
          status = res.status;
          logReq(res);
          return addSecurityHeaders(res);
        }
        if (path === "/oauth/revoke") {
          const res = await handleRevoke(req);
          status = res.status;
          logReq(res);
          return addSecurityHeaders(res);
        }

        // --- MCP endpoint (legacy multi-site + per-site) ---
        const mcpSiteMatch = path.match(/^\/_mcp\/([a-z0-9][a-z0-9-]*)\/?$/);
        if (path === "/_mcp" || mcpSiteMatch) {
          const urlSlug = mcpSiteMatch ? mcpSiteMatch[1] : null;
          const { response, siteSlug: mcpSlug } = await handleMcp(req, urlSlug);
          status = response.status;
          siteSlug = mcpSlug ?? urlSlug;
          logReq(response);
          return addSecurityHeaders(response);
        }

        // --- Admin API ---
        if (path.startsWith("/_admin/api/")) {
          const res = await handleAdminApi(req, path);
          if (res) {
            status = res.status;
            logReq(res);
            return addSecurityHeaders(res);
          }
        }

        // --- Admin UI ---
        if (path === "/_admin" || path.startsWith("/_admin")) {
          // Serve admin SPA — all non-API admin routes get index.html
          if (path.startsWith("/_admin/api/")) {
            status = 404;
            const res = new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
            logReq(res);
            return res;
          }

          // Serve static admin assets (no-cache so updates take effect immediately)
          let adminPath = path.replace("/_admin", "") || "/index.html";
          if (adminPath === "/") adminPath = "/index.html";
          const adminFile = join(ADMIN_DIR, adminPath);
          // Security: verify resolved path stays within admin directory
          const resolvedAdmin = resolve(adminFile);
          const resolvedAdminDir = resolve(ADMIN_DIR);
          if (adminPath !== "/index.html" && resolvedAdmin.startsWith(resolvedAdminDir + "/") && existsSync(adminFile) && statSync(adminFile).isFile()) {
            const res = serveFile(adminFile, req, "nocache");
            logReq(res);
            return res;
          }
          // SPA fallback
          const res = serveFile(join(ADMIN_DIR, "index.html"), req, "nocache");
          logReq(res);
          return res;
        }

        // --- Hosted sites ---
        // Two routing modes:
        //   - Host-aliased: the entire path on this host belongs to one site,
        //     resolved via Host header. URL has no slug prefix.
        //   - Path-based: parse /<slug>/rest/of/path on the canonical host.
        const parts = path.split("/").filter(Boolean);

        let candidateSlug: string;
        let reqPath: string;
        let basePath: string;

        if (hostAliasSlug) {
          // Host alias maps directly to a slug; the slug may itself be a
          // path alias, so run it through resolveAlias.
          candidateSlug = resolveAlias(hostAliasSlug);
          reqPath = parts.join("/") || "index.html";
          basePath = "/";
        } else {
          if (parts.length === 0) {
            // Root on canonical host — redirect to admin.
            status = 302;
            const res = new Response(null, { status: 302, headers: { Location: "/_admin" } });
            logReq(res);
            return res;
          }
          candidateSlug = resolveAlias(parts[0]);
          reqPath = parts.slice(1).join("/") || "index.html";
          basePath = `/${parts[0]}/`;
        }

        // If a .html URL has a trailing slash (e.g. /slug/page.html/), strip it.
        // The browser would otherwise resolve relative asset paths against the
        // file as if it were a directory, breaking CSS/JS references.
        if (/\.html\/$/.test(path)) {
          status = 301;
          const res = new Response(null, {
            status: 301,
            headers: { Location: path.replace(/\/+$/, "") + url.search },
          });
          logReq(res);
          return res;
        }

        const resolved = resolveSitePath(candidateSlug, reqPath);

        // Redirect /slug to /slug/ (and /slug/subdir to /slug/subdir/) so
        // relative asset paths in HTML resolve correctly in the browser.
        // Skip when the URL explicitly names a file (e.g. /slug/index.html or
        // /slug/sub/index.html); appending a slash would make the browser treat
        // the file as a directory and break relative paths.
        // Host-aliased requests always serve at host root, so this only fires
        // for path-based routing.
        if (
          !hostAliasSlug &&
          resolved &&
          !path.endsWith("/") &&
          !path.endsWith(".html") &&
          resolved.filePath.endsWith("index.html")
        ) {
          status = 301;
          const res = new Response(null, {
            status: 301,
            headers: { Location: path + "/" + url.search },
          });
          logReq(res);
          return res;
        }

        if (resolved) {
          siteSlug = candidateSlug;
          // For HTML files, rewrite <base href="/"> to the appropriate prefix:
          // path-based routing: "/<slug>/"; host-aliased: "/".
          if (resolved.filePath.endsWith(".html")) {
            const res = await serveHtml(resolved.filePath, basePath, req, resolved.version);
            logReq(res);
            return res;
          }
          // Content-hashed filenames (e.g. main.a1b2c3.js) get immutable caching;
          // everything else must revalidate so redeployments take effect immediately.
          const basename = resolved.filePath.substring(resolved.filePath.lastIndexOf("/") + 1);
          const isHashed = /\.[a-f0-9]{8,}\.\w+$/.test(basename) || /[-.][\w]*\.[a-f0-9]{8,}\./.test(basename);
          const res = serveFile(resolved.filePath, req, isHashed ? "immutable" : "revalidate", resolved.version);
          logReq(res);
          return res;
        }

        // 404
        status = 404;
        const notFoundBody = "<!DOCTYPE html><html><head><title>404</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;color:#333}h1{font-weight:300;font-size:2em}</style></head><body><h1>404 &mdash; Not Found</h1></body></html>";
        const res404 = new Response(notFoundBody, {
          status: 404,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": String(Buffer.byteLength(notFoundBody)),
          },
        });
        logReq(res404);
        return res404;
      } catch (e: any) {
        console.error("Request error:", path, e?.message, e?.stack);
        status = 500;
        const res = new Response("Internal Server Error", { status: 500 });
        logReq(res);
        return res;
      }

      function logReq(res?: Response | null) {
        if (!shouldTrack(path)) return;
        const elapsed = performance.now() - start;
        // Best-effort byte counts. Only counted when Content-Length is present;
        // chunked/streamed bodies (rare here) report 0. Inline tiny responses
        // (errors, redirects) also report 0 — acceptable for a dashboard chart.
        const requestBytes = parseInt(req.headers.get("content-length") || "0", 10) || 0;
        const responseBytes = res ? (parseInt(res.headers.get("content-length") || "0", 10) || 0) : 0;
        logRequest({
          site_slug: siteSlug,
          path,
          method: req.method,
          status,
          response_time_ms: elapsed,
          ip: meta.ip,
          country: meta.country,
          city: meta.city,
          user_agent: meta.user_agent,
          referrer: meta.referrer,
          content_type: req.headers.get("content-type") || null,
          accept_language: meta.accept_language,
          request_bytes: requestBytes,
          response_bytes: responseBytes,
        });
      }
    },
    error(err) {
      const msg = err?.stack || err?.message || String(err);
      console.error("Unhandled error:", msg);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
}
