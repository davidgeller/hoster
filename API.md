# Hoster Repository API — v1

A small REST API that lets an external application (a CRM, an integration) browse a Hoster document repository, search it, and create anonymous share links to its files. **Each API key belongs to exactly one repository and can only ever reach that repository.**

- Base URL: the Hoster site root, e.g. `https://hoster.example.com`. Every endpoint is `<root>/api/v1/...`.
- Format: JSON in, JSON out (`Content-Type: application/json`). File downloads are the only exception. Request bodies are limited to 16 KB.
- Timestamps: ISO 8601 UTC, e.g. `2026-11-22T18:04:11Z`.
- Ids: always **strings**. Treat them as opaque, and URL-encode them in paths.
- Links: share and repository URLs are **root-relative** (they start with `/`). Prepend the Hoster base URL from the client's own configuration to get an absolute link.

---

## Contract guarantees

| Guarantee | Detail |
|---|---|
| **No redirects** | `/api/v1` never answers with a 3xx. Trailing slashes are accepted in place (`/repositories` and `/repositories/` are the same). Hoster does not redirect http→https itself. If a proxy in front of it (e.g. Cloudflare "Always Use HTTPS") does, configure the client with an `https://` base URL. |
| **Stable error codes** | Every error body is `{ "error": { "code", "message" } }`. The codes below won't change. Use `message` for logs, not for logic. |
| **Bare arrays** | List endpoints (`/repositories`, `/search`, item listings) return a bare JSON array. |
| **Stable ids** | A repository id survives renames, slug changes and platform backup/restore. An item id survives renames and moves, and a trip through the trash and back. Ids contain only digits, so they are URL-safe once encoded. |
| **Idempotent shares** | `POST .../shares` with the same `Idempotency-Key` returns the same share: same `share_id`, same `url`. |
| **Relative share links** | A share's `url` is a root-relative path such as `/crm-demo/_repo/s/<token>`. Prepend the client's configured base URL (e.g. `https://hoster.example.com`). The resulting link opens for anonymous recipients with no sign-in. It's https whenever the base URL is. |
| **Fast** | Every endpoint answers well under the client's 15-second timeout. Search scans at most 5,000 candidate rows per repository. |

---

## Authentication

Send the API key as a bearer token:

```
Authorization: Bearer hk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

(`X-API-Key: hk_...` is also accepted.)

Keys are created in the repository's own settings: **Sites → (repository) → Settings → API Keys**. Anyone who can manage that repository can create keys for it: administrators, and site users assigned to it. Their password is required each time. Each key:

- **is bound to one repository.** It can list, browse, search, download from and share that repository. Every other repository answers `not_found`, exactly as if it didn't exist, and nothing else on Hoster is reachable with it. Deleting the repository deletes its keys. Changing the repository's slug doesn't affect them.
- has **scopes**: `read` always, plus `share` unless it was created read-only. Creating and revoking shares needs `share`.
- may have an **expiry** (`expires_at` in `/whoami`). After that moment every call returns `key_expired`.
- can be **revoked** at any time from the same settings tab. After that every call returns `key_revoked`.

The key is shown once, at creation. Hoster stores only its SHA-256.

Because a key sees one repository, a client can treat `/whoami`'s `repository.id` as *the* repository. `/repositories` and `/search` keep their usual shapes and return only that repository's data.

---

## Errors

```json
{ "error": { "code": "not_found", "message": "Item not found." } }
```

| HTTP | `code` | When |
|---|---|---|
| 401 | `unauthorized` | No key, a malformed key, or an unknown key. (Includes a key whose repository was deleted.) |
| 401 | `key_expired` | The key's `expires_at` has passed. |
| 401 | `key_revoked` | An administrator revoked the key. |
| 403 | `forbidden` | The key is valid but can't do this: a share operation on a read-only key. Also returned when the caller's IP address is on Hoster's blocklist. |
| 404 | `not_found` | Unknown repository, item, share or endpoint. Anything belonging to another repository (its id, its items, its shares) is also `not_found`, so a key can't tell other repositories exist. |
| 429 | `rate_limited` | Too many requests. Honour the `Retry-After` header (seconds). |
| 400 / 405 / 413 / 422 | `invalid_request` | Bad parameters or body, wrong HTTP method (405), oversized body (413), or an `Idempotency-Key` reused for a *different* request (422). |
| 500 | `internal_error` | A server bug. Safe to retry. |

### Rate limits

- **240 requests per minute per key** (fixed one-minute window).
- **30 failed authentications per minute per IP** with unknown keys. After that, further unknown keys from that IP get `rate_limited` until the window ends. A valid key is never caught by this limit, even from the same address. Expired and revoked keys don't count toward it either, so they keep getting their real code.

Both limits return `429` with a `Retry-After` header.

### Network rules

Requests from an IP address on Hoster's blocklist get `403 forbidden`, even with a valid key. Country allow-lists (global or per repository) apply to visitors of the repository's web pages, **not** to API calls. A key works from any country, so a CRM hosted abroad keeps working. Share links are ordinary page visits, so the repository's country list does apply to the people who open them.

---

## Objects

### Repository

```json
{
  "id": "1",
  "slug": "crm-demo",
  "name": "CRM Demo Library",
  "description": "Sample documents for API testing",
  "visibility": "private",
  "url": "/crm-demo/",
  "file_count": 5,
  "folder_count": 4,
  "size_bytes": 298,
  "created_at": "2026-11-23T00:26:41Z",
  "updated_at": "2026-11-23T00:26:41Z",
  "can_share": true
}
```

- `visibility` is `"public"` or `"private"`. It controls who can browse the repository's own web page. Share links work either way.
- `url` is the repository's own web page, root-relative. Prepend the base URL.
- `slug` can change, and so can `url`. Key on `id`.
- `can_share` tells you whether *this key* may create shares.

### Item

```json
{
  "id": "5",
  "repository_id": "1",
  "type": "file",
  "name": "Acme Corp proposal.md",
  "path": "Sales/Proposals/2026/Acme Corp proposal.md",
  "parent_id": "3",
  "size": 76,
  "mime_type": "text/markdown",
  "version": 1,
  "sha256": "9f2c…",
  "description": null,
  "tags": ["Contract"],
  "created_at": "2026-11-23T00:26:41Z",
  "updated_at": "2026-11-23T00:26:41Z"
}
```

- `type` is `"file"` or `"folder"`.
- `parent_id` is `null` for items at the repository root.
- `size`, `mime_type`, `version` and `sha256` are `null` for folders. `version` increases each time the file's content is replaced.

### Share

```json
{
  "share_id": "12",
  "url": "/crm-demo/_repo/s/hhPjHDQKNq_tyGjKG0fLtF84QXOJb3vj4gTRIVDHH_E",
  "repository_id": "1",
  "item_id": "5",
  "path": "Sales/Proposals/2026/Acme Corp proposal.md",
  "type": "file",
  "label": "Acme deal",
  "expires_at": "2026-12-31T00:00:00Z",
  "created_at": "2026-11-23T00:26:57Z",
  "revoked_at": null,
  "active": true
}
```

- `url` is root-relative. The link you hand to a recipient is `<base URL>` + `url`, e.g. `https://hoster.example.com/crm-demo/_repo/s/hhPj…`.
- A **file** share opens the file directly (or downloads it, for types a browser can't show).
- A **folder** share opens a listing of everything beneath the folder, with per-file links and a "download all" zip. Nothing outside the folder is reachable, including a sibling folder whose name differs only in case.
- A share points at the item's path at the moment it was created. If the item is later renamed, moved or deleted, the link stops working (the recipient sees a "link no longer available" page).

---

## Endpoints

### `GET /api/v1/whoami`

Describes the calling key. Use it to validate a key, to learn which repository it opens, and to show its expiry.

```json
{
  "key_id": "key_c059fb86f68cb9eb",
  "label": "CRM production",
  "repository": { "id": "1", "slug": "crm-demo", "name": "CRM Demo Library" },
  "scopes": ["read", "share"],
  "expires_at": "2027-02-21T00:26:41Z",
  "created_at": "2026-11-23T00:26:41Z"
}
```

- `repository` is the one repository this key can reach.
- `expires_at` is an ISO timestamp, or `null` for a key that never expires.

### `GET /api/v1/repositories`

The key's repository, as a bare array holding one [Repository](#repository).

### `GET /api/v1/repositories/{repository_id}`

One [Repository](#repository). Returns `404 not_found` for any id other than the key's own repository.

### `GET /api/v1/repositories/{repository_id}/items`

The contents of the repository root, or of a folder. The response is a bare array of [Item](#item), with folders first and then files, each sorted by name.

| Query | |
|---|---|
| `parent_id` | Optional. A folder's item id. When given, lists that folder instead of the root. |

### `GET /api/v1/repositories/{repository_id}/items/{item_id}`

One [Item](#item).

### `GET /api/v1/repositories/{repository_id}/items/{item_id}/children`

The same as `.../items?parent_id={item_id}`. Returns `400 invalid_request` if the item is a file.

### `GET /api/v1/repositories/{repository_id}/items/{item_id}/content`

The file's bytes, sent with `Content-Disposition: attachment`, a `Content-Type`, and `ETag` set to the SHA-256 (so `If-None-Match` returns `304`). Returns `400 invalid_request` for folders.

### `GET /api/v1/search`

Searches the key's repository: item names, paths, descriptions and tag names, case-insensitively. The response is a bare array of [Item](#item). Results are ranked with exact name matches first, then names starting with the query, then names containing it, then other matches. Ties are broken by path.

| Query | |
|---|---|
| `q` | Required. 1–200 characters. Matched literally (`%` and `_` are not wildcards). |
| `repository_id` | Optional. If given, it must be the key's own repository (any other is `not_found`). |
| `type` | Optional. `file` or `folder`. |
| `limit` | Optional. 1–200, default 50. |

### `POST /api/v1/repositories/{repository_id}/items/{item_id}/shares`

Creates an anonymous share link for a file or folder. Needs the `share` scope.

Headers:

```
Content-Type: application/json
Idempotency-Key: 6f1d2c9e-6b7a-4f0e-9a51-2d1f3e9b7c10     (recommended)
```

Body:

```json
{ "expires_at": "2026-12-31T00:00:00Z", "label": "Acme deal" }
```

| Field | |
|---|---|
| `expires_at` | ISO 8601 timestamp in the future, at most one year ahead, or `null` for a link that never expires. |
| `label` | String, may be empty. Shown to Hoster administrators next to the link. Truncated at 200 characters. |

Responses:

- **`201 Created`** with a [Share](#share) for a new link.
- **`200 OK`** with the *same* [Share](#share) (same `share_id`, same `url`) when the `Idempotency-Key` was already used by this key for the same request. The response also carries `Idempotent-Replayed: true`. A replay returns the share's current state, so a link revoked in the meantime comes back with `active: false`.
- **`422 invalid_request`** if the `Idempotency-Key` was already used by this key for a *different* repository, item, `expires_at` or `label`.

Idempotency keys are scoped to the API key that sent them, and are 1–255 visible ASCII characters (a UUID is ideal). They don't expire: the same key returns the same share for as long as the share record exists. Hoster purges revoked or expired shares 30 days after they end. After that, the same key creates a new share with a **new URL**, so a revoked link never starts working again. Without an `Idempotency-Key`, every call creates a new link.

The `url` is returned only by this endpoint. Hoster never stores share tokens in plaintext, so save the URL if you need it later.

### `DELETE /api/v1/shares/{share_id}`

Revokes a share. The link stops working immediately. Needs the `share` scope.

- **`204 No Content`** on success, including when the share was already revoked.
- **`404 not_found`** if the share doesn't exist or belongs to another repository.

---

## Building share links

The API returns links relative to the Hoster root, and the client turns them into absolute links:

```
share_link = base_url.rstrip("/") + share.url
```

Use the same base URL the client calls the API on. That should be the hostname your sites are served on. If the installation puts the admin panel on a separate hostname, use the sites hostname here, not the admin one. These paths work for every repository, including those that also have their own custom domain.

The CRM's https requirement is met by configuring an `https://` base URL.

---

## Quick reference

```bash
B=https://hoster.example.com/api/v1
K="Authorization: Bearer hk_…"

curl -H "$K" $B/whoami
curl -H "$K" $B/repositories
curl -H "$K" "$B/repositories/1/items"
curl -H "$K" "$B/repositories/1/items?parent_id=3"
curl -H "$K" "$B/search?q=proposal&limit=10"
curl -H "$K" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
     -d '{"expires_at":"2026-12-31T00:00:00Z","label":"Acme deal"}' \
     "$B/repositories/1/items/5/shares"
curl -H "$K" -X DELETE "$B/shares/12"
```
