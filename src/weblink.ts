// Web links inside a repository.
//
// A link is stored as an ordinary versioned file with the `.weblink`
// extension whose content is a small JSON document — so it gets history,
// sharing, moving, copying, and the trash for free. The UI renders these as
// link cards (title, description, Open Graph image) instead of documents.
//
// Open Graph lookup is done server-side through the same SSRF-hardened
// fetcher MCP uses for remote media (public http(s) only, no private IPs,
// bounded redirects/time), with a 1 MB cap since we only need the <head>.

import { fetchRemoteMedia } from "./remote-fetch";

export const WEBLINK_EXT = ".weblink";
export const WEBLINK_MIME = "application/x-hoster-weblink";
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const MAX_URL = 2048;
const OG_MAX_BYTES = 1024 * 1024;

export interface WebLink {
  url: string;
  title: string;
  description: string | null;
  image: string | null;      // absolute http(s) URL of a preview image
  site_name: string | null;
  fetched_at: string | null; // when Open Graph data was last pulled
}

// Only http(s), no credentials, bounded length. Returns the normalized URL.
export function normalizeLinkUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("URL is required");
  let text = raw.trim();
  if (!text) throw new Error("URL is required");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;
  let u: URL;
  try { u = new URL(text); } catch { throw new Error("That doesn't look like a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https links are allowed");
  if (u.username || u.password) throw new Error("Links must not contain credentials");
  const out = u.toString();
  if (out.length > MAX_URL) throw new Error("URL is too long");
  return out;
}

function optionalImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.toString().slice(0, MAX_URL);
  } catch { return null; }
}

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Build the JSON document from user input (title falls back to the host).
export function buildWebLink(input: { url: unknown; title?: unknown; description?: unknown; image?: unknown; site_name?: unknown; fetched_at?: unknown }): WebLink {
  const url = normalizeLinkUrl(input.url);
  const title = cleanText(input.title, MAX_TITLE) || new URL(url).hostname.replace(/^www\./, "");
  const description = cleanText(input.description, MAX_DESCRIPTION) || null;
  return {
    url, title, description,
    image: optionalImageUrl(input.image),
    site_name: cleanText(input.site_name, 120) || null,
    fetched_at: typeof input.fetched_at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(input.fetched_at) ? input.fetched_at : null,
  };
}

export function serializeWebLink(link: WebLink): string {
  return JSON.stringify({ hoster_weblink: 1, ...link }, null, 2) + "\n";
}

// Parse stored content leniently; returns null if it isn't a link file.
export function parseWebLink(text: string): WebLink | null {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || typeof data.url !== "string") return null;
    return buildWebLink(data);
  } catch { return null; }
}

// Filename for a link: the title, made filesystem/URL-friendly, plus the extension.
export function webLinkFileName(title: string): string {
  const base = title.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().replace(/\.+$/, "").slice(0, 120) || "link";
  return base + WEBLINK_EXT;
}

// --- Open Graph ---

export interface LinkPreview {
  url: string;          // final URL after redirects
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  fetched_at: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&"; if (l === "lt") return "<"; if (l === "gt") return ">";
    if (l === "quot") return '"'; if (l === "apos" || l === "#39") return "'"; if (l === "nbsp") return " ";
    if (l.startsWith("#x")) return String.fromCodePoint(parseInt(l.slice(2), 16)) || m;
    if (l.startsWith("#")) return String.fromCodePoint(parseInt(l.slice(1), 10)) || m;
    return m;
  });
}

// Pull <meta property/name=…> and <title> out of an HTML head without a
// parser. Attribute order varies between sites, so each <meta> tag is
// scanned for both attributes independently.
export function extractOpenGraph(html: string, baseUrl: string): Omit<LinkPreview, "fetched_at"> {
  const head = html.slice(0, 300_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const val = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    if (!key || !val) continue;
    const k = (key[1] ?? key[2] ?? key[3] ?? "").toLowerCase();
    const v = decodeEntities(val[1] ?? val[2] ?? val[3] ?? "").trim();
    if (k && v && !meta.has(k)) meta.set(k, v);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const pick = (...keys: string[]) => { for (const k of keys) { const v = meta.get(k); if (v) return v; } return null; };
  const rawImage = pick("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src");
  let image: string | null = null;
  if (rawImage) { try { image = new URL(rawImage, baseUrl).toString(); } catch { image = null; } }
  return {
    url: baseUrl,
    title: cleanText(pick("og:title", "twitter:title") || (titleTag ? decodeEntities(titleTag[1]) : ""), MAX_TITLE) || null,
    description: cleanText(pick("og:description", "twitter:description", "description"), MAX_DESCRIPTION) || null,
    image: optionalImageUrl(image),
    site_name: cleanText(pick("og:site_name"), 120) || null,
  };
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview> {
  const url = normalizeLinkUrl(rawUrl);
  const res = await fetchRemoteMedia(url, {
    maxBytes: OG_MAX_BYTES,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    userAgent: "Mozilla/5.0 (compatible; Hoster/2.0; +link-preview)",
  });
  const isHtml = /text\/html|application\/xhtml/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.bytes.subarray(0, 512).toString("utf8"));
  const og = isHtml ? extractOpenGraph(res.bytes.toString("utf8"), res.finalUrl) : { url: res.finalUrl, title: null, description: null, image: null, site_name: null };
  return { ...og, url: res.finalUrl, fetched_at: new Date().toISOString() };
}
