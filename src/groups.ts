// Site groups: named sets of sites that the Sites page can filter to with one
// click. A site may belong to any number of groups. Groups are shared across
// every account (like pins) and managed by administrators; a site user sees
// each group narrowed to the sites they can access. Which group an account
// last selected is remembered per account (admin_users.selected_site_group),
// so it survives sign-out and follows the account across browsers.
//
// Membership rows reference sites(slug) with ON DELETE CASCADE, so deleting a
// site drops it from every group, and changeSiteSlug() carries the rows along
// (its site_slug column is discovered from the schema).
import db from "./db";
import "./auth"; // admin_users must exist before the column below is added

db.exec(`
  CREATE TABLE IF NOT EXISTS site_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_site_groups_name ON site_groups(lower(name));

  CREATE TABLE IF NOT EXISTS site_group_members (
    group_id INTEGER NOT NULL,
    site_slug TEXT NOT NULL,
    PRIMARY KEY (group_id, site_slug),
    FOREIGN KEY (group_id) REFERENCES site_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_site_group_members_slug ON site_group_members(site_slug);
`);
try { db.exec("ALTER TABLE admin_users ADD COLUMN selected_site_group INTEGER"); } catch (_) {}

export const MAX_GROUP_NAME = 60;
export const MAX_GROUPS = 100;

export interface SiteGroup {
  id: number;
  name: string;
  position: number;
  slugs: string[];
}

function cleanName(raw: unknown): string {
  const name = Array.from(String(raw ?? ""))
    .filter(ch => { const c = ch.codePointAt(0)!; return c >= 32 && c !== 127; })
    .join("").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Group name is required");
  if (name.length > MAX_GROUP_NAME) throw new Error(`Group name exceeds ${MAX_GROUP_NAME} characters`);
  return name;
}

function assertNameFree(name: string, exceptId?: number): void {
  const clash = db.query("SELECT id FROM site_groups WHERE lower(name) = lower(?)").get(name) as { id: number } | null;
  if (clash && clash.id !== exceptId) throw new Error(`A group named '${name}' already exists`);
}

// Every group with its member slugs, in display order. `visible` (a site
// user's accessible slugs) narrows each group's members; groups left empty by
// that filter are dropped so a site user never sees a group they can't use.
export function listGroups(visible: Set<string> | null = null): SiteGroup[] {
  const groups = db.query("SELECT id, name, position FROM site_groups ORDER BY position, lower(name)").all() as Omit<SiteGroup, "slugs">[];
  const members = db.query("SELECT group_id, site_slug FROM site_group_members ORDER BY site_slug").all() as { group_id: number; site_slug: string }[];
  const byGroup = new Map<number, string[]>();
  for (const m of members) {
    if (visible && !visible.has(m.site_slug)) continue;
    const list = byGroup.get(m.group_id) || [];
    list.push(m.site_slug);
    byGroup.set(m.group_id, list);
  }
  const out = groups.map(g => ({ ...g, slugs: byGroup.get(g.id) || [] }));
  return visible ? out.filter(g => g.slugs.length > 0) : out;
}

export function getGroup(id: number): SiteGroup | null {
  return listGroups().find(g => g.id === id) || null;
}

function existingSlugs(slugs: unknown): string[] {
  if (!Array.isArray(slugs)) throw new Error("slugs must be an array");
  const wanted = Array.from(new Set(slugs.map(s => String(s))));
  const check = db.prepare("SELECT 1 FROM sites WHERE slug = ?");
  for (const s of wanted) if (!check.get(s)) throw new Error(`Site '${s}' does not exist`);
  return wanted;
}

export function createGroup(rawName: unknown, slugs: unknown = []): SiteGroup {
  const name = cleanName(rawName);
  assertNameFree(name);
  const count = (db.query("SELECT COUNT(*) AS n FROM site_groups").get() as { n: number }).n;
  if (count >= MAX_GROUPS) throw new Error(`At most ${MAX_GROUPS} groups`);
  const members = existingSlugs(slugs ?? []);
  const next = (db.query("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM site_groups").get() as { p: number }).p;
  let id = 0;
  db.transaction(() => {
    id = Number(db.run("INSERT INTO site_groups (name, position) VALUES (?, ?)", name, next).lastInsertRowid);
    const ins = db.prepare("INSERT INTO site_group_members (group_id, site_slug) VALUES (?, ?)");
    for (const s of members) ins.run(id, s);
  })();
  return getGroup(id)!;
}

// Rename and/or replace the member list. Omitted fields are left alone.
export function updateGroup(id: number, input: { name?: unknown; slugs?: unknown }): SiteGroup {
  if (!getGroup(id)) throw new Error("Group not found");
  const name = input.name === undefined ? null : cleanName(input.name);
  if (name) assertNameFree(name, id);
  const members = input.slugs === undefined ? null : existingSlugs(input.slugs);
  db.transaction(() => {
    if (name) db.run("UPDATE site_groups SET name = ? WHERE id = ?", name, id);
    if (members) {
      db.run("DELETE FROM site_group_members WHERE group_id = ?", id);
      const ins = db.prepare("INSERT INTO site_group_members (group_id, site_slug) VALUES (?, ?)");
      for (const s of members) ins.run(id, s);
    }
  })();
  return getGroup(id)!;
}

export function deleteGroup(id: number): boolean {
  const res = db.run("DELETE FROM site_groups WHERE id = ?", id);
  db.run("UPDATE admin_users SET selected_site_group = NULL WHERE selected_site_group = ?", id);
  return res.changes > 0;
}

// New display order: ids listed first in the given order; any group not
// listed keeps its relative order after them.
export function reorderGroups(ids: unknown): SiteGroup[] {
  if (!Array.isArray(ids)) throw new Error("ids must be an array");
  const all = listGroups().map(g => g.id);
  const listed = ids.map(Number).filter(id => all.includes(id));
  const order = [...new Set(listed), ...all.filter(id => !listed.includes(id))];
  db.transaction(() => {
    order.forEach((id, i) => db.run("UPDATE site_groups SET position = ? WHERE id = ?", i, id));
  })();
  return listGroups();
}

// Replace the set of groups one site belongs to.
export function setSiteGroups(slug: string, groupIds: unknown): number[] {
  if (!Array.isArray(groupIds)) throw new Error("group_ids must be an array");
  if (!db.query("SELECT 1 FROM sites WHERE slug = ?").get(slug)) throw new Error(`Site '${slug}' does not exist`);
  const ids = Array.from(new Set(groupIds.map(Number)));
  const check = db.prepare("SELECT 1 FROM site_groups WHERE id = ?");
  for (const id of ids) if (!Number.isInteger(id) || !check.get(id)) throw new Error("Group not found");
  db.transaction(() => {
    db.run("DELETE FROM site_group_members WHERE site_slug = ?", slug);
    const ins = db.prepare("INSERT INTO site_group_members (group_id, site_slug) VALUES (?, ?)");
    for (const id of ids) ins.run(id, slug);
  })();
  return getSiteGroupIds(slug);
}

// A newly created site joins the group the creating account has selected, so
// it shows up in the filtered list they're looking at. Returns the group id it
// joined, or null when "All sites" is selected (or the group is gone).
export function joinSelectedGroup(userId: number, slug: string): number | null {
  const id = getSelectedGroup(userId);
  if (id === null) return null;
  db.run("INSERT OR IGNORE INTO site_group_members (group_id, site_slug) VALUES (?, ?)", id, slug);
  return id;
}

export function getSiteGroupIds(slug: string): number[] {
  return (db.query("SELECT group_id FROM site_group_members WHERE site_slug = ? ORDER BY group_id").all(slug) as { group_id: number }[])
    .map(r => r.group_id);
}

// The account's remembered selection: a group id, or null for "All sites".
// A selection pointing at a group that no longer exists reads as null.
export function getSelectedGroup(userId: number): number | null {
  const row = db.query(
    "SELECT u.selected_site_group AS id FROM admin_users u JOIN site_groups g ON g.id = u.selected_site_group WHERE u.id = ?"
  ).get(userId) as { id: number } | null;
  return row ? row.id : null;
}

export function setSelectedGroup(userId: number, groupId: number | null): number | null {
  if (groupId !== null && !db.query("SELECT 1 FROM site_groups WHERE id = ?").get(groupId)) throw new Error("Group not found");
  db.run("UPDATE admin_users SET selected_site_group = ? WHERE id = ?", groupId, userId);
  return groupId;
}
