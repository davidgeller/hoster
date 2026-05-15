/* ============================================
   HOSTER — Admin Panel Application
   ============================================ */

const API = "/_admin/api";

// Country code to name resolver (uses browser's built-in Intl API)
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code) {
  if (!code) return "Unknown";
  try { return countryNames.of(code.toUpperCase()) || code; }
  catch { return code; }
}

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
  const headers = { "Content-Type": "application/json", ...opts.headers };
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  // Capture CSRF token from responses that provide one
  if (data.csrf_token) csrfToken = data.csrf_token;
  return data;
}

async function apiForm(path, formData) {
  const headers = {};
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(API + path, { method: "POST", body: formData, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
}

// --- App State ---
let currentView = "dashboard";
let pendingTotpToken = null;
let csrfToken = null;

// --- Init ---
document.addEventListener("DOMContentLoaded", async () => {
  initTheme();

  try {
    const auth = await api("/auth-check");
    if (auth.csrf_token) csrfToken = auth.csrf_token;
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
      const res = await fetch(API + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");

      if (data.requires_2fa) {
        pendingTotpToken = data.pending_token;
        showScreen("totp-screen");
        document.getElementById("totp-code").value = "";
        document.getElementById("totp-code").focus();
        return;
      }

      if (data.csrf_token) csrfToken = data.csrf_token;
      showScreen("main-screen");
      navigateTo("dashboard");
    } catch (err) { errEl.textContent = err.message; }
  });

  // --- 2FA Verification Form ---
  document.getElementById("totp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("totp-code").value;
    const errEl = document.getElementById("totp-error");
    errEl.textContent = "";
    try {
      await api("/login/2fa", {
        method: "POST",
        body: JSON.stringify({ pending_token: pendingTotpToken, code }),
      });
      pendingTotpToken = null;
      showScreen("main-screen");
      navigateTo("dashboard");
    } catch (err) { errEl.textContent = err.message; }
  });

  document.getElementById("totp-back-btn").addEventListener("click", () => {
    pendingTotpToken = null;
    showScreen("login-screen");
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
  document.querySelector("#upload-modal .modal-backdrop")?.addEventListener("click", closeUploadModal);

  // --- Blank Site Modal ---
  const blankModal = document.getElementById("blank-site-modal");
  document.getElementById("blank-site-btn").addEventListener("click", () => {
    blankModal.hidden = false;
  });
  document.getElementById("blank-cancel").addEventListener("click", closeBlankModal);
  blankModal.querySelector(".modal-backdrop").addEventListener("click", closeBlankModal);

  document.getElementById("blank-site-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const slug = document.getElementById("blank-slug").value.toLowerCase().trim();
    const name = document.getElementById("blank-name").value.trim() || slug;
    const errEl = document.getElementById("blank-error");
    const submitBtn = document.getElementById("blank-submit");
    errEl.textContent = "";
    if (!slug) { errEl.textContent = "Slug is required"; return; }
    submitBtn.disabled = true;
    try {
      await api("/sites/blank", {
        method: "POST",
        body: JSON.stringify({ slug, name }),
      });
      closeBlankModal();
      navigateTo("sites");
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

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

  // --- Log filters ---
  document.getElementById("apply-log-filters").addEventListener("click", () => loadLogs());
  document.getElementById("clear-log-filters").addEventListener("click", () => {
    document.getElementById("log-filter-status").value = "";
    document.getElementById("log-filter-country").value = "";
    document.getElementById("log-filter-site").value = "";
    document.getElementById("log-filter-search").value = "";
    loadLogs();
  });
  document.getElementById("log-filter-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); loadLogs(); }
  });

  // --- Country restriction form ---
  document.getElementById("country-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("country-error");
    const successEl = document.getElementById("country-success");
    errEl.textContent = "";
    successEl.textContent = "";
    const input = document.getElementById("allowed-countries").value.trim();
    const countries = input ? input.split(",").map(c => c.trim().toUpperCase()).filter(Boolean) : [];
    try {
      await api("/settings/countries", {
        method: "POST",
        body: JSON.stringify({ countries }),
      });
      successEl.textContent = countries.length ? `Restricted to: ${countries.join(", ")}` : "All countries allowed";
    } catch (err) { errEl.textContent = err.message; }
  });

  // --- Auto-block form ---
  document.getElementById("autoblock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("autoblock-error");
    const successEl = document.getElementById("autoblock-success");
    errEl.textContent = "";
    successEl.textContent = "";
    try {
      await api("/settings/autoblock", {
        method: "POST",
        body: JSON.stringify({
          enabled: document.getElementById("autoblock-enabled").checked,
          threshold: parseInt(document.getElementById("autoblock-threshold").value) || 20,
          window_minutes: parseInt(document.getElementById("autoblock-window").value) || 10,
          duration_hours: parseInt(document.getElementById("autoblock-duration").value) || 0,
        }),
      });
      successEl.textContent = "Auto-block settings saved";
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
  else if (view === "explorer") loadExplorer();
  else if (view === "analytics") loadAnalytics();
  else if (view === "logs") loadLogs();
  else if (view === "settings") loadSettings();
  else if (view === "about") loadAbout();
}

async function loadSettings() {
  bindSettingsTabs();

  try {
    const data = await api("/settings/countries");
    document.getElementById("allowed-countries").value = (data.countries || []).join(", ");
  } catch (_) {}

  try {
    const config = await api("/settings/autoblock");
    document.getElementById("autoblock-enabled").checked = config.enabled;
    document.getElementById("autoblock-threshold").value = config.threshold;
    document.getElementById("autoblock-window").value = config.window_minutes;
    document.getElementById("autoblock-duration").value = config.duration_hours;
  } catch (_) {}

  loadBlockedIps();
  loadTotpSettings();
  loadMcpTokens();
  loadOauthGrants();
  loadMcpAudit();
  loadCmsLibEditor();
}

// Settings page tabs — Access / MCP / OAuth / Security / Backup / CMS Library.
// Bound once; the buttons live in the static view so this is idempotent.
function bindSettingsTabs() {
  const tabs = document.querySelectorAll("#view-settings .settings-tab[data-settings-tab]");
  if (!tabs.length || tabs[0].dataset.bound) return;
  const panels = document.querySelectorAll("#view-settings .settings-page-panel");
  tabs.forEach(tab => {
    tab.dataset.bound = "1";
    tab.addEventListener("click", () => {
      const target = tab.dataset.settingsTab;
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      panels.forEach(p => {
        const match = p.dataset.settingsPanel === target;
        p.classList.toggle("active", match);
        p.hidden = !match;
      });
    });
  });
}

// --- CMS Library editor ---
// Shows the JS + CSS served at /_cms/<file>. Stored in SQLite (cms_lib_files),
// shared across every CMS-enabled site. Each file has its own version+etag
// so edits propagate to browsers on the next request without forcing a reload.
const cmsLibState = {
  files: {},          // path -> last-loaded file record
  current: "cms.js",
  dirty: false,
};

async function loadCmsLibEditor() {
  const editor = document.getElementById("cms-lib-content");
  if (!editor) return;
  try {
    const { files } = await api("/cms-lib");
    cmsLibState.files = {};
    for (const f of files) cmsLibState.files[f.path] = f;
    await selectCmsLibFile(cmsLibState.current);
    bindCmsLibHandlers();
  } catch (e) {
    const err = document.getElementById("cms-lib-error");
    if (err) err.textContent = e.message || "Failed to load CMS library";
  }
}

async function selectCmsLibFile(path) {
  cmsLibState.current = path;
  document.getElementById("cms-lib-file").value = path;
  document.getElementById("cms-lib-error").textContent = "";
  document.getElementById("cms-lib-success").textContent = "";
  try {
    const file = await api("/cms-lib/" + encodeURIComponent(path));
    cmsLibState.files[path] = file;
    document.getElementById("cms-lib-content").value = file.content;
    cmsLibState.dirty = false;
    renderCmsLibMeta(file);
  } catch (e) {
    document.getElementById("cms-lib-error").textContent = e.message;
  }
}

function renderCmsLibMeta(file) {
  const meta = document.getElementById("cms-lib-meta");
  if (!meta) return;
  const dirty = cmsLibState.dirty ? ' · <span style="color:var(--warning,#b07000)">unsaved changes</span>' : "";
  meta.innerHTML = `version <code>${esc(file.version)}</code> · ${file.size.toLocaleString()} bytes · updated ${esc(file.updated_at)}${dirty}`;
}

function bindCmsLibHandlers() {
  const editor = document.getElementById("cms-lib-content");
  const fileSelect = document.getElementById("cms-lib-file");
  if (!editor || editor.dataset.bound) return;
  editor.dataset.bound = "1";

  editor.addEventListener("input", () => {
    cmsLibState.dirty = true;
    const current = cmsLibState.files[cmsLibState.current];
    if (current) renderCmsLibMeta(current);
  });

  fileSelect.addEventListener("change", async () => {
    if (cmsLibState.dirty && !confirm("Discard unsaved changes?")) {
      fileSelect.value = cmsLibState.current;
      return;
    }
    await selectCmsLibFile(fileSelect.value);
  });

  document.getElementById("cms-lib-discard-btn").addEventListener("click", async () => {
    if (!cmsLibState.dirty) return;
    if (!confirm("Discard unsaved changes?")) return;
    await selectCmsLibFile(cmsLibState.current);
  });

  document.getElementById("cms-lib-save-btn").addEventListener("click", async () => {
    const path = cmsLibState.current;
    const content = editor.value;
    const err = document.getElementById("cms-lib-error");
    const ok = document.getElementById("cms-lib-success");
    err.textContent = "";
    ok.textContent = "";
    try {
      const file = await api("/cms-lib/" + encodeURIComponent(path), {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      cmsLibState.files[path] = file;
      cmsLibState.dirty = false;
      renderCmsLibMeta(file);
      ok.textContent = `Saved ${path} (${file.size.toLocaleString()} bytes)`;
    } catch (e) {
      err.textContent = e.message;
    }
  });

  document.getElementById("cms-lib-reset-btn").addEventListener("click", async () => {
    const path = cmsLibState.current;
    if (!confirm(`Reset ${path} to the bundled default? Any edits to ${path} will be lost.`)) return;
    const err = document.getElementById("cms-lib-error");
    const ok = document.getElementById("cms-lib-success");
    err.textContent = "";
    ok.textContent = "";
    try {
      await api("/cms-lib/reset", { method: "POST", body: JSON.stringify({ path }) });
      await selectCmsLibFile(path);
      ok.textContent = `Reset ${path} to bundled default.`;
    } catch (e) {
      err.textContent = e.message;
    }
  });
}

async function loadBlockedIps() {
  const el = document.getElementById("blocked-ips-list");
  if (!el) return;
  try {
    const { ips } = await api("/settings/blocked-ips");
    if (!ips.length) {
      el.innerHTML = '<p class="text-sm text-muted">No blocked IPs</p>';
      return;
    }
    el.innerHTML = `<h4 style="margin:0 0 8px;font-size:0.85rem;color:var(--text-muted)">Currently Blocked IPs</h4>
      <ul class="ranked-list">${ips.map(ip => `
        <li class="ranked-item">
          <div style="flex:1;min-width:0">
            <span class="label text-mono">${esc(ip.ip)}</span>
            <span class="text-sm text-muted">${esc(ip.reason || "")}</span>
            ${ip.expires_at ? `<span class="text-sm text-muted">expires ${ip.expires_at.replace("T", " ").substring(0, 16)}</span>` : '<span class="text-sm text-muted">permanent</span>'}
          </div>
          <button class="btn btn-sm" onclick="unblockIp(${ip.id})" title="Unblock">Unblock</button>
        </li>`).join("")}
      </ul>`;
  } catch (_) {
    el.innerHTML = '';
  }
}

async function unblockIp(id) {
  try {
    await api(`/settings/blocked-ips/${id}`, { method: "DELETE" });
    loadBlockedIps();
  } catch (err) { console.error(err); }
}

async function loadTotpSettings() {
  const container = document.getElementById("totp-settings");
  if (!container) return;
  try {
    const status = await api("/totp/status");
    if (status.enabled) {
      container.innerHTML = `
        <p style="margin-bottom:12px;color:var(--success);font-weight:500">2FA is enabled</p>
        <p class="text-sm text-muted" style="margin-bottom:12px">Recovery codes remaining: <strong>${status.recovery_codes_remaining}</strong></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" id="totp-regen-recovery">Regenerate Recovery Codes</button>
          <button class="btn btn-sm btn-danger" id="totp-disable-btn">Disable 2FA</button>
        </div>
        <div class="form-error" id="totp-settings-error" style="margin-top:8px"></div>
      `;
      document.getElementById("totp-disable-btn").addEventListener("click", async () => {
        const password = prompt("Enter your password to disable 2FA:");
        if (!password) return;
        const errEl = document.getElementById("totp-settings-error");
        errEl.textContent = "";
        try {
          await api("/totp/disable", {
            method: "POST",
            body: JSON.stringify({ password }),
          });
          loadTotpSettings();
        } catch (err) { errEl.textContent = err.message; }
      });
      document.getElementById("totp-regen-recovery").addEventListener("click", async () => {
        const password = prompt("Enter your password to regenerate recovery codes:");
        if (!password) return;
        const errEl = document.getElementById("totp-settings-error");
        errEl.textContent = "";
        try {
          const data = await api("/totp/recovery-codes", {
            method: "POST",
            body: JSON.stringify({ password }),
          });
          showRecoveryCodes(data.recovery_codes);
          loadTotpSettings();
        } catch (err) { errEl.textContent = err.message; }
      });
    } else {
      container.innerHTML = `
        <p class="text-sm text-muted" style="margin-bottom:12px">Add an extra layer of security by requiring a code from an authenticator app (like Authy, Google Authenticator, or 1Password) when you sign in.</p>
        <button class="btn btn-primary btn-sm" id="totp-setup-btn">Enable 2FA</button>
      `;
      document.getElementById("totp-setup-btn").addEventListener("click", startTotpSetup);
    }
  } catch (_) {}
}

async function startTotpSetup() {
  try {
    const data = await api("/totp/setup", { method: "POST" });
    const modal = document.createElement("div");
    modal.className = "modal totp-setup-modal";
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content" style="max-width:420px">
        <h2>Set Up 2FA</h2>
        <p class="text-sm text-muted" style="margin-bottom:16px">Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.</p>
        <div style="text-align:center;margin-bottom:16px">
          <img src="${data.qr}" alt="QR Code" style="width:200px;height:200px;image-rendering:pixelated;border-radius:8px">
        </div>
        <p class="text-sm text-muted" style="margin-bottom:4px">Or enter this key manually:</p>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:monospace;font-size:0.85rem;word-break:break-all;margin-bottom:16px;user-select:all;text-align:center;letter-spacing:0.1em">${data.secret}</div>
        <form id="totp-confirm-form">
          <input type="text" id="totp-confirm-code" placeholder="000000" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required style="text-align:center;font-size:1.3rem;letter-spacing:0.3em;font-family:monospace">
          <div class="modal-actions" style="margin-top:12px">
            <button type="button" class="btn btn-ghost close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Verify & Enable</button>
          </div>
          <div class="form-error" id="totp-confirm-error" style="margin-top:8px"></div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());
    modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());
    modal.querySelector("#totp-confirm-code").focus();

    modal.querySelector("#totp-confirm-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = document.getElementById("totp-confirm-code").value;
      const errEl = document.getElementById("totp-confirm-error");
      errEl.textContent = "";
      try {
        const result = await api("/totp/confirm", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        modal.remove();
        showRecoveryCodes(result.recovery_codes);
        loadTotpSettings();
      } catch (err) { errEl.textContent = err.message; }
    });
  } catch (err) { alert(err.message); }
}

function showRecoveryCodes(codes) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width:420px">
      <h2>Recovery Codes</h2>
      <p class="text-sm" style="margin-bottom:12px;color:var(--danger);font-weight:500">Save these codes in a safe place. Each code can only be used once.</p>
      <p class="text-sm text-muted" style="margin-bottom:16px">If you lose access to your authenticator app, you can use one of these codes to sign in.</p>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px;font-family:monospace;font-size:0.95rem;margin-bottom:16px;column-count:2;column-gap:16px;line-height:2">${codes.map(c => `<div>${c}</div>`).join("")}</div>
      <div class="modal-actions" style="gap:8px">
        <button class="btn btn-sm" id="recovery-copy-btn">Copy Codes</button>
        <button class="btn btn-primary close-modal">I've Saved These</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());
  modal.querySelector("#recovery-copy-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(codes.join("\n"));
    modal.querySelector("#recovery-copy-btn").textContent = "Copied!";
  });
}

async function loadMcpTokens() {
  const container = document.getElementById("mcp-token-list");
  if (!container) return;
  try {
    const [{ tokens }, { sites }] = await Promise.all([
      api("/mcp/tokens"),
      api("/sites"),
    ]);
    const mcpSites = sites.filter(s => s.mcp_enabled);

    let html = "";
    if (tokens.length) {
      html += `<table style="width:100%;font-size:0.85rem;margin-bottom:12px">
        <thead><tr><th style="text-align:left">Label</th><th style="text-align:left">Scope</th><th style="text-align:left">Expires</th><th></th></tr></thead>
        <tbody>`;
      for (const t of tokens) {
        const scopeText = t.site_slug ? esc(t.site_slug) : "All sites";
        const expiresText = t.expired ? '<span style="color:var(--danger)">Expired</span>' : timeUntil(t.expires_at);
        html += `<tr>
          <td>${esc(t.label)}</td>
          <td><code>${scopeText}</code></td>
          <td>${expiresText}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-sm" data-setup-token="${t.id}">Setup</button>
            <button class="btn btn-sm btn-danger" data-delete-token="${t.id}">Revoke</button>
          </td>
        </tr>`;
      }
      html += "</tbody></table>";
    } else {
      html += `<p class="text-muted" style="margin-bottom:12px">No tokens. Generate one to enable MCP access.</p>`;
    }

    // Generate form
    html += `<div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <label style="flex:1;min-width:120px;margin:0">
          <small>Label</small>
          <input type="text" id="mcp-token-label" placeholder="e.g. Claude Code" style="margin:0">
        </label>
        <label style="min-width:120px;margin:0">
          <small>Scope</small>
          <select id="mcp-token-scope" style="margin:0">
            <option value="">All MCP sites</option>
            ${mcpSites.map(s => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join("")}
          </select>
        </label>
        <label style="min-width:100px;margin:0">
          <small>Expires</small>
          <select id="mcp-token-expires" style="margin:0">
            <option value="30">30 days</option>
            <option value="90" selected>90 days</option>
            <option value="365">1 year</option>
            <option value="">Never</option>
          </select>
        </label>
        <button class="btn btn-primary btn-sm" id="mcp-generate-btn" style="height:38px">Generate</button>
      </div>
    </div>`;

    container.innerHTML = html;

    // Bind delete buttons
    container.querySelectorAll("[data-delete-token]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Revoke this token? It will immediately stop working.")) return;
        await api(`/mcp/tokens/${btn.dataset.deleteToken}`, { method: "DELETE" });
        loadMcpTokens();
      });
    });

    // Bind setup buttons
    container.querySelectorAll("[data-setup-token]").forEach(btn => {
      btn.addEventListener("click", () => {
        const tokenId = btn.dataset.setupToken;
        const tokenData = tokens.find(t => String(t.id) === tokenId);
        showMcpSetup(tokenData?.label);
      });
    });

    // Bind generate button
    document.getElementById("mcp-generate-btn")?.addEventListener("click", async () => {
      const label = document.getElementById("mcp-token-label").value.trim();
      if (!label) { alert("Label is required"); return; }
      const siteSlug = document.getElementById("mcp-token-scope").value || undefined;
      const expiresVal = document.getElementById("mcp-token-expires").value;
      const expiresInDays = expiresVal ? parseInt(expiresVal) : undefined;
      try {
        const { token } = await api("/mcp/tokens", {
          method: "POST",
          body: JSON.stringify({ label, site_slug: siteSlug, expires_in_days: expiresInDays }),
        });
        showMcpToken(token, label);
        loadMcpTokens();
      } catch (err) { alert(err.message); }
    });
  } catch (_) {}
}

function showDelegateShareModal(label, password, connectorUrl) {
  const shareText = `Hi! Here are the details to connect your AI tool to my site:

Connector URL: ${connectorUrl}

When prompted on the consent screen:
  Delegate name: ${label}
  Password: ${password}

Paste the URL into your chat client's "Add MCP server" dialog
(Claude.ai → Settings → Connectors, or equivalent), and use the
delegate name and password above when it asks you to authorize.`;

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width:580px">
      <h2>Delegate Created</h2>
      <p class="text-sm text-muted" style="margin-bottom:12px">Copy these instructions and send them to your collaborator. The password won't be shown again.</p>
      <textarea readonly style="width:100%;min-height:200px;font-family:monospace;font-size:0.85rem;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);resize:vertical;box-sizing:border-box">${esc(shareText)}</textarea>
      <div class="modal-actions" style="margin-top:12px;gap:8px">
        <button class="btn btn-sm" id="share-copy-btn">Copy Instructions</button>
        <button class="btn btn-ghost close-modal">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());
  modal.querySelector("#share-copy-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(shareText);
    modal.querySelector("#share-copy-btn").textContent = "Copied!";
  });
}

async function loadOauthGrants() {
  const urlsEl = document.getElementById("oauth-site-urls");
  const grantsEl = document.getElementById("oauth-grants");
  const clientsEl = document.getElementById("oauth-clients");
  if (!urlsEl || !grantsEl || !clientsEl) return;

  try {
    const [{ grants }, { clients }, { sites }] = await Promise.all([
      api("/oauth/grants"),
      api("/oauth/clients"),
      api("/sites"),
    ]);
    const mcpSites = sites.filter(s => s.mcp_enabled);
    const origin = window.location.origin;

    // --- Per-site connector URLs (helper for pasting into chat clients) ---
    if (mcpSites.length === 0) {
      urlsEl.innerHTML = '<p class="text-muted text-sm" style="margin:0">No MCP-enabled sites yet. Enable MCP on a site under Sites → Settings.</p>';
    } else {
      urlsEl.innerHTML = `
        <div style="font-size:0.85rem;font-weight:500;margin-bottom:6px">Connector URLs</div>
        <table style="width:100%;font-size:0.85rem">
          <thead><tr><th style="text-align:left">Site</th><th style="text-align:left">Connector URL</th><th></th></tr></thead>
          <tbody>
            ${mcpSites.map(s => `
              <tr>
                <td>${esc(s.name)}</td>
                <td><code style="font-size:0.8rem">${esc(origin)}/_mcp/${esc(s.slug)}</code></td>
                <td style="text-align:right"><button class="btn btn-sm" data-copy-url="${esc(origin)}/_mcp/${esc(s.slug)}">Copy</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
      urlsEl.querySelectorAll("[data-copy-url]").forEach(btn => {
        btn.addEventListener("click", () => {
          navigator.clipboard.writeText(btn.dataset.copyUrl);
          const orig = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = orig; }, 1500);
        });
      });
    }

    // --- Active OAuth grants ---
    if (grants.length === 0) {
      grantsEl.innerHTML = '<div style="font-size:0.85rem;font-weight:500;margin-bottom:6px">Active Connections</div><p class="text-muted text-sm" style="margin:0">No active OAuth connections. Connections appear here after a chat client completes the authorize flow.</p>';
    } else {
      let html = `<div style="font-size:0.85rem;font-weight:500;margin-bottom:6px">Active Connections</div>
        <table style="width:100%;font-size:0.85rem">
          <thead><tr><th style="text-align:left">Client</th><th style="text-align:left">Site</th><th style="text-align:left">Authorized by</th><th style="text-align:left">Scopes</th><th style="text-align:left">Issued</th><th></th></tr></thead>
          <tbody>`;
      for (const g of grants) {
        const principalLabel = g.principal === "admin" || !g.principal
          ? '<span class="text-sm text-muted">admin</span>'
          : `<span class="text-sm">delegate <code>${esc(g.principal.replace(/^delegate:/, ""))}</code></span>`;
        html += `<tr>
          <td>${esc(g.client_name)}${g.client_uri ? ` <a href="${esc(g.client_uri)}" target="_blank" rel="noopener" style="font-size:0.75rem">↗</a>` : ""}</td>
          <td><code>${esc(g.site_slug)}</code></td>
          <td>${principalLabel}</td>
          <td><code style="font-size:0.78rem">${esc(g.scopes)}</code></td>
          <td>${timeAgo(g.issued_at)}</td>
          <td style="text-align:right"><button class="btn btn-sm btn-danger" data-revoke-grant="${g.token_id}">Revoke</button></td>
        </tr>`;
      }
      html += "</tbody></table>";
      grantsEl.innerHTML = html;

      grantsEl.querySelectorAll("[data-revoke-grant]").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Revoke this OAuth connection? The client will need to re-authorize.")) return;
          try {
            await api(`/oauth/grants/${btn.dataset.revokeGrant}`, { method: "DELETE" });
            loadOauthGrants();
          } catch (err) { alert(err.message); }
        });
      });
    }

    // --- Registered clients (collapsed by default) ---
    if (clients.length === 0) {
      clientsEl.innerHTML = "";
    } else {
      let html = `<details style="font-size:0.85rem">
        <summary style="cursor:pointer;font-weight:500;margin-bottom:6px">Registered Clients (${clients.length})</summary>
        <table style="width:100%;font-size:0.85rem;margin-top:6px">
          <thead><tr><th style="text-align:left">Name</th><th style="text-align:left">Client ID</th><th style="text-align:left">Last Used</th><th style="text-align:left">Active Grants</th><th></th></tr></thead>
          <tbody>`;
      for (const c of clients) {
        html += `<tr>
          <td>${esc(c.name)}${c.client_uri ? ` <a href="${esc(c.client_uri)}" target="_blank" rel="noopener" style="font-size:0.75rem">↗</a>` : ""}</td>
          <td><code style="font-size:0.78rem">${esc(c.id.slice(0, 12))}…</code></td>
          <td>${c.last_used_at ? timeAgo(c.last_used_at) : '<span class="text-muted">never</span>'}</td>
          <td>${c.active_grants}</td>
          <td style="text-align:right"><button class="btn btn-sm btn-danger" data-delete-client="${esc(c.id)}">Delete</button></td>
        </tr>`;
      }
      html += "</tbody></table></details>";
      clientsEl.innerHTML = html;

      clientsEl.querySelectorAll("[data-delete-client]").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this client and all its tokens? It will need to re-register before it can connect again.")) return;
          try {
            await api(`/oauth/clients/${btn.dataset.deleteClient}`, { method: "DELETE" });
            loadOauthGrants();
          } catch (err) { alert(err.message); }
        });
      });
    }
  } catch (_) {}
}

async function loadMcpAudit() {
  const container = document.getElementById("mcp-audit-log");
  if (!container) return;
  try {
    const { entries } = await api("/mcp/audit?limit=20");
    if (!entries.length) {
      container.innerHTML = `<p class="text-muted">No MCP activity yet.</p>`;
      return;
    }
    container.innerHTML = `<table style="width:100%;font-size:0.8rem">
      <thead><tr><th style="text-align:left">Time</th><th style="text-align:left">Token</th><th style="text-align:left">Tool</th><th style="text-align:left">Site</th><th style="text-align:left">Path</th><th></th></tr></thead>
      <tbody>${entries.map(e => `<tr>
        <td>${timeAgo(e.created_at)}</td>
        <td>${esc(e.token_label || "—")}</td>
        <td><code>${esc(e.tool)}</code></td>
        <td>${esc(e.site_slug || "—")}</td>
        <td class="truncate" style="max-width:150px" title="${esc(e.path || "")}">${esc(e.path || "—")}</td>
        <td>${e.success ? '<span style="color:var(--success)">OK</span>' : '<span style="color:var(--danger)" title="' + esc(e.error || "") + '">ERR</span>'}</td>
      </tr>`).join("")}</tbody>
    </table>`;
  } catch (_) {}
}

// --- Configuration Backup ---
(function initBackup() {
  let pendingBackupFile = null;

  document.addEventListener("DOMContentLoaded", () => {
    const fileInput = document.getElementById("backup-file");
    const fileDrop = document.getElementById("backup-file-drop");
    const loadBtn = document.getElementById("backup-load-btn");
    const saveBtn = document.getElementById("backup-save-btn");

    if (fileInput) {
      fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
          pendingBackupFile = fileInput.files[0];
          fileDrop.querySelector("p").innerHTML = `Selected: <strong>${esc(pendingBackupFile.name)}</strong> (${formatBytes(pendingBackupFile.size)})`;
          loadBtn.disabled = false;
        }
      });
    }

    if (saveBtn) saveBtn.addEventListener("click", handleBackupSave);
    if (loadBtn) loadBtn.addEventListener("click", handleBackupLoad);

    const repairBtn = document.getElementById("repair-sites-btn");
    if (repairBtn) repairBtn.addEventListener("click", async () => {
      const resultEl = document.getElementById("repair-result");
      const errEl = document.getElementById("repair-error");
      resultEl.textContent = "";
      errEl.textContent = "";
      repairBtn.disabled = true;
      const original = repairBtn.textContent;
      repairBtn.textContent = "Repairing…";
      try {
        const data = await api("/sites/repair", { method: "POST" });
        const parts = [];
        if (data.repaired.length > 0) {
          parts.push(esc(`Rebuilt _current for ${data.repaired.length} site${data.repaired.length !== 1 ? "s" : ""}: ${data.repaired.join(", ")}`));
        }
        if (data.ok.length > 0 && data.repaired.length === 0) {
          parts.push(esc(`All ${data.ok.length} site${data.ok.length !== 1 ? "s are" : " is"} already healthy.`));
        }
        if (data.warnings.length > 0) {
          parts.push('<strong style="color:var(--danger)">Warnings:</strong>');
          for (const w of data.warnings) parts.push(`• ${esc(w)}`);
        }
        resultEl.innerHTML = parts.join("<br>");
        // Refresh sites list so badges update
        loadSites();
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        repairBtn.disabled = false;
        repairBtn.textContent = original;
      }
    });

    const cancelBtn = document.getElementById("backup-confirm-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
      document.getElementById("backup-confirm-modal").hidden = true;
    });

    // Close modal on backdrop click
    const modal = document.getElementById("backup-confirm-modal");
    if (modal) {
      modal.querySelector(".modal-backdrop").addEventListener("click", () => {
        modal.hidden = true;
      });
    }
  });

  async function handleBackupSave() {
    const password = document.getElementById("backup-password").value || "";
    const allVersions = document.getElementById("backup-all-versions").checked;
    const progressEl = document.getElementById("backup-save-progress");
    const fillEl = document.getElementById("backup-save-fill");
    const statusEl = document.getElementById("backup-save-status");
    const saveBtn = document.getElementById("backup-save-btn");
    const errEl = document.getElementById("backup-error");
    const successEl = document.getElementById("backup-success");

    errEl.textContent = "";
    successEl.textContent = "";
    progressEl.hidden = false;
    saveBtn.disabled = true;
    statusEl.textContent = "Preparing backup...";
    fillEl.style.width = "";
    fillEl.style.animation = "progress-indeterminate 1.5s ease-in-out infinite";

    try {
      const headers = { "Content-Type": "application/json" };
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

      const res = await fetch(API + "/config/export", {
        method: "POST",
        headers,
        body: JSON.stringify({ password: password || undefined, all_versions: allVersions }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Export failed");
      }

      statusEl.textContent = "Downloading...";
      fillEl.style.animation = "none";
      fillEl.style.width = "80%";

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="(.+?)"/);
      const filename = filenameMatch ? filenameMatch[1] : `hoster-backup-${new Date().toISOString().slice(0, 10)}.hoster`;

      // Trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      fillEl.style.width = "100%";
      statusEl.textContent = "Done!";
      successEl.textContent = `Backup saved (${formatBytes(blob.size)})`;

      setTimeout(() => { progressEl.hidden = true; }, 2000);
    } catch (err) {
      errEl.textContent = err.message;
      progressEl.hidden = true;
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function handleBackupLoad() {
    if (!pendingBackupFile) return;

    const password = document.getElementById("backup-load-password").value || "";
    const errEl = document.getElementById("backup-error");
    const progressEl = document.getElementById("backup-load-progress");
    const fillEl = document.getElementById("backup-load-fill");
    const statusEl = document.getElementById("backup-load-status");

    errEl.textContent = "";
    progressEl.hidden = false;
    statusEl.textContent = "Reading backup...";
    fillEl.style.width = "";
    fillEl.style.animation = "progress-indeterminate 1.5s ease-in-out infinite";

    try {
      // Preview the backup first
      const previewForm = new FormData();
      previewForm.append("file", pendingBackupFile);
      if (password) previewForm.append("password", password);

      const previewHeaders = {};
      if (csrfToken) previewHeaders["X-CSRF-Token"] = csrfToken;

      const previewRes = await fetch(API + "/config/preview", {
        method: "POST",
        body: previewForm,
        headers: previewHeaders,
      });
      const previewData = await previewRes.json();
      if (!previewRes.ok) throw new Error(previewData.error || "Preview failed");

      progressEl.hidden = true;

      // Show confirmation modal with preview info
      const manifest = previewData.manifest;
      const previewInfo = document.getElementById("backup-preview-info");
      previewInfo.innerHTML = `
        <div style="background:var(--bg-hover);border-radius:var(--radius-sm);padding:12px;font-size:0.85rem">
          <div style="margin-bottom:6px"><strong>Backup date:</strong> ${new Date(manifest.created_at).toLocaleString()}</div>
          <div style="margin-bottom:6px"><strong>Hoster version:</strong> ${esc(manifest.hoster_version)}</div>
          <div style="margin-bottom:6px"><strong>Sites:</strong> ${manifest.site_count}</div>
          <div style="margin-bottom:6px"><strong>Versions:</strong> ${manifest.all_versions ? "All versions" : "Current only"}</div>
          <div><strong>Encrypted:</strong> ${manifest.encrypted ? "Yes" : "No"}</div>
        </div>
      `;

      const modal = document.getElementById("backup-confirm-modal");
      const adminPwInput = document.getElementById("backup-confirm-admin-password");
      const confirmErrEl = document.getElementById("backup-confirm-error");
      adminPwInput.value = "";
      confirmErrEl.textContent = "";
      modal.hidden = false;
      setTimeout(() => adminPwInput.focus(), 50);

      // Wait for confirm or cancel
      const confirmBtn = document.getElementById("backup-confirm-ok");
      const cancelBtn = document.getElementById("backup-confirm-cancel");

      const adminPassword = await new Promise((resolve, reject) => {
        const cleanup = () => {
          confirmBtn.removeEventListener("click", onConfirm);
          cancelBtn.removeEventListener("click", onCancel);
          modal.querySelector(".modal-backdrop").removeEventListener("click", onCancel);
        };
        const onConfirm = () => {
          const pw = adminPwInput.value;
          if (!pw) { confirmErrEl.textContent = "Admin password is required."; return; }
          cleanup();
          modal.hidden = true;
          resolve(pw);
        };
        const onCancel = () => { cleanup(); modal.hidden = true; reject(new Error("Cancelled")); };
        confirmBtn.addEventListener("click", onConfirm);
        cancelBtn.addEventListener("click", onCancel);
        modal.querySelector(".modal-backdrop").addEventListener("click", onCancel);
      });

      // User confirmed — proceed with import
      progressEl.hidden = false;
      statusEl.textContent = "Restoring configuration...";
      fillEl.style.animation = "progress-indeterminate 1.5s ease-in-out infinite";

      const importForm = new FormData();
      importForm.append("file", pendingBackupFile);
      if (password) importForm.append("password", password);
      importForm.append("admin_password", adminPassword);
      importForm.append("confirm", "yes");

      const importHeaders = {};
      if (csrfToken) importHeaders["X-CSRF-Token"] = csrfToken;

      const importRes = await fetch(API + "/config/import", {
        method: "POST",
        body: importForm,
        headers: importHeaders,
      });
      const importData = await importRes.json();
      if (!importRes.ok) throw new Error(importData.error || "Import failed");

      fillEl.style.animation = "none";
      fillEl.style.width = "100%";
      statusEl.textContent = "Done!";

      const m = importData.manifest;
      const successEl = document.getElementById("backup-success");
      const warnings = m.warnings || [];
      const repairedCount = (m.repaired || []).length;

      // Build a multi-line success message: counts on the first line, then
      // a "repaired" note if symlinks had to be rebuilt, then warnings (one
      // per site) so the admin sees broken sites immediately instead of
      // discovering them by clicking around.
      let lines = [`Restored ${m.site_count} site${m.site_count !== 1 ? "s" : ""}.`];
      if (repairedCount > 0) {
        lines.push(`Rebuilt _current symlink for ${repairedCount} site${repairedCount !== 1 ? "s" : ""}.`);
      }
      if (warnings.length > 0) {
        lines.push(`<strong style="color:var(--danger)">${warnings.length} warning${warnings.length !== 1 ? "s" : ""}:</strong>`);
        for (const w of warnings) lines.push(`• ${esc(w)}`);
        lines.push("Reloading in 10 seconds...");
      } else {
        lines.push("Reloading...");
      }
      successEl.innerHTML = lines.join("<br>");

      // Session was cleared during import — give the admin time to read
      // warnings before the page reloads.
      const reloadDelay = warnings.length > 0 ? 10000 : 2000;
      setTimeout(() => { window.location.reload(); }, reloadDelay);

    } catch (err) {
      progressEl.hidden = true;
      if (err.message !== "Cancelled") {
        errEl.textContent = err.message;
      }
    }
  }
})();

function mcpServerName(label) {
  // Convert label to a slug-like name for use as the MCP server identifier
  return (label || "hoster").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "hoster";
}

function getMcpConfigJson(token, label) {
  const origin = window.location.origin;
  const name = mcpServerName(label);
  return JSON.stringify({
    mcpServers: {
      [name]: {
        type: "http",
        url: `${origin}/_mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2);
}

function getMcpCliCommand(token, label, userScope) {
  const origin = window.location.origin;
  const name = mcpServerName(label);
  const scope = userScope ? " --scope user" : "";
  return `claude mcp add --transport http${scope} ${name} ${origin}/_mcp --header "Authorization: Bearer ${token}"`;
}

function showMcpToken(token, label) {
  const configJson = getMcpConfigJson(token, label);
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width:560px">
      <h2>MCP Token Generated</h2>
      <p style="margin-bottom:12px;color:var(--text-muted)">Copy this token now — it won't be shown again.</p>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:monospace;font-size:0.85rem;word-break:break-all;margin-bottom:16px;user-select:all">${esc(token)}</div>

      <h3 style="font-size:0.9rem;margin-bottom:8px">Option 1: JSON Config</h3>
      <p class="text-sm text-muted" style="margin-bottom:8px">Add to your AI tool's MCP settings (e.g. Claude Code <code>settings.json</code>, Cursor, etc.):</p>
      <pre style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;overflow-x:auto;margin-bottom:8px;white-space:pre-wrap">${esc(configJson)}</pre>
      <button class="btn btn-sm" id="mcp-copy-config" style="margin-bottom:16px">Copy JSON</button>

      <h3 style="font-size:0.9rem;margin-bottom:8px">Option 2: Claude Code CLI</h3>
      <fieldset style="border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:0.85rem">
        <legend style="padding:0 6px;font-size:0.8rem;color:var(--text-muted)">Scope</legend>
        <label style="display:flex;align-items:center;gap:6px;margin:4px 0;flex-direction:row">
          <input type="radio" name="mcp-cli-scope" value="local" checked style="width:auto;margin:0">
          <span>This project only <small style="display:inline;margin:0;color:var(--text-muted)">(default)</small></span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;margin:4px 0;flex-direction:row">
          <input type="radio" name="mcp-cli-scope" value="user" style="width:auto;margin:0">
          <span>All projects for this user <small style="display:inline;margin:0;color:var(--text-muted)">(<code>--scope user</code>)</small></span>
        </label>
      </fieldset>
      <pre id="mcp-cli-pre" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;overflow-x:auto;margin-bottom:8px;white-space:pre-wrap"></pre>
      <button class="btn btn-sm" id="mcp-copy-cli" style="margin-bottom:16px">Copy Command</button>

      <p class="text-sm text-muted" style="margin-bottom:16px">Restart your AI tool after adding the config.</p>
      <div class="modal-actions" style="gap:8px">
        <button class="btn btn-sm" id="mcp-copy-token">Copy Token Only</button>
        <button class="btn btn-ghost close-modal">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const cliPre = modal.querySelector("#mcp-cli-pre");
  const getScope = () => modal.querySelector('input[name="mcp-cli-scope"]:checked')?.value === "user";
  const renderCli = () => { cliPre.textContent = getMcpCliCommand(token, label, getScope()); };
  modal.querySelectorAll('input[name="mcp-cli-scope"]').forEach(r => r.addEventListener("change", renderCli));
  renderCli();

  modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());
  modal.querySelector("#mcp-copy-token").addEventListener("click", () => {
    navigator.clipboard.writeText(token);
    modal.querySelector("#mcp-copy-token").textContent = "Copied!";
  });
  modal.querySelector("#mcp-copy-config").addEventListener("click", () => {
    navigator.clipboard.writeText(configJson);
    modal.querySelector("#mcp-copy-config").textContent = "Copied!";
  });
  modal.querySelector("#mcp-copy-cli").addEventListener("click", () => {
    navigator.clipboard.writeText(getMcpCliCommand(token, label, getScope()));
    modal.querySelector("#mcp-copy-cli").textContent = "Copied!";
  });
}

function showMcpSetup(label) {
  const placeholder = "<your-token>";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width:600px">
      <h2>MCP Setup Instructions</h2>
      <p class="text-sm text-muted" style="margin-bottom:16px">Connect your AI tool to this Hoster instance via the Model Context Protocol (MCP).</p>

      <label style="font-size:0.85rem;font-weight:500;display:block;margin-bottom:4px">Your Token</label>
      <input type="text" id="mcp-setup-token-input" placeholder="Paste your MCP token here" style="width:100%;padding:8px 10px;font-family:monospace;font-size:0.85rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);margin-bottom:16px;box-sizing:border-box">

      <h3 style="font-size:0.9rem;margin-bottom:8px">Option 1: JSON Config</h3>
      <p class="text-sm text-muted" style="margin-bottom:8px">Add to your tool's MCP settings file (e.g. Claude Code <code>settings.json</code>, Cursor config, etc.):</p>
      <pre id="mcp-setup-json" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;overflow-x:auto;margin-bottom:8px;white-space:pre-wrap"></pre>
      <button class="btn btn-sm" id="mcp-copy-setup-json" style="margin-bottom:16px">Copy JSON</button>

      <h3 style="font-size:0.9rem;margin-bottom:8px">Option 2: Claude Code CLI</h3>
      <fieldset style="border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:0.85rem">
        <legend style="padding:0 6px;font-size:0.8rem;color:var(--text-muted)">Scope</legend>
        <label style="display:flex;align-items:center;gap:6px;margin:4px 0;flex-direction:row">
          <input type="radio" name="mcp-setup-cli-scope" value="local" checked style="width:auto;margin:0">
          <span>This project only <small style="display:inline;margin:0;color:var(--text-muted)">(default)</small></span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;margin:4px 0;flex-direction:row">
          <input type="radio" name="mcp-setup-cli-scope" value="user" style="width:auto;margin:0">
          <span>All projects for this user <small style="display:inline;margin:0;color:var(--text-muted)">(<code>--scope user</code>)</small></span>
        </label>
      </fieldset>
      <pre id="mcp-setup-cli" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;overflow-x:auto;margin-bottom:8px;white-space:pre-wrap"></pre>
      <button class="btn btn-sm" id="mcp-copy-setup-cli" style="margin-bottom:16px">Copy Command</button>

      <p class="text-sm text-muted" style="margin-bottom:16px">Paste your token above to fill in the config, then copy. Restart your AI tool after adding the config.</p>

      <div class="modal-actions">
        <button class="btn btn-ghost close-modal">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());

  const tokenInput = modal.querySelector("#mcp-setup-token-input");
  const jsonPre = modal.querySelector("#mcp-setup-json");
  const cliPre = modal.querySelector("#mcp-setup-cli");

  const currentToken = () => tokenInput.value.trim() || placeholder;
  const userScope = () => modal.querySelector('input[name="mcp-setup-cli-scope"]:checked')?.value === "user";

  function updateConfigs() {
    jsonPre.textContent = getMcpConfigJson(currentToken(), label);
    cliPre.textContent = getMcpCliCommand(currentToken(), label, userScope());
  }
  tokenInput.addEventListener("input", updateConfigs);
  modal.querySelectorAll('input[name="mcp-setup-cli-scope"]').forEach(r => r.addEventListener("change", updateConfigs));
  updateConfigs();

  modal.querySelector("#mcp-copy-setup-json").addEventListener("click", () => {
    navigator.clipboard.writeText(getMcpConfigJson(currentToken(), label));
    modal.querySelector("#mcp-copy-setup-json").textContent = "Copied!";
  });
  modal.querySelector("#mcp-copy-setup-cli").addEventListener("click", () => {
    navigator.clipboard.writeText(getMcpCliCommand(currentToken(), label, userScope()));
    modal.querySelector("#mcp-copy-setup-cli").textContent = "Copied!";
  });
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

function closeBlankModal() {
  document.getElementById("blank-site-modal").hidden = true;
  document.getElementById("blank-site-form").reset();
  document.getElementById("blank-error").textContent = "";
}

// --- Dashboard ---
async function loadDashboard() {
  const hours = document.getElementById("dash-range").value;

  const [overview, topSites, traffic, bandwidth, countries, statusCodes, blocked] = await Promise.all([
    api(`/analytics/overview?hours=${hours}`),
    api(`/analytics/top-sites?hours=${hours}`),
    api(`/analytics/traffic?hours=${hours}`),
    api(`/analytics/bandwidth?hours=${hours}`),
    api(`/analytics/countries?hours=${hours}`),
    api(`/analytics/status-codes?hours=${hours}`),
    api(`/analytics/blocked?hours=${hours}`),
  ]);

  // Stats cards
  document.getElementById("dash-stats").innerHTML = `
    <div class="stat-card"><div class="stat-label">Requests</div><div class="stat-value">${fmt(overview.total_requests)}</div></div>
    <div class="stat-card"><div class="stat-label">Unique Visitors</div><div class="stat-value">${fmt(overview.unique_visitors)}</div></div>
    <div class="stat-card"><div class="stat-label">Active Sites</div><div class="stat-value">${fmt(overview.active_sites)}</div></div>
    <div class="stat-card"><div class="stat-label">Avg Response</div><div class="stat-value">${overview.avg_response_ms ?? 0}ms</div><div class="stat-detail">${overview.min_response_ms ?? 0}ms – ${overview.max_response_ms ?? 0}ms</div></div>
    <div class="stat-card"><div class="stat-label">Bandwidth Out</div><div class="stat-value">${formatBytes(overview.total_response_bytes)}</div><div class="stat-detail">${formatBytes(overview.total_request_bytes)} in</div></div>
    ${blocked.total > 0 ? `<div class="stat-card stat-card-blocked"><div class="stat-label">Blocked</div><div class="stat-value">${fmt(blocked.total)}</div></div>` : ""}
  `;

  // Traffic chart
  renderBarChart("dash-traffic-chart", traffic, "hits", "bucket");

  // Bandwidth chart (stacked: response bytes on bottom, request bytes on top)
  renderBandwidthChart("dash-bandwidth-chart", "dash-bandwidth-legend", bandwidth);

  // Top sites
  renderRankedList("dash-top-sites", topSites, "site_slug", "hits");

  // Countries — resolve codes to full names
  const countriesNamed = countries.map(c => ({ ...c, countryLabel: countryName(c.country) }));
  renderRankedList("dash-countries", countriesNamed, "countryLabel", "hits");

  // Status codes
  renderRankedList("dash-status-codes", statusCodes, "status_group", "count");

  // Blocked requests section
  const blockedEl = document.getElementById("dash-blocked");
  if (blockedEl) {
    if (blocked.total === 0) {
      blockedEl.innerHTML = '<div class="empty-state"><p>No blocked requests</p></div>';
    } else {
      let html = "";

      if (blocked.countries.length) {
        html += `<h4 style="margin:0 0 8px;font-size:0.85rem;color:var(--text-muted)">Blocked Countries</h4>`;
        html += `<ul class="ranked-list" style="margin-bottom:16px">`;
        const maxC = Math.max(...blocked.countries.map(c => c.hits), 1);
        for (const c of blocked.countries) {
          html += `<li class="ranked-item">
            <div style="flex:1;min-width:0">
              <span class="label">${esc(countryName(c.country))}</span>
              <span class="ranked-bar ranked-bar-blocked" style="width:${(c.hits / maxC) * 100}%"></span>
            </div>
            <span class="value" style="white-space:nowrap">${fmt(c.hits)} <span class="text-sm text-muted">(${c.ips} IP${c.ips !== 1 ? "s" : ""})</span></span>
          </li>`;
        }
        html += `</ul>`;
      }

      if (blocked.paths.length) {
        html += `<h4 style="margin:0 0 8px;font-size:0.85rem;color:var(--text-muted)">Blocked Paths</h4>`;
        html += `<ul class="ranked-list" style="margin-bottom:16px">`;
        const maxP = Math.max(...blocked.paths.map(p => p.hits), 1);
        for (const p of blocked.paths) {
          html += `<li class="ranked-item">
            <div style="flex:1;min-width:0">
              <span class="label truncate" title="${esc(p.path)}">${esc(p.path)}</span>
              <span class="ranked-bar ranked-bar-blocked" style="width:${(p.hits / maxP) * 100}%"></span>
            </div>
            <span class="value">${fmt(p.hits)}</span>
          </li>`;
        }
        html += `</ul>`;
      }

      if (blocked.ips.length) {
        html += `<h4 style="margin:0 0 8px;font-size:0.85rem;color:var(--text-muted)">Top Blocked IPs</h4>`;
        html += `<ul class="ranked-list">`;
        const maxI = Math.max(...blocked.ips.map(i => i.hits), 1);
        for (const i of blocked.ips) {
          html += `<li class="ranked-item">
            <div style="flex:1;min-width:0">
              <span class="label text-mono">${esc(i.ip)}</span> <span class="text-sm text-muted">${esc(i.country ? countryName(i.country) : "")}</span>
              <span class="ranked-bar ranked-bar-blocked" style="width:${(i.hits / maxI) * 100}%"></span>
            </div>
            <span class="value">${fmt(i.hits)}</span>
          </li>`;
        }
        html += `</ul>`;
      }

      blockedEl.innerHTML = html;
    }
  }
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
          <div class="site-slug">/${esc(s.slug)}${s.aliases && s.aliases.length ? ` <span class="text-muted text-sm">(also: ${s.aliases.map(a => "/" + esc(a)).join(", ")})</span>` : ""}${s.host_aliases && s.host_aliases.length ? ` <span class="text-muted text-sm">· host: ${s.host_aliases.map(h => esc(h)).join(", ")}</span>` : ""}</div>
          <div class="site-version-info">
            ${s.current_version ? `v${s.current_version}` : "no version"}
            ${s.root_dir ? ` · root: <code>${esc(s.root_dir)}</code>` : ""}
            ${s.spa ? " · SPA" : ""}
            ${s.mcp_enabled ? (s.mcp_read_only ? " · MCP (read-only)" : s.mcp_auto_commit ? " · MCP (auto-snapshot)" : " · MCP") : ""}
          </div>
        </div>
        <div class="site-card-badges">
          <span class="site-badge ${s.active ? "badge-active" : "badge-inactive"}">
            ${s.active ? "Active" : "Inactive"}
          </span>
          ${s.health && s.health !== "ok" ? `
            <span class="site-badge badge-broken" title="${esc(s.health_detail || s.health)}">Broken</span>
          ` : ""}
        </div>
      </div>
      <div class="site-meta">
        <span>${formatBytes(s.size_bytes)}</span>
        <span>${s.file_count} files</span>
        <span>${timeAgo(s.updated_at)}</span>
      </div>
      <div class="site-actions">
        <a href="/${esc(s.slug)}/${s.current_version ? "?_v=" + esc(s.current_version) : ""}" target="_blank" rel="noopener" class="btn btn-sm">Visit</a>
        <button class="btn btn-sm" onclick="showSiteFiles('${esc(s.slug)}', '${esc(s.name)}')">Files</button>
        <button class="btn btn-sm" onclick="showSiteDetail('${esc(s.slug)}')">Versions</button>
        <button class="btn btn-sm" onclick="redeploySite('${esc(s.slug)}', '${esc(s.name)}')">Update</button>
        <button class="btn btn-sm" onclick="showUploadFile('${esc(s.slug)}', '${esc(s.name)}', loadSites)">Upload File</button>
        <button class="btn btn-sm" data-settings="${esc(s.slug)}">Settings</button>
        <button class="btn btn-sm" onclick="reloadSiteCache('${esc(s.slug)}', this)">Reload</button>
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
      if (site) showSiteSettings(slug, site.root_dir, site.spa, site.mcp_enabled, site.mcp_read_only, site.mcp_auto_commit, site.cms_enabled);
    });
  });
}

// --- Site Explorer (experimental three-column layout) ---
let explorerSites = [];
let explorerSelectedSlug = null;

async function loadExplorer() {
  const { sites } = await api("/sites");
  explorerSites = sites;
  const countEl = document.getElementById("explorer-count");
  if (countEl) countEl.textContent = `${sites.length} site${sites.length === 1 ? "" : "s"}`;

  renderExplorerList();

  const searchEl = document.getElementById("explorer-search");
  if (searchEl && !searchEl.dataset.bound) {
    searchEl.dataset.bound = "1";
    searchEl.addEventListener("input", renderExplorerList);
  }

  // Restore previous selection if still present, else select first
  const remembered = localStorage.getItem("explorer.selectedSlug");
  const initial = (remembered && sites.find(s => s.slug === remembered)) ? remembered : (sites[0]?.slug || null);
  if (initial) selectExplorerSite(initial);
  else {
    document.getElementById("explorer-actions").innerHTML = '<div class="explorer-empty">No sites deployed yet.</div>';
    document.getElementById("explorer-preview").innerHTML = '<div class="explorer-empty">Preview appears here.</div>';
    document.getElementById("explorer-preview-url").textContent = "No site selected";
    document.getElementById("explorer-preview-open").hidden = true;
    document.getElementById("explorer-preview-refresh").hidden = true;
  }
}

function renderExplorerList() {
  const listEl = document.getElementById("explorer-list");
  if (!listEl) return;
  const q = (document.getElementById("explorer-search")?.value || "").trim().toLowerCase();

  const filtered = explorerSites.filter(s => {
    if (!q) return true;
    return s.slug.toLowerCase().includes(q)
      || (s.name || "").toLowerCase().includes(q)
      || (s.aliases || []).some(a => a.toLowerCase().includes(q))
      || (s.host_aliases || []).some(h => h.toLowerCase().includes(q));
  });

  if (!filtered.length) {
    listEl.innerHTML = '<div class="explorer-empty" style="height:auto;padding:30px 16px">No matching sites.</div>';
    return;
  }

  listEl.innerHTML = filtered.map(s => {
    const dotClass = !s.active ? "" : (s.health && s.health !== "ok" ? "broken" : "active");
    const tags = [];
    if (s.spa) tags.push("SPA");
    if (s.mcp_enabled) tags.push(s.mcp_read_only ? "MCP·RO" : "MCP");
    return `
      <button type="button" class="explorer-item ${s.slug === explorerSelectedSlug ? "active" : ""}" data-slug="${esc(s.slug)}">
        <div class="explorer-item-name"><span class="badge-dot ${dotClass}"></span>${esc(s.name)}</div>
        <div class="explorer-item-slug">/${esc(s.slug)}</div>
        <div class="explorer-item-meta">${formatBytes(s.size_bytes)} · ${s.file_count} files${tags.length ? " · " + tags.join(" · ") : ""}</div>
      </button>
    `;
  }).join("");

  listEl.querySelectorAll(".explorer-item").forEach(btn => {
    btn.addEventListener("click", () => selectExplorerSite(btn.dataset.slug));
  });
}

function selectExplorerSite(slug) {
  explorerSelectedSlug = slug;
  localStorage.setItem("explorer.selectedSlug", slug);

  // Update active state in list
  document.querySelectorAll(".explorer-item").forEach(el => {
    el.classList.toggle("active", el.dataset.slug === slug);
  });

  const site = explorerSites.find(s => s.slug === slug);
  if (!site) return;

  renderExplorerActions(site);
  renderExplorerPreview(site);
}

function renderExplorerActions(site) {
  const el = document.getElementById("explorer-actions");
  const aliasLine = (site.aliases && site.aliases.length)
    ? site.aliases.map(a => `/${esc(a)}`).join(", ")
    : '<span class="text-muted">none</span>';
  const hostLine = (site.host_aliases && site.host_aliases.length)
    ? site.host_aliases.map(h => esc(h)).join(", ")
    : '<span class="text-muted">none</span>';
  const mcpLabel = !site.mcp_enabled ? "off"
    : (site.mcp_read_only ? "read-only" : site.mcp_auto_commit ? "auto-snapshot" : "on");

  el.innerHTML = `
    <h2>${esc(site.name)}
      <span class="site-badge ${site.active ? "badge-active" : "badge-inactive"}" style="margin-left:6px;vertical-align:middle">${site.active ? "Active" : "Inactive"}</span>
      ${site.health && site.health !== "ok" ? '<span class="site-badge badge-broken" style="margin-left:4px">Broken</span>' : ""}
    </h2>
    <div class="slug-line">/${esc(site.slug)}</div>
    <dl class="meta-grid">
      <dt>Version</dt><dd>${site.current_version ? esc(site.current_version) : '<span class="text-muted">none</span>'}</dd>
      <dt>Size</dt><dd>${formatBytes(site.size_bytes)} · ${site.file_count} files</dd>
      <dt>Updated</dt><dd>${timeAgo(site.updated_at)}</dd>
      <dt>Root</dt><dd>${site.root_dir ? `<code>${esc(site.root_dir)}</code>` : '<span class="text-muted">—</span>'}</dd>
      <dt>SPA</dt><dd>${site.spa ? "yes" : "no"}</dd>
      <dt>MCP</dt><dd>${mcpLabel}</dd>
      <dt>Aliases</dt><dd>${aliasLine}</dd>
      <dt>Hosts</dt><dd>${hostLine}</dd>
    </dl>
    <div class="action-group">
      <a href="/${esc(site.slug)}/${site.current_version ? "?_v=" + esc(site.current_version) : ""}" target="_blank" rel="noopener" class="btn btn-sm">Visit</a>
      <button class="btn btn-sm" data-act="files">Files</button>
      <button class="btn btn-sm" data-act="versions">Versions</button>
      <button class="btn btn-sm" data-act="update">Update</button>
      <button class="btn btn-sm" data-act="upload">Upload File</button>
      <button class="btn btn-sm" data-act="settings">Settings</button>
      <button class="btn btn-sm" data-act="reload">Reload</button>
      <button class="btn btn-sm ${site.active ? "btn-danger" : "btn-primary"}" data-act="toggle" style="grid-column:1 / -1">${site.active ? "Disable" : "Enable"}</button>
      <button class="btn btn-sm btn-danger" data-act="delete" style="grid-column:1 / -1">Delete</button>
    </div>
  `;

  const slug = site.slug;
  el.querySelector('[data-act="files"]').addEventListener("click", () => showSiteFiles(slug, site.name));
  el.querySelector('[data-act="versions"]').addEventListener("click", () => showSiteDetail(slug));
  el.querySelector('[data-act="update"]').addEventListener("click", () => redeploySite(slug, site.name));
  el.querySelector('[data-act="upload"]').addEventListener("click", () => showUploadFile(slug, site.name, () => loadExplorer()));
  el.querySelector('[data-act="settings"]').addEventListener("click", () =>
    showSiteSettings(slug, site.root_dir, site.spa, site.mcp_enabled, site.mcp_read_only, site.mcp_auto_commit, site.cms_enabled));
  el.querySelector('[data-act="reload"]').addEventListener("click", (e) => reloadSiteCache(slug, e.currentTarget));
  el.querySelector('[data-act="toggle"]').addEventListener("click", async () => {
    await toggleSiteActive(slug, !site.active);
    loadExplorer();
  });
  el.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    await confirmDeleteSite(slug);
    loadExplorer();
  });
}

function renderExplorerPreview(site) {
  const previewEl = document.getElementById("explorer-preview");
  const urlEl = document.getElementById("explorer-preview-url");
  const openEl = document.getElementById("explorer-preview-open");
  const refreshEl = document.getElementById("explorer-preview-refresh");

  const url = `/${site.slug}/${site.current_version ? "?_v=" + site.current_version : ""}`;
  urlEl.textContent = url;
  openEl.href = url;
  openEl.hidden = false;
  refreshEl.hidden = false;

  // Hosted sites are served from the same origin as /_admin; if the iframe ran
  // with allow-same-origin, scripts inside could reach window.parent and read
  // the admin's CSRF token to forge requests. Omitting allow-same-origin gives
  // the iframe an opaque origin so same-origin policy blocks that path. Scripts,
  // forms, and popups still work, so the preview remains useful.
  previewEl.innerHTML = `<iframe src="${esc(url)}" loading="lazy" sandbox="allow-scripts allow-forms allow-popups"></iframe>`;

  refreshEl.onclick = () => {
    const iframe = previewEl.querySelector("iframe");
    if (!iframe) return;
    // Append a cache-buster so the iframe actually re-fetches instead of
    // pulling from disk cache (matters after an Upload File).
    const bust = `_r=${Date.now()}`;
    const base = url.includes("?") ? `${url}&${bust}` : `${url}?${bust}`;
    iframe.src = base;
  };
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
      ${site.current_version ? `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          <input type="text" id="commit-label" placeholder="Optional label (e.g. 'first draft')" style="flex:1">
          <button class="btn btn-sm btn-primary" id="commit-btn">Snapshot Current</button>
        </div>
        <div class="form-error" id="commit-error" style="margin-bottom:8px"></div>
      ` : ""}
      <div class="version-list">
        ${versions.map((v) => `
          <div class="version-item ${v.version === site.current_version ? "active" : ""}">
            <div class="version-meta">
              <span class="version-id">${v.version}${v.label ? ` — ${esc(v.label)}` : ""}${v.mcp_modified ? ' <span class="text-sm text-muted">(MCP edits)</span>' : ""}</span>
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

  const commitBtn = modal.querySelector("#commit-btn");
  if (commitBtn) {
    commitBtn.addEventListener("click", async () => {
      const errEl = modal.querySelector("#commit-error");
      const label = modal.querySelector("#commit-label").value.trim();
      errEl.textContent = "";
      commitBtn.disabled = true;
      try {
        await api(`/sites/${slug}/commit`, {
          method: "POST",
          body: JSON.stringify(label ? { label } : {}),
        });
        modal.remove();
        showSiteDetail(slug);
      } catch (err) {
        errEl.textContent = err.message;
        commitBtn.disabled = false;
      }
    });
  }
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

window.showSiteSettings = async function (slug, rootDir, spa, mcpEnabled, mcpReadOnly, mcpAutoCommit, cmsEnabled) {
  // Always re-fetch the site so the modal reflects the current DB state. The
  // caller's data may be stale: after a prior save, only the originating view
  // (sites or explorer) gets refreshed, so opening Settings from the other
  // view would otherwise show pre-save values and look like checkboxes "lost"
  // their state.
  let aliases = [];
  let hostAliases = [];
  try {
    const data = await api(`/sites/${slug}`);
    if (data && data.site) {
      const s = data.site;
      rootDir = s.root_dir;
      spa = s.spa;
      mcpEnabled = s.mcp_enabled;
      mcpReadOnly = s.mcp_read_only;
      mcpAutoCommit = s.mcp_auto_commit;
      cmsEnabled = s.cms_enabled;
    }
    aliases = (data && data.aliases) || [];
    hostAliases = (data && data.host_aliases) || [];
  } catch (_) {}

  const modal = document.createElement("div");
  modal.className = "modal site-settings-modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h2>Site Settings — ${esc(slug)}</h2>
      <div class="settings-tabs" role="tablist">
        <button type="button" class="settings-tab active" role="tab" data-tab="general">General</button>
        <button type="button" class="settings-tab" role="tab" data-tab="mcp">MCP</button>
        <button type="button" class="settings-tab" role="tab" data-tab="aliases">Aliases</button>
        <button type="button" class="settings-tab" role="tab" data-tab="cms">CMS</button>
      </div>
      <form id="site-settings-form">
        <div class="settings-tab-panel active" data-panel="general">
          <label>
            Root Directory
            <input type="text" id="settings-root-dir" value="${esc(rootDir || "")}" placeholder="e.g. browser, dist, build (leave empty for top level)">
            <small>Subdirectory containing index.html. Auto-detected for Angular/React/Vue builds.</small>
          </label>
          <label style="display:flex;align-items:center;gap:10px;flex-direction:row">
            <input type="checkbox" id="settings-spa" ${spa ? "checked" : ""} style="width:auto;margin:0">
            <span>SPA Mode <small style="display:inline;margin:0">(serve index.html for all unmatched routes)</small></span>
          </label>
        </div>

        <div class="settings-tab-panel" data-panel="mcp">
          <label style="display:flex;align-items:center;gap:10px;flex-direction:row">
            <input type="checkbox" id="settings-mcp" ${mcpEnabled ? "checked" : ""} style="width:auto;margin:0">
            <span>MCP Access <small style="display:inline;margin:0">(allow AI tools to access site files via MCP)</small></span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;flex-direction:row;margin-left:28px">
            <input type="checkbox" id="settings-mcp-readonly" ${mcpReadOnly ? "checked" : ""} style="width:auto;margin:0">
            <span>Read Only <small style="display:inline;margin:0">(block write and delete operations)</small></span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;flex-direction:row;margin-left:28px">
            <input type="checkbox" id="settings-mcp-autocommit" ${mcpAutoCommit ? "checked" : ""} style="width:auto;margin:0">
            <span>Auto-snapshot before AI edits <small style="display:inline;margin:0">(freeze the current version the first time MCP writes to it, preserving a rollback point)</small></span>
          </label>

          <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
          <label>
            Site Delegates
            <small>Per-site OAuth credentials you can share with collaborators. Each delegate authorizes via the OAuth consent screen using their own password — they can only access this site, never <code>/_admin</code> or other sites.</small>
          </label>
          <div id="settings-delegates-list" style="margin-bottom:8px"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr 110px auto;gap:6px;align-items:center">
            <input type="text" id="settings-delegate-label" placeholder="Label (e.g. 'Joe')" maxlength="60" pattern="[\\w .@\\-]+">
            <input type="password" id="settings-delegate-password" placeholder="Password (min 8 chars)" minlength="8">
            <select id="settings-delegate-expires">
              <option value="30">30 days</option>
              <option value="90" selected>90 days</option>
              <option value="365">1 year</option>
              <option value="">Never</option>
            </select>
            <button type="button" class="btn btn-sm btn-primary" id="add-delegate-btn">Add</button>
          </div>
          <div class="form-error" id="delegate-error" style="margin-top:4px"></div>
        </div>

        <div class="settings-tab-panel" data-panel="aliases">
          <label>
            Aliases
            <small>Alternative URL paths that serve this site's content.</small>
          </label>
          <div id="settings-aliases-list" style="margin-bottom:8px">
            ${aliases.length ? aliases.map(a => `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px" data-alias="${esc(a)}">
                <code style="flex:1">/${esc(a)}</code>
                <button type="button" class="btn btn-sm btn-danger remove-alias-btn">Remove</button>
              </div>
            `).join("") : '<div class="text-sm text-muted" id="no-aliases-msg">No aliases configured.</div>'}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="settings-new-alias" placeholder="e.g. ecg" style="flex:1" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]?">
            <button type="button" class="btn btn-sm btn-primary" id="add-alias-btn">Add Alias</button>
          </div>
          <div class="form-error" id="alias-error" style="margin-top:4px"></div>

          <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
          <label>
            Host Aliases
            <small>Custom domains that map to this site. Requests to <code>example.com/about</code> will serve the same content as <code>/${esc(slug)}/about</code> on this server. Configure your DNS / Cloudflare Tunnel to route the hostname here.</small>
          </label>
          <div id="settings-host-aliases-list" style="margin-bottom:8px">
            ${hostAliases.length ? hostAliases.map(h => `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px" data-host-alias="${esc(h)}">
                <code style="flex:1">${esc(h)}</code>
                <button type="button" class="btn btn-sm btn-danger remove-host-alias-btn">Remove</button>
              </div>
            `).join("") : '<div class="text-sm text-muted" id="no-host-aliases-msg">No host aliases configured.</div>'}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="settings-new-host-alias" placeholder="e.g. example.com" style="flex:1">
            <button type="button" class="btn btn-sm btn-primary" id="add-host-alias-btn">Add Host</button>
          </div>
          <div class="form-error" id="host-alias-error" style="margin-top:4px"></div>
        </div>

        <div class="settings-tab-panel" data-panel="cms">
          <label style="display:flex;align-items:center;gap:10px;flex-direction:row">
            <input type="checkbox" id="settings-cms" ${cmsEnabled ? "checked" : ""} style="width:auto;margin:0">
            <span>CMS <small style="display:inline;margin:0">(enable a JSON-driven blog/content system for this site)</small></span>
          </label>
          <p class="text-sm text-muted" style="margin-left:28px;margin-top:4px;line-height:1.45">
            When enabled, a <code>.cms/</code> directory is laid down in this site containing a zero-dependency JS library, two HTML page templates, and sample content. Posts are JSON files — edit them directly or have an AI tool write them via MCP. <strong>No build step.</strong>
          </p>

          <div id="cms-status-block" style="margin-top:16px;margin-left:28px"></div>

          <div class="form-error" id="cms-error" style="margin-top:4px;margin-left:28px"></div>
        </div>

        <div class="modal-actions" style="margin-top:16px">
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

  // Tab switching
  modal.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      modal.querySelectorAll(".settings-tab").forEach(t => t.classList.toggle("active", t === tab));
      modal.querySelectorAll(".settings-tab-panel").forEach(p => {
        p.classList.toggle("active", p.dataset.panel === target);
      });
    });
  });

  // Add alias
  modal.querySelector("#add-alias-btn").addEventListener("click", async () => {
    const input = document.getElementById("settings-new-alias");
    const alias = input.value.trim().toLowerCase();
    const errEl = document.getElementById("alias-error");
    errEl.textContent = "";
    if (!alias) return;
    try {
      const data = await api(`/sites/${slug}/aliases`, {
        method: "POST",
        body: JSON.stringify({ alias }),
      });
      // Refresh alias list in modal
      input.value = "";
      const listEl = document.getElementById("settings-aliases-list");
      const noMsg = document.getElementById("no-aliases-msg");
      if (noMsg) noMsg.remove();
      const div = document.createElement("div");
      div.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px";
      div.dataset.alias = alias;
      div.innerHTML = `<code style="flex:1">/${esc(alias)}</code><button type="button" class="btn btn-sm btn-danger remove-alias-btn">Remove</button>`;
      div.querySelector(".remove-alias-btn").addEventListener("click", () => removeAliasHandler(div, alias));
      listEl.appendChild(div);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // Remove alias handler
  async function removeAliasHandler(el, alias) {
    const errEl = document.getElementById("alias-error");
    errEl.textContent = "";
    try {
      await api(`/sites/${slug}/aliases/${alias}`, { method: "DELETE" });
      el.remove();
      const listEl = document.getElementById("settings-aliases-list");
      if (!listEl.children.length) {
        listEl.innerHTML = '<div class="text-sm text-muted" id="no-aliases-msg">No aliases configured.</div>';
      }
    } catch (err) {
      errEl.textContent = err.message;
    }
  }

  // Bind existing remove buttons
  modal.querySelectorAll(".remove-alias-btn").forEach(btn => {
    const alias = btn.closest("[data-alias]").dataset.alias;
    btn.addEventListener("click", () => removeAliasHandler(btn.closest("[data-alias]"), alias));
  });

  // --- Host aliases ---
  modal.querySelector("#add-host-alias-btn").addEventListener("click", async () => {
    const input = document.getElementById("settings-new-host-alias");
    const host = input.value.trim().toLowerCase();
    const errEl = document.getElementById("host-alias-error");
    errEl.textContent = "";
    if (!host) return;
    try {
      await api(`/sites/${slug}/host-aliases`, {
        method: "POST",
        body: JSON.stringify({ host }),
      });
      input.value = "";
      const listEl = document.getElementById("settings-host-aliases-list");
      const noMsg = document.getElementById("no-host-aliases-msg");
      if (noMsg) noMsg.remove();
      const div = document.createElement("div");
      div.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px";
      div.dataset.hostAlias = host;
      div.innerHTML = `<code style="flex:1">${esc(host)}</code><button type="button" class="btn btn-sm btn-danger remove-host-alias-btn">Remove</button>`;
      div.querySelector(".remove-host-alias-btn").addEventListener("click", () => removeHostAliasHandler(div, host));
      listEl.appendChild(div);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  async function removeHostAliasHandler(el, host) {
    const errEl = document.getElementById("host-alias-error");
    errEl.textContent = "";
    try {
      await api(`/sites/${slug}/host-aliases/${encodeURIComponent(host)}`, { method: "DELETE" });
      el.remove();
      const listEl = document.getElementById("settings-host-aliases-list");
      if (!listEl.children.length) {
        listEl.innerHTML = '<div class="text-sm text-muted" id="no-host-aliases-msg">No host aliases configured.</div>';
      }
    } catch (err) {
      errEl.textContent = err.message;
    }
  }

  modal.querySelectorAll(".remove-host-alias-btn").forEach(btn => {
    const host = btn.closest("[data-host-alias]").dataset.hostAlias;
    btn.addEventListener("click", () => removeHostAliasHandler(btn.closest("[data-host-alias]"), host));
  });

  // --- Site delegates ---
  async function loadDelegates() {
    const listEl = modal.querySelector("#settings-delegates-list");
    if (!listEl) return;
    try {
      const { delegates } = await api(`/sites/${slug}/delegates`);
      if (!delegates.length) {
        listEl.innerHTML = '<div class="text-sm text-muted" style="margin-bottom:6px">No delegates yet. Create one to share MCP access without giving out your admin password.</div>';
        return;
      }
      listEl.innerHTML = `<table style="width:100%;font-size:0.85rem;margin-bottom:8px">
        <thead><tr><th style="text-align:left">Name</th><th style="text-align:left">Last Used</th><th style="text-align:left">Expires</th><th></th></tr></thead>
        <tbody>${delegates.map(d => `
          <tr>
            <td><code>${esc(d.label)}</code></td>
            <td>${d.last_used_at ? timeAgo(d.last_used_at) : '<span class="text-muted">never</span>'}</td>
            <td>${d.expired ? '<span style="color:var(--danger)">Expired</span>' : (d.expires_at ? timeUntil(d.expires_at) : 'Never')}</td>
            <td style="text-align:right"><button type="button" class="btn btn-sm btn-danger" data-delete-delegate="${d.id}">Delete</button></td>
          </tr>
        `).join("")}</tbody></table>`;
      listEl.querySelectorAll("[data-delete-delegate]").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this delegate? Their OAuth tokens will continue to work until they expire — revoke those separately from Settings → OAuth Connections.")) return;
          try {
            await api(`/sites/${slug}/delegates/${btn.dataset.deleteDelegate}`, { method: "DELETE" });
            loadDelegates();
          } catch (err) { alert(err.message); }
        });
      });
    } catch (_) {}
  }

  modal.querySelector("#add-delegate-btn").addEventListener("click", async () => {
    const label = modal.querySelector("#settings-delegate-label").value.trim();
    const password = modal.querySelector("#settings-delegate-password").value;
    const expVal = modal.querySelector("#settings-delegate-expires").value;
    const expiresInDays = expVal ? parseInt(expVal) : null;
    const errEl = modal.querySelector("#delegate-error");
    errEl.textContent = "";
    if (!label) { errEl.textContent = "Label is required"; return; }
    if (!password || password.length < 8) { errEl.textContent = "Password must be at least 8 characters"; return; }
    try {
      await api(`/sites/${slug}/delegates`, {
        method: "POST",
        body: JSON.stringify({ label, password, expires_in_days: expiresInDays }),
      });
      // Show shareable instructions, then refresh the list
      const origin = window.location.origin;
      const connectorUrl = `${origin}/_mcp/${slug}`;
      showDelegateShareModal(label, password, connectorUrl);
      modal.querySelector("#settings-delegate-label").value = "";
      modal.querySelector("#settings-delegate-password").value = "";
      loadDelegates();
    } catch (err) { errEl.textContent = err.message; }
  });

  loadDelegates();

  // --- CMS panel ---
  async function loadCmsStatus() {
    const block = modal.querySelector("#cms-status-block");
    if (!block) return;
    block.innerHTML = '<div class="text-sm text-muted">Loading…</div>';
    try {
      const status = await api(`/sites/${slug}/cms/status`);
      renderCmsStatus(status);
    } catch (e) {
      block.innerHTML = `<div class="text-sm" style="color:var(--danger)">${esc(e.message || "Failed to load CMS status")}</div>`;
    }
  }

  function renderCmsStatus(status) {
    const block = modal.querySelector("#cms-status-block");
    if (!block) return;
    const enabledCheckbox = modal.querySelector("#settings-cms");
    const enabledNow = enabledCheckbox && enabledCheckbox.checked;

    if (!enabledNow && !status.scaffolded) {
      block.innerHTML = `<div class="text-sm text-muted">Check the box above and click <strong>Save</strong> to initialize the CMS for this site.</div>`;
      return;
    }
    if (enabledNow && !status.scaffolded) {
      block.innerHTML = `
        <div class="text-sm" style="margin-bottom:10px">CMS will be scaffolded on save. Files written:</div>
        <ul class="text-sm text-muted" style="margin:0 0 10px 16px;line-height:1.6">
          <li><code>.cms/lib/cms.js</code>, <code>.cms/lib/cms.css</code></li>
          <li><code>.cms/templates/list.html</code>, <code>.cms/templates/story.html</code></li>
          <li><code>.cms/content/index.json</code>, <code>categories.json</code>, <code>posts/welcome.json</code></li>
        </ul>
      `;
      return;
    }

    const rows = [
      ["Scaffold version", `<code>${esc(status.installed_version || "—")}</code>`],
      ["Posts", `${status.post_count}${status.draft_count ? ` <span class="text-muted">(${status.draft_count} draft${status.draft_count === 1 ? "" : "s"})</span>` : ""}`],
      ["Categories", String(status.categories)],
    ];
    const urlList = status.list_url
      ? `<div style="margin-top:10px"><strong>URLs</strong><div class="text-sm" style="margin-top:4px;line-height:1.7">
          <div>List: <a href="${esc(status.list_url)}" target="_blank" rel="noopener"><code>${esc(status.list_url)}</code></a></div>
          <div>Story: <code>${esc(status.story_url)}?slug=…</code></div>
          <div class="text-muted" style="font-size:0.85em">Add <code>?preview=1</code> to any CMS URL to reveal drafts.</div>
        </div></div>`
      : "";

    const reinitBtn = `<button type="button" class="btn btn-sm btn-ghost" id="cms-reinit-btn" title="Re-create any missing scaffold files (existing files are preserved)">Re-initialize</button>`;

    block.innerHTML = `
      <table class="text-sm" style="border-collapse:collapse;margin-bottom:8px">
        ${rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:2px 0">${v}</td></tr>`).join("")}
      </table>
      ${urlList}
      <p class="text-sm text-muted" style="margin-top:10px;margin-bottom:0">
        The JS library and CSS are served globally from <code>/_cms/cms.js</code> and <code>/_cms/cms.css</code>. Edit them once under <a href="#" data-go-settings="1">Settings → CMS Library</a> and every CMS-enabled site picks up the change.
      </p>
      <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
        ${reinitBtn}
      </div>
    `;

    const goSettings = block.querySelector('[data-go-settings]');
    if (goSettings) goSettings.addEventListener("click", (e) => {
      e.preventDefault();
      modal.remove();
      navigateTo("settings");
      setTimeout(() => {
        const card = document.getElementById("cms-lib-content");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    });
    const reinitEl = modal.querySelector("#cms-reinit-btn");
    if (reinitEl) reinitEl.addEventListener("click", async () => {
      const errEl = modal.querySelector("#cms-error");
      errEl.textContent = "";
      reinitEl.disabled = true;
      reinitEl.textContent = "Re-initializing…";
      try {
        const result = await api(`/sites/${slug}/cms/init`, { method: "POST" });
        renderCmsStatus(result.status);
      } catch (e) {
        errEl.textContent = e.message;
        reinitEl.disabled = false;
        reinitEl.textContent = "Re-initialize";
      }
    });
  }

  // Re-render the CMS status block whenever the toggle changes so the user
  // sees "will be scaffolded on save" vs the active status panel without
  // having to save first.
  modal.querySelector("#settings-cms").addEventListener("change", () => loadCmsStatus());

  // Initial load: only fetch when the CMS tab gains focus, but prime once so
  // it's ready immediately when the tab opens.
  loadCmsStatus();

  // Save settings form
  modal.querySelector("#site-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newRoot = document.getElementById("settings-root-dir").value.trim() || null;
    const newSpa = document.getElementById("settings-spa").checked;
    const newMcp = document.getElementById("settings-mcp").checked;
    const newMcpReadOnly = document.getElementById("settings-mcp-readonly").checked;
    const newMcpAutoCommit = document.getElementById("settings-mcp-autocommit").checked;
    const newCms = document.getElementById("settings-cms").checked;
    try {
      // Persist the settings (root_dir, spa, mcp flags, cms_enabled).
      await api(`/sites/${slug}/settings`, {
        method: "POST",
        body: JSON.stringify({ root_dir: newRoot, spa: newSpa, mcp_enabled: newMcp, mcp_read_only: newMcpReadOnly, mcp_auto_commit: newMcpAutoCommit, cms_enabled: newCms }),
      });
      // If CMS was just turned on and isn't scaffolded yet, lay the files down.
      if (newCms && !cmsEnabled) {
        try {
          const status = await api(`/sites/${slug}/cms/status`);
          if (!status.scaffolded) await api(`/sites/${slug}/cms/init`, { method: "POST" });
        } catch (_) {}
      }
      modal.remove();
      // Refresh whichever site listing the user is currently viewing so the
      // cards reflect new badges/flags. Both list functions hold their own
      // `sites` closures, so refreshing only one would leave the other stale.
      if (currentView === "explorer") loadExplorer();
      else loadSites();
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

window.showUploadFile = function (slug, name, onSuccess) {
  // Queue entries are { file, relativePath }. For a plain file pick the
  // relativePath is just the filename; for a dropped folder we preserve the
  // path within the dropped tree (e.g. "images/icons/logo.svg"). We store
  // our own array rather than the input's FileList because FileList is
  // read-only and doesn't carry the path-within-folder for dropped dirs.
  const queue = [];
  const MAX_FILES = 5000;

  const modal = document.createElement("div");
  modal.className = "modal upload-file-modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width:560px">
      <h2>Upload Files — ${esc(name)}</h2>
      <p class="text-sm text-muted mb-2">Drop files <strong>or folders</strong> into <code>/${esc(slug)}</code>. Folder structure is preserved — dropping <code>images/</code> with nested files writes them as <code>images/&lt;subdir&gt;/&lt;file&gt;</code>. The destination field is an optional prefix prepended to each path.</p>
      <form id="upload-file-form">
        <label>
          Files
          <div class="file-drop" id="upload-file-drop">
            <input type="file" id="upload-file-input" multiple>
            <input type="file" id="upload-folder-input" webkitdirectory directory hidden>
            <p>Drop files or folders here, <strong>click to browse files</strong>, or <a href="#" id="upload-folder-pick">choose a folder…</a></p>
            <p class="text-sm text-muted" id="upload-file-hint" style="margin-top:6px">No files selected.</p>
          </div>
        </label>
        <div id="upload-file-list" style="display:none;border:1px solid var(--border);border-radius:4px;max-height:220px;overflow:auto;margin-bottom:12px"></div>
        <label>
          Destination Path <small>(optional prefix — leave empty for the site root)</small>
          <input type="text" id="upload-file-path" placeholder="e.g. media/  (prefix prepended to each file's path)" autocomplete="off">
        </label>
        <label style="display:flex;align-items:center;gap:10px;flex-direction:row">
          <input type="checkbox" id="upload-file-replace" style="width:auto;margin:0">
          <span>Replace existing files <small style="display:inline;margin:0">(overwrite if a file already exists at the destination)</small></span>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary" id="upload-file-submit" disabled>Upload</button>
        </div>
        <div class="form-error" id="upload-file-error"></div>
        <div class="upload-progress" id="upload-file-progress" hidden>
          <div class="progress-bar"><div class="progress-fill" id="upload-file-fill"></div></div>
          <span id="upload-file-status">Uploading…</span>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());

  const drop = modal.querySelector("#upload-file-drop");
  const fileInput = modal.querySelector("#upload-file-input");
  const folderInput = modal.querySelector("#upload-folder-input");
  const hintEl = modal.querySelector("#upload-file-hint");
  const listEl = modal.querySelector("#upload-file-list");
  const submitBtn = modal.querySelector("#upload-file-submit");
  const pathEl = modal.querySelector("#upload-file-path");

  // Path field placeholder adapts: with a single plain file, "rename to" mode
  // is allowed (path = full destination filename). Once any folder structure
  // is involved (multi-file or any relativePath containing a slash), the
  // path is purely a folder prefix.
  function hasFolderEntries() {
    return queue.some(e => e.relativePath.includes("/"));
  }
  function refreshPathPlaceholder() {
    if (queue.length > 1 || hasFolderEntries()) {
      pathEl.placeholder = "e.g. media/  (prefix prepended to each file's path)";
    } else if (queue.length === 1) {
      pathEl.placeholder = "e.g. media/logo.png  or  media/  (rename, or use as folder)";
    } else {
      pathEl.placeholder = "e.g. media/  (prefix prepended to each file's path)";
    }
  }

  function renderList() {
    if (!queue.length) {
      listEl.style.display = "none";
      listEl.innerHTML = "";
      hintEl.textContent = "No files selected.";
      submitBtn.disabled = true;
      refreshPathPlaceholder();
      return;
    }
    const total = queue.reduce((s, e) => s + e.file.size, 0);
    const folderNote = hasFolderEntries() ? " · folder structure preserved" : "";
    hintEl.textContent = `${queue.length} file${queue.length === 1 ? "" : "s"} selected · ${formatBytes(total)} total${folderNote}`;
    listEl.style.display = "block";
    listEl.innerHTML = queue.map((e, i) => `
      <div class="upload-row" data-i="${i}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border)">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.relativePath)}">${esc(e.relativePath)}</span>
        <span class="text-muted text-sm">${formatBytes(e.file.size)}</span>
        <span class="upload-row-status text-sm text-muted" style="min-width:70px;text-align:right" data-status="${i}">queued</span>
        <button type="button" class="btn btn-sm btn-ghost" data-remove="${i}" title="Remove from queue" style="padding:2px 8px">×</button>
      </div>
    `).join("");
    const rows = listEl.querySelectorAll(".upload-row");
    if (rows.length) rows[rows.length - 1].style.borderBottom = "none";
    listEl.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.remove, 10);
        queue.splice(idx, 1);
        renderList();
      });
    });
    submitBtn.disabled = false;
    refreshPathPlaceholder();
  }

  // Add entries, skipping duplicates by relativePath + size.
  function addEntries(entries) {
    let added = 0, skipped = 0;
    for (const e of entries) {
      if (queue.length + added >= MAX_FILES) { skipped++; continue; }
      if (queue.some(q => q.relativePath === e.relativePath && q.file.size === e.file.size)) continue;
      queue.push(e);
      added++;
    }
    renderList();
    if (skipped > 0) {
      const errEl = modal.querySelector("#upload-file-error");
      errEl.textContent = `Truncated at ${MAX_FILES} files — ${skipped} more were skipped. Upload in batches if needed.`;
    }
  }

  // Recursively walk a FileSystemEntry tree, collecting all FileSystemFileEntry
  // leaves with their full path (relative to the dropped root). Wraps the
  // callback-based APIs as Promises. webkitGetAsEntry is non-standard but
  // implemented in every major browser (Chrome, Firefox, Edge, Safari).
  function readDirectoryEntries(dirReader) {
    return new Promise((resolve, reject) => {
      const out = [];
      const readBatch = () => {
        dirReader.readEntries(batch => {
          if (!batch.length) { resolve(out); return; }
          out.push(...batch);
          readBatch();  // readEntries returns a partial batch; keep calling until empty
        }, reject);
      };
      readBatch();
    });
  }
  async function walkEntry(entry, pathPrefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      // Strip the leading slash that some browsers add to fullPath.
      const rel = (pathPrefix ? pathPrefix + "/" : "") + entry.name;
      return [{ file, relativePath: rel }];
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readDirectoryEntries(reader);
      const nested = await Promise.all(
        children.map(c => walkEntry(c, (pathPrefix ? pathPrefix + "/" : "") + entry.name))
      );
      return nested.flat();
    }
    return [];
  }

  // For a DataTransferItemList drop, prefer the entry-based traversal so
  // folders are preserved. Fall back to plain file collection if items isn't
  // available (very old browsers).
  async function extractDroppedEntries(dataTransfer) {
    const items = dataTransfer.items;
    if (items && items.length && typeof items[0].webkitGetAsEntry === "function") {
      const entries = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      const collected = await Promise.all(entries.map(e => walkEntry(e, "")));
      return collected.flat();
    }
    // Fallback — no folder support.
    return Array.from(dataTransfer.files || []).map(file => ({ file, relativePath: file.name }));
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length) {
      addEntries(Array.from(fileInput.files).map(file => ({ file, relativePath: file.name })));
    }
    fileInput.value = "";  // Allow re-picking the same file.
  });
  modal.querySelector("#upload-folder-pick").addEventListener("click", (e) => {
    e.preventDefault();
    folderInput.click();
  });
  folderInput.addEventListener("change", () => {
    // The folder picker populates each File's webkitRelativePath, e.g.
    // "images/icons/logo.svg" — exactly the shape we want.
    if (folderInput.files && folderInput.files.length) {
      addEntries(Array.from(folderInput.files).map(file => ({
        file,
        relativePath: file.webkitRelativePath || file.name,
      })));
    }
    folderInput.value = "";
  });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    try {
      const entries = await extractDroppedEntries(e.dataTransfer);
      if (entries.length) addEntries(entries);
    } catch (err) {
      const errEl = modal.querySelector("#upload-file-error");
      errEl.textContent = "Couldn't read dropped folder: " + (err.message || err);
    }
  });

  // Compute the destination path for a single queue entry.
  //   - Empty prefix → use the relativePath as-is.
  //   - Prefix without trailing slash, single plain file, no folder structure
  //     anywhere → treat prefix as a full destination filename (rename mode).
  //   - Otherwise → prefix + "/" + relativePath, with prefix normalized.
  function destinationFor(rawPrefix, entry, treatAsPrefix) {
    const p = rawPrefix.trim().replace(/^\/+/, "");
    if (!p) return entry.relativePath;
    if (treatAsPrefix) {
      const prefix = p.endsWith("/") ? p : p + "/";
      return prefix + entry.relativePath;
    }
    // Single plain file, prefix without trailing slash → use as full path.
    return p;
  }

  modal.querySelector("#upload-file-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!queue.length) return;

    const rawPath = pathEl.value;
    const replace = modal.querySelector("#upload-file-replace").checked;
    const errEl = modal.querySelector("#upload-file-error");
    const progressEl = modal.querySelector("#upload-file-progress");
    const fillEl = modal.querySelector("#upload-file-fill");
    const statusEl = modal.querySelector("#upload-file-status");

    errEl.textContent = "";
    submitBtn.disabled = true;
    progressEl.hidden = false;
    fillEl.style.width = "0%";

    // "Rename mode" is only available when the user dropped a single plain
    // file with no folder structure AND typed a prefix that doesn't end in /.
    const treatAsPrefix = queue.length > 1 || hasFolderEntries() || rawPath.trim().endsWith("/");
    const total = queue.length;
    let succeeded = 0;
    const failures = []; // { name, message }

    // Sequential — keeps order predictable, avoids slamming the server with
    // parallel large uploads, and lets one failure not abort the rest.
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      const dest = destinationFor(rawPath, entry, treatAsPrefix);
      const statusCell = listEl.querySelector(`[data-status="${i}"]`);
      statusEl.textContent = `Uploading ${i + 1} of ${total}: ${dest}`;
      if (statusCell) { statusCell.textContent = "uploading…"; statusCell.style.color = ""; }

      const fd = new FormData();
      fd.append("file", entry.file);
      fd.append("path", dest);
      fd.append("replace", replace ? "true" : "false");

      try {
        await apiForm(`/sites/${slug}/upload-file`, fd);
        succeeded++;
        if (statusCell) { statusCell.textContent = "done"; statusCell.style.color = "var(--success,#2a8a2a)"; }
      } catch (err) {
        failures.push({ name: entry.relativePath, message: err.message || "Upload failed" });
        if (statusCell) {
          statusCell.textContent = "failed";
          statusCell.style.color = "var(--danger,#c33)";
          statusCell.title = err.message || "Upload failed";
        }
      }
      fillEl.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
    }

    if (failures.length === 0) {
      statusEl.textContent = `Uploaded ${succeeded} file${succeeded === 1 ? "" : "s"}.`;
      modal.remove();
      if (typeof onSuccess === "function") onSuccess({ count: succeeded });
      return;
    }
    statusEl.textContent = `Uploaded ${succeeded} of ${total} — ${failures.length} failed.`;
    errEl.innerHTML = failures.map(f =>
      `<div><code>${esc(f.name)}</code>: ${esc(f.message)}</div>`
    ).join("");
    submitBtn.disabled = false;
  });
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

// --- Site File Browser ---
window.showSiteFiles = async function (slug, name) {
  const modal = document.createElement("div");
  modal.className = "modal site-files-modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content" style="max-width:800px;max-height:90vh;display:flex;flex-direction:column">
      <h2>${esc(name)} — Files</h2>
      <p class="text-sm text-muted">Loading...</p>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".modal-backdrop").addEventListener("click", () => modal.remove());

  try {
    const data = await api(`/sites/${slug}/files`);
    const files = data.files || [];
    const content = modal.querySelector(".modal-content");

    if (!files.length) {
      content.innerHTML = `
        <h2>${esc(name)} — Files</h2>
        <p class="text-muted">No files found in this bundle.</p>
        <div class="modal-actions"><button class="btn btn-ghost close-modal">Close</button></div>
      `;
      content.querySelector(".close-modal").addEventListener("click", () => modal.remove());
      return;
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const rootNote = data.root_dir ? ` · root: <code>${esc(data.root_dir)}</code>` : "";

    content.innerHTML = `
      <div style="flex:0 0 auto">
        <h2>${esc(name)} — Files</h2>
        <p class="text-sm text-muted" style="margin-bottom:12px">
          Version <code>${data.version || "—"}</code>${rootNote} · ${files.length} files · ${formatBytes(totalSize)}
        </p>
        <div style="margin-bottom:12px">
          <input type="text" id="file-search" placeholder="Filter files..." style="width:100%;padding:6px 10px;font-size:0.85rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
        </div>
      </div>
      <div style="flex:1 1 auto;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
        <table style="width:100%;font-size:0.8rem;border-collapse:collapse" id="file-table">
          <thead style="position:sticky;top:0;background:var(--surface);z-index:1">
            <tr>
              <th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer" data-sort="path">Path</th>
              <th style="text-align:right;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer" data-sort="size">Size</th>
              <th style="text-align:right;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer" data-sort="modified">Modified</th>
            </tr>
          </thead>
          <tbody id="file-table-body"></tbody>
        </table>
      </div>
      <div class="modal-actions" style="flex:0 0 auto;margin-top:12px">
        <button class="btn btn-ghost close-modal">Close</button>
      </div>
    `;

    let sortKey = "path";
    let sortAsc = true;

    function renderFiles(filter) {
      const filtered = filter
        ? files.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()))
        : files;

      const sorted = [...filtered].sort((a, b) => {
        let cmp = 0;
        if (sortKey === "path") cmp = a.path.localeCompare(b.path);
        else if (sortKey === "size") cmp = a.size - b.size;
        else if (sortKey === "modified") cmp = a.modified.localeCompare(b.modified);
        return sortAsc ? cmp : -cmp;
      });

      const tbody = document.getElementById("file-table-body");
      if (!sorted.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-muted)">No matching files</td></tr>';
        return;
      }
      tbody.innerHTML = sorted.map(f => {
        const dir = f.path.lastIndexOf("/") >= 0 ? f.path.substring(0, f.path.lastIndexOf("/") + 1) : "";
        const fname = f.path.lastIndexOf("/") >= 0 ? f.path.substring(f.path.lastIndexOf("/") + 1) : f.path;
        const modDate = new Date(f.modified);
        const modStr = modDate.toLocaleDateString() + " " + modDate.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
        return `<tr>
          <td style="padding:4px 12px;border-bottom:1px solid var(--border);word-break:break-all;font-family:monospace">
            ${dir ? '<span class="text-muted">' + esc(dir) + '</span>' : ''}${esc(fname)}
          </td>
          <td style="padding:4px 12px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">${formatBytes(f.size)}</td>
          <td style="padding:4px 12px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">${modStr}</td>
        </tr>`;
      }).join("");
    }

    renderFiles("");

    // Search filter
    content.querySelector("#file-search").addEventListener("input", (e) => {
      renderFiles(e.target.value);
    });

    // Column sorting
    content.querySelectorAll("[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sortKey === key) sortAsc = !sortAsc;
        else { sortKey = key; sortAsc = true; }
        // Update sort indicators
        content.querySelectorAll("[data-sort]").forEach(h => h.textContent = h.textContent.replace(/ [▲▼]$/, ""));
        th.textContent += sortAsc ? " ▲" : " ▼";
        renderFiles(content.querySelector("#file-search").value);
      });
    });

    content.querySelector(".close-modal").addEventListener("click", () => modal.remove());
  } catch (err) {
    modal.querySelector(".modal-content").innerHTML = `
      <h2>${esc(name)} — Files</h2>
      <p style="color:var(--danger)">${esc(err.message)}</p>
      <div class="modal-actions"><button class="btn btn-ghost close-modal">Close</button></div>
    `;
    modal.querySelector(".close-modal").addEventListener("click", () => modal.remove());
  }
};

// --- Reload Site Cache ---
window.reloadSiteCache = async function (slug, btn) {
  const origText = btn.textContent;
  btn.textContent = "Reloading...";
  btn.disabled = true;
  try {
    await api(`/sites/${slug}/reload`, { method: "POST" });
    btn.textContent = "Reloaded!";
    setTimeout(() => {
      btn.textContent = origText;
      btn.disabled = false;
      loadSites();
    }, 1000);
  } catch (err) {
    btn.textContent = origText;
    btn.disabled = false;
    alert("Reload failed: " + err.message);
  }
};

// --- Analytics ---
async function loadAnalytics() {
  const hours = document.getElementById("analytics-range").value;

  const [paths, browsers] = await Promise.all([
    api(`/analytics/top-paths?hours=${hours}`),
    api(`/analytics/browsers?hours=${hours}`),
  ]);

  renderRankedList("analytics-paths", paths, "path", "hits");
  renderRankedList("analytics-browsers", browsers, "browser", "hits");
}

// --- Logs ---
async function loadLogs() {
  // Build query string from filters
  const params = new URLSearchParams({ limit: "200" });
  const statusFilter = document.getElementById("log-filter-status").value;
  const countryFilter = document.getElementById("log-filter-country").value;
  const siteFilter = document.getElementById("log-filter-site").value;
  const searchFilter = document.getElementById("log-filter-search").value.trim();

  if (statusFilter) params.set("status", statusFilter);
  if (countryFilter) params.set("country", countryFilter);
  if (siteFilter) params.set("site", siteFilter);
  if (searchFilter) params.set("search", searchFilter);

  const logs = await api(`/analytics/recent?${params}`);
  const tbody = document.getElementById("logs-body");

  // Populate filter dropdowns with unique values from results
  populateLogFilterOptions(logs);

  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No matching requests</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map((r) => {
    const statusClass = r.status < 300 ? "status-2xx" : r.status < 400 ? "status-3xx" : r.status < 500 ? "status-4xx" : "status-5xx";
    const isBlocked = r.status === 403;
    // Annotate /_mcp rows with the site(s) the call touched, when known.
    const isMcp = r.path === "/_mcp" || r.path?.startsWith("/_mcp/");
    const pathDisplay = isMcp && r.site_slug
      ? `${esc(r.path)} <span class="text-sm text-muted">(${esc(r.site_slug)})</span>`
      : esc(r.path);
    const pathTitle = isMcp && r.site_slug ? `${r.path} (${r.site_slug})` : r.path;
    return `
      <tr${isBlocked ? ' class="row-blocked"' : ""}>
        <td>${timeAgo(r.created_at)}</td>
        <td>${r.method}</td>
        <td class="truncate" title="${esc(pathTitle)}">${pathDisplay}</td>
        <td><span class="status-badge ${statusClass}">${r.status}</span>${isBlocked ? ' <span class="chip-blocked">Blocked</span>' : ""}</td>
        <td class="text-sm">${esc(r.browser || "—")}</td>
        <td class="text-mono text-sm">${esc(r.ip)}</td>
        <td>${countryName(r.country)}</td>
        <td class="text-mono text-sm">${r.response_time_ms?.toFixed(1) ?? "—"}ms</td>
      </tr>
    `;
  }).join("");
}

function populateLogFilterOptions(logs) {
  // Countries
  const countrySelect = document.getElementById("log-filter-country");
  const currentCountry = countrySelect.value;
  const countries = [...new Set(logs.map(r => r.country).filter(Boolean))].sort();
  countrySelect.innerHTML = '<option value="">All Countries</option>' +
    countries.map(c => `<option value="${esc(c)}" ${c === currentCountry ? "selected" : ""}>${esc(countryName(c))}</option>`).join("");

  // Sites
  const siteSelect = document.getElementById("log-filter-site");
  const currentSite = siteSelect.value;
  const sites = [...new Set(logs.map(r => r.site_slug).filter(Boolean))].sort();
  siteSelect.innerHTML = '<option value="">All Sites</option>' +
    sites.map(s => `<option value="${esc(s)}" ${s === currentSite ? "selected" : ""}>${esc(s)}</option>`).join("");
}

// --- Render Helpers ---
function renderBarChart(containerId, data, valueKey, labelKey) {
  const el = document.getElementById(containerId);
  if (!data || !data.length) {
    el.innerHTML = '<div class="empty-state"><p>No data</p></div>';
    return;
  }
  const max = Math.max(...data.map((d) => d[valueKey]), 1);

  // Pick ~4-6 evenly spaced X-axis labels
  const labelCount = Math.min(data.length, 6);
  const labelIndices = new Set();
  if (data.length <= 6) {
    data.forEach((_, i) => labelIndices.add(i));
  } else {
    for (let i = 0; i < labelCount; i++) {
      labelIndices.add(Math.round(i * (data.length - 1) / (labelCount - 1)));
    }
  }

  // Format Y-axis values
  const mid = Math.round(max / 2);
  const fmtVal = (v) => v >= 1000 ? (v / 1000).toFixed(1) + "k" : v;

  el.innerHTML = `<div class="chart-wrap">
    <div class="chart-y-axis">
      <span>${fmtVal(max)}</span>
      <span>${fmtVal(mid)}</span>
      <span>0</span>
    </div>
    <div class="chart-main">
      <div class="bar-chart">
        ${data.map((d, i) => {
          const pct = (d[valueKey] / max) * 100;
          const label = d[labelKey]?.replace("T", " ").substring(5, 16) || "";
          return `<div class="bar" style="height:${Math.max(pct, 2)}%" title="${label}: ${d[valueKey]}">
            <div class="bar-tooltip">${label}<br>${d[valueKey]} hits</div>
          </div>`;
        }).join("")}
      </div>
      <div class="chart-x-axis">
        ${data.map((d, i) => {
          const label = d[labelKey]?.replace("T", " ").substring(5, 16) || "";
          // Show time only (HH:MM) for shorter labels when there are many bars
          const shortLabel = label.length > 6 ? label.substring(6) : label;
          return `<span class="chart-x-label" style="visibility:${labelIndices.has(i) ? "visible" : "hidden"}">${shortLabel}</span>`;
        }).join("")}
      </div>
    </div>
  </div>`;
}

// Stacked bandwidth chart: response bytes (out) on bottom, request bytes (in)
// stacked above. Y-axis labels and tooltips auto-format with formatBytes.
function renderBandwidthChart(containerId, legendId, data) {
  const el = document.getElementById(containerId);
  const legendEl = legendId ? document.getElementById(legendId) : null;
  if (legendEl) legendEl.innerHTML = "";
  if (!data || !data.length || !data.some(d => (d.request_bytes || 0) + (d.response_bytes || 0) > 0)) {
    el.innerHTML = '<div class="empty-state"><p>No data</p></div>';
    return;
  }

  const totals = data.map(d => (d.request_bytes || 0) + (d.response_bytes || 0));
  const max = Math.max(...totals, 1);
  const mid = Math.round(max / 2);

  const labelCount = Math.min(data.length, 6);
  const labelIndices = new Set();
  if (data.length <= 6) {
    data.forEach((_, i) => labelIndices.add(i));
  } else {
    for (let i = 0; i < labelCount; i++) {
      labelIndices.add(Math.round(i * (data.length - 1) / (labelCount - 1)));
    }
  }

  el.innerHTML = `<div class="chart-wrap">
    <div class="chart-y-axis">
      <span>${formatBytes(max)}</span>
      <span>${formatBytes(mid)}</span>
      <span>0</span>
    </div>
    <div class="chart-main">
      <div class="bar-chart">
        ${data.map((d, i) => {
          const out = d.response_bytes || 0;
          const inn = d.request_bytes || 0;
          const total = out + inn;
          const pct = (total / max) * 100;
          const outPct = total > 0 ? (out / total) * 100 : 0;
          const label = d.bucket?.replace("T", " ").substring(5, 16) || "";
          return `<div class="bar bar-stacked" style="height:${Math.max(pct, 2)}%" title="${label}: ${formatBytes(total)}">
            <div class="bar-seg bar-seg-in" style="height:${100 - outPct}%"></div>
            <div class="bar-seg bar-seg-out" style="height:${outPct}%"></div>
            <div class="bar-tooltip">${label}<br>${formatBytes(out)} out<br>${formatBytes(inn)} in</div>
          </div>`;
        }).join("")}
      </div>
      <div class="chart-x-axis">
        ${data.map((d, i) => {
          const label = d.bucket?.replace("T", " ").substring(5, 16) || "";
          const shortLabel = label.length > 6 ? label.substring(6) : label;
          return `<span class="chart-x-label" style="visibility:${labelIndices.has(i) ? "visible" : "hidden"}">${shortLabel}</span>`;
        }).join("")}
      </div>
    </div>
  </div>`;

  if (legendEl) {
    legendEl.innerHTML = `
      <span class="legend-item"><span class="legend-swatch legend-swatch-out"></span>Sent (out)</span>
      <span class="legend-item"><span class="legend-swatch legend-swatch-in"></span>Received (in)</span>
    `;
  }
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

function timeUntil(dateStr) {
  if (!dateStr) return "Never";
  const date = new Date(dateStr + (dateStr.includes("Z") ? "" : "Z"));
  const diff = (date.getTime() - Date.now()) / 1000;
  if (diff <= 0) return "Expired";
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `in ${Math.floor(diff / 86400)}d`;
  return date.toLocaleDateString();
}
