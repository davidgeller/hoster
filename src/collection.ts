// Collection sites: a single page of cards linking to other sites and
// repositories on this Hoster. Everything about a collection lives in the
// database (the sites row plus collection_items) except its images:
//
//   sites/<slug>/_collection/
//     banner.<ext>            optional full-width banner
//     background.<ext>        optional page background image
//     card-<item>.<ext>       optional custom image for one card
//
// The page itself is rendered on each request (see renderCollectionPage), so
// renaming a site, disabling it, or deleting it shows up immediately.

import db from "./db";
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import {
  SITES_DIR, getSite, validateSlug, invalidateSiteCache, getHostAliases, COLLECTION_LAYOUTS,
  type Site, type CollectionLayout,
} from "./sites";
import { BANNER_TYPES, sniffImage, repoBannerPath } from "./repo";
import { originFor, sitesOrigin } from "./origin";

db.exec(`
  CREATE TABLE IF NOT EXISTS collection_items (
    collection_slug TEXT NOT NULL,
    item_slug TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    blurb TEXT,
    image TEXT,
    PRIMARY KEY (collection_slug, item_slug),
    FOREIGN KEY (collection_slug) REFERENCES sites(slug) ON DELETE CASCADE,
    FOREIGN KEY (item_slug) REFERENCES sites(slug) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_collection_items_item ON collection_items(item_slug);
`);
try { db.exec("ALTER TABLE collection_items ADD COLUMN url TEXT"); } catch (_) {}

export const MAX_COLLECTION_ITEMS = 200;
const MAX_DESCRIPTION = 1000;
const MAX_ITEM_TITLE = 120;
const MAX_ITEM_BLURB = 500;
const MAX_ITEM_URL = 2000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type CollectionImageKind = "banner" | "background";

export interface CollectionItem {
  item_slug: string;
  position: number;
  title: string | null;   // overrides the site's name on the card
  blurb: string | null;   // overrides the repository description on the card
  url: string | null;     // overrides where the card leads (e.g. the app's own domain)
  image: string | null;   // custom card image filename inside _collection/
}

// Admin view of a card: the stored row plus what the card will actually show.
export interface CollectionItemView extends CollectionItem {
  name: string;
  site_type: string;
  active: number;
  description: string | null;
  has_image: boolean;       // a custom image, or a public repository's banner
}

export function collectionDir(slug: string): string {
  return join(SITES_DIR, slug, "_collection");
}

function requireCollection(slug: string): Site {
  const site = getSite(slug);
  if (!site) throw new Error("Site not found");
  if (site.site_type !== "collection") throw new Error("Not a collection");
  return site;
}

function cleanText(input: unknown, max: number, label: string, multiline: boolean): string | null {
  if (input == null) return null;
  let s = String(input).replace(/\r\n?/g, "\n");
  s = Array.from(s).filter(ch => {
    const c = ch.codePointAt(0)!;
    if (multiline && (c === 10 || c === 9)) return true;
    return c >= 32 && c !== 127;
  }).join("").trim();
  if (!s) return null;
  if (s.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return s;
}

function normalizeColor(input: unknown): string | null {
  if (input == null || input === "") return null;
  const v = String(input).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(v)) throw new Error("Background color must look like #1a2b3c");
  return v;
}

function normalizeLayout(input: unknown): CollectionLayout {
  if (!COLLECTION_LAYOUTS.includes(input as CollectionLayout)) throw new Error("Layout must be 'grid' or 'carousel'");
  return input as CollectionLayout;
}

// --- Create / settings ---

export interface CreateCollectionOptions {
  description?: string | null;
  layout?: CollectionLayout;
  bg_color?: string | null;
}

export function createCollectionSite(slug: string, name: string, opts: CreateCollectionOptions = {}): Site {
  validateSlug(slug);
  if (getSite(slug)) throw new Error(`Site '${slug}' already exists`);
  const trimmedName = (name || "").trim() || slug;
  if (trimmedName.length > 200) throw new Error("Name exceeds 200 characters");
  const description = cleanText(opts.description, MAX_DESCRIPTION, "Description", true);
  const layout = opts.layout === undefined ? "grid" : normalizeLayout(opts.layout);
  const bgColor = normalizeColor(opts.bg_color);
  db.run(
    `INSERT INTO sites (slug, name, size_bytes, file_count, current_version, root_dir, spa, mcp_enabled, mcp_read_only,
       site_type, coll_layout, coll_description, coll_bg_color, updated_at)
     VALUES (?, ?, 0, 0, NULL, NULL, 0, 0, 0, 'collection', ?, ?, ?, datetime('now'))`,
    slug, trimmedName, layout, description, bgColor
  );
  invalidateSiteCache(slug);
  return getSite(slug)!;
}

export interface CollectionSettingsInput {
  description?: string | null;
  layout?: CollectionLayout;
  bg_color?: string | null;
}

export function updateCollectionSettings(slug: string, input: CollectionSettingsInput): void {
  const site = requireCollection(slug);
  const description = input.description !== undefined ? cleanText(input.description, MAX_DESCRIPTION, "Description", true) : site.coll_description;
  const layout = input.layout !== undefined ? normalizeLayout(input.layout) : site.coll_layout;
  const bgColor = input.bg_color !== undefined ? normalizeColor(input.bg_color) : site.coll_bg_color;
  db.run(
    "UPDATE sites SET coll_description = ?, coll_layout = ?, coll_bg_color = ?, updated_at = datetime('now') WHERE slug = ?",
    description, layout, bgColor, slug
  );
  invalidateSiteCache(slug);
}

// --- Cards ---

export function listCollectionItems(slug: string): CollectionItem[] {
  return db.query(
    "SELECT item_slug, position, title, blurb, url, image FROM collection_items WHERE collection_slug = ? ORDER BY position, item_slug"
  ).all(slug) as CollectionItem[];
}

export function countCollectionItems(slug: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM collection_items WHERE collection_slug = ?").get(slug) as { n: number };
  return row.n;
}

export function listCollectionItemViews(slug: string): CollectionItemView[] {
  const out: CollectionItemView[] = [];
  for (const item of listCollectionItems(slug)) {
    const site = getSite(item.item_slug);
    if (!site) continue;
    out.push({
      ...item,
      name: site.name,
      site_type: site.site_type,
      active: site.active,
      description: site.site_type === "repository" && site.repo_visibility === "public" ? site.repo_description : null,
      has_image: !!cardImage(slug, item, site),
    });
  }
  return out;
}

export interface PlannedItem {
  slug: string;
  title: string | null;
  blurb: string | null;
  url: string | null;
}

// A card's alternate link: an absolute http(s) URL, nothing else (no
// javascript:, data:, or relative paths).
export function normalizeCardUrl(input: unknown): string | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw.length > MAX_ITEM_URL) throw new Error(`Card link exceeds ${MAX_ITEM_URL} characters`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`Card link '${raw.slice(0, 80)}' isn't a valid URL (include https://)`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Card links must start with https:// or http://");
  if (u.username || u.password) throw new Error("Card links can't contain a username or password");
  return u.href;
}

export interface ItemInput {
  slug: string;
  title?: string | null;
  blurb?: string | null;
  url?: string | null;
}

// Replace the whole card list in one go: order is the array order. Cards that
// stay keep their custom image; cards that go lose it. Returns the slugs that
// are new to the collection so the caller can check the actor may add them.
export function planCollectionItems(slug: string, input: unknown): { items: PlannedItem[]; added: string[] } {
  requireCollection(slug);
  if (!Array.isArray(input)) throw new Error("items must be an array");
  if (input.length > MAX_COLLECTION_ITEMS) throw new Error(`A collection holds at most ${MAX_COLLECTION_ITEMS} cards`);
  const seen = new Set<string>();
  const items: PlannedItem[] = [];
  for (const raw of input as ItemInput[]) {
    const itemSlug = typeof raw?.slug === "string" ? raw.slug.trim().toLowerCase() : "";
    if (!itemSlug) throw new Error("Each card needs a site slug");
    if (seen.has(itemSlug)) throw new Error(`'${itemSlug}' appears more than once`);
    seen.add(itemSlug);
    if (itemSlug === slug) throw new Error("A collection can't include itself");
    const target = getSite(itemSlug);
    if (!target) throw new Error(`Site '${itemSlug}' does not exist`);
    if (target.site_type !== "web" && target.site_type !== "repository") {
      throw new Error(`'${itemSlug}' is a ${target.site_type}; only sites and repositories can be added`);
    }
    items.push({
      slug: itemSlug,
      title: cleanText(raw.title, MAX_ITEM_TITLE, "Card title", false),
      blurb: cleanText(raw.blurb, MAX_ITEM_BLURB, "Card description", true),
      url: normalizeCardUrl(raw.url),
    });
  }
  const existing = new Set(listCollectionItems(slug).map(i => i.item_slug));
  return { items, added: items.map(i => i.slug).filter(s => !existing.has(s)) };
}

export function setCollectionItems(slug: string, items: PlannedItem[]): void {
  requireCollection(slug);
  const before = listCollectionItems(slug);
  const keep = new Set(items.map(i => i.slug));
  const upsert = db.prepare(
    `INSERT INTO collection_items (collection_slug, item_slug, position, title, blurb, url) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(collection_slug, item_slug) DO UPDATE SET position = excluded.position, title = excluded.title, blurb = excluded.blurb, url = excluded.url`
  );
  const remove = db.prepare("DELETE FROM collection_items WHERE collection_slug = ? AND item_slug = ?");
  db.transaction(() => {
    for (const old of before) if (!keep.has(old.item_slug)) remove.run(slug, old.item_slug);
    items.forEach((it, i) => upsert.run(slug, it.slug, i, it.title, it.blurb, it.url));
  })();
  for (const old of before) {
    if (!keep.has(old.item_slug) && old.image) removeCollectionFile(slug, old.image);
  }
  db.run("UPDATE sites SET updated_at = datetime('now') WHERE slug = ?", slug);
  invalidateSiteCache(slug);
}

// --- Images ---

const FILE_RE = /^(banner|background|card-[a-z0-9-]+)\.(png|jpg|webp|gif)$/;

function removeCollectionFile(slug: string, name: string): void {
  if (!FILE_RE.test(name)) return;
  try { unlinkSync(join(collectionDir(slug), name)); } catch (_) {}
}

function writeImage(slug: string, base: string, data: Uint8Array | ArrayBuffer): { name: string; mime: string } {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Images must be 8 MB or smaller");
  const mime = sniffImage(bytes);
  if (!mime) throw new Error("Image must be a PNG, JPEG, WebP, or GIF");
  const dir = collectionDir(slug);
  mkdirSync(dir, { recursive: true });
  // Drop any earlier file for this slot (it may have had another extension).
  for (const ext of Object.values(BANNER_TYPES)) {
    try { unlinkSync(join(dir, base + ext)); } catch (_) {}
  }
  const name = base + BANNER_TYPES[mime];
  writeFileSync(join(dir, name), bytes);
  return { name, mime };
}

const IMAGE_COLUMN: Record<CollectionImageKind, "coll_banner" | "coll_bg_image"> = { banner: "coll_banner", background: "coll_bg_image" };

export function setCollectionImage(slug: string, kind: CollectionImageKind, data: Uint8Array | ArrayBuffer): { name: string; mime: string } {
  requireCollection(slug);
  const result = writeImage(slug, kind, data);
  db.run(`UPDATE sites SET ${IMAGE_COLUMN[kind]} = ?, updated_at = datetime('now') WHERE slug = ?`, result.name, slug);
  invalidateSiteCache(slug);
  return result;
}

export function clearCollectionImage(slug: string, kind: CollectionImageKind): void {
  const site = requireCollection(slug);
  const current = site[IMAGE_COLUMN[kind]];
  if (current) removeCollectionFile(slug, current);
  db.run(`UPDATE sites SET ${IMAGE_COLUMN[kind]} = NULL, updated_at = datetime('now') WHERE slug = ?`, slug);
  invalidateSiteCache(slug);
}

function getItem(slug: string, itemSlug: string): CollectionItem | null {
  return db.query("SELECT item_slug, position, title, blurb, url, image FROM collection_items WHERE collection_slug = ? AND item_slug = ?")
    .get(slug, itemSlug) as CollectionItem | null;
}

export function setCardImage(slug: string, itemSlug: string, data: Uint8Array | ArrayBuffer): { name: string; mime: string } {
  requireCollection(slug);
  if (!getItem(slug, itemSlug)) throw new Error("That site isn't in this collection");
  const result = writeImage(slug, `card-${itemSlug}`, data);
  db.run("UPDATE collection_items SET image = ? WHERE collection_slug = ? AND item_slug = ?", result.name, slug, itemSlug);
  return result;
}

export function clearCardImage(slug: string, itemSlug: string): void {
  requireCollection(slug);
  const item = getItem(slug, itemSlug);
  if (!item) throw new Error("That site isn't in this collection");
  if (item.image) removeCollectionFile(slug, item.image);
  db.run("UPDATE collection_items SET image = NULL WHERE collection_slug = ? AND item_slug = ?", slug, itemSlug);
}

function mimeOf(name: string): string {
  return Object.entries(BANNER_TYPES).find(([, ext]) => name.endsWith(ext))?.[0] || "application/octet-stream";
}

function fileIn(slug: string, name: string | null): { abs: string; mime: string } | null {
  if (!name || !FILE_RE.test(name)) return null;
  const abs = join(collectionDir(slug), name);
  return existsSync(abs) ? { abs, mime: mimeOf(name) } : null;
}

export function collectionImagePath(site: Site, kind: CollectionImageKind): { abs: string; mime: string } | null {
  if (site.site_type !== "collection") return null;
  return fileIn(site.slug, site[IMAGE_COLUMN[kind]]);
}

// A card's picture: its custom image, else a public repository's banner.
// A private repository's banner stays private.
function cardImage(slug: string, item: CollectionItem, target: Site): { abs: string; mime: string } | null {
  const own = fileIn(slug, item.image);
  if (own) return own;
  if (target.site_type === "repository" && target.repo_visibility === "public" && target.active) return repoBannerPath(target);
  return null;
}

export function cardImagePath(site: Site, itemSlug: string): { abs: string; mime: string } | null {
  if (site.site_type !== "collection") return null;
  const item = getItem(site.slug, itemSlug);
  const target = item ? getSite(itemSlug) : null;
  return item && target ? cardImage(site.slug, item, target) : null;
}

// Files for the platform backup's "current state" mode.
export function collectionFiles(slug: string): string[] {
  const dir = collectionDir(slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => FILE_RE.test(n));
}

// --- Public page ---

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function version(abs: string): string {
  try { const st = statSync(abs); return st.mtimeMs.toString(36) + st.size.toString(36); } catch { return "0"; }
}

// Where a card leads. A site with its own domain is linked there. Otherwise
// the path URL works when this page is itself path-routed (same host); on a
// custom domain we need the shared sites hostname, when one is configured.
function itemHref(target: Site, hostAliased: boolean): string | null {
  const hosts = getHostAliases(target.slug);
  if (hosts.length) return originFor(hosts[0]) + "/";
  if (!hostAliased) return `/${target.slug}/`;
  const shared = sitesOrigin();
  return shared ? `${shared}/${target.slug}/` : null;
}

// Relative luminance of "#rrggbb" — picks light or dark text for a background.
function isDark(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L < 0.4;
}

// Stable hue per slug for cards without a picture.
function hueFor(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return letters.toUpperCase();
}

interface Card {
  slug: string;
  title: string;
  blurb: string | null;
  kind: string;
  href: string | null;
  image: string | null;
}

function buildCards(site: Site, basePath: string, hostAliased: boolean): Card[] {
  const cards: Card[] = [];
  for (const item of listCollectionItems(site.slug)) {
    const target = getSite(item.item_slug);
    if (!target || !target.active) continue;
    const img = cardImage(site.slug, item, target);
    cards.push({
      slug: target.slug,
      title: item.title || target.name,
      // A private repository's page hides its description from visitors, so
      // the card only borrows a public one.
      blurb: item.blurb || (target.site_type === "repository" && target.repo_visibility === "public" ? target.repo_description : null),
      kind: target.site_type === "repository" ? "Repository" : "Site",
      href: item.url || itemHref(target, hostAliased),
      image: img ? `${basePath}_collection/card/${target.slug}?v=${version(img.abs)}` : null,
    });
  }
  return cards;
}

function renderCard(c: Card): string {
  const media = c.image
    ? `<img src="${esc(c.image)}" alt="" loading="lazy" decoding="async">`
    : `<span class="ph" style="--h:${hueFor(c.slug)}" aria-hidden="true">${esc(initials(c.title))}</span>`;
  const inner = `
      <span class="media">${media}</span>
      <span class="body">
        <span class="kind">${esc(c.kind)}</span>
        <span class="title">${esc(c.title)}</span>
        ${c.blurb ? `<span class="blurb">${esc(c.blurb)}</span>` : ""}
      </span>`;
  return c.href
    ? `<a class="card" href="${esc(c.href)}">${inner}</a>`
    : `<div class="card is-static">${inner}</div>`;
}

const PAGE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  background:var(--bg);color:var(--fg);line-height:1.5}
body.has-bg-image{background:var(--bg) var(--bg-image) center/cover fixed no-repeat}
.banner{display:block;width:100%;aspect-ratio:5/1;min-height:120px;max-height:420px;object-fit:cover}
.head{max-width:1120px;margin:0 auto;padding:40px 24px 8px;text-align:center}
.has-bg-image .head-inner{display:inline-block;padding:20px 28px;border-radius:18px;background:rgba(10,12,20,.55);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:#fff}
h1{margin:0;font-size:clamp(1.8rem,4vw,2.8rem);font-weight:700;letter-spacing:-.02em}
.desc{margin:10px auto 0;max-width:680px;font-size:1.05rem;opacity:.82;white-space:pre-line}
main{max-width:1120px;margin:0 auto;padding:28px 24px 64px}
.empty{text-align:center;opacity:.7;padding:48px 0}

.card{display:flex;flex-direction:column;height:100%;background:#fff;color:#16181d;text-decoration:none;border-radius:16px;overflow:hidden;
  box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(15,23,42,.10);transition:transform .25s ease,box-shadow .25s ease}
a.card:hover{transform:translateY(-4px);box-shadow:0 2px 4px rgba(0,0,0,.08),0 18px 40px rgba(15,23,42,.18)}
a.card:focus-visible{outline:3px solid #4f7cff;outline-offset:3px}
.media{display:block;aspect-ratio:16/9;background:#e9ecf2;overflow:hidden}
.media img{display:block;width:100%;height:100%;object-fit:cover}
.ph{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:2.4rem;font-weight:700;letter-spacing:.04em;color:#fff;
  background:linear-gradient(135deg,hsl(var(--h) 70% 55%),hsl(calc(var(--h) + 40) 65% 42%))}
.body{display:flex;flex-direction:column;gap:6px;padding:16px 18px 20px}
.kind{font-size:.7rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#6b7280}
.title{font-size:1.15rem;font-weight:650;line-height:1.3}
.blurb{font-size:.92rem;color:#4b5563;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:24px}

/* Carousel: without script the cards simply wrap like the grid. */
.cf-track{display:flex;flex-wrap:wrap;gap:24px;justify-content:center}
.cf-track>.card{width:300px}
.cf-nav,.cf-dots{display:none}
.js .cf{position:relative;perspective:1400px;outline:none;overflow-x:clip}
.js .cf-track{display:block;position:relative;height:var(--cf-h,440px);transform-style:preserve-3d}
.js .cf-track>.card{position:absolute;left:50%;top:10px;width:min(340px,72vw);height:auto;margin-left:calc(min(340px,72vw) / -2);
  transition:transform .6s cubic-bezier(.22,.8,.26,1),opacity .6s ease,box-shadow .3s ease;will-change:transform}
.js .cf-track>.card:not(.is-active){cursor:pointer}
.js .cf-track>.card.is-active{box-shadow:0 4px 10px rgba(0,0,0,.10),0 30px 60px rgba(15,23,42,.28)}
.js .cf-track>.card::after{content:"";position:absolute;inset:0;background:rgba(10,12,20,var(--dim,0));pointer-events:none;transition:background .6s ease}
.js .cf-nav{display:flex;position:absolute;top:calc(var(--cf-h,440px) / 2 - 22px);width:44px;height:44px;border-radius:50%;border:0;
  align-items:center;justify-content:center;cursor:pointer;background:rgba(255,255,255,.92);color:#16181d;
  box-shadow:0 4px 14px rgba(0,0,0,.18);z-index:500;font-size:22px;line-height:1}
.js .cf-nav:hover{background:#fff}
.js .cf-nav:focus-visible{outline:3px solid #4f7cff;outline-offset:2px}
.js .cf-prev{left:0}.js .cf-next{right:0}
.js .cf-dots{display:flex;justify-content:center;gap:8px;margin-top:18px;flex-wrap:wrap}
.cf-dots button{width:9px;height:9px;padding:0;border-radius:50%;border:0;background:var(--fg);opacity:.28;cursor:pointer;transition:opacity .2s,transform .2s}
.cf-dots button[aria-current="true"]{opacity:.9;transform:scale(1.3)}
@media (max-width:600px){.head{padding-top:28px}main{padding:20px 16px 48px}.js .cf-nav{display:none}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

// Coverflow: the active card faces the viewer; the rest fan out behind it,
// turned toward the centre. Clicking a side card (or arrow keys, swipes,
// dots) brings it forward; clicking the front card follows its link.
const CAROUSEL_JS = `
(function(){
  document.body.classList.add("js");
  var cf=document.querySelector(".cf"); if(!cf) return;
  var track=cf.querySelector(".cf-track"), cards=[].slice.call(track.children), dots=cf.querySelector(".cf-dots");
  var n=cards.length, i=Math.min(n-1,Math.floor((n-1)/2));
  if(!n) return;
  cards.forEach(function(c,k){
    var b=document.createElement("button"); b.type="button"; b.setAttribute("aria-label","Show card "+(k+1)+" of "+n);
    b.addEventListener("click",function(){go(k)}); dots.appendChild(b);
    c.addEventListener("click",function(e){ if(k!==i){ e.preventDefault(); go(k); } });
  });
  function size(){ var h=0; cards.forEach(function(c){h=Math.max(h,c.offsetHeight)}); cf.style.setProperty("--cf-h",(h+40)+"px"); }
  function render(){
    var narrow=window.innerWidth<600;
    cards.forEach(function(c,k){
      var d=k-i, a=Math.abs(d), s=d<0?-1:1;
      var x=a===0?0:s*((narrow?40:64)+(a-1)*(narrow?16:30));
      var t="translateX("+x+"%) translateZ("+(-a*(narrow?110:150))+"px) rotateY("+(a===0?0:-s*42)+"deg)";
      c.style.transform=t;
      c.style.zIndex=String(200-a); c.style.opacity=a>3?"0":"1"; c.style.pointerEvents=a>3?"none":"";
      c.style.setProperty("--dim",a===0?"0":String(Math.min(.45,.15*a)));
      c.classList.toggle("is-active",a===0);
      c.setAttribute("aria-hidden",a===0?"false":"true");
      c.tabIndex=a===0?0:-1;
    });
    [].forEach.call(dots.children,function(b,k){b.setAttribute("aria-current",k===i?"true":"false")});
  }
  function go(k){ i=(k+n)%n; render(); }
  cf.querySelector(".cf-prev").addEventListener("click",function(){go(i-1)});
  cf.querySelector(".cf-next").addEventListener("click",function(){go(i+1)});
  cf.addEventListener("keydown",function(e){
    if(e.key==="ArrowLeft"){e.preventDefault();go(i-1)} else if(e.key==="ArrowRight"){e.preventDefault();go(i+1)}
  });
  var sx=null, swiped=false;
  track.addEventListener("pointerdown",function(e){sx=e.clientX; swiped=false});
  track.addEventListener("pointerup",function(e){ if(sx===null) return; var dx=e.clientX-sx; sx=null; if(Math.abs(dx)>40){swiped=true; go(dx<0?i+1:i-1)} });
  // A swipe that ends on a card is not a click on it.
  track.addEventListener("click",function(e){ if(swiped){ swiped=false; e.preventDefault(); e.stopPropagation(); } },true);
  track.addEventListener("dragstart",function(e){e.preventDefault()});
  window.addEventListener("resize",function(){size();render()});
  [].forEach.call(track.querySelectorAll("img"),function(img){ if(!img.complete) img.addEventListener("load",size) });
  size(); render();
})();
`;

export function renderCollectionPage(site: Site, opts: { basePath: string; hostAliased: boolean }): { html: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64");
  const cards = buildCards(site, opts.basePath, opts.hostAliased);
  const banner = collectionImagePath(site, "banner");
  const bgImage = collectionImagePath(site, "background");
  const bg = site.coll_bg_color || "#f4f5f8";
  const fg = bgImage || isDark(bg) ? "#f5f7fb" : "#16181d";
  const bgImageUrl = bgImage ? `${opts.basePath}_collection/background?v=${version(bgImage.abs)}` : null;
  const carousel = site.coll_layout === "carousel" && cards.length > 1;

  let body: string;
  if (!cards.length) {
    body = `<p class="empty">Nothing here yet.</p>`;
  } else if (carousel) {
    body = `
    <section class="cf" tabindex="0" aria-roledescription="carousel" aria-label="${esc(site.name)}">
      <button type="button" class="cf-nav cf-prev" aria-label="Previous">&#8249;</button>
      <div class="cf-track">${cards.map(renderCard).join("")}</div>
      <button type="button" class="cf-nav cf-next" aria-label="Next">&#8250;</button>
      <div class="cf-dots"></div>
    </section>`;
  } else {
    body = `<div class="grid">${cards.map(renderCard).join("")}</div>`;
  }

  const description = site.coll_description;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(site.name)}</title>
${description ? `<meta name="description" content="${esc(description.slice(0, 300))}">` : ""}
<meta property="og:title" content="${esc(site.name)}">
${description ? `<meta property="og:description" content="${esc(description.slice(0, 300))}">` : ""}
<meta name="theme-color" content="${esc(bg)}">
<style>${PAGE_CSS}
:root{--bg:${bg};--fg:${fg};${bgImageUrl ? `--bg-image:url("${esc(bgImageUrl)}");` : ""}}
</style>
</head>
<body${bgImageUrl ? ' class="has-bg-image"' : ""}>
${banner ? `<img class="banner" src="${esc(`${opts.basePath}_collection/banner?v=${version(banner.abs)}`)}" alt="">` : ""}
<header class="head"><div class="head-inner">
  <h1>${esc(site.name)}</h1>
  ${description ? `<p class="desc">${esc(description)}</p>` : ""}
</div></header>
<main>${body}</main>
${carousel ? `<script nonce="${nonce}">${CAROUSEL_JS}</script>` : ""}
</body>
</html>`;
  return { html, nonce };
}

// --- HTTP ---

function csp(nonce: string): string {
  return `default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
}

function serveImage(req: Request, file: { abs: string; mime: string }): Response {
  const st = statSync(file.abs);
  const etag = `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(Bun.file(file.abs), {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(st.size),
      "Cache-Control": "public, max-age=300",
      "ETag": etag,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Everything under /<slug>/ (or the host root on a custom domain) for a
// collection. reqPath is relative to the collection root, "" for the page.
export function handleCollectionSite(req: Request, site: Site, reqPath: string, ctx: { basePath: string; hostAliased: boolean }): Response {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (reqPath === "" || reqPath === "index.html") {
    const { html, nonce } = renderCollectionPage(site, ctx);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": csp(nonce),
      },
    });
  }
  if (reqPath === "_collection/banner" || reqPath === "_collection/background") {
    const file = collectionImagePath(site, reqPath === "_collection/banner" ? "banner" : "background");
    return file ? serveImage(req, file) : new Response("Not found", { status: 404 });
  }
  const card = reqPath.match(/^_collection\/card\/([a-z0-9-]+)$/);
  if (card) {
    const file = cardImagePath(site, card[1]);
    return file ? serveImage(req, file) : new Response("Not found", { status: 404 });
  }
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
