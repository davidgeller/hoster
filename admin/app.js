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
  else if (view === "analytics") loadAnalytics();
  else if (view === "logs") loadLogs();
  else if (view === "settings") loadSettings();
  else if (view === "about") loadAbout();
}

async function loadSettings() {
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
  loadMcpAudit();
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

function getMcpCliCommand(token, label) {
  const origin = window.location.origin;
  const name = mcpServerName(label);
  return `claude mcp add --transport http ${name} ${origin}/_mcp --header "Authorization: Bearer ${token}"`;
}

function showMcpToken(token, label) {
  const configJson = getMcpConfigJson(token, label);
  const cliCommand = getMcpCliCommand(token, label);
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
      <pre style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;overflow-x:auto;margin-bottom:8px;white-space:pre-wrap">${esc(cliCommand)}</pre>
      <button class="btn btn-sm" id="mcp-copy-cli" style="margin-bottom:16px">Copy Command</button>

      <p class="text-sm text-muted" style="margin-bottom:16px">Restart your AI tool after adding the config.</p>
      <div class="modal-actions" style="gap:8px">
        <button class="btn btn-sm" id="mcp-copy-token">Copy Token Only</button>
        <button class="btn btn-ghost close-modal">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
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
    navigator.clipboard.writeText(cliCommand);
    modal.querySelector("#mcp-copy-cli").textContent = "Copied!";
  });
}

function showMcpSetup(label) {
  const origin = window.location.origin;
  const placeholder = "<your-token>";

  function buildConfig(token) { return getMcpConfigJson(token, label); }
  function buildCli(token) { return getMcpCliCommand(token, label); }

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
      <pre id="mcp-setup-json" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;overflow-x:auto;margin-bottom:8px;white-space:pre-wrap">${esc(buildConfig(placeholder))}</pre>
      <button class="btn btn-sm" id="mcp-copy-setup-json" style="margin-bottom:16px">Copy JSON</button>

      <h3 style="font-size:0.9rem;margin-bottom:8px">Option 2: Claude Code CLI</h3>
      <pre id="mcp-setup-cli" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;overflow-x:auto;margin-bottom:8px;white-space:pre-wrap">${esc(buildCli(placeholder))}</pre>
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

  function updateConfigs() {
    const token = tokenInput.value.trim() || placeholder;
    jsonPre.textContent = buildConfig(token);
    cliPre.textContent = buildCli(token);
  }
  tokenInput.addEventListener("input", updateConfigs);

  modal.querySelector("#mcp-copy-setup-json").addEventListener("click", () => {
    const token = tokenInput.value.trim() || placeholder;
    navigator.clipboard.writeText(buildConfig(token));
    modal.querySelector("#mcp-copy-setup-json").textContent = "Copied!";
  });
  modal.querySelector("#mcp-copy-setup-cli").addEventListener("click", () => {
    const token = tokenInput.value.trim() || placeholder;
    navigator.clipboard.writeText(buildCli(token));
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

// --- Dashboard ---
async function loadDashboard() {
  const hours = document.getElementById("dash-range").value;

  const [overview, topSites, traffic, countries, statusCodes, blocked] = await Promise.all([
    api(`/analytics/overview?hours=${hours}`),
    api(`/analytics/top-sites?hours=${hours}`),
    api(`/analytics/traffic?hours=${hours}`),
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
    ${blocked.total > 0 ? `<div class="stat-card stat-card-blocked"><div class="stat-label">Blocked</div><div class="stat-value">${fmt(blocked.total)}</div></div>` : ""}
  `;

  // Traffic chart
  renderBarChart("dash-traffic-chart", traffic, "hits", "bucket");

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
          <div class="site-slug">/${esc(s.slug)}${s.aliases && s.aliases.length ? ` <span class="text-muted text-sm">(also: ${s.aliases.map(a => "/" + esc(a)).join(", ")})</span>` : ""}</div>
          <div class="site-version-info">
            ${s.current_version ? `v${s.current_version}` : "no version"}
            ${s.root_dir ? ` · root: <code>${esc(s.root_dir)}</code>` : ""}
            ${s.spa ? " · SPA" : ""}
            ${s.mcp_enabled ? (s.mcp_read_only ? " · MCP (read-only)" : " · MCP") : ""}
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
      if (site) showSiteSettings(slug, site.root_dir, site.spa, site.mcp_enabled, site.mcp_read_only);
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

window.showSiteSettings = async function (slug, rootDir, spa, mcpEnabled, mcpReadOnly) {
  // Fetch current aliases
  let aliases = [];
  try {
    const data = await api(`/sites/${slug}/aliases`);
    aliases = data.aliases || [];
  } catch (_) {}

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
        <label style="display:flex;align-items:center;gap:10px;flex-direction:row">
          <input type="checkbox" id="settings-mcp" ${mcpEnabled ? "checked" : ""} style="width:auto;margin:0">
          <span>MCP Access <small style="display:inline;margin:0">(allow AI tools to access site files via MCP)</small></span>
        </label>
        <label style="display:flex;align-items:center;gap:10px;flex-direction:row;margin-left:28px">
          <input type="checkbox" id="settings-mcp-readonly" ${mcpReadOnly ? "checked" : ""} style="width:auto;margin:0">
          <span>Read Only <small style="display:inline;margin:0">(block write and delete operations)</small></span>
        </label>
        <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">
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

  // Save settings form
  modal.querySelector("#site-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newRoot = document.getElementById("settings-root-dir").value.trim() || null;
    const newSpa = document.getElementById("settings-spa").checked;
    const newMcp = document.getElementById("settings-mcp").checked;
    const newMcpReadOnly = document.getElementById("settings-mcp-readonly").checked;
    try {
      await api(`/sites/${slug}/settings`, {
        method: "POST",
        body: JSON.stringify({ root_dir: newRoot, spa: newSpa, mcp_enabled: newMcp, mcp_read_only: newMcpReadOnly }),
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
    return `
      <tr${isBlocked ? ' class="row-blocked"' : ""}>
        <td>${timeAgo(r.created_at)}</td>
        <td>${r.method}</td>
        <td class="truncate" title="${esc(r.path)}">${esc(r.path)}</td>
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
