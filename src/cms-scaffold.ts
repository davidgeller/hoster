// Hoster CMS — scaffold contents
//
// All files scaffolded into a site's `.cms/` directory when the CMS feature
// is enabled. Kept as template-literal strings so they're embedded in the
// compiled binary; no runtime filesystem dependency.
//
// Bump CMS_LIB_VERSION whenever lib files change so the admin UI can prompt
// for an upgrade on sites running an older version.

export const CMS_LIB_VERSION = "1.0.0";

// -- The library: data layer, custom elements, minimal markdown renderer --
// Vanilla JS, zero dependencies. Renders content into light DOM so the
// host site's CSS can style every element directly (no shadow DOM).
export const CMS_LIB_JS = `// Hoster CMS — v${CMS_LIB_VERSION}
// Zero-dependency vanilla JS library. Renders JSON content into light DOM
// so site CSS can target .cms-* classes directly.

(function () {
  "use strict";

  const VERSION = "${CMS_LIB_VERSION}";
  const DEFAULT_CONTENT_BASE = "/.cms/content";

  const config = {
    contentBase: DEFAULT_CONTENT_BASE,
    preview: false,
  };

  function configure(opts) {
    Object.assign(config, opts || {});
  }

  // Auto-detect preview mode from the URL once at load.
  try {
    config.preview = new URLSearchParams(window.location.search).get("preview") === "1";
  } catch (_) {}

  // -- Caches --
  let indexCache = null;
  const postCache = new Map();
  let categoriesCache = null;

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Fetch failed: " + res.status);
    return res.json();
  }

  async function loadIndex() {
    if (indexCache) return indexCache;
    indexCache = await fetchJson(config.contentBase + "/index.json");
    return indexCache;
  }

  async function loadPost(slug) {
    if (postCache.has(slug)) return postCache.get(slug);
    const post = await fetchJson(config.contentBase + "/posts/" + encodeURIComponent(slug) + ".json");
    postCache.set(slug, post);
    return post;
  }

  async function loadCategories() {
    if (categoriesCache) return categoriesCache;
    try {
      categoriesCache = await fetchJson(config.contentBase + "/categories.json");
    } catch (_) {
      categoriesCache = { categories: [] };
    }
    return categoriesCache;
  }

  function sortPosts(posts, sortBy, order) {
    sortBy = sortBy || "publishedAt";
    order = order || "desc";
    return [...posts].sort((a, b) => {
      const av = a[sortBy] || "";
      const bv = b[sortBy] || "";
      if (av === bv) return 0;
      return order === "desc" ? (av < bv ? 1 : -1) : (av < bv ? -1 : 1);
    });
  }

  async function getAllPosts(opts) {
    opts = opts || {};
    const idx = await loadIndex();
    let posts = (idx && idx.posts) || [];
    if (!opts.includeDrafts && !config.preview) {
      posts = posts.filter(p => !p.draft);
    }
    return sortPosts(posts, opts.sortBy, opts.order);
  }

  async function getPostsByCategory(catSlug) {
    const all = await getAllPosts();
    return all.filter(p => (p.categories || []).indexOf(catSlug) !== -1);
  }

  async function getPostsByTag(tag) {
    const all = await getAllPosts();
    return all.filter(p => (p.tags || []).indexOf(tag) !== -1);
  }

  async function searchPosts(query, opts) {
    const fields = (opts && opts.fields) || ["title", "excerpt", "tags"];
    const q = String(query || "").toLowerCase().trim();
    if (!q) return await getAllPosts();
    const all = await getAllPosts();
    const scored = all.map(p => {
      let score = 0;
      for (let i = 0; i < fields.length; i++) {
        const v = p[fields[i]];
        if (!v) continue;
        const text = Array.isArray(v) ? v.join(" ") : String(v);
        if (text.toLowerCase().indexOf(q) !== -1) score++;
      }
      return { p, score };
    });
    return scored.filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(s => s.p);
  }

  async function getRecentPosts(count) {
    const all = await getAllPosts();
    return all.slice(0, count || 5);
  }

  function formatDate(iso, format) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    format = format || "long";
    if (format === "short") return d.toLocaleDateString();
    if (format === "relative") {
      const diff = Date.now() - d.getTime();
      const m = 60000, h = 3600000, day = 86400000;
      if (diff < m) return "just now";
      if (diff < h) return Math.floor(diff / m) + " min ago";
      if (diff < day) return Math.floor(diff / h) + " hr ago";
      if (diff < day * 30) return Math.floor(diff / day) + " days ago";
      return d.toLocaleDateString();
    }
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getQueryParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (_) {
      return null;
    }
  }

  // -- Minimal Markdown renderer --
  // Supported: ATX headings, paragraphs, bold/italic/code, links, images,
  // unordered/ordered lists, blockquotes, fenced code blocks, horizontal rules.
  function renderMarkdown(md) {
    if (!md) return "";
    const lines = String(md).replace(/\\r\\n?/g, "\\n").split("\\n");
    let html = "";
    let i = 0;

    function inline(text) {
      let s = escapeHtml(text);
      s = s.replace(/\`([^\`]+)\`/g, function (_, c) { return "<code>" + c + "</code>"; });
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
      s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^\\w*])\\*([^*\\n]+)\\*(?!\\w)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^\\w_])_([^_\\n]+)_(?!\\w)/g, "$1<em>$2</em>");
      s = s.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+&quot;([^&]*)&quot;)?\\)/g,
        function (_, alt, url, title) {
          return '<img src="' + url + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : "") + ">";
        });
      s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+&quot;([^&]*)&quot;)?\\)/g,
        function (_, text, url, title) {
          return '<a href="' + url + '"' + (title ? ' title="' + title + '"' : "") + ">" + text + "</a>";
        });
      return s;
    }

    while (i < lines.length) {
      const line = lines[i];

      if (/^\`\`\`/.test(line)) {
        const lang = line.replace(/^\`\`\`/, "").trim();
        i++;
        const code = [];
        while (i < lines.length && !/^\`\`\`/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++;
        html += "<pre><code" + (lang ? ' class="language-' + lang + '"' : "") + ">" + escapeHtml(code.join("\\n")) + "</code></pre>";
        continue;
      }

      const h = line.match(/^(#{1,6})\\s+(.+)$/);
      if (h) {
        html += "<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">";
        i++;
        continue;
      }

      if (/^(\\*\\*\\*|---|___)\\s*$/.test(line)) {
        html += "<hr>";
        i++;
        continue;
      }

      if (/^>\\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\\s?/, ""));
          i++;
        }
        html += "<blockquote><p>" + inline(buf.join(" ")) + "</p></blockquote>";
        continue;
      }

      if (/^[-*+]\\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*+]\\s+/, ""));
          i++;
        }
        html += "<ul>" + items.map(it => "<li>" + inline(it) + "</li>").join("") + "</ul>";
        continue;
      }

      if (/^\\d+\\.\\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\\d+\\.\\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\\d+\\.\\s+/, ""));
          i++;
        }
        html += "<ol>" + items.map(it => "<li>" + inline(it) + "</li>").join("") + "</ol>";
        continue;
      }

      if (line.trim() === "") {
        i++;
        continue;
      }

      const buf = [];
      while (i < lines.length && lines[i].trim() !== "" &&
             !/^(#{1,6}\\s|>\\s?|[-*+]\\s+|\\d+\\.\\s+|\`\`\`|---|___|\\*\\*\\*)/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      html += "<p>" + inline(buf.join(" ")) + "</p>";
    }
    return html;
  }

  function renderBody(body) {
    if (!body) return "";
    const fmt = body.format || "markdown";
    const content = body.content || "";
    return fmt === "html" ? content : renderMarkdown(content);
  }

  // Build a URL to a sibling template page, preserving preview mode.
  function relUrl(file, params) {
    const here = window.location.pathname.replace(/[^/]*$/, "");
    const url = new URL(here + file, window.location.origin);
    Object.keys(params || {}).forEach(k => {
      if (params[k] != null) url.searchParams.set(k, params[k]);
    });
    if (config.preview) url.searchParams.set("preview", "1");
    return url.pathname + url.search;
  }

  function postUrl(post) {
    return relUrl("story.html", { slug: post.slug });
  }

  function categoryUrl(catSlug) {
    return relUrl("list.html", { category: catSlug });
  }

  function tagUrl(tag) {
    return relUrl("list.html", { tag: tag });
  }

  // -- Custom elements (light DOM, no shadow) --

  function renderCard(p) {
    const cats = (p.categories || []).map(c =>
      '<a class="cms-category-tag" href="' + escapeHtml(categoryUrl(c)) + '">' + escapeHtml(c) + '</a>'
    ).join("");
    const cover = p.coverImage
      ? '<a class="cms-card-cover" href="' + escapeHtml(postUrl(p)) + '"><img src="' + escapeHtml(p.coverImage) + '" alt=""></a>'
      : "";
    const draftBadge = p.draft ? '<span class="cms-draft-badge">Draft</span>' : "";
    const meta = [
      p.author ? '<span class="cms-author">' + escapeHtml(p.author) + '</span>' : "",
      p.publishedAt ? '<time class="cms-date" datetime="' + escapeHtml(p.publishedAt) + '">' + escapeHtml(formatDate(p.publishedAt)) + '</time>' : "",
    ].filter(Boolean).join(" · ");
    return [
      '<article class="cms-card' + (p.draft ? " cms-draft" : "") + '">',
        draftBadge,
        cover,
        '<h2 class="cms-card-title"><a href="' + escapeHtml(postUrl(p)) + '">' + escapeHtml(p.title || p.slug) + '</a></h2>',
        meta ? '<div class="cms-meta">' + meta + '</div>' : "",
        p.excerpt ? '<p class="cms-excerpt">' + escapeHtml(p.excerpt) + '</p>' : "",
        cats ? '<div class="cms-categories">' + cats + '</div>' : "",
      '</article>'
    ].join("");
  }

  class CmsList extends HTMLElement {
    connectedCallback() { this.render(); }
    async render() {
      const limit = parseInt(this.getAttribute("limit") || "0", 10) || 0;
      const category = this.getAttribute("category") || getQueryParam("category");
      const tag = this.getAttribute("tag") || getQueryParam("tag");
      const search = this.getAttribute("search") || getQueryParam("search");

      this.innerHTML = '<div class="cms-status">Loading…</div>';
      try {
        let posts;
        if (search) posts = await searchPosts(search);
        else if (category) posts = await getPostsByCategory(category);
        else if (tag) posts = await getPostsByTag(tag);
        else posts = await getAllPosts();

        if (limit) posts = posts.slice(0, limit);

        const header = category
          ? '<div class="cms-list-header">Category: <strong>' + escapeHtml(category) + '</strong></div>'
          : tag
            ? '<div class="cms-list-header">Tag: <strong>' + escapeHtml(tag) + '</strong></div>'
            : search
              ? '<div class="cms-list-header">Search: <strong>' + escapeHtml(search) + '</strong></div>'
              : "";

        if (!posts.length) {
          this.innerHTML = header + '<div class="cms-empty">No posts found.</div>';
          return;
        }
        this.innerHTML = header + '<div class="cms-list">' + posts.map(renderCard).join("") + '</div>';
      } catch (e) {
        this.innerHTML = '<div class="cms-error">Failed to load posts.</div>';
      }
    }
  }

  function updateMetaTags(post) {
    if (post.title) document.title = post.title;
    const desc = (post.seo && post.seo.metaDescription) || post.excerpt;
    if (desc) {
      let meta = document.querySelector('meta[name="description"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "description");
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", desc);
    }
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", window.location.origin + window.location.pathname + "?slug=" + encodeURIComponent(post.slug));

    const existing = document.querySelector('script[type="application/ld+json"][data-cms="story"]');
    if (existing) existing.remove();
    const ld = document.createElement("script");
    ld.type = "application/ld+json";
    ld.setAttribute("data-cms", "story");
    const payload = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "headline": post.title,
      "datePublished": post.publishedAt,
      "dateModified": post.updatedAt || post.publishedAt,
    };
    if (post.author) payload.author = { "@type": "Person", "name": post.author };
    const image = (post.seo && post.seo.ogImage) || post.coverImage;
    if (image) payload.image = image;
    const sdesc = (post.seo && post.seo.metaDescription) || post.excerpt;
    if (sdesc) payload.description = sdesc;
    ld.textContent = JSON.stringify(payload);
    document.head.appendChild(ld);
  }

  class CmsStory extends HTMLElement {
    connectedCallback() { this.render(); }
    async render() {
      const slug = this.getAttribute("slug") || getQueryParam("slug");
      if (!slug) {
        this.innerHTML = '<div class="cms-error">Missing post slug.</div>';
        return;
      }
      this.innerHTML = '<div class="cms-status">Loading…</div>';
      try {
        const post = await loadPost(slug);
        if (post.draft && !config.preview) {
          this.innerHTML = '<div class="cms-error">Post not found.</div>';
          return;
        }
        updateMetaTags(post);
        const cats = (post.categories || []).map(c =>
          '<a class="cms-category-tag" href="' + escapeHtml(categoryUrl(c)) + '">' + escapeHtml(c) + '</a>'
        ).join("");
        const tags = (post.tags || []).map(t =>
          '<a class="cms-tag" href="' + escapeHtml(tagUrl(t)) + '">' + escapeHtml(t) + '</a>'
        ).join("");
        const meta = [
          post.author ? '<span class="cms-author">' + escapeHtml(post.author) + '</span>' : "",
          post.publishedAt ? '<time class="cms-date" datetime="' + escapeHtml(post.publishedAt) + '">' + escapeHtml(formatDate(post.publishedAt)) + '</time>' : "",
        ].filter(Boolean).join(" · ");

        this.innerHTML = [
          '<article class="cms-story' + (post.draft ? " cms-draft" : "") + '">',
            post.draft ? '<div class="cms-draft-banner">Draft preview — not visible to the public</div>' : "",
            '<header class="cms-story-header">',
              '<h1 class="cms-title">' + escapeHtml(post.title || post.slug) + '</h1>',
              meta ? '<div class="cms-meta">' + meta + '</div>' : "",
              post.coverImage ? '<img class="cms-cover" src="' + escapeHtml(post.coverImage) + '" alt="">' : "",
            '</header>',
            '<div class="cms-body">' + renderBody(post.body) + '</div>',
            (cats || tags)
              ? '<footer class="cms-footer">' +
                  (cats ? '<div class="cms-categories">' + cats + '</div>' : "") +
                  (tags ? '<div class="cms-tags">' + tags + '</div>' : "") +
                '</footer>'
              : "",
          '</article>'
        ].join("");
      } catch (e) {
        this.innerHTML = '<div class="cms-error">Failed to load post.</div>';
      }
    }
  }

  class CmsSearch extends HTMLElement {
    connectedCallback() {
      const placeholder = this.getAttribute("placeholder") || "Search posts…";
      this.innerHTML =
        '<form class="cms-search-form" role="search">' +
          '<input type="search" class="cms-search-input" name="search" placeholder="' + escapeHtml(placeholder) + '" value="' + escapeHtml(getQueryParam("search") || "") + '">' +
          '<button type="submit" class="cms-search-button">Search</button>' +
        '</form>';
      this.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const q = this.querySelector("input").value.trim();
        const target = relUrl("list.html", q ? { search: q } : {});
        window.location.href = target;
      });
    }
  }

  class CmsCategoryList extends HTMLElement {
    connectedCallback() { this.render(); }
    async render() {
      this.innerHTML = '<div class="cms-status">Loading…</div>';
      try {
        const data = await loadCategories();
        const cats = (data && data.categories) || [];
        if (!cats.length) {
          this.innerHTML = '<div class="cms-empty">No categories defined.</div>';
          return;
        }
        this.innerHTML = '<ul class="cms-category-list">' +
          cats.map(c =>
            '<li><a class="cms-category-link" href="' + escapeHtml(categoryUrl(c.slug)) + '">' +
              '<span class="cms-category-name">' + escapeHtml(c.name || c.slug) + '</span>' +
              (c.description ? '<span class="cms-category-desc">' + escapeHtml(c.description) + '</span>' : "") +
            '</a></li>'
          ).join("") +
        '</ul>';
      } catch (e) {
        this.innerHTML = '<div class="cms-error">Failed to load categories.</div>';
      }
    }
  }

  // -- Public API on window.CMS --
  window.CMS = {
    VERSION: VERSION,
    configure: configure,
    loadIndex: loadIndex,
    loadPost: loadPost,
    loadCategories: loadCategories,
    getAllPosts: getAllPosts,
    getPostsByCategory: getPostsByCategory,
    getPostsByTag: getPostsByTag,
    searchPosts: searchPosts,
    getRecentPosts: getRecentPosts,
    formatDate: formatDate,
    renderMarkdown: renderMarkdown,
    renderBody: renderBody,
    getQueryParam: getQueryParam,
    postUrl: postUrl,
    categoryUrl: categoryUrl,
    tagUrl: tagUrl,
    isPreview: function () { return config.preview; },
  };

  customElements.define("cms-list", CmsList);
  customElements.define("cms-story", CmsStory);
  customElements.define("cms-search", CmsSearch);
  customElements.define("cms-category-list", CmsCategoryList);
})();
`;

// -- Minimal default styles --
// Opt-in. Users can delete this file or override any class in their site CSS.
export const CMS_LIB_CSS = `/* Hoster CMS — default styles (opt-in, override freely) */

.cms-status,
.cms-empty,
.cms-error {
  padding: 1.5rem 0;
  color: #888;
  font-style: italic;
}
.cms-error { color: #c33; }

.cms-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.5rem;
}
.cms-list-header {
  margin-bottom: 1rem;
  font-size: 0.95rem;
  color: #666;
}

.cms-card {
  display: flex;
  flex-direction: column;
  position: relative;
  padding: 1rem;
  border: 1px solid #eaeaea;
  border-radius: 6px;
  background: #fff;
}
.cms-card-cover img {
  width: 100%;
  height: auto;
  border-radius: 4px;
  margin-bottom: 0.75rem;
  display: block;
}
.cms-card-title {
  margin: 0 0 0.5rem;
  font-size: 1.2rem;
  line-height: 1.3;
}
.cms-card-title a {
  color: inherit;
  text-decoration: none;
}
.cms-card-title a:hover { text-decoration: underline; }

.cms-meta {
  font-size: 0.85rem;
  color: #777;
  margin-bottom: 0.5rem;
}
.cms-excerpt {
  margin: 0.5rem 0;
  color: #444;
  line-height: 1.5;
}
.cms-categories,
.cms-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.5rem;
}
.cms-category-tag,
.cms-tag {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  font-size: 0.78rem;
  background: #f0f0f0;
  color: #555;
  border-radius: 999px;
  text-decoration: none;
}
.cms-category-tag:hover,
.cms-tag:hover { background: #e0e0e0; }

.cms-story-header {
  margin-bottom: 2rem;
}
.cms-title {
  margin: 0 0 0.5rem;
  font-size: 2rem;
  line-height: 1.2;
}
.cms-cover {
  width: 100%;
  height: auto;
  margin-top: 1rem;
  border-radius: 6px;
  display: block;
}
.cms-body {
  line-height: 1.65;
}
.cms-body img { max-width: 100%; height: auto; }
.cms-body pre {
  background: #f6f6f6;
  padding: 1rem;
  border-radius: 4px;
  overflow-x: auto;
}
.cms-body code {
  background: #f0f0f0;
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-size: 0.9em;
}
.cms-body pre code { background: none; padding: 0; }
.cms-body blockquote {
  border-left: 3px solid #ddd;
  padding-left: 1rem;
  margin-left: 0;
  color: #666;
}
.cms-footer {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid #eee;
}

/* Drafts */
.cms-draft {
  position: relative;
}
.cms-draft-badge {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  padding: 0.15rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  background: #fff4cc;
  color: #8a6a00;
  border: 1px solid #f0d878;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.cms-draft-banner {
  padding: 0.6rem 1rem;
  margin-bottom: 1.5rem;
  background: #fff4cc;
  border: 1px solid #f0d878;
  border-radius: 4px;
  color: #8a6a00;
  font-size: 0.9rem;
}

/* Search */
.cms-search-form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}
.cms-search-input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 1rem;
}
.cms-search-button {
  padding: 0.5rem 1rem;
  background: #222;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
}

/* Category list */
.cms-category-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.cms-category-list li { margin-bottom: 0.4rem; }
.cms-category-link {
  display: block;
  padding: 0.6rem 0.8rem;
  background: #fafafa;
  border-radius: 4px;
  text-decoration: none;
  color: inherit;
}
.cms-category-link:hover { background: #f0f0f0; }
.cms-category-name {
  font-weight: 600;
  display: block;
}
.cms-category-desc {
  display: block;
  font-size: 0.85rem;
  color: #777;
  margin-top: 0.2rem;
}
`;

// -- Template: list of stories --
// The lib + CSS are loaded from the universal endpoint /_cms/<file>, which
// works on both canonical hosts and host-aliased domains. Editing the global
// lib (admin Settings → CMS Library) propagates to every CMS-enabled site
// without redeploying their .cms/ directories.
export const CMS_TEMPLATE_LIST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog</title>
  <meta name="description" content="Latest posts">
  <link rel="stylesheet" href="/_cms/cms.css">
  <script defer src="/_cms/cms.js"></script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 0 auto; padding: 2rem 1rem; color: #222; }
    header.site { margin-bottom: 2rem; }
    header.site h1 { margin: 0; font-weight: 400; }
    header.site p { color: #777; margin: 0.3rem 0 0; }
  </style>
</head>
<body>
  <header class="site">
    <h1>Blog</h1>
    <p>Latest posts and updates.</p>
  </header>

  <cms-search></cms-search>
  <cms-list></cms-list>
</body>
</html>
`;

// -- Template: single story --
export const CMS_TEMPLATE_STORY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Post</title>
  <link rel="stylesheet" href="/_cms/cms.css">
  <script defer src="/_cms/cms.js"></script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 0 auto; padding: 2rem 1rem; color: #222; }
    nav.cms-back { margin-bottom: 1.5rem; font-size: 0.9rem; }
    nav.cms-back a { color: #555; text-decoration: none; }
    nav.cms-back a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <nav class="cms-back"><a href="list.html">← All posts</a></nav>
  <cms-story></cms-story>
</body>
</html>
`;

// -- Sample content --
export const CMS_SAMPLE_INDEX_JSON = JSON.stringify({
  version: 1,
  updated: new Date().toISOString(),
  posts: [
    {
      slug: "welcome",
      title: "Welcome to your new CMS",
      excerpt: "A quick tour of how the JSON-driven blog works.",
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      categories: ["announcements"],
      tags: ["intro"],
      author: "You",
      coverImage: null,
      draft: false,
    },
  ],
}, null, 2);

export const CMS_SAMPLE_CATEGORIES_JSON = JSON.stringify({
  categories: [
    {
      slug: "announcements",
      name: "Announcements",
      description: "Updates and news.",
    },
  ],
}, null, 2);

export const CMS_SAMPLE_WELCOME_POST_JSON = JSON.stringify({
  slug: "welcome",
  title: "Welcome to your new CMS",
  excerpt: "A quick tour of how the JSON-driven blog works.",
  publishedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  categories: ["announcements"],
  tags: ["intro"],
  author: "You",
  coverImage: null,
  draft: false,
  body: {
    format: "markdown",
    content: `# Welcome

This post is rendered from a JSON file in \`.cms/content/posts/welcome.json\`.

## How it works

- The blog is driven entirely by JSON files in \`.cms/content/\`.
- The library at \`.cms/lib/cms.js\` reads those files and renders them client-side.
- Two host pages live in \`.cms/templates/\`: \`list.html\` and \`story.html\`.

## Adding a post

1. Create a new JSON file at \`.cms/content/posts/<slug>.json\` with the post body.
2. Add an entry for that slug to \`.cms/content/index.json\` (metadata only — no body).
3. The post appears immediately. No build, no restart.

## Drafts

Set \`"draft": true\` in both the index entry and the post file to hide a post. Add \`?preview=1\` to any CMS URL to reveal drafts with a visual badge.

## Styling

Every rendered element uses a \`.cms-*\` class in light DOM, so your site CSS can target it directly — no shadow DOM. The default styles in \`.cms/lib/cms.css\` are a starting point; delete or override anything you don't want.
`,
  },
  seo: {
    metaDescription: "A quick tour of how the JSON-driven blog works.",
    ogImage: null,
  },
}, null, 2);

// -- Files scaffolded into a site's .cms/ directory on CMS init --
//
// Only the per-site bits live here: a VERSION marker, the two HTML page
// templates, and the seed content. The JS lib + CSS are served from the
// global /_cms/ endpoint (see cms-lib.ts), so they aren't scaffolded per-site.
//
// preserveIfExists controls re-initialization: VERSION is overwritten so the
// marker tracks current scaffold layout; templates and content are preserved
// once the user has customized them.
export interface ScaffoldFile {
  path: string;                // relative to .cms/
  content: string;
  preserveIfExists: boolean;
}

export function getScaffoldFiles(): ScaffoldFile[] {
  return [
    { path: "VERSION",                    content: CMS_LIB_VERSION,              preserveIfExists: false },
    { path: "templates/list.html",        content: CMS_TEMPLATE_LIST_HTML,       preserveIfExists: true },
    { path: "templates/story.html",       content: CMS_TEMPLATE_STORY_HTML,      preserveIfExists: true },
    { path: "content/index.json",         content: CMS_SAMPLE_INDEX_JSON,        preserveIfExists: true },
    { path: "content/categories.json",    content: CMS_SAMPLE_CATEGORIES_JSON,   preserveIfExists: true },
    { path: "content/posts/welcome.json", content: CMS_SAMPLE_WELCOME_POST_JSON, preserveIfExists: true },
  ];
}
