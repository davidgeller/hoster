// Repository descriptions and tags: the storage model, how they follow items
// through copy/rename/trash, backup round-trips, and the HTTP surface.
//
// HOSTER_HOME is set in test/preload.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createRepositorySite, putRepoFile, createRepoFolder, listRepoTree, getRepoFile, renameRepoPath, copyRepoPaths,
  deleteRepoPaths, listRepoTrash, restoreRepoTrash, exportRepoBackup, importRepoBackup,
  setRepoDescription, listRepoTags, createRepoTag, updateRepoTag, deleteRepoTag, tagRepoPaths, getRepoTag,
} from "../src/repo";
import { deleteSite } from "../src/sites";
import { createAdminUser } from "../src/auth";
import { createServer } from "../src/server";
import db from "../src/db";

const SLUG = "tag-docs";
const text = (s: string) => new TextEncoder().encode(s);

describe("descriptions and tags", () => {
  beforeAll(async () => {
    createRepositorySite(SLUG, "Tagged", {});
    await putRepoFile(SLUG, "reports/q1.pdf", text("q1"));
    await putRepoFile(SLUG, "reports/q2.pdf", text("q2"));
    await putRepoFile(SLUG, "notes.md", text("# notes"));
    createRepoFolder(SLUG, "archive");
  });
  afterAll(() => { try { deleteSite(SLUG); } catch (_) {} });

  test("descriptions attach to files and folders, and clear with empty text", () => {
    const f = setRepoDescription(SLUG, "reports/q1.pdf", "  First quarter numbers.\r\n\r\nFinal. ", "pat");
    expect(f.description).toBe("First quarter numbers.\n\nFinal.");
    expect(f.updated_by).toBe("pat");
    const d = setRepoDescription(SLUG, "archive", "Old stuff", "pat");
    expect(d.kind).toBe("dir");
    expect(d.description).toBe("Old stuff");
    expect(listRepoTree(SLUG).dirs.find(x => x.path === "archive")!.description).toBe("Old stuff");
    expect(setRepoDescription(SLUG, "archive", "   ").description).toBeNull();
    expect(() => setRepoDescription(SLUG, "missing.txt", "x")).toThrow(/does not exist/);
    expect(() => setRepoDescription(SLUG, "notes.md", "x".repeat(2001))).toThrow(/too long/);
    expect(() => setRepoDescription(SLUG, "notes.md", 42 as any)).toThrow(/must be text/);
  });

  test("tag library: create, validate, rename, recolour, delete", () => {
    const a = createRepoTag(SLUG, { name: "  Finance  ", color: "#2F6FED", description: "Money things" }, "pat");
    expect(a.name).toBe("Finance");
    expect(a.color).toBe("#2f6fed");
    expect(a.description).toBe("Money things");
    expect(a.created_by).toBe("pat");
    expect(a.item_count).toBe(0);
    const b = createRepoTag(SLUG, { name: "Draft" });
    expect(b.display_order).toBeGreaterThan(a.display_order);
    expect(b.color).toBeNull();
    expect(() => createRepoTag(SLUG, { name: "finance" })).toThrow(/already exists/);
    expect(() => createRepoTag(SLUG, { name: "" })).toThrow(/required/);
    expect(() => createRepoTag(SLUG, { name: "x".repeat(41) })).toThrow(/too long/);
    expect(() => createRepoTag(SLUG, { name: "ok", color: "blue" })).toThrow(/hex/);
    const renamed = updateRepoTag(SLUG, a.id, { name: "Accounting", color: null });
    expect(renamed.name).toBe("Accounting");
    expect(renamed.color).toBeNull();
    expect(() => updateRepoTag(SLUG, b.id, { name: "accounting" })).toThrow(/already exists/);
    expect(listRepoTags(SLUG).map(t => t.name)).toEqual(["Accounting", "Draft"]);
    expect(getRepoTag(SLUG, 999999)).toBeNull();
    expect(() => updateRepoTag(SLUG, 999999, { name: "x" })).toThrow(/not found/);
  });

  test("tags apply to any item, and are reported on the tree", () => {
    const [acct, draft] = listRepoTags(SLUG);
    const r = tagRepoPaths(SLUG, ["reports/q1.pdf", "reports/q2.pdf", "archive", "reports/q1.pdf"], { add: [acct.id] }, "pat");
    expect(r.paths).toEqual(["reports/q1.pdf", "reports/q2.pdf", "archive"]);
    expect(r.added).toBe(3);
    tagRepoPaths(SLUG, ["reports/q1.pdf"], { add: [draft.id] });
    const tree = listRepoTree(SLUG);
    expect(tree.files.find(f => f.path === "reports/q1.pdf")!.tags).toEqual([acct.id, draft.id]);
    expect(tree.files.find(f => f.path === "notes.md")!.tags).toEqual([]);
    expect(tree.dirs.find(d => d.path === "archive")!.tags).toEqual([acct.id]);
    expect(getRepoTag(SLUG, acct.id)!.item_count).toBe(3);
    // Idempotent adds, removes, and validation.
    expect(tagRepoPaths(SLUG, ["reports/q1.pdf"], { add: [acct.id] }).added).toBe(0);
    expect(tagRepoPaths(SLUG, ["reports/q1.pdf"], { remove: [draft.id] }).removed).toBe(1);
    expect(getRepoFile(SLUG, "reports/q1.pdf")!.tags).toEqual([acct.id]);
    expect(() => tagRepoPaths(SLUG, ["reports/q1.pdf"], { add: [999999] })).toThrow(/does not exist/);
    expect(() => tagRepoPaths(SLUG, ["nope.txt"], { add: [acct.id] })).toThrow(/does not exist/);
    expect(() => tagRepoPaths(SLUG, ["reports/q1.pdf"], {})).toThrow(/Nothing to change/);
    // Tags from another site can't be applied here.
    createRepositorySite("other-tags", "Other", {});
    const foreign = createRepoTag("other-tags", { name: "Foreign" });
    expect(() => tagRepoPaths(SLUG, ["reports/q1.pdf"], { add: [foreign.id] })).toThrow(/does not exist in this repository/);
    deleteSite("other-tags");
  });

  test("tags and descriptions follow renames, copies, and the trash", () => {
    const [acct] = listRepoTags(SLUG);
    renameRepoPath(SLUG, "reports/q1.pdf", "reports/2025-q1.pdf");
    const moved = getRepoFile(SLUG, "reports/2025-q1.pdf")!;
    expect(moved.tags).toEqual([acct.id]);
    expect(moved.description).toBe("First quarter numbers.\n\nFinal.");
    copyRepoPaths(SLUG, ["reports"], "archive");
    const copy = getRepoFile(SLUG, "archive/reports/2025-q1.pdf")!;
    expect(copy.tags).toEqual([acct.id]);
    expect(copy.description).toBe("First quarter numbers.\n\nFinal.");
    deleteRepoPaths(SLUG, ["archive/reports"]);
    const trashed = listRepoTrash(SLUG).find(t => t.path === "archive/reports/2025-q1.pdf")!;
    expect(trashed.tags).toEqual([acct.id]);
    // Trashed items don't count toward the tag's live total.
    expect(getRepoTag(SLUG, acct.id)!.item_count).toBe(3);
    restoreRepoTrash(SLUG, [listRepoTrash(SLUG).find(t => t.path === "archive/reports")!.id]);
    expect(getRepoFile(SLUG, "archive/reports/2025-q1.pdf")!.tags).toEqual([acct.id]);
    expect(getRepoTag(SLUG, acct.id)!.item_count).toBe(5);
  });

  test("deleting a tag removes it everywhere", () => {
    const [acct, draft] = listRepoTags(SLUG);
    expect(deleteRepoTag(SLUG, draft.id).removed_from).toBe(0);
    const r = deleteRepoTag(SLUG, acct.id);
    expect(r.removed_from).toBe(5);
    expect(listRepoTags(SLUG)).toEqual([]);
    expect(getRepoFile(SLUG, "reports/2025-q1.pdf")!.tags).toEqual([]);
    expect((db.query("SELECT COUNT(*) AS n FROM repo_item_tags it JOIN repo_files f ON f.id = it.file_id WHERE f.site_slug = ?").get(SLUG) as any).n).toBe(0);
    expect(() => deleteRepoTag(SLUG, acct.id)).toThrow(/not found/);
  });

  test("backups carry tags and descriptions, and restore them", async () => {
    const t = createRepoTag(SLUG, { name: "Keep", color: "#17a36a", description: "Long-term" });
    tagRepoPaths(SLUG, ["reports/2025-q1.pdf", "archive"], { add: [t.id] });
    const backup = await exportRepoBackup(SLUG);
    const bytes = new Uint8Array(await backup.file.arrayBuffer());
    // Wipe, then restore.
    deleteRepoTag(SLUG, t.id);
    setRepoDescription(SLUG, "reports/2025-q1.pdf", null);
    expect(listRepoTags(SLUG)).toEqual([]);
    await importRepoBackup(SLUG, Buffer.from(bytes));
    const tags = listRepoTags(SLUG);
    expect(tags.map(x => [x.name, x.color, x.description, x.item_count])).toEqual([["Keep", "#17a36a", "Long-term", 2]]);
    const f = getRepoFile(SLUG, "reports/2025-q1.pdf")!;
    expect(f.tags).toEqual([tags[0].id]);
    expect(f.description).toBe("First quarter numbers.\n\nFinal.");
    expect(getRepoFile(SLUG, "archive")!.tags).toEqual([tags[0].id]);
  });
});

describe("descriptions and tags over HTTP", () => {
  const PORT = 39811 + Math.floor(Math.random() * 200);
  let server: ReturnType<typeof createServer>;
  const base = () => `http://127.0.0.1:${PORT}`;
  const SITE = "tag-http";
  let cookie = "", csrf = "";
  const post = (api: string, body: any, auth = true) => fetch(`${base()}/${SITE}/_repo/api/${api}`, {
    method: "POST",
    headers: auth ? { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    createRepositorySite(SITE, "Tag HTTP", { visibility: "public" });
    await putRepoFile(SITE, "a.txt", text("a"));
    createRepoFolder(SITE, "folder");
    try { await createAdminUser("tagadmin", "tagadmin-pass-1", { isAdmin: true }); } catch (_) {}
    server = createServer(PORT);
    const res = await fetch(`${base()}/${SITE}/_repo/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tagadmin", password: "tagadmin-pass-1" }),
    });
    expect(res.status).toBe(200);
    csrf = (await res.json()).csrf_token;
    cookie = res.headers.get("set-cookie")!.split(";")[0];
  });
  afterAll(() => { server.stop(true); try { deleteSite(SITE); } catch (_) {} });

  test("writers manage the library and apply tags; readers see them on the tree", async () => {
    expect((await post("tags/create", { name: "Urgent" }, false)).status).toBe(401);
    const created = await post("tags/create", { name: "Urgent", color: "#d93a3a", description: "Needs eyes" });
    expect(created.status).toBe(200);
    const { tag } = await created.json();
    expect(tag.name).toBe("Urgent");
    const dup = await post("tags/create", { name: "urgent" });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already exists/);

    const applied = await post("tag", { paths: ["a.txt", "folder"], add: [tag.id] });
    expect(applied.status).toBe(200);
    expect((await applied.json()).added).toBe(2);
    const described = await post("describe", { path: "folder", description: "Things in a folder" });
    expect(described.status).toBe(200);
    expect((await described.json()).item.description).toBe("Things in a folder");

    // Anonymous readers of a public repository get tags and descriptions with the tree.
    const tree = await (await fetch(`${base()}/${SITE}/_repo/api/tree`)).json();
    expect(tree.tags.map((t: any) => t.name)).toEqual(["Urgent"]);
    expect(tree.tags[0].item_count).toBe(2);
    expect(tree.files.find((f: any) => f.path === "a.txt").tags).toEqual([tag.id]);
    expect(tree.dirs.find((d: any) => d.path === "folder").description).toBe("Things in a folder");
    const list = await (await fetch(`${base()}/${SITE}/_repo/api/tags`)).json();
    expect(list.tags.length).toBe(1);

    const updated = await post("tags/update", { id: tag.id, name: "Priority", color: null });
    expect(updated.status).toBe(200);
    expect((await updated.json()).tag).toMatchObject({ name: "Priority", color: null });
    const removed = await post("tag", { paths: ["a.txt"], remove: [tag.id] });
    expect((await removed.json()).removed).toBe(1);
    const gone = await post("tags/delete", { id: tag.id });
    expect((await gone.json()).removed_from).toBe(1);
    expect((await post("tags/delete", { id: tag.id })).status).toBe(400);
    expect((await post("tag", { paths: [], add: [1] })).status).toBe(400);
  });
});
