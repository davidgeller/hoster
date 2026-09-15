// Hoster repository site — built-in document library UI.
//
// Talks to the site's own API under `_repo/api/` (relative to <base href>, so
// the same bundle works at /<slug>/ and at the root of a custom domain).
// No inline handlers anywhere: the page runs under `script-src 'self'`.

(() => {
  "use strict";

  const API = "_repo/api/";
  const $ = (id) => document.getElementById(id);

  // ---------- State ----------
  const state = {
    info: null,          // GET info
    csrf: null,
    canWrite: false,
    canRead: false,
    files: [],           // flat list from GET tree
    dirs: [],
    stats: null,
    cwd: "",             // current folder ("" = root)
    view: localStorage.getItem("repo.view") || "grid",
    sort: localStorage.getItem("repo.sort") || "name",
    search: "",
    selected: new Set(), // paths
    previewPath: null,
    trashMode: false,
    uploads: [],         // { name, size, status, pct }
  };

  // ---------- Helpers ----------
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  function timeAgo(s) {
    if (!s) return "";
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  }
  function baseName(p) { const i = p.lastIndexOf("/"); return i === -1 ? p : p.slice(i + 1); }
  function parentOf(p) { const i = p.lastIndexOf("/"); return i === -1 ? "" : p.slice(0, i); }
  function joinPath(dir, name) { return dir ? `${dir}/${name}` : name; }
  function fileUrl(path, opts = {}) {
    let u = `${API}file?path=${encodeURIComponent(path)}`;
    if (opts.v) u += `&v=${opts.v}`;
    if (opts.dl) u += "&dl=1";
    return u;
  }
  function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : ""; }

  const isLink = (f) => f && f.kind === "file" && f.mime === "application/x-hoster-weblink";
  const displayName = (f) => isLink(f) ? f.name.replace(/\.weblink$/i, "") : f.name;
  // Link files are tiny JSON docs; fetched lazily and cached per version so
  // cards can show the page's title/image without a round trip per render.
  const linkCache = new Map();
  async function loadLink(f) {
    const key = `${f.path}@${f.version_no}`;
    if (linkCache.has(key)) return linkCache.get(key);
    const p = fetch(fileUrl(f.path) + `&_v=${f.version_no}`, { credentials: "same-origin" })
      .then(r => r.ok ? r.json() : null).then(d => (d && typeof d.url === "string") ? d : null).catch(() => null);
    linkCache.set(key, p);
    return p;
  }
  function iconFor(file) {
    if (file.kind === "dir") return "📁";
    const m = file.mime || "";
    if (m === "application/x-hoster-weblink") return "🔗";
    if (m.startsWith("image/")) return "🖼️";
    if (m.startsWith("video/")) return "🎬";
    if (m.startsWith("audio/")) return "🎵";
    if (m === "application/pdf") return "📕";
    if (m === "text/markdown") return "📝";
    if (m.startsWith("text/") || m === "application/json") return "📄";
    if (/word|opendocument\.text|rtf/.test(m)) return "📘";
    if (/sheet|excel|csv/.test(m)) return "📗";
    if (/presentation|powerpoint/.test(m)) return "📙";
    if (/zip|tar|gzip|7z|rar/.test(m)) return "🗜️";
    return "📦";
  }
  function previewKind(mime) {
    if (!mime) return "none";
    if (mime === "application/x-hoster-weblink") return "link";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "pdf";
    if (mime === "text/markdown") return "markdown";
    if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return "text";
    return "none";
  }
  const isTextFile = (f) => ["text", "markdown"].includes(previewKind(f.mime)) && !["text/html", "application/xml", "text/xml"].includes(f.mime);

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2600);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (opts.method && opts.method !== "GET" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
    const res = await fetch(API + path, { ...opts, headers, credentials: "same-origin" });
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res;
    }
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.signIn = !!data.sign_in;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- Markdown (small, safe) ----------
  // Escapes the whole input first, then applies block + inline patterns to the
  // escaped text, so no raw HTML from the document ever reaches the DOM.
  function renderMarkdown(src) {
    const lines = src.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const inline = (t) => {
      t = esc(t);
      t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
      t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => `<img alt="${alt}" src="${safeUrl(url, true)}">`);
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
      t = t.replace(/(^|[^*\w])\*([^*]+)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_]+)_(?!\w)/g, "$1<em>$2</em>");
      t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      t = t.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (_, pre, url) => `${pre}<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
      return t;
    };
    const safeUrl = (u, isImage = false) => {
      // Already HTML-escaped input; decode the few entities we might have hit.
      const raw = u.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (/^(https?:|mailto:)/i.test(raw)) return esc(raw);
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "#"; // javascript:, data:, etc.
      // Relative → a file in this repository, resolved against the current folder.
      const rel = raw.replace(/^\.\//, "");
      const target = rel.startsWith("/") ? rel.slice(1) : joinPath(parentOf(state.previewPath || ""), rel);
      return esc(isImage ? fileUrl(target) : `?file=${encodeURIComponent(target)}`);
    };
    while (i < lines.length) {
      let line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      let m;
      if ((m = /^(`{3,}|~{3,})\s*(\w+)?\s*$/.exec(line))) {
        const fence = m[1][0]; const buf = [];
        i++;
        while (i < lines.length && !new RegExp(`^${fence}{3,}\\s*$`).test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if ((m = /^(#{1,6})(?:\s+(.*?))?\s*#*$/.exec(line))) { out.push(`<h${m[1].length}>${inline(m[2] || "")}</h${m[1].length}>`); i++; continue; }
      if (/^(\s*[-*_]){3,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
        out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
        continue;
      }
      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
        const head = cells(line); i += 2; const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      if ((m = /^\s*([-*+]|\d+[.)])\s+/.exec(line))) {
        const ordered = /\d/.test(m[1]); const items = [];
        const re = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
        while (i < lines.length && re.test(lines[i])) {
          let text = re.exec(lines[i])[2]; i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) text += " " + lines[i++].trim();
          const task = /^\[([ xX])\]\s+/.exec(text);
          if (task) text = `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}>` + inline(text.slice(task[0].length));
          else text = inline(text);
          items.push(`<li>${text}</li>`);
        }
        out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      // Paragraph: always consume the current line (even if it looks like the
      // start of another block that didn't fully match, e.g. "## " while a
      // heading is still being typed) so the loop can never stall.
      const buf = [lines[i++]];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}(\s|$)|>|`{3}|~{3}|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join("\n")).replace(/ {2}\n/g, "<br>").replace(/\n/g, " ")}</p>`);
    }
    return out.join("\n");
  }

  // ---------- Loading ----------
  async function loadInfo() {
    const info = await api("info");
    state.info = info;
    state.csrf = info.auth.csrf_token;
    state.canWrite = info.auth.can_write;
    state.canRead = info.auth.can_read;
    state.stats = info.stats;
    document.title = info.name;
    $("repo-title").textContent = info.name;
    const desc = $("repo-description");
    desc.textContent = info.description || "";
    desc.hidden = !info.description;
    const banner = $("hero-banner");
    if (info.banner) {
      banner.style.backgroundImage = `url("_repo/banner?t=${Date.now()}")`;
      banner.hidden = false;
    } else banner.hidden = true;
    renderWho();
    renderStorage();
    document.querySelectorAll(".writer-only").forEach(el => { el.hidden = !state.canWrite; });
    $("gate").hidden = state.canRead;
    $("toolbar").hidden = !state.canRead;
    $("main").hidden = !state.canRead || state.trashMode;
    if (!state.canRead) {
      $("gate-title").textContent = info.auth.authenticated ? "You don't have access to this repository" : "Sign in to view this repository";
      $("gate-text").textContent = info.auth.authenticated
        ? `You're signed in as ${info.auth.username}, but this repository isn't shared with your account.`
        : "These documents are private. Sign in with your Hoster account to continue.";
      $("gate-signin").textContent = info.auth.authenticated ? "Switch account" : "Sign in";
      $("gate-passkey").hidden = info.auth.authenticated || !passkeyAvailable();
      $("gate-signin").classList.toggle("btn-primary", info.auth.authenticated || !passkeyAvailable());
      $("gate-error").textContent = "";
    }
  }

  function renderWho() {
    const a = state.info.auth;
    const el = $("who");
    if (a.authenticated) {
      el.innerHTML = `<span class="name">${esc(a.username)}</span><span class="muted">${a.can_write ? "· can edit" : "· view only"}</span> <button type="button" class="btn btn-sm" id="signout-btn">Sign out</button>`;
      $("signout-btn").addEventListener("click", signOut);
    } else {
      el.innerHTML = `<button type="button" class="btn btn-primary" id="signin-btn">Sign in</button>`;
      $("signin-btn").addEventListener("click", () => openSignIn());
    }
  }

  function renderStorage() {
    const s = state.stats;
    const el = $("storage-meter");
    if (!s || !state.canWrite) { el.hidden = true; return; }
    el.hidden = false;
    const pct = s.quota_bytes > 0 ? Math.min(100, (s.used_bytes / s.quota_bytes) * 100) : 0;
    const fill = $("storage-fill");
    fill.style.width = `${pct}%`;
    fill.className = "storage-fill" + (pct >= 98 ? " full" : pct >= 85 ? " warn" : "");
    $("storage-label").textContent = s.quota_bytes > 0
      ? `${fmtBytes(s.used_bytes)} of ${fmtBytes(s.quota_bytes)} used · ${s.file_count} file${s.file_count === 1 ? "" : "s"}`
      : `${fmtBytes(s.used_bytes)} used · ${s.file_count} file${s.file_count === 1 ? "" : "s"}`;
    const tc = $("trash-count");
    if (tc) tc.textContent = s.trash_count ? String(s.trash_count) : "";
  }

  async function loadTree() {
    if (!state.canRead) return;
    const data = await api("tree");
    state.files = data.files;
    state.dirs = data.dirs;
    state.stats = data.stats;
    // Prune selections that vanished.
    const live = new Set([...state.files, ...state.dirs].map(f => f.path));
    for (const p of [...state.selected]) if (!live.has(p)) state.selected.delete(p);
    if (state.previewPath && !live.has(state.previewPath)) closePreview();
    renderStorage();
    render();
    if (state.previewPath) showPreview(state.previewPath, { keep: true });
  }

  // ---------- Rendering ----------
  function currentEntries() {
    const q = state.search.trim().toLowerCase();
    let list;
    if (q) {
      list = [...state.dirs, ...state.files].filter(f => f.path.toLowerCase().includes(q));
    } else {
      list = [...state.dirs, ...state.files].filter(f => parentOf(f.path) === state.cwd);
    }
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      modified: (a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""),
      size: (a, b) => (b.size || 0) - (a.size || 0),
      kind: (a, b) => (extOf(a.name) || "").localeCompare(extOf(b.name) || "") || a.name.localeCompare(b.name),
    }[state.sort] || ((a, b) => 0);
    list.sort((a, b) => (a.kind === b.kind ? cmp(a, b) : a.kind === "dir" ? -1 : 1));
    return list;
  }

  function render() {
    renderCrumbs();
    const listing = $("listing");
    const entries = currentEntries();
    listing.className = `listing ${state.view}${state.selected.size ? " selecting" : ""}`;
    const empty = $("empty");
    if (!entries.length) {
      listing.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = state.search
        ? `No files match <strong>${esc(state.search)}</strong>.`
        : state.canWrite
          ? `<strong>This folder is empty.</strong><br>Drag files or folders here, or use <strong>Upload</strong>.`
          : `<strong>This folder is empty.</strong>`;
    } else {
      empty.hidden = true;
      const searching = !!state.search.trim();
      const rows = entries.map(f => {
        const sel = state.selected.has(f.path);
        const thumb = f.kind === "file" && (f.mime || "").startsWith("image/")
          ? `<div class="thumb"><img src="${esc(fileUrl(f.path))}" alt="" loading="lazy"></div>`
          : `<div class="thumb${f.kind === "dir" ? " dir" : isLink(f) ? " link" : ""}">${iconFor(f)}</div>`;
        const label = searching ? f.path : displayName(f);
        return `<div class="item${sel ? " selected" : ""}" data-path="${esc(f.path)}" data-kind="${f.kind}" tabindex="0" role="button" draggable="${state.canWrite ? "true" : "false"}">
          <div class="check" data-check>${sel ? "✓" : ""}</div>
          ${thumb}
          <div class="info"><div class="name" title="${esc(f.path)}">${esc(label)}</div>
          <div class="sub">${f.kind === "dir" ? "Folder" : `${fmtBytes(f.size)} · ${timeAgo(f.updated_at)}`}</div></div>
          <div class="col col-size">${f.kind === "dir" ? "—" : fmtBytes(f.size)}</div>
          <div class="col col-mod" title="${esc(fmtDate(f.updated_at))}">${esc(fmtDate(f.updated_at))}</div>
          <div class="col col-by">${esc(f.updated_by || "")}</div>
          <div class="col col-v">${f.kind === "file" && f.version_no > 1 ? `<span class="vbadge">v${f.version_no}</span>` : ""}</div>
        </div>`;
      });
      const head = state.view === "list"
        ? `<div class="head"><div></div><div></div><div>Name</div><div>Size</div><div class="col-mod">Modified</div><div class="col-by">By</div><div class="col-v">Ver.</div></div>`
        : "";
      listing.innerHTML = head + rows.join("");
      // Fill in link cards (image + site) once their JSON arrives.
      for (const f of entries.filter(isLink)) {
        loadLink(f).then(link => {
          if (!link) return;
          const item = listing.querySelector(`.item[data-path="${CSS.escape(f.path)}"]`);
          if (!item) return;
          const thumb = item.querySelector(".thumb");
          if (link.image && thumb) thumb.innerHTML = `<img class="og" src="${esc(link.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
          const sub = item.querySelector(".sub");
          if (sub) sub.textContent = link.site_name || new URL(link.url).hostname.replace(/^www\./, "");
          const nameEl = item.querySelector(".name");
          if (nameEl && !state.search.trim()) nameEl.textContent = link.title;
          item.title = link.url;
        });
      }
    }
    renderSelbar();
    document.querySelectorAll(".seg [data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
    $("sort").value = state.sort;
  }

  function renderCrumbs() {
    const el = $("crumbs");
    const parts = state.cwd ? state.cwd.split("/") : [];
    let html = `<a href="?path=" data-path="" class="${parts.length ? "" : "current"}">${esc(state.info.name)}</a>`;
    let acc = "";
    parts.forEach((p, idx) => {
      acc = acc ? `${acc}/${p}` : p;
      const last = idx === parts.length - 1;
      html += `<span class="sep">›</span>` + (last
        ? `<span class="current">${esc(p)}</span>`
        : `<a href="?path=${encodeURIComponent(acc)}" data-path="${esc(acc)}">${esc(p)}</a>`);
    });
    if (state.search.trim()) html += `<span class="sep">›</span><span class="muted">search results</span>`;
    el.innerHTML = html;
  }

  function renderSelbar() {
    const bar = $("selbar");
    const n = state.selected.size;
    bar.hidden = n === 0;
    if (!n) return;
    $("sel-count").textContent = `${n} selected`;
    $("sel-rename").hidden = !state.canWrite || n !== 1;
    $("sel-share").hidden = !state.canWrite || n !== 1;
    $("sel-move").hidden = !state.canWrite;
    $("sel-copy").hidden = !state.canWrite;
    $("sel-delete").hidden = !state.canWrite;
  }

  // ---------- Navigation ----------
  function navigate(dir, { push = true } = {}) {
    state.cwd = dir;
    state.search = "";
    $("search").value = "";
    state.selected.clear();
    if (push) history.pushState({ path: dir }, "", dir ? `?path=${encodeURIComponent(dir)}` : location.pathname);
    render();
  }

  function readUrlState() {
    const params = new URLSearchParams(location.search);
    const file = params.get("file");
    if (file) {
      state.cwd = parentOf(file);
      return { file };
    }
    state.cwd = (params.get("path") || "").replace(/^\/+|\/+$/g, "");
    return {};
  }

  // ---------- Selection & interaction ----------
  function entryAt(path) {
    return state.files.find(f => f.path === path) || state.dirs.find(d => d.path === path) || null;
  }

  function toggleSelect(path, on) {
    if (on === undefined) on = !state.selected.has(path);
    if (on) state.selected.add(path); else state.selected.delete(path);
    render();
  }

  $("listing").addEventListener("click", (e) => {
    const item = e.target.closest(".item");
    if (!item) return;
    const path = item.dataset.path;
    if (e.target.closest("[data-check]") || e.metaKey || e.ctrlKey) { toggleSelect(path); return; }
    if (e.shiftKey && state.selected.size) {
      const entries = currentEntries().map(f => f.path);
      const anchor = [...state.selected].pop();
      const a = entries.indexOf(anchor), b = entries.indexOf(path);
      if (a !== -1 && b !== -1) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(entries[i]);
        render();
        return;
      }
    }
    if (item.dataset.kind === "dir") { navigate(path); return; }
    showPreview(path);
  });
  $("listing").addEventListener("dblclick", (e) => {
    const item = e.target.closest(".item");
    if (!item || item.dataset.kind !== "file") return;
    const f = entryAt(item.dataset.path);
    if (f && isLink(f)) { loadLink(f).then(l => { if (l) window.open(l.url, "_blank", "noopener,noreferrer"); }); return; }
    if (f && state.canWrite && isTextFile(f)) openEditor(f);
    else if (f) window.open(fileUrl(f.path, { dl: previewKind(f.mime) === "none" }), "_blank", "noopener");
  });
  $("listing").addEventListener("keydown", (e) => {
    const item = e.target.closest(".item");
    if (!item) return;
    if (e.key === "Enter") { e.preventDefault(); item.click(); }
    if (e.key === " ") { e.preventDefault(); toggleSelect(item.dataset.path); }
  });

  $("crumbs").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-path]");
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.path);
  });
  window.addEventListener("popstate", () => { readUrlState(); state.selected.clear(); render(); });

  $("search").addEventListener("input", (e) => { state.search = e.target.value; state.selected.clear(); render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; localStorage.setItem("repo.sort", state.sort); render(); });
  document.querySelectorAll(".seg [data-view]").forEach(b => b.addEventListener("click", () => {
    state.view = b.dataset.view; localStorage.setItem("repo.view", state.view); render();
  }));

  $("sel-clear").addEventListener("click", () => { state.selected.clear(); render(); });
  $("sel-download").addEventListener("click", () => downloadPaths([...state.selected]));
  $("sel-delete").addEventListener("click", () => confirmDelete([...state.selected]));
  $("sel-rename").addEventListener("click", () => { const p = [...state.selected][0]; if (p) promptRename(p); });
  $("sel-share").addEventListener("click", () => { const p = [...state.selected][0]; if (p) openShareDialog(p); });
  $("sel-move").addEventListener("click", () => moveOrCopyDialog([...state.selected], "move"));
  $("sel-copy").addEventListener("click", () => moveOrCopyDialog([...state.selected], "copy"));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (document.querySelector(".modal:not([hidden])")) { if (e.key === "Escape") closeModals(); return; }
    if (e.key === "Escape") { if (state.selected.size) { state.selected.clear(); render(); } else closePreview(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && state.canRead && !state.trashMode) {
      e.preventDefault();
      currentEntries().forEach(f => state.selected.add(f.path));
      render();
    }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected.size && state.canWrite) { e.preventDefault(); confirmDelete([...state.selected]); }
  });

  // ---------- Download / package ----------
  async function downloadPaths(paths) {
    if (!paths.length) return;
    const single = paths.length === 1 ? entryAt(paths[0]) : null;
    if (single && single.kind === "file") {
      triggerDownload(fileUrl(single.path, { dl: true }));
      return;
    }
    toast("Packaging…");
    try {
      const headers = { "Content-Type": "application/json" };
      if (state.csrf) headers["X-CSRF-Token"] = state.csrf;
      const name = paths.length === 1 ? baseName(paths[0]) : `${state.info.slug}-files`;
      const res = await fetch(`${API}zip`, { method: "POST", headers, body: JSON.stringify({ paths, name }), credentials: "same-origin" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Packaging failed (${res.status})`); }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") || "";
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd) || /filename="([^"]+)"/.exec(cd);
      const filename = m ? decodeURIComponent(m[1]) : "download.zip";
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { toast(e.message, true); }
  }
  function triggerDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    if (filename) a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- Preview ----------
  let previewVersionsToken = 0;
  async function showPreview(path, { keep = false } = {}) {
    const f = entryAt(path);
    if (!f || f.kind !== "file") return;
    state.previewPath = path;
    if (!keep) history.replaceState(null, "", `?file=${encodeURIComponent(path)}`);
    const pane = $("preview");
    pane.hidden = false;
    $("preview-title").textContent = displayName(f);
    const body = $("preview-body");
    const kind = previewKind(f.mime);
    const url = fileUrl(path) + `&_v=${f.version_no}`;
    if (kind === "image") body.innerHTML = `<img src="${esc(url)}" alt="${esc(f.name)}">`;
    else if (kind === "video") body.innerHTML = `<video controls preload="metadata" src="${esc(url)}"></video>`;
    else if (kind === "audio") body.innerHTML = `<audio controls preload="metadata" src="${esc(url)}"></audio>`;
    else if (kind === "pdf") body.innerHTML = `<iframe src="${esc(url)}" title="${esc(f.name)}"></iframe>`;
    else if (kind === "link") {
      body.innerHTML = `<div class="linkbox muted">Loading…</div>`;
      loadLink(f).then(link => {
        if (state.previewPath !== path) return;
        if (!link) { body.innerHTML = `<div class="none">This link file couldn't be read.</div>`; return; }
        $("preview-title").textContent = link.title;
        body.innerHTML = `<div class="linkbox">
          ${link.image ? `<img src="${esc(link.image)}" alt="" referrerpolicy="no-referrer">` : ""}
          <div class="lt">${esc(link.title)}</div>
          ${link.description ? `<div class="ld">${esc(link.description)}</div>` : ""}
          <div class="lu"><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.url)}</a></div>
        </div>`;
      });
    }
    else if (kind === "text" || kind === "markdown") {
      body.innerHTML = `<pre class="muted">Loading…</pre>`;
      if (f.size > 2 * 1024 * 1024) body.innerHTML = `<div class="none"><div class="big">${iconFor(f)}</div>Too large to preview here.</div>`;
      else fetch(url, { credentials: "same-origin" }).then(r => r.text()).then(t => {
        if (state.previewPath !== path) return;
        body.innerHTML = kind === "markdown" ? `<div class="md-preview">${renderMarkdown(t)}</div>` : `<pre></pre>`;
        if (kind !== "markdown") body.querySelector("pre").textContent = t;
      }).catch(() => { body.innerHTML = `<div class="none">Couldn't load the file.</div>`; });
    } else body.innerHTML = `<div class="none"><div class="big">${iconFor(f)}</div>No preview for this file type.</div>`;

    $("preview-meta").innerHTML = `
      <dt>Path</dt><dd class="mono">${esc(f.path)}</dd>
      <dt>Size</dt><dd>${fmtBytes(f.size)}</dd>
      <dt>Type</dt><dd>${esc(f.mime || "unknown")}</dd>
      <dt>Modified</dt><dd>${esc(fmtDate(f.updated_at))}${f.updated_by ? ` by ${esc(f.updated_by)}` : ""}</dd>
      <dt>Created</dt><dd>${esc(fmtDate(f.created_at))}${f.created_by ? ` by ${esc(f.created_by)}` : ""}</dd>
      <dt>Version</dt><dd>${f.version_no}</dd>`;
    const acts = $("preview-actions");
    acts.innerHTML = `
      ${kind === "link" ? `<button type="button" class="btn btn-sm btn-primary" data-act="open-link">Open link ↗</button>` : `<a class="btn btn-sm" href="${esc(fileUrl(path, { dl: true }))}">Download</a>`}
      ${kind !== "none" && kind !== "link" ? `<a class="btn btn-sm" href="${esc(fileUrl(path))}" target="_blank" rel="noopener">Open</a>` : ""}
      ${kind === "link" && state.canWrite ? `<button type="button" class="btn btn-sm" data-act="edit-link">Edit link</button>` : ""}
      <button type="button" class="btn btn-sm" data-act="copy">Copy link</button>
      ${state.canWrite && isTextFile(f) ? `<button type="button" class="btn btn-sm btn-primary" data-act="edit">Edit</button>` : ""}
      ${state.canWrite ? `<button type="button" class="btn btn-sm" data-act="share">Share…</button><button type="button" class="btn btn-sm" data-act="rename">Rename</button><button type="button" class="btn btn-sm" data-act="move">Move to…</button><button type="button" class="btn btn-sm" data-act="copy">Copy to…</button><button type="button" class="btn btn-sm btn-danger" data-act="delete">Delete</button>` : ""}`;
    acts.querySelector('[data-act="copy"]').addEventListener("click", () => {
      const link = new URL(`?file=${encodeURIComponent(path)}`, document.baseURI).href;
      navigator.clipboard?.writeText(link).then(() => toast("Link copied")).catch(() => toast(link));
    });
    acts.querySelector('[data-act="edit"]')?.addEventListener("click", () => openEditor(f));
    acts.querySelector('[data-act="open-link"]')?.addEventListener("click", async () => { const l = await loadLink(f); if (l) window.open(l.url, "_blank", "noopener,noreferrer"); });
    acts.querySelector('[data-act="edit-link"]')?.addEventListener("click", async () => { const l = await loadLink(f); if (l) openLinkDialog({ path: f.path, link: l }); });
    acts.querySelector('[data-act="rename"]')?.addEventListener("click", () => promptRename(path));
    acts.querySelector('[data-act="share"]')?.addEventListener("click", () => openShareDialog(path));
    acts.querySelector('[data-act="move"]')?.addEventListener("click", () => moveOrCopyDialog([path], "move"));
    acts.querySelector('[data-act="copy"]')?.addEventListener("click", () => moveOrCopyDialog([path], "copy"));
    acts.querySelector('[data-act="delete"]')?.addEventListener("click", () => confirmDelete([path]));

    const vEl = $("preview-versions");
    const token = ++previewVersionsToken;
    vEl.innerHTML = "";
    try {
      const { versions } = await api(`versions?path=${encodeURIComponent(path)}`);
      if (token !== previewVersionsToken) return;
      if (versions.length <= 1 && !state.canWrite) return;
      vEl.innerHTML = `<h4>Versions (${versions.length})</h4>` + versions.map(v => `
        <div class="version${v.current ? " current" : ""}" data-v="${v.version_no}">
          <div><div class="v">v${v.version_no}<small>${fmtBytes(v.size)} · ${esc(timeAgo(v.created_at))}${v.created_by ? ` · ${esc(v.created_by)}` : ""}</small></div>
          ${v.note ? `<div class="note">${esc(v.note)}</div>` : ""}</div>
          <div class="acts">
            <a class="btn btn-sm btn-ghost" href="${esc(fileUrl(path, { v: v.version_no, dl: true }))}" title="Download this version">↓</a>
            ${state.canWrite && !v.current ? `<button type="button" class="btn btn-sm btn-ghost" data-restore="${v.version_no}" title="Make this the current version">Restore</button><button type="button" class="btn btn-sm btn-ghost" data-delv="${v.version_no}" title="Delete this version">✕</button>` : ""}
          </div>
        </div>`).join("");
      vEl.querySelectorAll("[data-restore]").forEach(b => b.addEventListener("click", async () => {
        try {
          await api("restore-version", { method: "POST", body: JSON.stringify({ path, version: Number(b.dataset.restore) }) });
          toast(`Restored version ${b.dataset.restore}`);
          await loadTree();
        } catch (e) { toast(e.message, true); }
      }));
      vEl.querySelectorAll("[data-delv]").forEach(b => b.addEventListener("click", async () => {
        try {
          await api("delete-version", { method: "POST", body: JSON.stringify({ path, version: Number(b.dataset.delv) }) });
          await loadTree();
        } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { /* versions are optional in the pane */ }
  }
  function closePreview() {
    state.previewPath = null;
    $("preview").hidden = true;
    $("preview-body").innerHTML = "";
    if (new URLSearchParams(location.search).has("file")) {
      history.replaceState(null, "", state.cwd ? `?path=${encodeURIComponent(state.cwd)}` : location.pathname);
    }
  }
  $("preview-close").addEventListener("click", closePreview);

  // ---------- Modals ----------
  function closeModals() { document.querySelectorAll(".modal").forEach(m => { m.hidden = true; }); }
  document.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", closeModals));

  function promptDialog({ title, text, label = "Name", value = "", ok = "OK", validate }) {
    return new Promise((resolve) => {
      const modal = $("prompt-modal");
      $("prompt-title").textContent = title;
      $("prompt-text").textContent = text || "";
      $("prompt-label").textContent = label;
      $("prompt-ok").textContent = ok;
      const input = $("prompt-input");
      input.value = value;
      $("prompt-error").textContent = "";
      modal.hidden = false;
      setTimeout(() => { input.focus(); const dot = value.lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 0);
      const form = $("prompt-form");
      const onSubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim();
        const err = validate ? validate(v) : (v ? null : "Name is required");
        if (err) { $("prompt-error").textContent = err; return; }
        cleanup(); resolve(v);
      };
      const onClose = () => { cleanup(); resolve(null); };
      const cleanup = () => { form.removeEventListener("submit", onSubmit); modal.querySelectorAll("[data-close]").forEach(b => b.removeEventListener("click", onClose)); modal.hidden = true; };
      form.addEventListener("submit", onSubmit);
      modal.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", onClose));
    });
  }
  function confirmDialog({ title, text, ok = "Delete" }) {
    return new Promise((resolve) => {
      const modal = $("confirm-modal");
      $("confirm-title").textContent = title;
      $("confirm-text").textContent = text;
      const okBtn = $("confirm-ok");
      okBtn.textContent = ok;
      modal.hidden = false;
      const onOk = () => { cleanup(); resolve(true); };
      const onClose = () => { cleanup(); resolve(false); };
      const cleanup = () => { okBtn.removeEventListener("click", onOk); modal.querySelectorAll("[data-close]").forEach(b => b.removeEventListener("click", onClose)); modal.hidden = true; };
      okBtn.addEventListener("click", onOk);
      modal.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", onClose));
      setTimeout(() => okBtn.focus(), 0);
    });
  }
  const nameCheck = (v) => {
    if (!v) return "Name is required";
    if (v.includes("/") || v.includes("\\")) return "Use Rename / Move to change folders";
    if (v === "." || v === "..") return "Invalid name";
    if (/[\x00-\x1f]/.test(v)) return "Name contains invalid characters";
    return null;
  };

  // ---------- Write actions ----------
  $("new-folder-btn").addEventListener("click", async () => {
    const name = await promptDialog({ title: "New folder", label: "Folder name", ok: "Create", validate: nameCheck });
    if (!name) return;
    try {
      await api("mkdir", { method: "POST", body: JSON.stringify({ path: joinPath(state.cwd, name) }) });
      await loadTree();
    } catch (e) { toast(e.message, true); }
  });

  $("new-text-btn").addEventListener("click", async () => {
    const name = await promptDialog({
      title: "New text file", text: "Markdown (.md) files get a live preview; .txt, .csv, .json and other text types open in the plain editor.",
      label: "File name", value: "untitled.md", ok: "Create",
      validate: (v) => nameCheck(v) || (/\.(md|markdown|txt|csv|tsv|json|yaml|yml|xml|log|toml|ini)$/i.test(v) ? null : "Use a text extension such as .md, .txt, .csv or .json"),
    });
    if (!name) return;
    const path = joinPath(state.cwd, name);
    if (entryAt(path)) { toast(`'${name}' already exists`, true); return; }
    openEditor({ path, name, mime: /\.(md|markdown)$/i.test(name) ? "text/markdown" : "text/plain", size: 0, version_no: 0 }, { create: true });
  });

  async function promptRename(path) {
    const f = entryAt(path);
    if (!f) return;
    const to = await promptDialog({
      title: f.kind === "dir" ? "Rename folder" : "Rename file",
      text: "Edit the name. You can also type a full path (e.g. archive/2025/report.pdf) to move it at the same time.",
      label: "Path", value: path, ok: "Save",
      validate: (v) => (!v ? "Path is required" : v === path ? "Unchanged" : null),
    });
    if (!to) return;
    try {
      const r = await api("rename", { method: "POST", body: JSON.stringify({ from: path, to }) });
      state.selected.clear();
      if (state.previewPath === path) state.previewPath = r.to;
      await loadTree();
      if (state.previewPath === r.to) showPreview(r.to);
    } catch (e) { toast(e.message, true); }
  }

  async function confirmDelete(paths) {
    if (!paths.length) return;
    const names = paths.map(p => baseName(p));
    const ok = await confirmDialog({
      title: paths.length === 1 ? `Delete "${names[0]}"?` : `Delete ${paths.length} items?`,
      text: `Deleted items go to the trash and can be restored for ${state.info.trash_ttl_days} days.`,
    });
    if (!ok) return;
    try {
      await api("delete", { method: "POST", body: JSON.stringify({ paths }) });
      state.selected.clear();
      if (paths.includes(state.previewPath)) closePreview();
      toast(`Moved ${paths.length === 1 ? `"${names[0]}"` : `${paths.length} items`} to the trash`);
      await loadTree();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Share links ----------
  // With a path: create links for that file/folder and list its links.
  // Without: list every link in the repository.
  let shareCtxPath = null;
  async function openShareDialog(path) {
    shareCtxPath = path || null;
    const f = path ? entryAt(path) : null;
    if (path && !f) return;
    $("share-title").textContent = path ? `Share ${f.kind === "dir" ? "folder" : "file"} "${f.name}"` : "Share links";
    $("share-text").textContent = path
      ? (f.kind === "dir"
        ? "Anyone with the link can browse and download everything in this folder until it expires, even if the repository is private. The link stops working if the folder is moved, renamed, or deleted."
        : "Anyone with the link can view or download this file until it expires, even if the repository is private. The link always serves the current version and stops working if the file is moved, renamed, or deleted.")
      : "Every link created for this repository. Revoke any you no longer need.";
    $("share-form").hidden = !path;
    $("share-result").hidden = true;
    $("share-url").value = "";
    $("share-error").textContent = "";
    $("share-label").value = "";
    $("share-modal").hidden = false;
    await loadShareList();
  }
  async function loadShareList() {
    const list = $("share-list");
    list.innerHTML = '<div class="share-item muted">Loading…</div>';
    try {
      const { shares } = await api(`shares${shareCtxPath ? `?path=${encodeURIComponent(shareCtxPath)}` : ""}`);
      $("share-list-title").textContent = shareCtxPath ? `Links for this ${entryAt(shareCtxPath)?.kind === "dir" ? "folder" : "file"}` : "All links";
      if (!shares.length) { list.innerHTML = '<div class="share-item muted">No links yet.</div>'; return; }
      list.innerHTML = shares.map(sh => {
        const status = sh.revoked_at ? "revoked" : sh.expired ? "expired" : sh.expires_at ? `expires ${fmtDate(sh.expires_at)}` : "never expires";
        return `<div class="share-item${sh.active ? "" : " dead"}" data-id="${sh.id}">
          <span>${sh.kind === "dir" ? "📁" : "📄"}</span>
          <span class="p" title="${esc(sh.path)}">${esc(shareCtxPath ? (sh.label || "(no label)") : sh.path)}<small>${esc(shareCtxPath ? "" : (sh.label ? sh.label + " · " : ""))}created ${esc(timeAgo(sh.created_at))}${sh.created_by ? ` by ${esc(sh.created_by)}` : ""} · used ${sh.uses}×</small></span>
          <span class="st">${esc(status)}</span>
          ${sh.active ? `<button type="button" class="btn btn-sm btn-danger" data-revoke="${sh.id}">Revoke</button>` : ""}
        </div>`;
      }).join("");
      list.querySelectorAll("[data-revoke]").forEach(b => b.addEventListener("click", async () => {
        try { await api("share/revoke", { method: "POST", body: JSON.stringify({ id: Number(b.dataset.revoke) }) }); toast("Link revoked"); await loadShareList(); }
        catch (e) { $("share-error").textContent = e.message; }
      }));
    } catch (e) { list.innerHTML = `<div class="share-item">${esc(e.message)}</div>`; }
  }
  $("share-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!shareCtxPath) return;
    const btn = $("share-create");
    btn.disabled = true;
    $("share-error").textContent = "";
    try {
      const hours = $("share-expiry").value;
      const r = await api("share", { method: "POST", body: JSON.stringify({ path: shareCtxPath, expires_in_hours: hours ? Number(hours) : null, label: $("share-label").value }) });
      const full = new URL(r.url, location.href).href;
      $("share-url").value = full;
      $("share-result").hidden = false;
      $("share-url").focus(); $("share-url").select();
      navigator.clipboard?.writeText(full).then(() => toast("Link created and copied")).catch(() => toast("Link created"));
      await loadShareList();
    } catch (err) { $("share-error").textContent = err.message; }
    finally { btn.disabled = false; }
  });
  $("share-copy").addEventListener("click", () => {
    const v = $("share-url").value;
    if (!v) return;
    navigator.clipboard?.writeText(v).then(() => toast("Link copied")).catch(() => { $("share-url").select(); });
  });
  $("shares-btn").addEventListener("click", () => openShareDialog(null));

  // ---------- Move / copy to a chosen folder ----------
  function pickFolder({ title, text, ok, disabled = new Set(), initial = state.cwd }) {
    return new Promise((resolve) => {
      const modal = $("folder-modal");
      $("folder-title").textContent = title;
      $("folder-text").textContent = text || "";
      $("folder-ok").textContent = ok;
      $("folder-error").textContent = "";
      const tree = $("folder-tree");
      let chosen = initial;
      const dirs = [...state.dirs].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
      const rows = [{ path: "", depth: 0, name: state.info.name }].concat(dirs.map(d => ({ path: d.path, depth: d.path.split("/").length, name: d.name })));
      tree.innerHTML = rows.map(r => {
        const off = disabled.has(r.path) || [...disabled].some(d => d && r.path.startsWith(d + "/"));
        return `<button type="button" data-path="${esc(r.path)}" style="padding-left:${8 + r.depth * 18}px" ${off ? "disabled" : ""} class="${r.path === chosen ? "active" : ""}">${r.path === "" ? "🏠" : "📁"} ${esc(r.name)}</button>`;
      }).join("");
      if (!tree.querySelector(`button.active`) || tree.querySelector(`button.active`).disabled) { chosen = ""; tree.querySelector('[data-path=""]').classList.add("active"); }
      tree.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
        chosen = b.dataset.path;
        tree.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
      }));
      tree.querySelectorAll("button").forEach(b => b.addEventListener("dblclick", () => { if (!b.disabled) onOk(); }));
      modal.hidden = false;
      const okBtn = $("folder-ok");
      const onOk = () => { cleanup(); resolve(chosen); };
      const onClose = () => { cleanup(); resolve(null); };
      const cleanup = () => { okBtn.removeEventListener("click", onOk); modal.querySelectorAll("[data-close]").forEach(x => x.removeEventListener("click", onClose)); modal.hidden = true; };
      okBtn.addEventListener("click", onOk);
      modal.querySelectorAll("[data-close]").forEach(x => x.addEventListener("click", onClose));
    });
  }

  async function moveOrCopyDialog(paths, op) {
    if (!paths.length) return;
    const isMove = op === "move";
    // A folder can't be moved/copied into itself; when moving, the current
    // parent is pointless too.
    const disabled = new Set(paths.filter(p => entryAt(p)?.kind === "dir"));
    const dest = await pickFolder({
      title: isMove ? `Move ${paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`} to…` : `Copy ${paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`} to…`,
      text: isMove ? "Choose the destination folder. Version history moves with each file." : "Choose the destination folder. Copies share stored content, so they use no extra space; if a name is taken the copy is named “… copy”.",
      ok: isMove ? "Move here" : "Copy here",
      disabled,
      initial: paths.length && parentOf(paths[0]) === state.cwd ? "" : state.cwd,
    });
    if (dest === null) return;
    await performMoveCopy(paths, dest, op);
  }

  async function performMoveCopy(paths, dest, op) {
    try {
      const r = await api(op, { method: "POST", body: JSON.stringify({ paths, to: dest }) });
      state.selected.clear();
      const n = op === "move" ? r.moved.length : r.copied.length;
      const where = dest ? `"${baseName(dest)}"` : "the top level";
      toast(op === "move" ? (n ? `Moved ${n} item${n === 1 ? "" : "s"} to ${where}` : "Nothing to move") : `Copied ${n} item${n === 1 ? "" : "s"} to ${where}`);
      if (op === "move" && state.previewPath) {
        const hit = r.moved.find(m => state.previewPath === m.from || state.previewPath.startsWith(m.from + "/"));
        if (hit) state.previewPath = hit.to + state.previewPath.slice(hit.from.length);
      }
      await loadTree();
    } catch (e) { toast(e.message, true); }
  }

  // Move via drag-and-drop within the listing (onto folders or breadcrumbs).
  // Hold Alt/Option while dropping to copy instead.
  let dragPaths = null;
  $("listing").addEventListener("dragstart", (e) => {
    const item = e.target.closest(".item");
    if (!item || !state.canWrite) return;
    const p = item.dataset.path;
    dragPaths = state.selected.has(p) ? [...state.selected] : [p];
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/x-repo-paths", JSON.stringify(dragPaths));
  });
  $("listing").addEventListener("dragend", () => { dragPaths = null; document.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target")); });
  function internalDrag(e) { return dragPaths && e.dataTransfer.types.includes("text/x-repo-paths"); }
  async function moveInto(targetDir, copy = false) {
    const paths = (dragPaths || []).filter(p => !(joinPath(targetDir, baseName(p)) === p || targetDir === p || targetDir.startsWith(p + "/")));
    dragPaths = null;
    if (!paths.length) return;
    await performMoveCopy(paths, targetDir, copy ? "copy" : "move");
  }
  for (const [container, selector] of [[$("listing"), ".item[data-kind='dir']"], [$("crumbs"), "a[data-path]"]]) {
    container.addEventListener("dragover", (e) => {
      if (!internalDrag(e)) return;
      const t = e.target.closest(selector);
      container.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      t.classList.add("drop-target");
    });
    container.addEventListener("drop", (e) => {
      if (!internalDrag(e)) return;
      const t = e.target.closest(selector);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      t.classList.remove("drop-target");
      moveInto(t.dataset.path, e.altKey);
    });
  }

  // ---------- Uploads (drag & drop of files and folders) ----------
  const browser = $("browser");
  let dragDepth = 0;
  browser.addEventListener("dragenter", (e) => {
    if (!state.canWrite || internalDrag(e) || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    browser.classList.add("dragover");
    $("dropzone-hint").hidden = false;
  });
  browser.addEventListener("dragover", (e) => {
    if (!state.canWrite || internalDrag(e) || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  browser.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; browser.classList.remove("dragover"); $("dropzone-hint").hidden = true; }
  });
  browser.addEventListener("drop", async (e) => {
    if (internalDrag(e)) return;
    if (!state.canWrite || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth = 0;
    browser.classList.remove("dragover");
    $("dropzone-hint").hidden = true;
    try {
      const entries = await extractDropped(e.dataTransfer);
      if (entries.length) uploadEntries(entries, state.cwd);
    } catch (err) { toast("Couldn't read the dropped items: " + err.message, true); }
  });
  $("upload-btn").addEventListener("click", (e) => {
    if (e.altKey || e.shiftKey) $("upload-folder-input").click(); else $("upload-input").click();
  });
  $("upload-btn").title = "Upload files (Shift-click to pick a folder)";
  $("upload-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []).map(file => ({ file, relativePath: file.name }));
    e.target.value = "";
    if (files.length) uploadEntries(files, state.cwd);
  });
  $("upload-folder-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []).map(file => ({ file, relativePath: file.webkitRelativePath || file.name }));
    e.target.value = "";
    if (files.length) uploadEntries(files, state.cwd);
  });

  function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
      const out = [];
      const step = () => reader.readEntries(batch => { if (!batch.length) resolve(out); else { out.push(...batch); step(); } }, reject);
      step();
    });
  }
  async function walkEntry(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      return [{ file, relativePath: (prefix ? prefix + "/" : "") + entry.name }];
    }
    if (entry.isDirectory) {
      const children = await readAllEntries(entry.createReader());
      const nested = await Promise.all(children.map(c => walkEntry(c, (prefix ? prefix + "/" : "") + entry.name)));
      return nested.flat();
    }
    return [];
  }
  async function extractDropped(dt) {
    const items = dt.items;
    if (items && items.length && typeof items[0].webkitGetAsEntry === "function") {
      const entries = [];
      for (const item of items) { const en = item.webkitGetAsEntry(); if (en) entries.push(en); }
      return (await Promise.all(entries.map(en => walkEntry(en, "")))).flat();
    }
    return Array.from(dt.files || []).map(file => ({ file, relativePath: file.name }));
  }

  const MAX_PARALLEL = 3;
  async function uploadEntries(entries, destDir) {
    const max = state.info.max_file_bytes || Infinity;
    const panel = $("uploads");
    panel.hidden = false;
    const jobs = entries.map(e => ({ ...e, dest: joinPath(destDir, e.relativePath.replace(/^\/+/, "")), pct: 0, status: e.file.size > max ? "too large" : "queued" }));
    state.uploads = jobs;
    renderUploads();
    let done = 0, failed = 0, idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const job = jobs[idx++];
        if (job.status === "too large") { failed++; continue; }
        try {
          await uploadOne(job);
          job.status = "done"; job.pct = 100; done++;
        } catch (e) {
          job.status = "error: " + (e.message || "failed"); failed++;
          if (e.signIn) { toast("Your session expired — sign in again", true); }
        }
        renderUploads();
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, jobs.length) }, worker));
    $("uploads-title").textContent = failed ? `Uploaded ${done}, ${failed} failed` : `Uploaded ${done} file${done === 1 ? "" : "s"}`;
    if (!failed) setTimeout(() => { if (state.uploads === jobs) panel.hidden = true; }, 4000);
    await loadTree();
    const info = await api("info"); state.stats = info.stats; renderStorage();
  }
  function uploadOne(job) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API}upload?path=${encodeURIComponent(job.dest)}`);
      xhr.setRequestHeader("X-CSRF-Token", state.csrf || "");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { job.pct = Math.round((e.loaded / e.total) * 100); job.status = "uploading"; renderUploads(); } };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else { const err = new Error(data.error || `Upload failed (${xhr.status})`); err.signIn = !!data.sign_in; reject(err); }
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(job.file);
    });
  }
  function renderUploads() {
    const list = $("uploads-list");
    const jobs = state.uploads;
    const active = jobs.filter(j => j.status === "uploading" || j.status === "queued").length;
    $("uploads-title").textContent = active ? `Uploading ${jobs.length - active + 1} of ${jobs.length}…` : "Uploads";
    list.innerHTML = jobs.slice(-60).map(j => `
      <div class="upload-row">
        <div class="line"><span class="n" title="${esc(j.dest)}">${esc(j.relativePath)}</span>
        <span class="s ${j.status.startsWith("error") || j.status === "too large" ? "err" : j.status === "done" ? "ok" : ""}">${j.status === "uploading" ? j.pct + "%" : j.status === "done" ? "✓" : esc(j.status)}</span></div>
        <div class="bar"><div class="fill" style="width:${j.pct}%"></div></div>
      </div>`).join("");
  }
  $("uploads-close").addEventListener("click", () => { $("uploads").hidden = true; });

  // ---------- Web links ----------
  $("new-link-btn").addEventListener("click", () => openLinkDialog({}));
  function openLinkDialog({ path = null, link = null }) {
    $("link-title").textContent = path ? "Edit link" : "New link";
    $("link-path").value = path || "";
    $("link-url").value = link ? link.url : "";
    $("link-name").value = link ? link.title : "";
    $("link-desc").value = link ? (link.description || "") : "";
    $("link-image").value = link ? (link.image || "") : "";
    $("link-site-name").value = link ? (link.site_name || "") : "";
    $("link-fetched-at").value = link ? (link.fetched_at || "") : "";
    $("link-error").textContent = "";
    updateLinkPreviewBox();
    $("link-modal").hidden = false;
    setTimeout(() => $("link-url").focus(), 0);
  }
  function updateLinkPreviewBox() {
    const img = $("link-image").value.trim();
    const site = $("link-site-name").value.trim();
    const box = $("link-preview-box");
    box.hidden = !img && !site;
    $("link-preview-img").hidden = !img;
    if (img) $("link-preview-img").src = img;
    $("link-preview-site").textContent = site;
  }
  $("link-image").addEventListener("input", updateLinkPreviewBox);
  $("link-fetch").addEventListener("click", async () => {
    const btn = $("link-fetch");
    const errEl = $("link-error");
    errEl.textContent = "";
    const url = $("link-url").value.trim();
    if (!url) { errEl.textContent = "Enter a URL first"; return; }
    btn.disabled = true; btn.textContent = "Fetching…";
    try {
      const { preview } = await api("link-preview", { method: "POST", body: JSON.stringify({ url }) });
      $("link-url").value = preview.url;
      if (preview.title && !$("link-name").value.trim()) $("link-name").value = preview.title;
      else if (preview.title && $("link-name").value.trim() === "") $("link-name").value = preview.title;
      if (preview.description && !$("link-desc").value.trim()) $("link-desc").value = preview.description;
      if (preview.image) $("link-image").value = preview.image;
      $("link-site-name").value = preview.site_name || "";
      $("link-fetched-at").value = preview.fetched_at;
      updateLinkPreviewBox();
      if (!preview.title && !preview.description && !preview.image) toast("The page didn't offer any details — fill them in by hand");
    } catch (e) { errEl.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = "Fetch details"; }
  });
  $("link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("link-error");
    errEl.textContent = "";
    const path = $("link-path").value;
    const body = {
      url: $("link-url").value.trim(), title: $("link-name").value.trim(), description: $("link-desc").value.trim(),
      image: $("link-image").value.trim(), site_name: $("link-site-name").value, fetched_at: $("link-fetched-at").value || null,
    };
    if (path) body.path = path; else body.dir = state.cwd;
    $("link-save").disabled = true;
    try {
      const r = await api("link", { method: "POST", body: JSON.stringify(body) });
      $("link-modal").hidden = true;
      toast(path ? "Link updated" : "Link saved");
      await loadTree();
      showPreview(r.file.path);
    } catch (err) { errEl.textContent = err.message; }
    finally { $("link-save").disabled = false; }
  });

  // ---------- Text editor ----------
  const editor = { file: null, create: false, dirty: false };
  function openEditor(file, { create = false } = {}) {
    editor.file = file; editor.create = create; editor.dirty = false;
    const modal = $("editor-modal");
    $("editor-title").textContent = (create ? "New: " : "Edit: ") + file.path;
    $("editor-error").textContent = "";
    $("editor-note").value = "";
    $("editor-status").textContent = create ? "" : `v${file.version_no} · ${fmtBytes(file.size)}`;
    const isMd = file.mime === "text/markdown";
    $("editor-mode").hidden = !isMd;
    setEditorMode(isMd ? (localStorage.getItem("repo.editorMode") || "split") : "edit");
    const ta = $("editor-text");
    ta.value = "";
    modal.hidden = false;
    if (create) { ta.focus(); return; }
    fetch(fileUrl(file.path) + `&_v=${file.version_no}`, { credentials: "same-origin" }).then(r => r.ok ? r.text() : Promise.reject(new Error(`Couldn't load (${r.status})`)))
      .then(t => { ta.value = t; updateEditorPreview(); ta.focus(); })
      .catch(e => { $("editor-error").textContent = e.message; });
  }
  function setEditorMode(mode) {
    $("editor-body").dataset.mode = mode;
    document.querySelectorAll("#editor-mode button").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    if (editor.file && editor.file.mime === "text/markdown") localStorage.setItem("repo.editorMode", mode);
    updateEditorPreview();
  }
  function updateEditorPreview() {
    if (!editor.file || editor.file.mime !== "text/markdown" || $("editor-body").dataset.mode === "edit") return;
    $("editor-preview").innerHTML = renderMarkdown($("editor-text").value);
  }
  document.querySelectorAll("#editor-mode button").forEach(b => b.addEventListener("click", () => setEditorMode(b.dataset.mode)));
  let previewTimer = null;
  $("editor-text").addEventListener("input", () => { editor.dirty = true; clearTimeout(previewTimer); previewTimer = setTimeout(updateEditorPreview, 150); });
  $("editor-text").addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); const ta = e.target; const s = ta.selectionStart; ta.setRangeText("  ", s, ta.selectionEnd, "end"); editor.dirty = true; }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveEditor(); }
  });
  $("editor-cancel").addEventListener("click", async () => {
    if (editor.dirty && !(await confirmDialog({ title: "Discard changes?", text: "Your unsaved edits will be lost.", ok: "Discard" }))) return;
    $("editor-modal").hidden = true;
  });
  $("editor-save").addEventListener("click", saveEditor);
  async function saveEditor() {
    const btn = $("editor-save");
    btn.disabled = true;
    $("editor-error").textContent = "";
    try {
      const r = await api("text", { method: "POST", body: JSON.stringify({ path: editor.file.path, content: $("editor-text").value, note: $("editor-note").value, create: editor.create }) });
      $("editor-modal").hidden = true;
      toast(r.new_version ? `Saved v${r.file.version_no}` : "No changes to save");
      await loadTree();
      showPreview(r.file.path);
    } catch (e) { $("editor-error").textContent = e.message; }
    finally { btn.disabled = false; }
  }

  // ---------- Trash ----------
  $("trash-btn").addEventListener("click", () => openTrash());
  $("trash-back").addEventListener("click", () => closeTrash());
  $("trash-empty").addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Empty the trash?", text: "Every deleted item and its version history will be permanently removed.", ok: "Empty trash" }))) return;
    try { await api("trash/purge", { method: "POST", body: "{}" }); await openTrash(); await loadTree(); } catch (e) { toast(e.message, true); }
  });
  async function openTrash() {
    state.trashMode = true;
    $("main").hidden = true; $("toolbar").hidden = true; $("selbar").hidden = true;
    $("trash-view").hidden = false;
    try {
      const { entries, ttl_days } = await api("trash");
      $("trash-note").textContent = `Items are kept for ${ttl_days} days, then removed automatically. Restoring a folder brings back everything deleted with it.`;
      const list = $("trash-list");
      if (!entries.length) { list.innerHTML = `<div class="empty">The trash is empty.</div>`; return; }
      list.innerHTML = entries.map(t => `
        <div class="trash-row" data-id="${t.id}">
          <div>${iconFor(t)}</div>
          <div class="path" title="${esc(t.path)}">${esc(t.path)}</div>
          <div class="muted">${t.kind === "dir" ? "folder" : fmtBytes(t.size)}</div>
          <div class="muted">${esc(fmtDate(t.deleted_at))}${t.deleted_by ? ` · ${esc(t.deleted_by)}` : ""}</div>
          <div class="acts"><button type="button" class="btn btn-sm" data-restore>Restore</button><button type="button" class="btn btn-sm btn-danger" data-purge>Delete forever</button></div>
        </div>`).join("");
      list.querySelectorAll("[data-restore]").forEach(b => b.addEventListener("click", async () => {
        const id = Number(b.closest(".trash-row").dataset.id);
        try { const r = await api("trash/restore", { method: "POST", body: JSON.stringify({ ids: [id] }) }); toast(`Restored ${r.restored.length} item${r.restored.length === 1 ? "" : "s"}`); await openTrash(); await loadTree(); }
        catch (e) { toast(e.message, true); }
      }));
      list.querySelectorAll("[data-purge]").forEach(b => b.addEventListener("click", async () => {
        const id = Number(b.closest(".trash-row").dataset.id);
        if (!(await confirmDialog({ title: "Delete forever?", text: "This item and all of its versions will be permanently removed.", ok: "Delete forever" }))) return;
        try { await api("trash/purge", { method: "POST", body: JSON.stringify({ ids: [id] }) }); await openTrash(); await loadTree(); }
        catch (e) { toast(e.message, true); }
      }));
    } catch (e) { $("trash-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function closeTrash() {
    state.trashMode = false;
    $("trash-view").hidden = true;
    $("toolbar").hidden = false; $("main").hidden = false;
    render();
  }

  // ---------- Passkeys (WebAuthn) ----------
  // Same wire format as the admin panel: the server speaks base64url JSON,
  // the browser API wants ArrayBuffers.
  function b64uToBuf(value) {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function bufToB64u(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const passkeysInBrowser = () => typeof window.PublicKeyCredential !== "undefined" && !!(navigator.credentials && navigator.credentials.get);
  function passkeyAvailable() { return !!state.info?.passkey_enabled && passkeysInBrowser(); }
  async function signInWithPasskey(errEl, btn) {
    errEl.textContent = "";
    btn.disabled = true;
    try {
      const options = await api("auth/passkey/options", { method: "POST", body: "{}" });
      const assertion = await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: b64uToBuf(options.challenge),
          allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: b64uToBuf(c.id) })),
        },
      });
      if (!assertion) throw new Error("No passkey selected");
      const r = assertion.response;
      const result = await api("auth/passkey/verify", {
        method: "POST",
        body: JSON.stringify({ response: {
          id: assertion.id, rawId: bufToB64u(assertion.rawId), type: assertion.type,
          clientExtensionResults: assertion.getClientExtensionResults(),
          authenticatorAttachment: assertion.authenticatorAttachment || undefined,
          response: {
            clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData),
            signature: bufToB64u(r.signature), userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
          },
        } }),
      });
      closeModals();
      state.csrf = result.csrf_token;
      await boot();
      toast(`Signed in as ${result.username}`);
    } catch (err) {
      // NotAllowedError is the user dismissing the OS prompt — not worth an error.
      errEl.textContent = err.name === "NotAllowedError" ? "" : err.message;
    } finally { btn.disabled = false; }
  }
  $("signin-passkey-btn").addEventListener("click", () => signInWithPasskey($("signin-error"), $("signin-passkey-btn")));
  $("gate-passkey").addEventListener("click", () => signInWithPasskey($("gate-error"), $("gate-passkey")));

  // ---------- Sign in / out ----------
  function openSignIn() {
    $("signin-passkey-block").hidden = !passkeyAvailable();
    $("signin-error").textContent = "";
    $("signin-code-row").hidden = true;
    $("signin-code").value = "";
    $("signin-password").value = "";
    $("signin-modal").hidden = false;
    setTimeout(() => $("signin-username").focus(), 0);
  }
  $("gate-signin").addEventListener("click", async () => {
    if (state.info.auth.authenticated) await signOut({ silent: true });
    openSignIn();
  });
  document.querySelector("#who #signin-btn")?.addEventListener("click", openSignIn);
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("signin-error");
    errEl.textContent = "";
    const body = { username: $("signin-username").value.trim(), password: $("signin-password").value };
    const code = $("signin-code").value.trim();
    if (code) body.code = code;
    try {
      const r = await api("auth/login", { method: "POST", body: JSON.stringify(body) });
      if (r.requires_2fa) { $("signin-code-row").hidden = false; $("signin-code").focus(); return; }
      closeModals();
      state.csrf = r.csrf_token;
      await boot();
      toast(`Signed in as ${r.username}`);
    } catch (err) {
      if (err.data && err.data.requires_2fa) $("signin-code-row").hidden = false;
      errEl.textContent = err.message;
    }
  });
  async function signOut({ silent = false } = {}) {
    try { await api("auth/logout", { method: "POST", body: "{}" }); } catch (_) {}
    state.csrf = null;
    if (!silent) { await boot(); toast("Signed out"); }
  }


// --- Password reveal ---
// Every password field gets a "Show" checkbox beneath it so you can confirm
// what you typed. Fields are wrapped in a block so the checkbox sits inside
// the same grid/flex cell as the input and never shifts a form row. Works for
// fields that exist at load and any added later (modals), via an observer.
  function installPasswordReveal(root = document) {
  const wrap = (input) => {
    if (input.dataset.revealBound) return;
    input.dataset.revealBound = "1";
    const wrapper = document.createElement("span");
    wrapper.className = "pw-wrap";
    if (input.style.width) wrapper.style.width = input.style.width;
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    const label = document.createElement("label");
    label.className = "pw-reveal";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("aria-label", "Show password");
    label.appendChild(box);
    label.appendChild(document.createTextNode(" Show"));
    wrapper.appendChild(label);
    box.addEventListener("change", () => { input.type = box.checked ? "text" : "password"; });
    // A form reset hides the text again.
    const form = input.closest("form");
    if (form) form.addEventListener("reset", () => { box.checked = false; input.type = "password"; });
  };
  root.querySelectorAll('input[type="password"]').forEach(wrap);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;
      if (n.matches && n.matches('input[type="password"]')) wrap(n);
      n.querySelectorAll?.('input[type="password"]').forEach(wrap);
    }
  }).observe(root.body || root, { childList: true, subtree: true });
}

  // ---------- Boot ----------
  async function boot() {
    try {
      await loadInfo();
      const urlState = readUrlState();
      if (state.canRead) {
        await loadTree();
        if (urlState.file && entryAt(urlState.file)) showPreview(urlState.file, { keep: true });
      }
      $("app").dataset.state = "ready";
    } catch (e) {
      $("app").dataset.state = "ready";
      toast(e.message || "Couldn't load the repository", true);
    }
  }
  installPasswordReveal();
  boot();
})();
