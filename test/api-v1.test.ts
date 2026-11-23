// External repository API (/api/v1): repository-bound keys and error codes,
// listing, search, idempotent share creation, anonymous share access,
// revocation, the no-redirect contract, and per-repository key management
// in the admin API.
//
// HOSTER_HOME is set in test/preload.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRepositorySite, putRepoFile, createRepoFolder, renameRepoPath, createRepoTag, tagRepoPaths, setRepoDescription, deleteRepoPaths, getRepoFile, purgeStaleRepoShares, listRepoTrash } from "../src/repo";
import { blockIp, invalidateBlockedCache } from "../src/analytics";
import { deleteSite, getSite, createBlankSite, changeSiteSlug } from "../src/sites";
import { createAdminUser, deleteAdminUser, getUserByUsername, createSession } from "../src/auth";
import { createServer } from "../src/server";
import { handleAdminApi } from "../src/admin-api";
import { createApiKey, revokeApiKey, listApiKeys } from "../src/api-v1";
import db from "../src/db";

const REPO = "apidocs";
const OTHER = "apiother";
const PASSWORD = "correct horse battery";
let server: ReturnType<typeof createServer>;
let base = "";
let adminId = 0, repoUserId = 0;
let fullKey = "", readOnlyKey = "", otherKey = "";
let repoId = "", otherId = "";

function headers(key: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "X-Real-IP": "10.9.0.1", ...extra };
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}
async function get(path: string, key: string | null = fullKey, extra: Record<string, string> = {}) {
  return fetch(base + path, { headers: headers(key, extra), redirect: "manual" });
}
async function post(path: string, body: unknown, key: string | null = fullKey, extra: Record<string, string> = {}) {
  return fetch(base + path, {
    method: "POST", redirect: "manual",
    headers: headers(key, { "Content-Type": "application/json", ...extra }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function del(path: string, key: string | null = fullKey) {
  return fetch(base + path, { method: "DELETE", headers: headers(key), redirect: "manual" });
}
async function errCode(res: Response) {
  const j = await res.json() as any;
  return j?.error?.code;
}
const inAYear = () => new Date(Date.now() + 364 * 86400_000).toISOString();

// Drive the admin API as a given account (real session + CSRF gates).
async function asUser(userId: number, method: string, path: string, body?: any) {
  const { sessionToken, csrfToken } = createSession("10.9.0.9", userId);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { cookie: `hoster_session=${sessionToken}`, "x-csrf-token": csrfToken, "x-real-ip": "10.9.0.9", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleAdminApi(req, path);
  if (!res) throw new Error(`No route for ${method} ${path}`);
  return { status: res.status, data: await res.json() as any };
}

beforeAll(async () => {
  createRepositorySite(REPO, "API Docs");
  createRepositorySite(OTHER, "Other Docs");
  createBlankSite("apiweb", "Not a repo");
  repoId = String(getSite(REPO)!.id);
  otherId = String(getSite(OTHER)!.id);
  createRepoFolder(REPO, "Contracts/2026");
  await putRepoFile(REPO, "Contracts/2026/acme msa.pdf", "%PDF-1.4 fake");
  await putRepoFile(REPO, "Contracts/readme.txt", "hello contracts");
  await putRepoFile(REPO, "Pricing.md", "# Pricing");
  await putRepoFile(OTHER, "secret pricing.txt", "other");
  const tag = createRepoTag(REPO, { name: "Legal" });
  tagRepoPaths(REPO, ["Contracts/readme.txt"], { add: [tag.id] });
  setRepoDescription(REPO, "Pricing.md", "Current price list for enterprise plans");

  adminId = await createAdminUser("apiadmin", PASSWORD, { isAdmin: true });
  repoUserId = await createAdminUser("apirepouser", PASSWORD, { sites: [REPO] });
  fullKey = createApiKey(REPO, { label: "CRM", expires_at: inAYear() }, "test").key;
  readOnlyKey = createApiKey(REPO, { label: "RO", can_share: false }, "test").key;
  otherKey = createApiKey(OTHER, { label: "Other CRM" }, "test").key;

  server = createServer(0);
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  for (const s of [REPO, OTHER, "apiweb", "apigone", "apirenamed"]) { try { deleteSite(s); } catch (_) {} }
  for (const u of ["apiadmin", "apirepouser"]) {
    const p = getUserByUsername(u);
    if (p) { try { deleteAdminUser(p.userId); } catch (_) {} }
  }
});

describe("authentication and errors", () => {
  test("missing key -> unauthorized with error envelope", async () => {
    const res = await get("/api/v1/whoami", null);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
  });

  test("unknown key -> unauthorized", async () => {
    const res = await get("/api/v1/whoami", "hk_nope");
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("unauthorized");
  });

  test("expired key -> key_expired, revoked key -> key_revoked", async () => {
    const { key, info } = createApiKey(REPO, { label: "Soon", expires_at: new Date(Date.now() + 60_000).toISOString() }, "test");
    db.run("UPDATE repo_api_keys SET expires_at = datetime('now', '-1 minute') WHERE id = ?", info.id);
    let res = await get("/api/v1/whoami", key);
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("key_expired");

    const r = createApiKey(REPO, { label: "Gone" }, "test");
    revokeApiKey(REPO, r.info.id);
    res = await get("/api/v1/whoami", r.key);
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("key_revoked");
  });

  test("deleting the repository deletes its keys", async () => {
    createRepositorySite("apigone", "Doomed");
    const { key } = createApiKey("apigone", { label: "Doomed" }, "test");
    expect((await get("/api/v1/whoami", key)).status).toBe(200);
    deleteSite("apigone");
    const res = await get("/api/v1/whoami", key);
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("unauthorized");
    expect(db.query("SELECT COUNT(*) AS n FROM repo_api_keys WHERE label = 'Doomed'").get()).toEqual({ n: 0 });
  });

  test("keys can't be made for web sites", () => {
    expect(() => createApiKey("apiweb", { label: "x" }, "test")).toThrow(/only available for repositories/);
  });

  test("unknown endpoint -> not_found; wrong method -> invalid_request", async () => {
    let res = await get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("not_found");
    res = await post("/api/v1/whoami", {});
    expect(res.status).toBe(405);
    expect(await errCode(res)).toBe("invalid_request");
  });
});

describe("whoami", () => {
  test("names the key's repository and returns expires_at as ISO, or null", async () => {
    let j = await (await get("/api/v1/whoami")).json() as any;
    expect(j.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(j.label).toBe("CRM");
    expect(j.key_id).toMatch(/^key_[0-9a-f]{16}$/);
    expect(j.scopes).toEqual(["read", "share"]);
    expect(j.repository).toEqual({ id: repoId, slug: REPO, name: "API Docs" });
    expect(j.account).toBeUndefined();
    j = await (await get("/api/v1/whoami", readOnlyKey)).json() as any;
    expect(j.expires_at).toBeNull();
    expect(j.scopes).toEqual(["read"]);
  });
});

describe("no redirects", () => {
  test("trailing slashes are answered in place", async () => {
    for (const p of ["/api/v1/whoami/", "/api/v1/repositories/", `/api/v1/repositories/${repoId}/`]) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
    const res = await get("/api/v1");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  test("'api' is a reserved slug", () => {
    expect(() => createBlankSite("api", "x")).toThrow(/reserved/);
  });
});

describe("a key reaches exactly one repository", () => {
  test("lists only its own repository, as a bare array", async () => {
    let list = await (await get("/api/v1/repositories")).json() as any[];
    expect(list.map(r => r.id)).toEqual([repoId]);
    expect(list[0]).toMatchObject({ name: "API Docs", slug: REPO, url: `/${REPO}/`, file_count: 3, folder_count: 2, can_share: true });
    list = await (await get("/api/v1/repositories", otherKey)).json() as any[];
    expect(list.map(r => r.id)).toEqual([otherId]);
  });

  test("another repository looks exactly like a missing one", async () => {
    // No existence oracle: a real foreign repository, a web site, and an
    // unused id all answer the same 404.
    const bodies: string[] = [];
    for (const id of [otherId, String(getSite("apiweb")!.id), "99999"]) {
      const r = await get(`/api/v1/repositories/${id}`);
      expect(r.status).toBe(404);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
    let res = await get(`/api/v1/repositories/${otherId}/items`);
    expect(await errCode(res)).toBe("not_found");
    // An item id from the other repository, asked for under this one.
    const otherItems = await (await get(`/api/v1/repositories/${otherId}/items`, otherKey)).json() as any[];
    res = await get(`/api/v1/repositories/${repoId}/items/${otherItems[0].id}`);
    expect(res.status).toBe(404);
    // Search never crosses over, even unscoped.
    const hits = await (await get("/api/v1/search?q=pricing")).json() as any[];
    expect(hits.every(i => i.repository_id === repoId)).toBe(true);
    expect(hits.map(i => i.name)).toEqual(["Pricing.md"]);
    res = await get(`/api/v1/search?q=a&repository_id=${otherId}`);
    expect(await errCode(res)).toBe("not_found");
    // A share in the other repository can't be revoked from here.
    const s = await (await post(`/api/v1/repositories/${otherId}/items/${otherItems[0].id}/shares`, { expires_at: null, label: "x" }, otherKey)).json() as any;
    res = await del(`/api/v1/shares/${s.share_id}`);
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("not_found");
    expect((await del(`/api/v1/shares/${s.share_id}`, otherKey)).status).toBe(204);
  });

  test("unknown repository is not_found", async () => {
    const res = await get(`/api/v1/repositories/99999`);
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("not_found");
  });

  test("keys and ids survive a slug change", async () => {
    createRepositorySite("apirenamed-src", "Renamed");
    const { key } = createApiKey("apirenamed-src", { label: "Rename" }, "test");
    const id = String(getSite("apirenamed-src")!.id);
    changeSiteSlug("apirenamed-src", "apirenamed");
    const j = await (await get("/api/v1/whoami", key)).json() as any;
    expect(j.repository).toMatchObject({ id, slug: "apirenamed" });
  });
});

describe("items", () => {
  test("browses root, folders, and nested folders", async () => {
    const root = await (await get(`/api/v1/repositories/${repoId}/items`)).json() as any[];
    expect(root.map(i => [i.name, i.type])).toEqual([["Contracts", "folder"], ["Pricing.md", "file"]]);
    expect(root.every(i => i.parent_id === null)).toBe(true);
    const contracts = root[0];
    const kids = await (await get(`/api/v1/repositories/${repoId}/items/${contracts.id}/children`)).json() as any[];
    expect(kids.map(i => i.name)).toEqual(["2026", "readme.txt"]);
    expect(kids.every(i => i.parent_id === contracts.id)).toBe(true);
    expect(kids[1].tags).toEqual(["Legal"]);
    const viaQuery = await (await get(`/api/v1/repositories/${repoId}/items?parent_id=${encodeURIComponent(kids[0].id)}`)).json() as any[];
    expect(viaQuery.map(i => i.name)).toEqual(["acme msa.pdf"]);
    expect(viaQuery[0]).toMatchObject({ type: "file", size: 13, mime_type: "application/pdf", version: 1, path: "Contracts/2026/acme msa.pdf" });
    expect(viaQuery[0].updated_at).toMatch(/Z$/);
    // Hoster account names are not part of the API.
    expect(viaQuery[0].created_by).toBeUndefined();
    expect(viaQuery[0].updated_by).toBeUndefined();
  });

  test("item ids survive a rename", async () => {
    const root = await (await get(`/api/v1/repositories/${repoId}/items`)).json() as any[];
    const pricing = root.find(i => i.name === "Pricing.md");
    renameRepoPath(REPO, "Pricing.md", "Pricing 2026.md");
    const again = await (await get(`/api/v1/repositories/${repoId}/items/${pricing.id}`)).json() as any;
    expect(again.name).toBe("Pricing 2026.md");
    renameRepoPath(REPO, "Pricing 2026.md", "Pricing.md");
  });

  test("downloads file content", async () => {
    const kids = await (await get(`/api/v1/repositories/${repoId}/items`)).json() as any[];
    const pricing = kids.find(i => i.name === "Pricing.md");
    const res = await get(`/api/v1/repositories/${repoId}/items/${pricing.id}/content`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Pricing");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });
});

describe("search", () => {
  test("bare array, name matches first, covers descriptions and tags", async () => {
    let res = await (await get("/api/v1/search?q=enterprise")).json() as any[];
    expect(res.map(i => i.name)).toEqual(["Pricing.md"]);
    res = await (await get("/api/v1/search?q=legal")).json() as any[];
    expect(res.map(i => i.name)).toEqual(["readme.txt"]);
    res = await (await get(`/api/v1/search?q=contracts&type=folder&repository_id=${repoId}`)).json() as any[];
    expect(res.map(i => i.path)).toEqual(["Contracts", "Contracts/2026"]);
  });

  test("validates parameters; % and _ are literal", async () => {
    let r = await get("/api/v1/search");
    expect(r.status).toBe(400);
    expect(await errCode(r)).toBe("invalid_request");
    r = await get("/api/v1/search?q=a&limit=0");
    expect(await errCode(r)).toBe("invalid_request");
    expect(await (await get("/api/v1/search?q=%25")).json()).toEqual([]);
  });
});

describe("shares", () => {
  let fileId = "", folderId = "";
  beforeAll(async () => {
    const root = await (await get(`/api/v1/repositories/${repoId}/items`)).json() as any[];
    fileId = root.find(i => i.name === "Pricing.md").id;
    folderId = root.find(i => i.name === "Contracts").id;
  });

  test("same Idempotency-Key returns the same share and url", async () => {
    const body = { expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), label: "Acme deal" };
    const path = `/api/v1/repositories/${encodeURIComponent(repoId)}/items/${encodeURIComponent(fileId)}/shares`;
    const a = await post(path, body, fullKey, { "Idempotency-Key": "crm-123" });
    expect(a.status).toBe(201);
    const sa = await a.json() as any;
    const b = await post(path, body, fullKey, { "Idempotency-Key": "crm-123" });
    expect(b.status).toBe(200);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    const sb = await b.json() as any;
    expect(sb.share_id).toBe(sa.share_id);
    expect(sb.url).toBe(sa.url);
    expect(sa).toMatchObject({ label: "Acme deal", item_id: fileId, repository_id: repoId, active: true });
    expect(Math.abs(new Date(sa.expires_at).getTime() - new Date(body.expires_at).getTime())).toBeLessThan(1000);
    // Different Idempotency-Key -> different share.
    const c = await (await post(path, body, fullKey, { "Idempotency-Key": "crm-124" })).json() as any;
    expect(c.share_id).not.toBe(sa.share_id);
    expect(c.url).not.toBe(sa.url);
    // The same Idempotency-Key from a different API key is independent.
    const k2 = createApiKey(REPO, { label: "Second CRM" }, "test").key;
    const d = await (await post(path, body, k2, { "Idempotency-Key": "crm-123" })).json() as any;
    expect(d.share_id).not.toBe(sa.share_id);
    // Reusing a key for a different request is refused.
    const e = await post(path, { ...body, label: "changed" }, fullKey, { "Idempotency-Key": "crm-123" });
    expect(e.status).toBe(422);
    expect(await errCode(e)).toBe("invalid_request");
  });

  test("relative share url opens anonymously; DELETE revokes with 204", async () => {
    const created = await (await post(`/api/v1/repositories/${repoId}/items/${fileId}/shares`, { expires_at: null, label: "" })).json() as any;
    expect(created.expires_at).toBeNull();
    expect(created.url).toMatch(new RegExp(`^/${REPO}/_repo/s/[A-Za-z0-9_-]{43}$`));
    let res = await fetch(base + created.url, { headers: { "X-Real-IP": "10.9.0.2" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Pricing");

    expect((await del(`/api/v1/shares/${encodeURIComponent(created.share_id)}`)).status).toBe(204);
    res = await fetch(base + created.url, { headers: { "X-Real-IP": "10.9.0.2" } });
    expect(res.status).not.toBe(200);
    expect((await del(`/api/v1/shares/${created.share_id}`)).status).toBe(204);
    const missing = await del(`/api/v1/shares/999999`);
    expect(missing.status).toBe(404);
    expect(await errCode(missing)).toBe("not_found");
  });

  test("links stay relative whatever host the request used; folder shares open", async () => {
    const res = await post(`/api/v1/repositories/${repoId}/items/${folderId}/shares`, { expires_at: null, label: "folder" }, fullKey, { Host: "docs.example.com" });
    const s = await res.json() as any;
    expect(s.url).toMatch(new RegExp(`^/${REPO}/_repo/s/[A-Za-z0-9_-]{43}$`));
    expect(s.type).toBe("folder");
    const page = await fetch(base + s.url, { headers: { "X-Real-IP": "10.9.0.3" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("readme.txt");
  });

  test("read-only keys can't share", async () => {
    const res = await post(`/api/v1/repositories/${repoId}/items/${fileId}/shares`, { expires_at: null, label: "x" }, readOnlyKey);
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("forbidden");
  });

  test("a huge body is refused without being buffered", async () => {
    const path = `/api/v1/repositories/${repoId}/items/${fileId}/shares`;
    // Chunked with no Content-Length: 8 MB streamed must stop at the 16 KB cap.
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const stream = new ReadableStream({
      pull(c) { if (sent >= 8 * 1024 * 1024) { c.close(); return; } sent += chunk.byteLength; c.enqueue(chunk); },
    });
    let res = await fetch(base + path, { method: "POST", headers: headers(fullKey, { "Content-Type": "application/json" }), body: stream, duplex: "half" } as any);
    expect(res.status).toBe(413);
    expect(await errCode(res)).toBe("invalid_request");
    // Invalid UTF-8 is rejected, not mangled.
    res = await fetch(base + path, { method: "POST", headers: headers(fullKey, { "Content-Type": "application/json" }), body: new Uint8Array([0x7b, 0xff, 0x7d]) });
    expect(res.status).toBe(400);
  });

  test("validates the body", async () => {
    const path = `/api/v1/repositories/${repoId}/items/${fileId}/shares`;
    for (const body of [{ expires_at: "yesterday", label: "" }, { expires_at: "2001-01-01T00:00:00Z", label: "" }, { expires_at: null, label: 5 }, "not json"]) {
      const res = await post(path, body);
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("invalid_request");
    }
    const far = await post(path, { expires_at: new Date(Date.now() + 400 * 86400_000).toISOString(), label: "" });
    expect(await errCode(far)).toBe("invalid_request");
  });
});

describe("admin API: keys live in the repository's settings", () => {
  test("an administrator creates, lists, and revokes a key (password required)", async () => {
    let r = await asUser(adminId, "POST", `/_admin/api/sites/${REPO}/api-keys`, { label: "From UI", expires_in_days: 30 });
    expect(r.status).toBe(400); // no confirm_password
    r = await asUser(adminId, "POST", `/_admin/api/sites/${REPO}/api-keys`, { label: "From UI", expires_in_days: 30, confirm_password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.data.key).toMatch(/^hk_/);
    expect(r.data.api_key).toMatchObject({ label: "From UI", repository_id: repoId, status: "active" });
    const who = await (await get("/api/v1/whoami", r.data.key)).json() as any;
    expect(who.repository.id).toBe(repoId);

    const list = await asUser(adminId, "GET", `/_admin/api/sites/${REPO}/api-keys`);
    expect(list.data.keys.map((k: any) => k.label)).toContain("From UI");
    expect(list.data.keys.every((k: any) => k.repository_id === repoId)).toBe(true);

    const rev = await asUser(adminId, "POST", `/_admin/api/sites/${REPO}/api-keys/${r.data.api_key.id}/revoke`);
    expect(rev.data.api_key.status).toBe("revoked");
    expect(await errCode(await get("/api/v1/whoami", r.data.key))).toBe("key_revoked");
    const gone = await asUser(adminId, "DELETE", `/_admin/api/sites/${REPO}/api-keys/${r.data.api_key.id}`);
    expect(gone.status).toBe(200);
  });

  test("a site user manages keys for their repository only", async () => {
    const mine = await asUser(repoUserId, "POST", `/_admin/api/sites/${REPO}/api-keys`, { label: "Mine", confirm_password: PASSWORD });
    expect(mine.status).toBe(200);
    const theirs = await asUser(repoUserId, "GET", `/_admin/api/sites/${OTHER}/api-keys`);
    expect(theirs.status).toBe(403);
    const create = await asUser(repoUserId, "POST", `/_admin/api/sites/${OTHER}/api-keys`, { label: "Sneaky", confirm_password: PASSWORD });
    expect(create.status).toBe(403);
  });

  test("a key id from another repository can't be revoked through this one", async () => {
    const otherKeyId = listApiKeys(OTHER)[0].id;
    const r = await asUser(adminId, "POST", `/_admin/api/sites/${REPO}/api-keys/${otherKeyId}/revoke`);
    expect(r.status).toBe(404);
    expect((await get("/api/v1/whoami", otherKey)).status).toBe(200);
  });

  test("web sites have no API keys", async () => {
    const r = await asUser(adminId, "GET", `/_admin/api/sites/apiweb/api-keys`);
    expect(r.status).toBe(400);
  });
});

describe("security regressions", () => {
  test("a folder share never reaches a sibling folder that differs only in case", async () => {
    await putRepoFile(REPO, "Public/ok.txt", "ok");
    await putRepoFile(REPO, "public/salaries.txt", "SALARY-CANARY");
    const root = await (await get(`/api/v1/repositories/${repoId}/items`)).json() as any[];
    const pub = root.find(i => i.path === "Public");
    // API listing
    const kids = await (await get(`/api/v1/repositories/${repoId}/items/${pub.id}/children`)).json() as any[];
    expect(kids.map(k => k.path)).toEqual(["Public/ok.txt"]);
    // Anonymous share page and its zip
    const share = await (await post(`/api/v1/repositories/${repoId}/items/${pub.id}/shares`, { expires_at: null, label: "case" })).json() as any;
    const page = await (await fetch(base + share.url, { headers: { "X-Real-IP": "10.9.0.4" } })).text();
    expect(page).toContain("ok.txt");
    expect(page).not.toContain("salaries");
    const zip = new Uint8Array(await (await fetch(base + share.url + "?dl=1", { headers: { "X-Real-IP": "10.9.0.4" } })).arrayBuffer());
    expect(new TextDecoder("latin1").decode(zip)).not.toContain("salaries");
    // The same rule protects the repository's own folder operations.
    deleteRepoPaths(REPO, ["Public"]);
    expect(getRepoFile(REPO, "public/salaries.txt")).not.toBeNull();
    expect(listRepoTrash(REPO).map(t => t.path)).not.toContain("public/salaries.txt");
  });

  test("a revoked, purged share never comes back under the same Idempotency-Key", async () => {
    const root = await (await get(`/api/v1/repositories/${repoId}/items`)).json() as any[];
    const file = root.find(i => i.name === "Pricing.md");
    const path = `/api/v1/repositories/${repoId}/items/${file.id}/shares`;
    const body = { expires_at: null, label: "leaky" };
    const first = await (await post(path, body, fullKey, { "Idempotency-Key": "deal-42" })).json() as any;
    expect((await del(`/api/v1/shares/${first.share_id}`)).status).toBe(204);
    // Age the revocation past the 30-day purge and purge.
    db.run("UPDATE repo_shares SET revoked_at = datetime('now', '-31 days') WHERE id = ?", Number(first.share_id));
    expect(purgeStaleRepoShares()).toBeGreaterThan(0);
    const again = await post(path, body, fullKey, { "Idempotency-Key": "deal-42" });
    expect(again.status).toBe(201);
    const second = await again.json() as any;
    expect(second.url).not.toBe(first.url);
    const old = await fetch(base + first.url, { headers: { "X-Real-IP": "10.9.0.5" } });
    expect(old.status).not.toBe(200);
  });

  test("bad guesses from an address don't lock out a valid key on it", async () => {
    const ip = { "X-Real-IP": "10.9.0.77" };
    let r: Response | null = null;
    for (let i = 0; i < 35; i++) r = await get("/api/v1/whoami", `hk_guess${i}`, ip);
    expect(r!.status).toBe(429);
    expect((await get("/api/v1/whoami", fullKey, ip)).status).toBe(200);
  });

  test("a blocked IP can't use the API, even with a valid key", async () => {
    blockIp("10.9.0.88", "test", 1);
    const r = await get("/api/v1/whoami", fullKey, { "X-Real-IP": "10.9.0.88" });
    expect(r.status).toBe(403);
    expect(await errCode(r)).toBe("forbidden");
    db.run("DELETE FROM blocked_ips WHERE ip = '10.9.0.88'");
    invalidateBlockedCache();
  });
});

describe("rate limiting", () => {
  test("too many requests -> rate_limited with Retry-After", async () => {
    const { key } = createApiKey(REPO, { label: "Burst" }, "test");
    let last: Response | null = null;
    for (let i = 0; i < 245; i++) {
      last = await get("/api/v1/whoami", key);
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await errCode(last!)).toBe("rate_limited");
  });
});
