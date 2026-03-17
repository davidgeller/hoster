# Hoster Security Audit

**Date:** 2026-03-17
**Scope:** Full platform audit including newly added TOTP 2FA implementation
**Audited files:** All source in `src/`, `admin/app.js`, `admin/index.html`

---

## Executive Summary

The hoster platform demonstrates solid security fundamentals: Argon2id password hashing, cryptographically random session tokens, secure cookie attributes, HTML escaping against XSS, parameterized SQL queries, and path traversal protections on file operations. The newly added TOTP 2FA implementation follows industry standards (RFC 6238) and includes recovery codes, QR provisioning, and rate limiting.

A total of 15 findings were identified during the audit. All have been remediated.

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
