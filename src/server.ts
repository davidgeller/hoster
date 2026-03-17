import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { handleAdminApi } from "./admin-api";
import { handleMcp } from "./mcp";
import { logRequest, extractRequestMeta, shouldTrack, isCountryAllowed } from "./analytics";
import { resolveSitePath } from "./sites";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

import { dirname } from "path";
const BASE_DIR = dirname(process.execPath);
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

async function serveHtml(filePath: string, slug: string): Promise<Response> {
  try {
    const file = Bun.file(filePath);
    let html = await file.text();
    // Rewrite base href to include the site slug prefix
    html = html.replace(/<base\s+href="\/"\s*\/?>/i, `<base href="/${slug}/">`);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e: any) {
    console.error("serveHtml error:", filePath, e?.message);
    console.error("serveHtml file error:", e?.message);
    return new Response("File error", { status: 500 });
  }
}

async function serveFile(filePath: string, noCache = false): Promise<Response> {
  try {
    const file = Bun.file(filePath);
    const bytes = await file.arrayBuffer();
    return new Response(bytes, {
      headers: {
        "Content-Type": getMime(filePath),
        "Cache-Control": noCache ? "no-cache, no-store, must-revalidate" : "public, max-age=3600",
      },
    });
  } catch (e: any) {
    console.error("serveFile error:", filePath, e?.message);
    console.error("serveFile error:", e?.message);
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

      try {
        // --- Version check (no auth needed) ---
        if (path === "/_admin/api/version") {
          const { VERSION } = await import("./index");
          return new Response(JSON.stringify({ version: VERSION }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
          });
        }

        // --- Country restriction (skip for admin and MCP) ---
        if (!path.startsWith("/_admin") && path !== "/_mcp") {
          if (!isCountryAllowed(meta.country)) {
            status = 403;
            logReq();
            return new Response("Access denied", { status: 403 });
          }
        }

        // --- MCP endpoint ---
        if (path === "/_mcp") {
          const res = await handleMcp(req);
          status = res.status;
          logReq();
          return addSecurityHeaders(res);
        }

        // --- Admin API ---
        if (path.startsWith("/_admin/api/")) {
          const res = await handleAdminApi(req, path);
          if (res) {
            status = res.status;
            logReq();
            return addSecurityHeaders(res);
          }
        }

        // --- Admin UI ---
        if (path === "/_admin" || path.startsWith("/_admin")) {
          // Serve admin SPA — all non-API admin routes get index.html
          if (path.startsWith("/_admin/api/")) {
            status = 404;
            logReq();
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }

          // Serve static admin assets (no-cache so updates take effect immediately)
          let adminPath = path.replace("/_admin", "") || "/index.html";
          if (adminPath === "/") adminPath = "/index.html";
          const adminFile = join(ADMIN_DIR, adminPath);
          // Security: verify resolved path stays within admin directory
          const resolvedAdmin = resolve(adminFile);
          const resolvedAdminDir = resolve(ADMIN_DIR);
          if (adminPath !== "/index.html" && resolvedAdmin.startsWith(resolvedAdminDir + "/") && existsSync(adminFile) && statSync(adminFile).isFile()) {
            logReq();
            return serveFile(adminFile, true);
          }
          // SPA fallback
          logReq();
          return serveFile(join(ADMIN_DIR, "index.html"), true);
        }

        // --- Hosted sites ---
        // Parse /<slug>/rest/of/path
        const parts = path.split("/").filter(Boolean);
        if (parts.length === 0) {
          // Root — show a simple landing or redirect to admin
          status = 302;
          logReq();
          return new Response(null, { status: 302, headers: { Location: "/_admin" } });
        }

        const candidateSlug = parts[0];
        const filePath = parts.slice(1).join("/") || "index.html";
        const resolved = resolveSitePath(candidateSlug, filePath);

        if (resolved) {
          siteSlug = candidateSlug;
          logReq();
          // For HTML files, rewrite <base href="/"> to <base href="/slug/">
          if (resolved.endsWith(".html")) {
            return serveHtml(resolved, siteSlug);
          }
          return serveFile(resolved);
        }

        // 404
        status = 404;
        logReq();
        return new Response("<!DOCTYPE html><html><head><title>404</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;color:#333}h1{font-weight:300;font-size:2em}</style></head><body><h1>404 &mdash; Not Found</h1></body></html>", {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch (e: any) {
        console.error("Request error:", path, e?.message, e?.stack);
        status = 500;
        logReq();
        return new Response("Internal Server Error", { status: 500 });
      }

      function logReq() {
        if (!shouldTrack(path)) return;
        const elapsed = performance.now() - start;
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
