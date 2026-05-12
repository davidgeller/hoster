# Hoster Security Audit

**Date:** 2026-03-17 (initial), 2026-05-11 (Site Explorer + single-file upload + settings tabs)
**Scope:** Full platform audit including newly added TOTP 2FA implementation
**Audited files:** All source in `src/`, `admin/app.js`, `admin/index.html`

---

## Executive Summary

The hoster platform demonstrates solid security fundamentals: Argon2id password hashing, cryptographically random session tokens, secure cookie attributes, HTML escaping against XSS, parameterized SQL queries, and path traversal protections on file operations. The newly added TOTP 2FA implementation follows industry standards (RFC 6238) and includes recovery codes, QR provisioning, and rate limiting.

A total of 15 findings were identified during the initial audit. All have been remediated. A follow-up audit on 2026-05-11 covering the Site Explorer view, single-file upload feature, settings tabs refactor, and refresh-button addition identified 4 additional findings — all remediated and documented at the bottom of this file (S1–S4).

---

## Findings — All Remediated

### 2FA Implementation Fixes

#### R1. Race Condition in 2FA Token Consumption
**Severity:** Critical | **Category:** Session Management
**Location:** `src/auth.ts` — `consumePending2faToken()`
**Issue:** Pending 2FA token validation and consumption were separate operations, allowing a race condition where two concurrent requests could both succeed with the same token.
**Fix:** Wrapped validate+delete in a SQLite transaction (`consumePending2faToken`), making the operation atomic.

#### R2. No Rate Limiting on 2FA Verification
**Severity:** High | **Category:** Brute Force Protection
**Location:** `src/admin-api.ts` — `/login/2fa` endpoint
**Issue:** Failed TOTP code attempts were not tracked, allowing unlimited brute-force of 6-digit codes (1,000,000 possibilities).
**Fix:** Added `totp_attempts` table, `isTotpRateLimited()`, and `recordTotpAttempt()`. TOTP verification is now limited to 5 failed attempts per 15 minutes per IP.

#### R3. Recovery Codes Stored in Plaintext
**Severity:** High | **Category:** Secret Storage
**Location:** `src/auth.ts` — `enableTotp()`
**Issue:** Recovery codes were stored as plaintext JSON in the database. A database breach would expose all codes.
**Fix:** Recovery codes are now SHA-256 hashed before storage. Comparison uses `crypto.timingSafeEqual()` to prevent timing attacks. Codes are shown to the user once and never stored in readable form.

#### R4. Pending 2FA Tokens Stored in Plaintext
**Severity:** High | **Category:** Secret Storage
**Location:** `src/auth.ts` — `createPending2faToken()`
**Issue:** Pending 2FA tokens were stored as plaintext in the database.
**Fix:** Tokens are now SHA-256 hashed before storage (`token_hash` column). Only the hash is persisted; the plaintext token is returned to the client once.

---

### Platform-Wide Fixes

#### F1. CSRF Token Protection Added
**Severity:** High | **Category:** CSRF
**Location:** `src/auth.ts`, `src/admin-api.ts`, `admin/app.js`
**Issue:** All POST/DELETE endpoints relied solely on cookie-based auth with `SameSite=Strict`.
**Fix:** Sessions now include a `csrf_token` column. A unique CSRF token is generated per session, returned to the frontend on login and auth-check, and validated via `X-CSRF-Token` header on all non-GET authenticated requests. Comparison uses `crypto.timingSafeEqual()`.

#### F2. IP Address Spoofing Prevention
**Severity:** High | **Category:** Authentication
**Location:** `src/auth.ts` — `getClientIp()`, `src/analytics.ts` — `extractRequestMeta()`
**Issue:** `getClientIp()` trusted `cf-connecting-ip` and `x-forwarded-for` headers unconditionally. Attackers could spoof IPs to bypass rate limiting.
**Fix:** Proxy headers are now only trusted when `cf-ipcountry` header is present (indicating Cloudflare origin). Outside Cloudflare, `x-forwarded-for` is ignored. Falls back to `x-real-ip` or `"unknown"`.

#### F3. Query Parameter Bounds Enforced
**Severity:** High | **Category:** Input Validation / DoS
**Location:** `src/admin-api.ts` — all analytics endpoints
**Issue:** `parseInt()` on `hours` and `limit` query parameters had no upper bound, enabling expensive full-table scans.
**Fix:** Added `clampInt()` helper. All analytics `hours` parameters clamped to 1-8760 (max 1 year). All `limit` parameters clamped to 1-500.

#### F4. root_dir Input Validation
**Severity:** High | **Category:** Path Traversal
**Location:** `src/sites.ts` — `updateSiteSettings()`
**Issue:** The `root_dir` site setting accepted arbitrary strings including `../` path traversal sequences.
**Fix:** `root_dir` is now validated at configuration time: rejects values containing `..`, starting with `/`, containing null bytes, or characters outside `[a-zA-Z0-9._-/]`.

#### F5. HTTP Security Headers Added
**Severity:** Medium | **Category:** HTTP Headers
**Location:** `src/server.ts` — `SECURITY_HEADERS`
**Issue:** Missing `Strict-Transport-Security`, `Content-Security-Policy`, and `Permissions-Policy` headers.
**Fix:** Added:
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`

#### F6. Session IP Binding
**Severity:** Medium | **Category:** Session Management
**Location:** `src/auth.ts` — `validateSession()`
**Issue:** Session IP was recorded but not validated on subsequent requests. A stolen session token worked from any IP.
**Fix:** `validateSession()` now accepts an optional `ip` parameter. When provided, it verifies the session IP matches the request IP. Mismatches invalidate the session (with a grace for `"unknown"` IPs).

#### F7. LIKE Wildcard Escaping
**Severity:** Medium | **Category:** Input Validation
**Location:** `src/analytics.ts` — `getRecentRequests()`
**Issue:** The search filter passed user input directly into a LIKE clause. Characters `%` and `_` acted as wildcards.
**Fix:** LIKE wildcard characters (`%`, `_`, `\`) are now escaped before inclusion in the query, with `ESCAPE '\'` clause added.

#### F8. Generic Error Messages
**Severity:** Medium | **Category:** Information Disclosure
**Location:** `src/admin-api.ts` — login endpoint
**Issue:** Login returned "Invalid password" on failure, confirming the account exists.
**Fix:** Changed to generic message: "Invalid credentials".

#### F9. Session Duration Reduced
**Severity:** Low | **Category:** Session Management
**Location:** `src/auth.ts` — `SESSION_DURATION_HOURS`
**Issue:** 72-hour session duration increased the window for session hijacking.
**Fix:** Reduced to 24 hours.

#### F10. Admin Audit Logging
**Severity:** Low | **Category:** Audit Trail
**Location:** `src/auth.ts`, `src/admin-api.ts`, `src/db.ts`
**Issue:** Critical operations (password change, site deletion, 2FA enable/disable) were not audit logged.
**Fix:** Added `audit_log` table and `auditLog()` function. Now logs: setup, login, login failures, 2FA verification, password changes, TOTP enable/disable, site deletion. Logs auto-prune after 90 days. Viewable via `GET /_admin/api/audit`.

#### F11. ZIP Staging Directory
**Severity:** Low | **Category:** File Upload Security
**Location:** `src/sites.ts` — `deploySite()`
**Issue:** Symlinks were removed after extraction into the final version directory. A brief window existed where symlinks were accessible to visitors.
**Fix:** ZIP files are now extracted into a `_staging_<version>` directory. Symlink removal and path traversal validation happen in staging. Only after validation passes is the staging directory renamed to the final version directory.

---

## 2FA Implementation Assessment

### Architecture
The TOTP 2FA follows a standard flow:
1. **Setup:** Generate secret, display QR code, user confirms with a valid code
2. **Login:** Password verified first, then a short-lived pending token is issued, user submits TOTP code to complete login
3. **Recovery:** 8 one-time recovery codes generated at setup, stored as SHA-256 hashes

### Strengths
- TOTP secret generated with cryptographically secure 160-bit entropy
- QR code generated server-side (no external API calls)
- Recovery codes hashed with SHA-256, compared with constant-time equality
- Pending 2FA tokens hashed in database with 5-minute expiry
- Atomic token consumption prevents race conditions
- Dedicated rate limiting for TOTP attempts (separate from password attempts)
- Recovery codes accepted at the 2FA prompt (no separate flow needed)
- Clean disable flow requires password confirmation

### TOTP Configuration
| Parameter | Value | Assessment |
|-----------|-------|------------|
| Algorithm | SHA1 | Standard (RFC 6238 default) |
| Digits | 6 | Standard |
| Period | 30s | Standard |
| Window | 1 (±30s) | Appropriate drift tolerance |
| Secret size | 160 bits | Meets RFC recommendation |

### Compatibility
Compatible with all major authenticator apps:
- Authy
- Google Authenticator
- Microsoft Authenticator
- 1Password / Bitwarden
- Any TOTP-compatible app

---

## Summary Table

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| R1 | Race condition in 2FA token consumption | Critical | **Fixed** |
| R2 | No rate limiting on 2FA verification | High | **Fixed** |
| R3 | Recovery codes stored in plaintext | High | **Fixed** |
| R4 | Pending 2FA tokens stored in plaintext | High | **Fixed** |
| F1 | CSRF token protection | High | **Fixed** |
| F2 | IP address spoofing via proxy headers | High | **Fixed** |
| F3 | Unvalidated query parameter bounds | High | **Fixed** |
| F4 | No validation on root_dir parameter | High | **Fixed** |
| F5 | Missing HTTP security headers | Medium | **Fixed** |
| F6 | Session token not bound to IP | Medium | **Fixed** |
| F7 | LIKE wildcard injection in log search | Medium | **Fixed** |
| F8 | Informative error messages | Medium | **Fixed** |
| F9 | Long session duration | Low | **Fixed** |
| F10 | No audit logging for admin operations | Low | **Fixed** |
| F11 | ZIP symlink removal timing | Low | **Fixed** |

---

## Positive Observations

- **Password hashing:** Argon2id with appropriate cost parameters (64KB memory, 3 iterations)
- **Session tokens:** 256-bit cryptographic random values with per-session CSRF tokens
- **Cookie security:** HttpOnly, Secure, SameSite=Strict, 24-hour Max-Age
- **XSS prevention:** Consistent use of `esc()` HTML escaping in frontend
- **SQL injection prevention:** All queries use parameterized statements
- **Path traversal protection:** Multi-layer defense (slug validation, resolve+startsWith, realpathSync, symlink removal, root_dir validation)
- **MCP token security:** SHA-256 hashed storage with constant-time comparison
- **Rate limiting:** IP-based rate limiting on both password and TOTP attempts
- **Spawn security:** Uses array-form `Bun.spawn()` (no shell injection)
- **CSRF protection:** Per-session tokens validated with constant-time comparison on all state-changing requests
- **Audit trail:** Critical admin operations logged with IP and auto-pruned after 90 days
- **ZIP upload security:** Staging directory pattern prevents exposure of unvalidated content
- **File streaming:** Zero-copy sendfile serving — files never buffered in memory
- **ETag caching:** Weak ETags enable 304 responses, reducing bandwidth and server load
- **Config caching:** Site config and realpath results cached with TTL, reducing per-request DB and filesystem overhead

---

# April 2026 Audit (post-OAuth)

**Date:** 2026-04-27
**Scope:** Re-audit after shipping OAuth 2.1 authorization server, per-site delegate credentials, write_media_file, blank-site creation, and version snapshot tools.
**Audited files:** `src/oauth.ts` (new, ~770 lines), `src/mcp.ts`, `src/server.ts`, `src/auth.ts`, `src/admin-api.ts`, `src/sites.ts`, `src/backup.ts`, `src/analytics.ts`, `src/db.ts`.
**Status:** *All six Critical findings remediated in commits leading up to v1.0.0.* High-severity items remain — they're tracked for a follow-up hardening release. The April section below is preserved verbatim as a reference; remediation notes are inline next to each finding.

The audit incorporates two independent review passes plus targeted hand-verification of the highest-impact claims. The earlier (March 2026) audit's 15 findings remain remediated — this section covers issues introduced or surfaced by the OAuth/delegate work.

## Prioritized Fix List (April)

All six Criticals were remediated before v1.0.0. Status column reflects current state:

| # | Severity | Title | Status |
|---|---|---|---|
| 1 | Critical | Timestamp-format mismatch breaks brute-force rate limiting | **Fixed** — `sqliteNow()` helper + SQL-side `datetime('now', '...')` everywhere |
| 2 | Critical | Backup restore overwrites the admin password hash | **Fixed** — current admin password required for restore; rate-limited and audit-logged |
| 3 | Critical | Refresh tokens have no absolute expiry | **Fixed** — `refresh_expires_at` column + replay detection (rotated-then-replayed refresh revokes the entire chain) |
| 4 | Critical | DCR rate limiter doesn't actually rate-limit per IP | **Fixed** — `created_ip` column + 5/hr/IP and 200/day/global caps |
| 5 | Critical | DCR accepts arbitrary `http://` redirect URIs | **Fixed** — `https://` only, plus `http://` for loopback hosts (127.0.0.1, ::1, localhost) |
| 6 | Critical | Pending-2FA token not IP-bound; sessions not rotated post-login | **Fixed** — `consumePending2faToken(token, ip)` checks IP; sessions rotated on every login |
| 7 | High | `originOf` trusts forwarded headers without Cloudflare gate | Mirror `auth.ts:111-119` Cloudflare-signal test |
| 8 | High | OAuth POST endpoints bypass country/IP-block lists | Apply `isIpBlocked` / `checkAndAutoBlock` to OAuth POST endpoints |
| 9 | High | `pruneExpired` never invoked + wrong predicate | Schedule from `index.ts`; rewrite predicate |
| 10 | High | `validateMcpToken` does O(n) linear scan on every MCP call | Replace with `WHERE token_hash = ?` lookup |
| 11 | High | `safePath` skips realpath check when leaf doesn't exist | Walk parent dirs and lstat each component |
| 12 | High | OAuth tokens accepted on slug-less `/_mcp` route | Reject OAuth tokens at `/_mcp` (no slug) |
| 13 | High | `client_uri` rendered as link with no scheme validation | Reject non-`http(s)` schemes at DCR time |
| 14 | High | `style-src 'unsafe-inline'` weakens admin XSS containment | Move consent CSS to external file; tighten CSP |
| 15 | High | `verifyDelegate` dummy hash may fail-fast → label enumeration timing | Pre-compute a real Argon2id hash at module load |

**Recommendation:** address the Critical list before the next build/deploy. Items 1, 2, and 6 are immediately exploitable from the open internet.

## Critical (April)

### A-C1. Timestamp-format mismatch defeats brute-force rate limiting

**Location:** `src/auth.ts:35` (`isRateLimited`), `src/auth.ts:303` (`isTotpRateLimited`), `src/auth.ts:69` (session validation), `src/auth.ts:276`/`:287` (pending-2FA), `src/oauth.ts:246` (`dcrRateLimited`), `src/oauth.ts:763` (`pruneExpired` for codes)

**Attack:** Cutoffs are built in JavaScript with `new Date(...).toISOString()` (e.g. `2026-04-27T14:15:00.000Z`) and compared against columns populated by SQLite's `DEFAULT (datetime('now'))` (e.g. `2026-04-27 14:25:00`). String comparison diverges at character index 10: `T` (ASCII 84) vs space (ASCII 32). For same-day rows `created_at > cutoff` evaluates to `false` for in-window failed attempts because the row's space-format value sorts below the cutoff's T-format value.

Verified by hand: with a row inserted via `datetime('now')` 5 minutes ago and a 15-minute JS cutoff, the comparison returns "row is older than cutoff" — the row is not counted toward the rate limit.

Downstream effects:
- **Admin login rate limit** does not see same-day failed attempts. An attacker can spray passwords against `/oauth/authorize` POST or `/_admin/api/login` without ever tripping the 5-attempts-per-15-min lockout.
- **TOTP rate limit, DCR rate limit, session expiration, pending-2FA expiration, code prune** all carry the same defect.

Combined with A-C4 + A-C5 (anonymous DCR + open redirect URIs) and A-C6 (no IP binding on 2FA), an attacker has effectively unlimited password guesses against the admin and any site delegate.

**Fix:** Pick one canonical on-disk format (recommend `YYYY-MM-DD HH:MM:SS` matching SQLite's `datetime('now')`) and route every JS-side timestamp through a helper:

```ts
function sqliteNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace("T", " ").substring(0, 19);
}
```

`grep -nE "toISOString\\(\\)|datetime\\('now'\\)"` enumerates the audit surface. Replace all comparison cutoffs.

### A-C2. Backup restore overwrites the admin password hash

**Location:** `src/backup.ts:103-172` (`importDatabase`), `src/admin-api.ts:591-606` (`/_admin/api/config/import`), `src/backup.ts:368-371` (unencrypted path)

**Attack:** `restoreBackup` accepts an unencrypted backup; the endpoint requires only an admin session, with no current-password re-prompt. An attacker who briefly compromises an admin session uploads a crafted unencrypted `.hoster` whose `database.json` contains an attacker-controlled `admin_password_hash`. `previewBackup` shows a legitimate-looking manifest, the admin clicks Confirm, and the password is silently replaced. Full account takeover.

**Fix:** Require the current admin password (not just session) on every backup import. Reject any imported `config` row whose key is `admin_password_hash`, `totp_secret`, or `totp_recovery_codes` unless the operator has just re-authenticated interactively.

### A-C3. Refresh tokens have no absolute expiry

**Location:** `src/oauth.ts:698-735` (`handleRefreshGrant`), schema 51-77 (no `refresh_expires_at`)

**Attack:** `REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60` is declared at line 82 but never compared anywhere. A leaked refresh token rotates indefinitely without ever returning to the consent screen. There is no stolen-refresh detection — both legitimate user and attacker holding the same refresh token can rotate in turn, with the only signal being one party's *next* refresh failing after the other has already extracted a fresh access token.

**Fix:**
- Add `refresh_expires_at` column. Populate with `now + REFRESH_TOKEN_TTL_SECONDS` at issue. Reject expired refreshes.
- Store the previous refresh hash for one rotation cycle. If it comes back, treat as theft and revoke the entire `(client_id, principal, site_slug)` chain.

### A-C4. DCR rate limiter doesn't rate-limit per IP

**Location:** `src/oauth.ts:242-249`

**Attack:** `dcrRateLimited(ip)` ignores its `ip` argument. The query counts all registrations from anyone in the last hour. A single attacker fills the global cap (30/hr) and locks everyone out, or stays just under it and grows the table forever. There is no admin approval gate, no per-IP cap, no inactive-client pruning, and `pruneExpired` doesn't touch `oauth_clients` at all.

**Fix:** Track source IP per registration (new `oauth_clients.created_ip` column). Implement true per-IP rate limiting (e.g. 5/hour/IP, 200/day global). Auto-prune clients with `last_used_at IS NULL` after 7 days. Optionally gate DCR behind admin approval.

### A-C5. DCR accepts arbitrary `http://` redirect URIs to any host

**Location:** `src/oauth.ts:275-279`

**Attack:** The validator only checks `^https?:\/\//`. No host restriction, no rejection of plaintext HTTP for non-loopback hosts. An attacker registers a client with `redirect_uris: ["http://attacker.com/cb"]` and phishes the consent screen — the access token is delivered over plaintext HTTP. Per OAuth 2.1 §3.1.2.1: HTTPS is required except for explicit loopback URIs.

**Fix:** Restrict at registration time to `https://` (any host) or `http://127.0.0.1` / `http://[::1]` / `http://localhost` (any port). Reject userinfo, fragments, and wildcards. Use `new URL()` rather than regex.

### A-C6. Pending-2FA token not IP-bound; sessions not rotated post-login

**Location:** `src/admin-api.ts:88-112`, `src/auth.ts:264-298`

**Attack:** `createPending2faToken` records source IP but `consumePending2faToken(token)` never compares the consumer's IP to it. An attacker who steals a pending token can complete 2FA from a different machine within the 5-minute window. Amplified by A-C1 (TOTP rate limiter is broken).

Additionally, on successful login Hoster mints a new session but does not invalidate any prior session — a passively-held stolen cookie remains valid through subsequent password changes.

**Fix:**
- `consumePending2faToken(token, ip)` — compare against `pending_2fa.ip`; reject mismatches.
- After successful login, `DELETE FROM sessions WHERE token != <new>`. Same after password change.

## High (April)

### A-H1. `originOf` trusts forwarded headers without Cloudflare gate

**Location:** `src/oauth.ts:115-121`, `src/mcp.ts:749-761`

**Attack:** Forged `X-Forwarded-Host: attacker.com` produces a poisoned `issuer` and `authorization_endpoint` in `/.well-known/oauth-authorization-server`. Same affects `WWW-Authenticate` `resource_metadata` URLs. `auth.ts:111-119` already demonstrates the right pattern: trust forwarding headers only when `cf-ipcountry` is present.

**Fix:** Mirror that pattern in `originOf`, or pin `issuer` to a config value set at install time.

### A-H2. OAuth endpoints bypass country/IP-block lists

**Location:** `src/server.ts:152-169` (`isInfraPath` whitelist)

**Attack:** Country/IP-auto-block gates explicitly skip `/oauth/*`. `/oauth/authorize` POST also skips them. An attacker on a country-blocked or auto-blocked IP walks straight in.

**Fix:** Apply `isIpBlocked` and `checkAndAutoBlock` to `/oauth/authorize` POST and `/oauth/token`. Discovery and DCR can stay open.

### A-H3. `pruneExpired` never invoked + wrong predicate

**Location:** `src/oauth.ts:762-770`, `src/index.ts` (no setInterval)

**Attack:** `pruneExpired` is exported but never called. Even if called, the second statement filters `WHERE … refresh_hash IS NULL` — but every OAuth-issued row has a non-null refresh hash. `oauth_codes` and OAuth tokens grow unbounded; combined with A-C4 (DCR floods) the database accretes indefinitely.

**Fix:** Schedule from `index.ts`. Rewrite predicate to delete any row where (`refresh_expires_at IS NULL OR refresh_expires_at < datetime('now')`) AND `expires_at < datetime('now')`.

### A-H4. `validateMcpToken` does O(n) linear scan with timing oracle

**Location:** `src/mcp.ts:147-171`

**Attack:** Every `/_mcp` POST loads every row of `mcp_tokens` and does `constantTimeEqual` against each. Early-return on match makes valid tokens return faster than invalid ones. As DCR-driven OAuth grants accumulate (per A-C4 + A-H3), MCP call latency scales with token-table size — a slow-DoS amplifier.

The constant-time compare is unnecessary because the lookup key is already a SHA-256 hash; an attacker can't construct a candidate hash without already holding the preimage.

**Fix:** `mcp_tokens.token_hash` is `UNIQUE` (so the index exists). Replace the loop with `SELECT … WHERE token_hash = ?`.

### A-H5. `safePath` skips realpath check when leaf doesn't exist

**Location:** `src/mcp.ts:221-233`

**Attack:** Realpath check is wrapped in `if (existsSync(resolved))`. If a symlink ever lands inside a site dir, a write to a *new* leaf through it bypasses the check:

1. Symlink at `_current/uploads/share -> /etc`
2. MCP `write_file` with `path = "uploads/share/passwd"`
3. `existsSync(resolved)` is false
4. Realpath check skipped
5. `mkdirSync` + `writeFileSync` follow the symlink, write to `/etc/passwd`

`commitVersion` uses plain `cp -R` (`sites.ts`), which preserves any symlinks in the source.

**Fix:** Walk every parent path component and `lstatSync` each one; reject if any component is a symlink.

### A-H6. OAuth tokens accepted on slug-less `/_mcp`, leaking site enumeration

**Location:** `src/mcp.ts:788-804`, `src/server.ts:230-238`

**Attack:** Audience check at `mcp.ts:791` is wrapped in `if (urlSlug !== null)`. The legacy `/_mcp` path accepts any token, including OAuth tokens. An OAuth token bound to site A can hit `/_mcp` with `list_sites` and enumerate every MCP-enabled site on the instance.

**Fix:** Reject OAuth tokens at `/_mcp` (no slug) with 401. Move the OAuth-audience check above the `urlSlug !== null` guard.

### A-H7. `client_uri` rendered as a clickable link with no scheme validation

**Location:** `src/oauth.ts:363` (renderConsent), `src/oauth.ts:275-279` (DCR validation)

**Attack:** DCR accepts `client_uri` with no validation. `escapeHtml` handles attribute-quote injection but does not check the URL scheme. `client_uri: "javascript:fetch('/some/admin/api', {method:'POST'})"` renders an `<a href="javascript:...">` that runs in the admin's session context if clicked. `target="_blank"` + `rel="noopener noreferrer"` doesn't help against `javascript:` URLs.

**Fix:** Parse with `new URL(uri)` at DCR time; require `protocol === 'http:' || 'https:'`. Drop or render-as-text otherwise.

### A-H8. CSP allows `'unsafe-inline'` styles

**Location:** `src/server.ts:13`

**Attack:** `style-src 'self' 'unsafe-inline'` enables CSS-injection attacks against the admin SPA. With any reflected-content vector, attribute-selector exfiltration of CSRF tokens or other DOM secrets becomes possible. The `'unsafe-inline'` is required because the OAuth consent page inlines its styles.

**Fix:** Move the consent stylesheet to `/oauth/consent.css` (a real file). Drop `'unsafe-inline'` from `style-src`. Optionally use a per-response nonce for any remaining inline blocks.

### A-H9. `verifyDelegate` dummy hash may fail-fast → label enumeration timing

**Location:** `src/oauth.ts:929-946`

**Attack:** When no row matches, `verifyDelegate` falls back to a hand-built dummy Argon2id hash. If `Bun.password.verify` fast-fails on the malformed encoding, the unknown-label code path returns much faster (~0ms) than the known-label path (~50ms Argon2id verify). An attacker can enumerate which delegate labels exist for a site by timing.

**Fix:** Compute a real Argon2id hash of a random throwaway password at module load and store it as a constant. Use it as the dummy.

## Medium (April)

### A-M1. Site cache TTL allows MCP toggling to take effect with up to 60s lag

**Location:** `src/sites.ts:73-101`

**Attack:** After admin disables MCP, OAuth flows initiated within 60s can still issue tokens. Same applies to `mcp_read_only`.

**Fix:** Drop TTL to 5s, or re-read `getSite(slug)` immediately before issuing a code in `handleAuthorize` POST.

### A-M2. Session IP-binding bypassable when current IP is `unknown`

**Location:** `src/auth.ts:66-77`

**Attack:** `validateSession` short-circuits the IP comparison if either `ip === "unknown"`. A request from `localhost` (where `getClientIp` returns `unknown`) using a stolen cookie bypasses IP binding.

**Fix:** Refuse to *create* sessions when current IP is `unknown`. Refuse to *validate* a session whose stored IP is non-unknown when current IP is `unknown`.

### A-M3. `/_admin/api/auth-check` discloses TOTP-enabled state to anonymous callers

**Location:** `src/admin-api.ts:122-127`

**Attack:** Lets attackers prioritize Hoster instances without 2FA for password spraying.

**Fix:** Return `{ authenticated, setup }` for unauthenticated callers; only include `totp_enabled` after auth.

### A-M4. ZIP extraction shells out to `unzip` with post-hoc symlink scrub

**Location:** `src/sites.ts:289-304`, `src/backup.ts:386-397`

**Attack:** `unzip` extracts symlinks; `removeSymlinks` walks the tree afterward. The window is small but real, and `cp -R` in `commitVersion` propagates any symlink that bypassed the scrub.

**Fix:** Use a JavaScript ZIP library that exposes per-entry types so symlinks are skipped at extract time.

### A-M5. State parameter has no length cap

**Location:** `src/oauth.ts:338-357`

**Attack:** Client-supplied `state` is reflected back unbounded. Limited impact (no XSS due to escaping) but lets a hostile client store opaque payloads in URLs that bounce through the admin's browser history.

**Fix:** Cap `state` to 512 chars on receive; reject control characters.

### A-M6. Audit log entries can include user-controlled strings without length cap

**Location:** `src/auth.ts:134-139`, `src/mcp.ts:190-200`

**Attack:** Log-line confusion via crafted delegate labels or paths. Mitigated by the regex restriction on labels but worth bounding.

**Fix:** Cap `detail` length on insert and reject control characters.

## Low / Informational (April)

- **A-L1.** WAL mode without explicit checkpoint discipline (`src/db.ts:11`). Add `PRAGMA wal_autocheckpoint = 1000`.
- **A-L2.** WWW-Authenticate Bearer challenge omits `realm` (`src/mcp.ts:759`). Add `realm="hoster-mcp"`.
- **A-L3.** `mcp_audit_log` prune is select-then-delete without transaction (`src/mcp.ts:190-200`). Wrap in `db.transaction`.
- **A-L4.** Outside Cloudflare, `x-real-ip` is trusted with no source verification (`src/analytics.ts:113-127`). Bind Bun.serve to localhost-only and require Cloudflare Tunnel.
- **A-L5.** Static-token "All sites" scope by design allows cross-site access. Document the trade-off in README.

## April Audit Summary

**Strong:**
- Argon2id for both admin and delegate passwords (memoryCost 65536, timeCost 3).
- AES-256-GCM with PBKDF2-100K-SHA256 for backup encryption, fresh salt+IV per backup.
- PKCE-S256 with constant-time verifier comparison.
- Authorization codes are single-use with explicit expiration check and PKCE binding.
- Per-site OAuth audience binding works correctly when clients hit `/_mcp/<slug>`.
- ZIP slip protection via `verifyNoEscape` + `removeSymlinks` + `realpathSync`.
- `getClientIp` correctly gates `cf-connecting-ip` on a Cloudflare signal.
- All SQL is parameterized.
- Magic-byte validation on media uploads + `nosniff` defends against polyglot files.

**Weak:**
- The timestamp-format mismatch (A-C1) silently breaks brute-force protection across at least five rate limiters.
- Backup restore (A-C2) is a one-click admin password reset for anyone with a brief session.
- OAuth token lifecycle is incomplete: no refresh expiry (A-C3), wrong prune predicate (A-H3), prune never invoked (A-H3), refresh theft undetectable (A-C3).
- Anonymous DCR (A-C4) is unbounded, accepts plaintext-HTTP redirect URIs (A-C5), and is the primary attack surface for OAuth phishing.
- 2FA flow has IP-binding gaps (A-C6) and pre-existing sessions are not invalidated on login.
- Origin determination (A-H1) trusts forwarded headers, allowing metadata poisoning.
- `safePath` (A-H5) has a write-time escape window for symlinks.
- `client_uri` rendering (A-H7) is one missing scheme check from `javascript:` URL execution.

**Recommendation:** Treat the Critical list as a deploy gate. A-C1 alone makes the entire rate-limiting architecture decorative — fix that first and grep for sibling occurrences. A-C2 and A-C6 follow immediately because both are exploitable from a single moment of session compromise. A-C3–A-C5 close out the OAuth-side attack surface.

Once Criticals are fixed, the High list can be batched into a single hardening release. Mediums and Lows are quality-of-implementation items that don't block production use.

*April 2026 audit conducted against commit `d3f141f`. The timestamp-format mismatch (A-C1) and `pruneExpired` non-invocation (A-H3) were verified by hand against the code.*

---

## May 2026 Audit — Site Explorer, Single-File Upload, Settings Tabs

**Date:** 2026-05-11
**Scope:** Changes since `30dad1a` covering:
- New `Site Explorer` admin view with three-column layout (list / actions / live preview iframe)
- New single-file upload feature (`POST /_admin/api/sites/:slug/upload-file`) with optional path and replace flag
- Settings modal refactored into a tabbed interface (General / MCP / Aliases)
- Refresh button added to Explorer preview pane
- DigitalOcean deploy script (`deploy-to-do.sh`)

**Audited files:** `src/sites.ts`, `src/admin-api.ts`, `admin/app.js`, `admin/index.html`, `admin/style.css`, `test/upload-file.test.ts`, `.gitignore`, `deploy-to-do.sh`

A total of 4 findings were identified. **All remediated.**

### S1. Iframe sandbox enables admin escalation via hosted-site XSS
**Severity:** High | **Category:** Cross-Frame Scripting
**Location:** `admin/app.js` — `renderExplorerPreview()`
**Issue:** The Site Explorer's preview iframe was rendered with `sandbox="allow-same-origin allow-scripts allow-forms allow-popups"`. Hosted sites are served from the same origin as `/_admin`, so the iframe document shared the admin-page origin. JavaScript inside the iframe could reach `window.parent.csrfToken` (set on the admin page after `/auth-check`) and forge authenticated requests against `/_admin/api/*` using the admin's session cookies. Any author who can upload a single file to any hosted site (including via MCP delegate tokens) could plant a script that, the moment an admin previewed the site, would delete/disable other sites, exfiltrate secrets, or pivot to full admin compromise.
**Fix:** Dropped `allow-same-origin` from the sandbox attribute. The iframe document now has an opaque origin and same-origin policy blocks all access to parent globals. Scripts, forms, and popups still work, so the preview remains functional for visual inspection. Side effect: cookie/localStorage-based logged-in views won't reflect inside the preview, which is acceptable (and arguably safer) for an admin preview.

### S2. Single-file upload had no size cap (disk DoS)
**Severity:** Medium | **Category:** Resource Exhaustion
**Location:** `src/admin-api.ts` — `POST /sites/:slug/upload-file`
**Issue:** The new upload route accepted arbitrarily large multipart bodies. An authenticated admin (or a hijacked session) could write a multi-GB file in a single POST, filling the host's disk and crashing the service. Bun's `req.formData()` buffers the full body in memory before returning, so this also affects RAM usage.
**Fix:** Added `MAX_UPLOAD_FILE_SIZE = 100 MB` with two checks: an early reject based on `Content-Length` (returns 413 before any body is buffered) and a post-parse reject based on `file.size`. 100 MB covers typical media (videos, PDFs) while making cheap DoS impractical. Full-site ZIP deploys use a separate code path and are not affected.

### S3. Parent-directory symlink check was post-existence only
**Severity:** Low | **Category:** Path Traversal (defense-in-depth)
**Location:** `src/sites.ts` — `uploadFileToSite()`
**Issue:** The realpath verification only fired when the destination *already existed*. For brand-new files in subdirectories, the function trusted the logical path check (`resolved.startsWith(contentDir + "/")`). If a parent directory inside the site tree were ever a symlink — introduced via a future code path or manual filesystem tampering — a new-file upload could escape the site dir even though the logical path appeared safe. Deploy-time `removeSymlinks()` + `verifyNoEscape()` make this rare in practice; this is defense-in-depth.
**Fix:** After `mkdirSync(parentDir, { recursive: true })`, the function now realpaths the parent and confirms the resolved real path stays inside the real content directory. Throws "Path escapes site directory" otherwise. New test in `test/upload-file.test.ts` plants a symlink under `_current` pointing outside the site and confirms the upload is rejected and no file lands at the escape target.

### S4. Build artifacts and tooling state not in `.gitignore`
**Severity:** Low | **Category:** Accidental Disclosure / Repo Hygiene
**Location:** `.gitignore`
**Issue:** The pre-existing `.gitignore` covered `hoster-pi.sh` and `hoster-linux-arm64` but did not list the x64 build outputs (`hoster-x64.sh`, `hoster-linux-x64`) introduced by the cross-arch build work, nor local tooling state directories (`.claude/`, `.shots/`). A `git add .` could accidentally commit a 38 MB installer binary or session metadata.
**Fix:** Extended `.gitignore` to cover all build-artifact patterns and local tooling directories. No previously committed artifacts found.

### Verified Strong (May 2026)
- Path normalization in `uploadFileToSite` correctly strips leading slashes, rejects `..` segments and null bytes, and rejects empty filenames before any disk access.
- Multipart parsing wrapped in try/catch with a clean 400 response on malformed input.
- All user-controlled data in the Site Explorer and upload modal (`site.name`, `site.slug`, aliases, host aliases, version, root_dir) routes through the existing `esc()` HTML-escape helper — no XSS sinks introduced.
- CSRF protection inherits via the existing pre-route gate in `handleAdminApi` (line 150) — the new upload endpoint is a non-GET request and is automatically covered.
- Single-file upload preserves the `mcp_auto_commit` rollback semantics so admin writes follow the same snapshot-on-first-mutation contract as MCP edits.
- Audit log entry written for each upload with slug and destination path (`file_uploaded`).
- The `deploy-to-do.sh` helper contains only a hostname and SSH user; no embedded secrets, and relies on SSH key auth + a narrow sudoers rule on the droplet.
- Settings tabs refactor is pure DOM restructuring; tab buttons use `type="button"` so they never trigger form submit, and click handlers are scoped to the modal instance.

*May 2026 audit conducted against the working tree before commit. Fixes verified by `bun test` (56/56 pass) including a new test that exercises the symlinked-parent escape path.*
