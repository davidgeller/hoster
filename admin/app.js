/* ============================================
   HOSTER — Admin Panel Application
   ============================================ */

const API = "/_admin/api";

// --- Theme Management ---
function initTheme() {
  const saved = localStorage.getItem("hoster-theme") || "auto";
  applyTheme(saved);
  document.querySelectorAll(".theme-toggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === saved);
    btn.addEventListener("click", () => {
      const theme = btn.dataset.theme;
      localStorage.setItem("hoster-theme", theme);
      applyTheme(theme);
      document.querySelectorAll(".theme-toggle button").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
    });
  });
}

function applyTheme(theme) {
  if (theme === "auto") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((localStorage.getItem("hoster-theme") || "auto") === "auto") {
    applyTheme("auto");
  }
});

// --- API Helpers ---
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiForm(path, formData) {
  const res = await fetch(API + path, { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
}

// --- App State ---
let currentView = "dashboard";

// --- Init ---
document.addEventListener("DOMContentLoaded", async () => {
  initTheme();

  try {
    const auth = await api("/auth-check");
    if (!auth.setup) {
      showScreen("setup-screen");
    } else if (!auth.authenticated) {
      showScreen("login-screen");
    } else {
      showScreen("main-screen");
      navigateTo("dashboard");
    }
  } catch (e) {
    showScreen("login-screen");
  }

  // --- Setup Form ---
  document.getElementById("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("setup-password").value;
    const confirm = document.getElementById("setup-confirm").value;
    const errEl = document.getElementById("setup-error");

    if (pw !== confirm) { errEl.textContent = "Passwords do not match"; return; }
    try {
      await api("/setup", { method: "POST", body: JSON.stringify({ password: pw }) });
      showScreen("main-screen");
      navigateTo("dashboard");
    } catch (err) { errEl.textContent = err.message; }
  });

  // --- Login Form ---
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("login-password").value;
    const errEl = document.getElementById("login-error");
    errEl.textContent = "";
    try {
      await api("/login", { method: "POST", body: JSON.stringify({ password: pw }) });
      showScreen("main-screen");
      navigateTo("dashboard");
    } catch (err) { errEl.textContent = err.message; }
  });

  // --- Navigation ---
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      navigateTo(link.dataset.view);
    });
  });

  // --- Logout ---
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/logout", { method: "POST" });
    showScreen("login-screen");
  });

  // --- Upload Modal ---
  document.getElementById("upload-btn").addEventListener("click", () => {
    document.getElementById("upload-modal").hidden = false;
  });
  document.getElementById("upload-cancel").addEventListener("click", closeUploadModal);
  document.querySelector(".modal-backdrop")?.addEventListener("click", closeUploadModal);

  // File drop visual
  const dropZone = document.getElementById("file-drop");
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) document.getElementById("upload-file").files = e.dataTransfer.files;
  });

  // --- Upload Form ---
  document.getElementById("upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const slug = document.getElementById("upload-slug").value.toLowerCase().trim();
    const name = document.getElementById("upload-name").value.trim() || slug;
    const file = document.getElementById("upload-file").files[0];
    const errEl = document.getElementById("upload-error");
    const progress = document.getElementById("upload-progress");
    const submitBtn = document.getElementById("upload-submit");

    errEl.textContent = "";
    if (!file) { errEl.textContent = "Please select a ZIP file"; return; }

    progress.hidden = false;
    submitBtn.disabled = true;

    const fd = new FormData();
    fd.append("slug", slug);
    fd.append("name", name);
    fd.append("file", file);

    try {
      await apiForm("/sites", fd);
      closeUploadModal();
      navigateTo("sites");
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      progress.hidden = true;
      submitBtn.disabled = false;
    }
  });

  // --- Dashboard range change ---
  document.getElementById("dash-range").addEventListener("change", () => loadDashboard());

  // --- Analytics range change ---
  document.getElementById("analytics-range").addEventListener("change", () => loadAnalytics());

  // --- Refresh logs ---
  document.getElementById("refresh-logs").addEventListener("click", () => loadLogs());

  // --- Password form ---
  document.getElementById("password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("pw-error");
    const successEl = document.getElementById("pw-success");
    errEl.textContent = "";
    successEl.textContent = "";

    const current = document.getElementById("pw-current").value;
    const newPw = document.getElementById("pw-new").value;
    const confirm = document.getElementById("pw-confirm").value;

    if (newPw !== confirm) { errEl.textContent = "Passwords do not match"; return; }
    try {
      await api("/change-password", {
        method: "POST",
        body: JSON.stringify({ current, password: newPw }),
      });
      successEl.textContent = "Password updated successfully";
      e.target.reset();
    } catch (err) { errEl.textContent = err.message; }
  });
});

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = true));
  document.getElementById(id).hidden = false;
}

function navigateTo(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  document.getElementById("view-" + view).hidden = false;
  document.querySelectorAll("[data-view]").forEach((a) =>
    a.classList.toggle("active", a.dataset.view === view)
  );

  if (view === "dashboard") loadDashboard();
  else if (view === "sites") loadSites();
  else if (view === "analytics") loadAnalytics();
  else if (view === "logs") loadLogs();
  else if (view === "about") loadAbout();
}

async function loadAbout() {
  try {
    const data = await api("/version");
    document.getElementById("about-version").textContent = "Version " + data.version;
  } catch (_) {}
}

function closeUploadModal() {
  document.getElementById("upload-modal").hidden = true;
  document.getElementById("upload-form").reset();
  document.getElementById("upload-error").textContent = "";
  document.getElementById("upload-progress").hidden = true;
}

// --- Dashboard ---
async function loadDashboard() {
  const hours = document.getElementById("dash-range").value;

  const [overview, topSites, traffic, countries, statusCodes] = await Promise.all([
    api(`/analytics/overview?hours=${hours}`),
    api(`/analytics/top-sites?hours=${hours}`),
    api(`/analytics/traffic?hours=${hours}`),
    api(`/analytics/countries?hours=${hours}`),
    api(`/analytics/status-codes?hours=${hours}`),
  ]);

  // Stats cards
  document.getElementById("dash-stats").innerHTML = `
    <div class="stat-card"><div class="stat-label">Requests</div><div class="stat-value">${fmt(overview.total_requests)}</div></div>
    <div class="stat-card"><div class="stat-label">Unique Visitors</div><div class="stat-value">${fmt(overview.unique_visitors)}</div></div>
    <div class="stat-card"><div class="stat-label">Active Sites</div><div class="stat-value">${fmt(overview.active_sites)}</div></div>
    <div class="stat-card"><div class="stat-label">Avg Response</div><div class="stat-value">${overview.avg_response_ms ?? 0}ms</div></div>
  `;

  // Traffic chart
  renderBarChart("dash-traffic-chart", traffic, "hits", "bucket");

  // Top sites
  renderRankedList("dash-top-sites", topSites, "site_slug", "hits");

  // Countries
  renderRankedList("dash-countries", countries, "country", "hits");

  // Status codes
  renderRankedList("dash-status-codes", statusCodes, "status_group", "count");
}

// --- Sites ---
async function loadSites() {
  const { sites } = await api("/sites");
  const el = document.getElementById("sites-list");

  if (!sites.length) {
    el.innerHTML = `<div class="empty-state"><p>No sites deployed yet. Click <strong>Deploy Site</strong> to get started.</p></div>`;
    return;
  }

  el.innerHTML = sites.map((s) => `
    <div class="site-card" data-slug="${esc(s.slug)}">
      <div class="site-card-header">
        <div>
          <h2>${esc(s.name)}</h2>
          <div class="site-slug">/${esc(s.slug)}</div>
          <div class="site-version-info">
            ${s.current_version ? `v${s.current_version}` : "no version"}
            ${s.root_dir ? ` · root: <code>${esc(s.root_dir)}</code>` : ""}
            ${s.spa ? " · SPA" : ""}
          </div>
        </div>
        <span class="site-badge ${s.active ? "badge-active" : "badge-inactive"}">
          ${s.active ? "Active" : "Inactive"}
        </span>
      </div>
      <div class="site-meta">
        <span>${formatBytes(s.size_bytes)}</span>
        <span>${s.file_count} files</span>
        <span>${timeAgo(s.updated_at)}</span>
      </div>
      <div class="site-actions">
        <a href="/${esc(s.slug)}/" target="_blank" class="btn btn-sm">Visit</a>
        <button class="btn btn-sm" onclick="showSiteDetail('${esc(s.slug)}')">Versions</button>
        <button class="btn btn-sm" onclick="redeploySite('${esc(s.slug)}', '${esc(s.name)}')">Update</button>
        <button class="btn btn-sm" data-settings="${esc(s.slug)}">Settings</button>
        <button class="btn btn-sm ${s.active ? "btn-danger" : "btn-primary"}" onclick="toggleSiteActive('${esc(s.slug)}', ${!s.active})">
          ${s.active ? "Disable" : "Enable"}
        </button>
        <button class="btn btn-sm btn-danger" onclick="confirmDeleteSite('${esc(s.slug)}')">Delete</button>
      </div>
    </div>
  `).join("");

  // Bind settings buttons (avoids inline onclick quoting issues)
  el.querySelectorAll("[data-settings]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.dataset.settings;
      const site = sites.find((s) => s.slug === slug);
      if (site) showSiteSettings(slug, site.root_dir, site.spa);
    });
  });
}

window.showSiteDetail = async function (slug) {
  const { site, versions } = await api(`/sites/${slug}`);

  const modal = document.createElement("div");
  modal.className = "modal site-detail-modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h2>${esc(site.name)} — Versions</h2>
      <p class="text-sm text-muted mb-2">Current: <code>${site.current_version || "none"}</code></p>
      <div class="version-list">
        ${versions.map((v) => `
          <div class="version-item ${v.version === site.current_version ? "active" : ""}">
            <div class="version-meta">
              <span class="version-id">${v.version}${v.label ? ` — ${esc(v.label)}` : ""}</span>
              <span class="version-date">${formatBytes(v.size_bytes)} · ${v.file_count} files · ${timeAgo(v.created_at)}</span>
            </div>
            <div class="version-actions">
              ${v.version !== site.current_version ? `
                <button class="btn btn-sm btn-primary" onclick="activateVersion('${slug}', '${v.version}')">Activate</button>
                <button class="btn btn-sm btn-danger" onclick="deleteVersionBtn('${slug}', '${v.version}')">Delete</button>
              ` : '<span class="site-badge badge-active">Current</span>'}
            </div>
          </div>
        `).join("")}
      </div>
      <div class="modal-actions mt-4">
        <button class="btn btn-ghost close-modal">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());
};

window.activateVersion = async function (slug, version) {
  await api(`/sites/${slug}/versions/${version}/activate`, { method: "POST" });
  document.querySelector(".site-detail-modal")?.remove();
  loadSites();
};

window.deleteVersionBtn = async function (slug, version) {
  if (!confirm(`Delete version ${version}?`)) return;
  try {
    await api(`/sites/${slug}/versions/${version}`, { method: "DELETE" });
    document.querySelector(".site-detail-modal")?.remove();
    showSiteDetail(slug);
  } catch (err) { alert(err.message); }
};

window.showSiteSettings = function (slug, rootDir, spa) {
  const modal = document.createElement("div");
  modal.className = "modal site-settings-modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h2>Site Settings — ${esc(slug)}</h2>
      <form id="site-settings-form">
        <label>
          Root Directory
          <input type="text" id="settings-root-dir" value="${esc(rootDir || "")}" placeholder="e.g. browser, dist, build (leave empty for top level)">
          <small>Subdirectory containing index.html. Auto-detected for Angular/React/Vue builds.</small>
        </label>
        <label style="display:flex;align-items:center;gap:10px;flex-direction:row">
          <input type="checkbox" id="settings-spa" ${spa ? "checked" : ""} style="width:auto;margin:0">
          <span>SPA Mode <small style="display:inline;margin:0">(serve index.html for all unmatched routes)</small></span>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
        <div class="form-error" id="settings-error"></div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
  modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());
  modal.querySelector("#site-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newRoot = document.getElementById("settings-root-dir").value.trim() || null;
    const newSpa = document.getElementById("settings-spa").checked;
    try {
      await api(`/sites/${slug}/settings`, {
        method: "POST",
        body: JSON.stringify({ root_dir: newRoot, spa: newSpa }),
      });
      modal.remove();
      loadSites();
    } catch (err) {
      document.getElementById("settings-error").textContent = err.message;
    }
  });
};

window.redeploySite = function (slug, name) {
  document.getElementById("upload-slug").value = slug;
  document.getElementById("upload-name").value = name;
  document.getElementById("upload-modal").hidden = false;
};

window.toggleSiteActive = async function (slug, active) {
  await api(`/sites/${slug}/${active ? "enable" : "disable"}`, { method: "POST" });
  loadSites();
};

window.confirmDeleteSite = async function (slug) {
  if (!confirm(`Delete site "${slug}" and ALL its versions? This cannot be undone.`)) return;
  await api(`/sites/${slug}`, { method: "DELETE" });
  loadSites();
};

// --- Analytics ---
async function loadAnalytics() {
  const hours = document.getElementById("analytics-range").value;

  const [paths, agents] = await Promise.all([
    api(`/analytics/top-paths?hours=${hours}`),
    api(`/analytics/user-agents?hours=${hours}`),
  ]);

  renderRankedList("analytics-paths", paths, "path", "hits");
  renderRankedList("analytics-agents", agents, "user_agent", "hits", true);
}

// --- Logs ---
async function loadLogs() {
  const logs = await api("/analytics/recent?limit=100");
  const tbody = document.getElementById("logs-body");

  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted)">No requests logged yet</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map((r) => {
    const statusClass = r.status < 300 ? "status-2xx" : r.status < 400 ? "status-3xx" : r.status < 500 ? "status-4xx" : "status-5xx";
    return `
      <tr>
        <td>${timeAgo(r.created_at)}</td>
        <td>${r.method}</td>
        <td class="truncate" title="${esc(r.path)}">${esc(r.path)}</td>
        <td><span class="status-badge ${statusClass}">${r.status}</span></td>
        <td class="text-mono text-sm">${esc(r.ip)}</td>
        <td>${r.country || "—"}</td>
        <td class="text-mono text-sm">${r.response_time_ms?.toFixed(1) ?? "—"}ms</td>
      </tr>
    `;
  }).join("");
}

// --- Render Helpers ---
function renderBarChart(containerId, data, valueKey, labelKey) {
  const el = document.getElementById(containerId);
  if (!data || !data.length) {
    el.innerHTML = '<div class="empty-state"><p>No data</p></div>';
    return;
  }
  const max = Math.max(...data.map((d) => d[valueKey]), 1);
  el.innerHTML = `<div class="bar-chart">
    ${data.map((d) => {
      const pct = (d[valueKey] / max) * 100;
      const label = d[labelKey]?.replace("T", " ").substring(5, 16) || "";
      return `<div class="bar" style="height:${Math.max(pct, 2)}%" title="${label}: ${d[valueKey]}">
        <div class="bar-tooltip">${label}<br>${d[valueKey]} hits</div>
      </div>`;
    }).join("")}
  </div>`;
}

function renderRankedList(containerId, data, labelKey, valueKey, truncateLabel = false) {
  const el = document.getElementById(containerId);
  if (!data || !data.length) {
    el.innerHTML = '<div class="empty-state"><p>No data</p></div>';
    return;
  }
  const max = Math.max(...data.map((d) => d[valueKey]), 1);
  el.innerHTML = `<ul class="ranked-list">
    ${data.map((d) => `
      <li class="ranked-item">
        <div style="flex:1;min-width:0">
          <span class="label ${truncateLabel ? "truncate" : ""}">${esc(String(d[labelKey] || "—"))}</span>
          <span class="ranked-bar" style="width:${(d[valueKey] / max) * 100}%"></span>
        </div>
        <span class="value">${fmt(d[valueKey])}</span>
      </li>
    `).join("")}
  </ul>`;
}

// --- Utility ---
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function fmt(n) {
  if (n == null) return "0";
  return n.toLocaleString();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(dateStr + (dateStr.includes("Z") ? "" : "Z"));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}
