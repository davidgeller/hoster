// Site groups (v2.9.0) and changing a site's slug.
//
// Groups: CRUD, multi-membership, cascade on site delete, the per-account
// remembered selection, and the admin-API gates (site users read a filtered
// view and may store their selection, nothing more).
//
// Slug change: every reference follows the site (DB rows in every table, the
// folder on disk, the absolute _current symlink, the default landing page),
// pins survive, and every collision is refused without touching anything.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "fs";
import { join } from "path";
import db from "../src/db";
import {
  SITES_DIR, createBlankSite, deleteSite, getSite, listSites, listVersions,
  addAlias, getAliases, addHostAlias, getHostAliases, resolveHostAlias,
  setSitePinned, changeSiteSlug, checkSiteHealth, setDefaultSite, getDefaultSite,
  resolveSitePath,
} from "../src/sites";
import {
  listGroups, createGroup, updateGroup, deleteGroup, reorderGroups,
  setSiteGroups, getSiteGroupIds, getSelectedGroup, setSelectedGroup, joinSelectedGroup,
} from "../src/groups";
import { createAdminUser, createSession, getUserSiteSlugs } from "../src/auth";
import { createRule, listRules } from "../src/protect";
import { createCollectionSite, planCollectionItems, setCollectionItems, listCollectionItems } from "../src/collection";
import { handleAdminApi } from "../src/admin-api";

const IP = "203.0.113.77";
const PW = "correct-horse-battery";

function reset() {
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM admin_users");
  db.exec("DELETE FROM site_groups");
  db.exec("DELETE FROM config WHERE key = 'default_site'");
  for (const s of listSites()) deleteSite(s.slug);
  setDefaultSite({ target: "" });
}
beforeEach(reset);

async function asUser(userId: number, method: string, path: string, body?: any) {
  const { sessionToken, csrfToken } = createSession(IP, userId);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `hoster_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
      "x-real-ip": IP,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleAdminApi(req, path);
  if (!res) throw new Error(`No route for ${method} ${path}`);
  return { status: res.status, data: await res.json() as any };
}

describe("site groups", () => {
  test("a site can belong to several groups; names are unique case-insensitively", () => {
    createBlankSite("alpha", "Alpha");
    createBlankSite("beta", "Beta");
    const work = createGroup("Work", ["alpha", "beta"]);
    const fav = createGroup("Favorites", ["alpha"]);
    expect(work.slugs).toEqual(["alpha", "beta"]);
    expect(getSiteGroupIds("alpha").sort()).toEqual([work.id, fav.id].sort());
    expect(() => createGroup("work")).toThrow(/already exists/);
    expect(() => createGroup("  ")).toThrow(/required/);
    expect(() => createGroup("Ghosts", ["nope"])).toThrow(/does not exist/);
    expect(() => updateGroup(fav.id, { name: "WORK" })).toThrow(/already exists/);
  });

  test("update, setSiteGroups, reorder and delete", () => {
    createBlankSite("alpha", "Alpha");
    createBlankSite("beta", "Beta");
    const a = createGroup("A");
    const b = createGroup("B");
    expect(updateGroup(a.id, { name: "Renamed", slugs: ["beta"] })).toMatchObject({ name: "Renamed", slugs: ["beta"] });
    expect(setSiteGroups("alpha", [a.id, b.id])).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(() => setSiteGroups("alpha", [99999])).toThrow(/not found/);
    expect(reorderGroups([b.id, a.id]).map(g => g.id)).toEqual([b.id, a.id]);
    expect(deleteGroup(a.id)).toBe(true);
    expect(listGroups().map(g => g.name)).toEqual(["B"]);
    expect(getSite("alpha")).not.toBeNull(); // deleting a group never touches sites
  });

  test("deleting a site removes it from every group", () => {
    createBlankSite("alpha", "Alpha");
    createBlankSite("beta", "Beta");
    const g = createGroup("G", ["alpha", "beta"]);
    deleteSite("alpha");
    expect(listGroups().find(x => x.id === g.id)!.slugs).toEqual(["beta"]);
  });

  test("selection is remembered per account and cleared when the group goes", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const other = await createAdminUser("other", PW, { isAdmin: true });
    const g = createGroup("G");
    expect(getSelectedGroup(root)).toBeNull();
    setSelectedGroup(root, g.id);
    expect(getSelectedGroup(root)).toBe(g.id);
    expect(getSelectedGroup(other)).toBeNull();
    expect(() => setSelectedGroup(root, 12345)).toThrow(/not found/);
    deleteGroup(g.id);
    expect(getSelectedGroup(root)).toBeNull();
  });

  test("a new site, repository or collection joins the creator's selected group", async () => {
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const other = await createAdminUser("other", PW, { isAdmin: true });
    const g = createGroup("Clients");
    setSelectedGroup(root, g.id);

    expect((await asUser(root, "POST", "/_admin/api/sites/blank", { slug: "new-blank" })).status).toBe(200);
    expect((await asUser(root, "POST", "/_admin/api/sites/repository", { slug: "new-repo" })).status).toBe(200);
    expect((await asUser(root, "POST", "/_admin/api/sites/collection", { slug: "new-coll" })).status).toBe(200);
    // Another account with "All sites" selected adds nothing to the group.
    expect((await asUser(other, "POST", "/_admin/api/sites/blank", { slug: "elsewhere" })).status).toBe(200);

    expect(listGroups().find(x => x.id === g.id)!.slugs).toEqual(["new-blank", "new-coll", "new-repo"]);
    expect(getSiteGroupIds("elsewhere")).toEqual([]);
    expect(joinSelectedGroup(other, "elsewhere")).toBeNull();
  });

  test("admin API: administrators manage groups; site users see a filtered view and store only their selection", async () => {
    createBlankSite("alpha", "Alpha");
    createBlankSite("beta", "Beta");
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const editor = await createAdminUser("editor", PW, { sites: ["alpha"] });

    const created = await asUser(root, "POST", "/_admin/api/site-groups", { name: "Clients", slugs: ["alpha", "beta"] });
    expect(created.status).toBe(200);
    const id = created.data.group.id;
    const betaOnly = (await asUser(root, "POST", "/_admin/api/site-groups", { name: "Beta only", slugs: ["beta"] })).data.group.id;

    // Site user: sees Clients narrowed to alpha, and not "Beta only" at all.
    const view = await asUser(editor, "GET", "/_admin/api/site-groups");
    expect(view.status).toBe(200);
    expect(view.data.groups).toEqual([{ id, name: "Clients", position: expect.any(Number), slugs: ["alpha"] }]);

    expect((await asUser(editor, "POST", "/_admin/api/site-groups/selected", { group_id: id })).status).toBe(200);
    expect((await asUser(editor, "GET", "/_admin/api/site-groups")).data.selected).toBe(id);

    // ...but can't create, edit, delete, reorder, or change memberships.
    expect((await asUser(editor, "POST", "/_admin/api/site-groups", { name: "Mine" })).status).toBe(403);
    expect((await asUser(editor, "POST", `/_admin/api/site-groups/${id}`, { name: "x" })).status).toBe(403);
    expect((await asUser(editor, "DELETE", `/_admin/api/site-groups/${betaOnly}`)).status).toBe(403);
    expect((await asUser(editor, "POST", "/_admin/api/site-groups/reorder", { ids: [] })).status).toBe(403);
    expect((await asUser(editor, "POST", "/_admin/api/sites/alpha/groups", { group_ids: [] })).status).toBe(403);

    // Administrator: membership from the site's side.
    const set = await asUser(root, "POST", "/_admin/api/sites/alpha/groups", { group_ids: [betaOnly] });
    expect(set.data.group_ids).toEqual([betaOnly]);
    expect((await asUser(root, "GET", "/_admin/api/sites/alpha/groups")).data.group_ids).toEqual([betaOnly]);
    expect((await asUser(root, "DELETE", `/_admin/api/site-groups/${id}`)).status).toBe(200);
    expect((await asUser(editor, "GET", "/_admin/api/site-groups")).data.selected).toBeNull();
  });
});

describe("changing a site's slug", () => {
  test("every reference follows the site", async () => {
    createBlankSite("old-name", "My Site");
    const before = getSite("old-name")!;
    setSitePinned("old-name", true);
    addAlias("legacy", "old-name");
    addHostAlias("example.com", "old-name");
    const user = await createAdminUser("editor", PW, { sites: ["old-name"] });
    const g = createGroup("Group", ["old-name"]);
    createRule("old-name", { path_prefix: "/members/" });
    createCollectionSite("hub", "Hub");
    setCollectionItems("hub", planCollectionItems("hub", [{ slug: "old-name" }]).items);
    setDefaultSite({ target: "old-name" });
    db.run("INSERT INTO requests (site_slug, path, method, status, ip) VALUES ('old-name', '/', 'GET', 200, '1.2.3.4')");

    const res = changeSiteSlug("old-name", "new-name");
    expect(res).toEqual({ old_slug: "old-name", slug: "new-name", alias_kept: false });

    expect(getSite("old-name")).toBeNull();
    const after = getSite("new-name")!;
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("My Site");
    expect(after.pinned_at).not.toBeNull();
    expect(after.current_version).toBe(before.current_version);
    expect(listVersions("new-name").length).toBe(1);
    expect(getAliases("new-name")).toEqual(["legacy"]);
    expect(getHostAliases("new-name")).toEqual(["example.com"]);
    expect(resolveHostAlias("example.com")).toBe("new-name");
    expect(getUserSiteSlugs(user)).toEqual(["new-name"]);
    expect(listGroups().find(x => x.id === g.id)!.slugs).toEqual(["new-name"]);
    expect(listRules("new-name").length).toBe(1);
    expect(listCollectionItems("hub").map(i => i.item_slug)).toEqual(["new-name"]);
    expect(getDefaultSite().target).toBe("new-name");
    expect((db.query("SELECT COUNT(*) AS n FROM requests WHERE site_slug = 'new-name'").get() as any).n).toBe(1);

    // Disk: folder moved, _current points into it, the site serves.
    expect(existsSync(join(SITES_DIR, "old-name"))).toBe(false);
    expect(realpathSync(join(SITES_DIR, "new-name", "_current"))).toBe(realpathSync(join(SITES_DIR, "new-name", after.current_version!)));
    expect(checkSiteHealth("new-name").status).toBe("ok");
    const served = resolveSitePath("new-name", "index.html");
    expect(served && readFileSync(served.filePath, "utf8")).toContain("<");
  });

  test("keep_alias leaves the old slug resolving to the site", () => {
    createBlankSite("first", "First");
    changeSiteSlug("first", "second", { keepAlias: true });
    expect(getAliases("second")).toEqual(["first"]);
    // ...and the old slug can later be reclaimed by renaming back onto it.
    changeSiteSlug("second", "first");
    expect(getSite("first")).not.toBeNull();
    expect(getAliases("first")).toEqual([]);
  });

  test("collisions and invalid slugs are refused without changing anything", () => {
    createBlankSite("one", "One");
    createBlankSite("two", "Two");
    addAlias("two-alias", "two");
    mkdirSync(join(SITES_DIR, "orphan"), { recursive: true });

    expect(() => changeSiteSlug("one", "two")).toThrow(/already exists/);
    expect(() => changeSiteSlug("one", "two-alias")).toThrow(/alias of the site 'two'/);
    expect(() => changeSiteSlug("one", "orphan")).toThrow(/folder named 'orphan'/);
    expect(() => changeSiteSlug("one", "one")).toThrow(/same/);
    expect(() => changeSiteSlug("one", "Bad Slug")).toThrow(/lowercase/);
    expect(() => changeSiteSlug("one", "-x")).toThrow(/lowercase/);
    expect(() => changeSiteSlug("one", "repair")).toThrow(/reserved/);
    expect(() => changeSiteSlug("nope", "whatever")).toThrow(/does not exist/);

    expect(getSite("one")).not.toBeNull();
    expect(getSite("two")).not.toBeNull();
    expect(checkSiteHealth("one").status).toBe("ok");
    expect(existsSync(join(SITES_DIR, "orphan"))).toBe(true);
    rmSync(join(SITES_DIR, "orphan"), { recursive: true });
  });

  test("admin API: administrators only, with the error surfaced", async () => {
    createBlankSite("site-a", "A");
    createBlankSite("site-b", "B");
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const editor = await createAdminUser("editor", PW, { sites: ["site-a"] });

    expect((await asUser(editor, "POST", "/_admin/api/sites/site-a/slug", { new_slug: "site-c" })).status).toBe(403);
    const clash = await asUser(root, "POST", "/_admin/api/sites/site-a/slug", { new_slug: "site-b" });
    expect(clash.status).toBe(400);
    expect(clash.data.error).toMatch(/already exists/);
    const ok = await asUser(root, "POST", "/_admin/api/sites/site-a/slug", { new_slug: "site-c", keep_alias: true });
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ old_slug: "site-a", slug: "site-c", alias_kept: true });
    // The editor's grant moved with the site.
    expect((await asUser(editor, "GET", "/_admin/api/sites/site-c")).status).toBe(200);
  });
});

describe("backup and restore", () => {
  test("groups, memberships, and each account's selection survive a round trip", async () => {
    const { createBackup, restoreBackup } = await import("../src/backup");
    createBlankSite("kept", "Kept");
    const root = await createAdminUser("root", PW, { isAdmin: true });
    const g = createGroup("Keepers", ["kept"]);
    createGroup("Empty");
    setSelectedGroup(root, g.id);
    const backup = await createBackup(undefined, false);
    deleteGroup(g.id);
    await restoreBackup(backup);
    expect(listGroups().map(x => [x.name, x.slugs])).toEqual([["Keepers", ["kept"]], ["Empty", []]]);
    expect(getSelectedGroup(root)).toBe(g.id);
  });
});
