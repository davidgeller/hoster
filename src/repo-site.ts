// HTTP surface of a repository site — everything under /<slug>/ (or the host
// root on a custom domain) when the site is a document library.
//
//   /                      built-in UI (admin/repo/index.html, <base href> rewritten)
//   /_repo/ui/<asset>      UI assets (app.js, style.css)
//   /_repo/banner          banner image
//   /_repo/api/*           JSON + file API used by the UI (and usable directly)
//
// Access rules:
//   * Readers: everyone when the site is public; otherwise only writers.
//   * Writers: platform administrators and site users assigned to this site.
//   * Sign-in reuses Hoster accounts (username/password, TOTP if enabled) and
//     issues the same session cookie the admin panel uses. Mutations require
//     the session's CSRF token in the X-CSRF-Token header.
//   * Raw file bytes are served with nosniff, a strong ETag, and — for anything
//     a browser could execute (HTML, SVG, XML) — a `sandbox` CSP so a hostile
//     document can never run script on the site's origin.

import { existsSync, statSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import {
  getSessionToken, validateSession, getSessionUser, validateCsrf, getCsrfToken,
  verifyUserPassword, isTotpEnabled, verifyTotpOrRecovery, isRateLimited, isTotpRateLimited, recordTotpAttempt,
  createSession, destroySession, destroySessionsForUser, sessionCookie, auditLog, userCanAccessSite,
  type Principal,
} from "./auth";
import type { Site } from "./sites";
import {
  listRepoTree, readRepoContent, stageBlob, commitRepoFile, writeRepoText, createRepoFolder, renameRepoPath,
  deleteRepoPaths, moveRepoPaths, copyRepoPaths, listRepoTrash, restoreRepoTrash, purgeRepoTrash, listRepoVersions, restoreRepoVersion, deleteRepoVersion,
  zipRepoPaths, repoStats, repoBannerPath, setRepoBanner, clearRepoBanner, previewKind, isTextMime, mimeForName,
  REPO_MAX_FILE_BYTES, TRASH_TTL_DAYS, repoQuotaRemaining,
} from "./repo";

const BASE_DIR = process.env.HOSTER_HOME || dirname(process.execPath);
const REPO_UI_DIR = join(BASE_DIR, "admin", "repo");

// Content-Security-Policy for the built-in UI document. Scripts only from the
// UI bundle (no inline handlers), media/images/frames from this origin so the
// previews work, and frame-ancestors 'self' so the admin Site Explorer can
// embed the page.
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; frame-src 'self'; object-src 'self'; connect-src 'self'; font-src 'self'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function readJson<T = any>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

// RFC 5987 filename for Content-Disposition — ASCII fallback + UTF-8 form.
function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

interface Auth {
  principal: Principal | null;
  token: string | undefined;
  canWrite: boolean;
  canRead: boolean;
}

function resolveAuth(req: Request, site: Site, ip: string): Auth {
  const token = getSessionToken(req);
  const principal = token && validateSession(token, ip) ? getSessionUser(token) : null;
  const canWrite = !!principal && userCanAccessSite(principal, site.slug);
  const canRead = site.repo_visibility === "public" || canWrite;
  return { principal, token, canWrite, canRead };
}

export interface RepoRequestContext {
  ip: string;
  basePath: string;      // "/<slug>/" or "/" on a host alias
  hostAliased: boolean;
}

export async function handleRepoSite(req: Request, site: Site, reqPath: string, ctx: RepoRequestContext): Promise<Response> {
  const url = new URL(req.url);
  const auth = resolveAuth(req, site, ctx.ip);
  const actor = auth.principal?.username ?? null;
  const audit = (action: string, detail: string | null) => auditLog(action, detail, ctx.ip, actor);

  // --- UI document ---
  if (reqPath === "" || reqPath === "index.html") {
    return serveUiDocument(ctx.basePath);
  }

  // --- UI assets ---
  const assetMatch = reqPath.match(/^_repo\/ui\/([a-z0-9._-]+)$/);
  if (assetMatch) {
    const file = join(REPO_UI_DIR, assetMatch[1]);
    const resolved = resolve(file);
    if (!resolved.startsWith(resolve(REPO_UI_DIR) + "/") || !existsSync(file) || !statSync(file).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    const type = file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
    return new Response(Bun.file(file), { headers: { "Content-Type": type, "Cache-Control": "no-cache", "Content-Length": String(statSync(file).size) } });
  }

  // --- Banner (visible to anyone who can see the page shell) ---
  if (reqPath === "_repo/banner") {
    // Part of the content, not the shell: a private repository's banner is
    // only for people who can see its files.
    if (!auth.canRead) return new Response("Not found", { status: 404 });
    const banner = repoBannerPath(site);
    if (!banner) return new Response("Not found", { status: 404 });
    const st = statSync(banner.abs);
    return new Response(Bun.file(banner.abs), {
      headers: { "Content-Type": banner.mime, "Cache-Control": "no-cache", "Content-Length": String(st.size), "ETag": `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"` },
    });
  }

  if (!reqPath.startsWith("_repo/api/")) {
    // Any other path on a repository site is the UI's problem (client-side
    // routing via ?path=), so send the visitor to the document root.
    return new Response(null, { status: 302, headers: { Location: ctx.basePath + (url.search || "") } });
  }
  const api = reqPath.slice("_repo/api/".length);

  // --- Public info: what the page needs to render its shell ---
  if (api === "info" && req.method === "GET") {
    const stats = auth.canRead ? repoStats(site.slug) : null;
    return json({
      slug: site.slug,
      name: site.name,
      // Anyone who can reach the page learns its title (it's the sign-in
      // gate's heading); everything else about a private repository waits
      // for a reader.
      description: auth.canRead ? site.repo_description : null,
      visibility: site.repo_visibility,
      banner: auth.canRead && !!repoBannerPath(site),
      base_path: ctx.basePath,
      max_file_bytes: REPO_MAX_FILE_BYTES,
      trash_ttl_days: TRASH_TTL_DAYS,
      auth: {
        authenticated: !!auth.principal,
        username: auth.principal?.username ?? null,
        is_admin: !!auth.principal?.isAdmin,
        can_read: auth.canRead,
        can_write: auth.canWrite,
        csrf_token: auth.principal ? getCsrfToken(auth.token) : null,
      },
      stats,
    });
  }

  // --- Sign in / out (same accounts and lockouts as the admin panel) ---
  if (api === "auth/login" && req.method === "POST") {
    if (isRateLimited(ctx.ip)) return json({ error: "Too many attempts. Try again later." }, 429);
    const body = await readJson<{ username?: string; password?: string; code?: string }>(req);
    if (!body) return json({ error: "Invalid request body" }, 400);
    const username = (body.username || "").trim();
    if (!username || !body.password) return json({ error: "Username and password required" }, 400);
    const user = await verifyUserPassword(username, body.password, ctx.ip);
    if (!user) {
      auditLog("repo_login_failed", `${site.slug} user:${username.toLowerCase()}`, ctx.ip, null);
      return json({ error: "Invalid credentials" }, 401);
    }
    if (isTotpEnabled(user.userId)) {
      const code = (body.code || "").trim();
      if (!code) return json({ requires_2fa: true });
      if (isTotpRateLimited(ctx.ip)) return json({ error: "Too many attempts. Try again later." }, 429);
      if (!verifyTotpOrRecovery(user.userId, code)) {
        recordTotpAttempt(ctx.ip, false);
        auditLog("repo_login_2fa_failed", site.slug, ctx.ip, user.username);
        return json({ error: "Invalid authentication code", requires_2fa: true }, 401);
      }
      recordTotpAttempt(ctx.ip, true);
    }
    destroySessionsForUser(user.userId);
    const { sessionToken, csrfToken } = createSession(ctx.ip, user.userId);
    auditLog("repo_login", site.slug, ctx.ip, user.username);
    const canWrite = userCanAccessSite(user, site.slug);
    return json(
      { ok: true, csrf_token: csrfToken, username: user.username, can_write: canWrite, can_read: site.repo_visibility === "public" || canWrite },
      200, { "Set-Cookie": sessionCookie(sessionToken) }
    );
  }
  if (api === "auth/logout" && req.method === "POST") {
    if (auth.token) destroySession(auth.token);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("deleted", 0) });
  }

  // Everything below needs read access at minimum.
  if (!auth.canRead) return json({ error: auth.principal ? "You don't have access to this repository" : "Sign in required", sign_in: !auth.principal }, auth.principal ? 403 : 401);

  // --- Reads ---
  if (api === "tree" && req.method === "GET") {
    const tree = listRepoTree(site.slug);
    return json({ ...tree, stats: repoStats(site.slug) });
  }

  if (api === "file" && req.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const v = url.searchParams.get("v");
    const versionNo = v ? parseInt(v, 10) : null;
    if (v && (!Number.isInteger(versionNo) || versionNo! < 1)) return json({ error: "Invalid version" }, 400);
    let content;
    try { content = readRepoContent(site.slug, path, versionNo); } catch (e: any) { return json({ error: e.message }, 400); }
    if (!content) return json({ error: "Not found" }, 404);
    return serveContent(req, content.abs, content.size, content.mime, content.name, content.sha256, url.searchParams.get("dl") === "1");
  }

  if (api === "versions" && req.method === "GET") {
    try {
      return json({ versions: listRepoVersions(site.slug, url.searchParams.get("path") || "") });
    } catch (e: any) { return json({ error: e.message }, 400); }
  }

  if (api === "zip" && req.method === "POST") {
    // Packaging is a read, but it's a POST (body carries the selection) so it
    // still goes through CSRF when a session is present — and stays available
    // to anonymous readers of a public repository.
    if (auth.principal && !validateCsrf(req, auth.token)) return json({ error: "Invalid CSRF token" }, 403);
    const body = await readJson<{ paths?: unknown; name?: unknown }>(req);
    const paths = Array.isArray(body?.paths) ? body!.paths.filter((p): p is string => typeof p === "string") : [];
    if (!paths.length) return json({ error: "paths is required" }, 400);
    try {
      const result = await zipRepoPaths(site.slug, paths, typeof body?.name === "string" ? body!.name : undefined);
      return new Response(result.file, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": contentDisposition("attachment", result.filename),
          "Content-Length": String(result.size),
          "Cache-Control": "no-store",
        },
      });
    } catch (e: any) { return json({ error: e.message }, 400); }
  }

  if (api === "trash" && req.method === "GET") {
    if (!auth.canWrite) return json({ error: "Forbidden" }, 403);
    return json({ entries: listRepoTrash(site.slug), ttl_days: TRASH_TTL_DAYS });
  }

  // --- Writes: session + CSRF + write access ---
  if (req.method === "GET") return json({ error: "Not found" }, 404);
  if (!auth.principal) return json({ error: "Sign in required", sign_in: true }, 401);
  if (!validateCsrf(req, auth.token)) return json({ error: "Invalid CSRF token" }, 403);
  if (!auth.canWrite) return json({ error: "You can view this repository but not change it" }, 403);

  try {
    if (api === "upload" && req.method === "POST") {
      const path = url.searchParams.get("path") || "";
      if (!path) return json({ error: "path is required" }, 400);
      const replace = url.searchParams.get("replace") !== "0";
      const declared = parseInt(req.headers.get("content-length") || "0", 10) || 0;
      if (declared > REPO_MAX_FILE_BYTES) return json({ error: `File exceeds the ${Math.round(REPO_MAX_FILE_BYTES / (1024 * 1024 * 1024))} GB limit` }, 413);
      // Stop streaming as soon as the quota would be exceeded rather than
      // spooling a doomed upload to disk. (Content identical to an existing
      // blob would be free, but we can't know that before hashing the body,
      // so a nearly-full repository may reject a re-upload — acceptable.)
      const remaining = repoQuotaRemaining(site.slug);
      if (declared > remaining) return json({ error: "Not enough space left in this repository for that file" }, 413);
      const staged = await stageBlob(site.slug, req.body, Math.min(REPO_MAX_FILE_BYTES, remaining));
      const result = commitRepoFile(site.slug, path, staged, { actor, replace, note: url.searchParams.get("note") });
      audit("repo_file_uploaded", `${site.slug}:${result.file.path}${result.new_version ? ` v${result.file.version_no}` : " (unchanged)"}`);
      return json({ ok: true, ...result });
    }

    if (api === "text" && req.method === "POST") {
      const body = await readJson<{ path?: unknown; content?: unknown; note?: unknown; create?: unknown }>(req);
      if (!body || typeof body.path !== "string" || typeof body.content !== "string") return json({ error: "path and content are required" }, 400);
      const result = await writeRepoText(site.slug, body.path, body.content, {
        actor, note: typeof body.note === "string" ? body.note : null, replace: body.create === true ? false : true,
      });
      audit("repo_text_saved", `${site.slug}:${result.file.path} v${result.file.version_no}`);
      return json({ ok: true, ...result });
    }

    if (api === "mkdir" && req.method === "POST") {
      const body = await readJson<{ path?: unknown }>(req);
      if (!body || typeof body.path !== "string") return json({ error: "path is required" }, 400);
      const result = createRepoFolder(site.slug, body.path, actor);
      if (result.created) audit("repo_folder_created", `${site.slug}:${result.path}`);
      return json({ ok: true, ...result });
    }

    if (api === "rename" && req.method === "POST") {
      const body = await readJson<{ from?: unknown; to?: unknown }>(req);
      if (!body || typeof body.from !== "string" || typeof body.to !== "string") return json({ error: "from and to are required" }, 400);
      const result = renameRepoPath(site.slug, body.from, body.to, actor);
      audit("repo_renamed", `${site.slug}: ${result.from} -> ${result.to}`);
      return json({ ok: true, ...result });
    }

    if ((api === "move" || api === "copy") && req.method === "POST") {
      const body = await readJson<{ paths?: unknown; to?: unknown }>(req);
      const paths = Array.isArray(body?.paths) ? body!.paths.filter((p): p is string => typeof p === "string") : [];
      if (!paths.length) return json({ error: "paths is required" }, 400);
      const to = typeof body?.to === "string" ? body!.to : "";
      if (api === "move") {
        const result = moveRepoPaths(site.slug, paths, to, actor);
        audit("repo_moved", `${site.slug}: ${result.moved.length} item(s) -> /${to}`);
        return json({ ok: true, ...result });
      }
      const result = copyRepoPaths(site.slug, paths, to, actor);
      audit("repo_copied", `${site.slug}: ${result.copied.length} item(s) (${result.files} files) -> /${to}`);
      return json({ ok: true, ...result });
    }

    if (api === "delete" && req.method === "POST") {
      const body = await readJson<{ paths?: unknown }>(req);
      const paths = Array.isArray(body?.paths) ? body!.paths.filter((p): p is string => typeof p === "string") : [];
      if (!paths.length) return json({ error: "paths is required" }, 400);
      const result = deleteRepoPaths(site.slug, paths, actor);
      audit("repo_deleted", `${site.slug}: ${result.deleted.length} item(s) — ${result.deleted.slice(0, 20).map(d => d.path).join(", ")}${result.deleted.length > 20 ? ", …" : ""}`);
      return json({ ok: true, ...result });
    }

    if (api === "trash/restore" && req.method === "POST") {
      const body = await readJson<{ ids?: unknown }>(req);
      const ids = Array.isArray(body?.ids) ? body!.ids.filter((i): i is number => Number.isInteger(i)) : [];
      if (!ids.length) return json({ error: "ids is required" }, 400);
      const result = restoreRepoTrash(site.slug, ids, actor);
      audit("repo_trash_restored", `${site.slug}: ${result.restored.length} item(s)`);
      return json({ ok: true, ...result });
    }

    if (api === "trash/purge" && req.method === "POST") {
      const body = await readJson<{ ids?: unknown }>(req);
      const ids = Array.isArray(body?.ids) ? body!.ids.filter((i): i is number => Number.isInteger(i)) : null;
      const result = purgeRepoTrash(site.slug, ids);
      audit("repo_trash_purged", `${site.slug}: ${result.purged} item(s)`);
      return json({ ok: true, ...result });
    }

    if (api === "restore-version" && req.method === "POST") {
      const body = await readJson<{ path?: unknown; version?: unknown }>(req);
      if (!body || typeof body.path !== "string" || !Number.isInteger(body.version)) return json({ error: "path and version are required" }, 400);
      const result = restoreRepoVersion(site.slug, body.path, body.version as number, actor);
      audit("repo_version_restored", `${site.slug}:${result.file.path} <- v${body.version}`);
      return json({ ok: true, ...result });
    }

    if (api === "delete-version" && req.method === "POST") {
      const body = await readJson<{ path?: unknown; version?: unknown }>(req);
      if (!body || typeof body.path !== "string" || !Number.isInteger(body.version)) return json({ error: "path and version are required" }, 400);
      const ok = deleteRepoVersion(site.slug, body.path, body.version as number);
      if (ok) audit("repo_version_deleted", `${site.slug}:${body.path} v${body.version}`);
      return ok ? json({ ok: true }) : json({ error: "Version not found" }, 404);
    }

    if (api === "banner" && req.method === "POST") {
      const declared = parseInt(req.headers.get("content-length") || "0", 10) || 0;
      if (declared > 8 * 1024 * 1024) return json({ error: "Banner image must be 8 MB or smaller" }, 413);
      const bytes = new Uint8Array(await req.arrayBuffer());
      const result = setRepoBanner(site.slug, bytes);
      audit("repo_banner_set", `${site.slug} (${result.mime})`);
      return json({ ok: true, ...result });
    }
    if (api === "banner" && req.method === "DELETE") {
      clearRepoBanner(site.slug);
      audit("repo_banner_cleared", site.slug);
      return json({ ok: true });
    }
  } catch (e: any) {
    return json({ error: e?.message || "Request failed" }, 400);
  }

  return json({ error: "Not found" }, 404);
}

// --- UI document ---

let uiTemplateCache: { mtime: number; html: string } | null = null;

function serveUiDocument(basePath: string): Response {
  const file = join(REPO_UI_DIR, "index.html");
  if (!existsSync(file)) return new Response("Repository UI is not installed", { status: 500 });
  const st = statSync(file);
  if (!uiTemplateCache || uiTemplateCache.mtime !== st.mtimeMs) {
    uiTemplateCache = { mtime: st.mtimeMs, html: readFileSync(file, "utf8") };
  }
  const html = uiTemplateCache.html.replace(/<base\s+href="\/"\s*\/?>/i, `<base href="${basePath}">`);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Length": String(Buffer.byteLength(html)),
      "Content-Security-Policy": UI_CSP,
      "Referrer-Policy": "same-origin",
    },
  });
}

// --- Raw content ---

// Types a browser may interpret as a document with script or external
// references. These are only ever served inline under a `sandbox` CSP.
function isActiveType(mime: string): boolean {
  return mime === "text/html" || mime === "image/svg+xml" || mime === "application/xml" || mime === "text/xml" || mime === "application/xhtml+xml";
}

function serveContent(req: Request, abs: string, size: number, mime: string, name: string, sha256: string, forceDownload: boolean): Response {
  const etag = `"${sha256}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  const kind = previewKind(mime);
  const inline = !forceDownload && kind !== "none";
  const headers: Record<string, string> = {
    "Content-Type": isTextMime(mime) ? `${mime}; charset=utf-8` : mime,
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", name),
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "ETag": etag,
    "Accept-Ranges": "bytes",
  };
  if (inline && isActiveType(mime)) headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  // Markdown previews are rendered client-side from the text; the raw route
  // serves it as plain text so nothing tries to interpret it.
  if (mime === "text/markdown") headers["Content-Type"] = "text/plain; charset=utf-8";

  const file = Bun.file(abs);
  const range = req.headers.get("range");
  const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
  if (m && size > 0) {
    let start = m[1] ? parseInt(m[1], 10) : NaN;
    let end = m[2] ? parseInt(m[2], 10) : NaN;
    if (Number.isNaN(start)) { // suffix range: last N bytes
      const n = Number.isNaN(end) ? 0 : end;
      start = Math.max(0, size - n); end = size - 1;
    } else if (Number.isNaN(end) || end >= size) {
      end = size - 1;
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(file, { headers });
}

export { mimeForName };
