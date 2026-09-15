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

  function iconFor(file) {
    if (file.kind === "dir") return "📁";
    const m = file.mime || "";
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
      if ((m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
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
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|>|`{3}|~{3}|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
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
          : `<div class="thumb${f.kind === "dir" ? " dir" : ""}">${iconFor(f)}</div>`;
        const label = searching ? f.path : f.name;
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
    $("preview-title").textContent = f.name;
    const body = $("preview-body");
    const kind = previewKind(f.mime);
    const url = fileUrl(path) + `&_v=${f.version_no}`;
    if (kind === "image") body.innerHTML = `<img src="${esc(url)}" alt="${esc(f.name)}">`;
    else if (kind === "video") body.innerHTML = `<video controls preload="metadata" src="${esc(url)}"></video>`;
    else if (kind === "audio") body.innerHTML = `<audio controls preload="metadata" src="${esc(url)}"></audio>`;
    else if (kind === "pdf") body.innerHTML = `<iframe src="${esc(url)}" title="${esc(f.name)}"></iframe>`;
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
      <a class="btn btn-sm" href="${esc(fileUrl(path, { dl: true }))}">Download</a>
      ${kind !== "none" ? `<a class="btn btn-sm" href="${esc(fileUrl(path))}" target="_blank" rel="noopener">Open</a>` : ""}
      <button type="button" class="btn btn-sm" data-act="copy">Copy link</button>
      ${state.canWrite && isTextFile(f) ? `<button type="button" class="btn btn-sm btn-primary" data-act="edit">Edit</button>` : ""}
      ${state.canWrite ? `<button type="button" class="btn btn-sm" data-act="rename">Rename</button><button type="button" class="btn btn-sm btn-danger" data-act="delete">Delete</button>` : ""}`;
    acts.querySelector('[data-act="copy"]').addEventListener("click", () => {
      const link = new URL(`?file=${encodeURIComponent(path)}`, document.baseURI).href;
      navigator.clipboard?.writeText(link).then(() => toast("Link copied")).catch(() => toast(link));
    });
    acts.querySelector('[data-act="edit"]')?.addEventListener("click", () => openEditor(f));
    acts.querySelector('[data-act="rename"]')?.addEventListener("click", () => promptRename(path));
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
      title: f.kind === "dir" ? "Rename or move folder" : "Rename or move file",
      text: "Edit the name, or give a full path (e.g. archive/2025/report.pdf) to move it into another folder.",
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

  // Move via drag-and-drop within the listing (onto folders or breadcrumbs).
  let dragPaths = null;
  $("listing").addEventListener("dragstart", (e) => {
    const item = e.target.closest(".item");
    if (!item || !state.canWrite) return;
    const p = item.dataset.path;
    dragPaths = state.selected.has(p) ? [...state.selected] : [p];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-repo-paths", JSON.stringify(dragPaths));
  });
  $("listing").addEventListener("dragend", () => { dragPaths = null; document.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target")); });
  function internalDrag(e) { return dragPaths && e.dataTransfer.types.includes("text/x-repo-paths"); }
  async function moveInto(targetDir) {
    const paths = dragPaths || [];
    dragPaths = null;
    let moved = 0;
    for (const p of paths) {
      const dest = joinPath(targetDir, baseName(p));
      if (dest === p || targetDir === p || targetDir.startsWith(p + "/")) continue;
      try { await api("rename", { method: "POST", body: JSON.stringify({ from: p, to: dest }) }); moved++; }
      catch (e) { toast(e.message, true); }
    }
    if (moved) { state.selected.clear(); toast(`Moved ${moved} item${moved === 1 ? "" : "s"}`); await loadTree(); }
  }
  for (const [container, selector] of [[$("listing"), ".item[data-kind='dir']"], [$("crumbs"), "a[data-path]"]]) {
    container.addEventListener("dragover", (e) => {
      if (!internalDrag(e)) return;
      const t = e.target.closest(selector);
      container.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      t.classList.add("drop-target");
    });
    container.addEventListener("drop", (e) => {
      if (!internalDrag(e)) return;
      const t = e.target.closest(selector);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      t.classList.remove("drop-target");
      moveInto(t.dataset.path);
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

  // ---------- Sign in / out ----------
  function openSignIn() {
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
  boot();
})();
