---
title: Google connectors (Gmail, Calendar, Drive) — spec
status: draft
---

This page records the Google connectors as built on 2026-10-31 (API 103, migration 0059): slices G0 to G3 of [the plan](../superpowers/plans/2026-10-31-google-connectors-plan.md). Everything cites code. What was never run against a real Google account is listed in section 12 and is **unverified**.

Google sign-in here is a **connector credential only**. It is never an app login and never a model provider. The older `/auth/google/*` routes (IMAP over `mail.google.com`) are not part of this page except for the legacy token (section 4).

---

## 1 Files

| Role | Path |
|---|---|
| Scope registry, host list, granted-scope check | `extension/connectors/google/google-scopes.mjs` |
| The only outbound path to Google (pinned, allowlisted, capped, retries) | `extension/connectors/google/google-fetch.mjs` |
| OAuth core: PKCE, loopback listener, tokens, revoke, disconnect, legacy token | `extension/connectors/google/google-auth.mjs` |
| Gmail (Pattern B), HTML to Markdown | `extension/connectors/google/gmail.mjs`, `html-to-markdown.mjs` |
| Calendar (Pattern A) | `extension/connectors/google/gcal.mjs` |
| Drive (Pattern A) | `extension/connectors/google/gdrive.mjs` |
| State (accounts, cursors) | `extension/kb/google-store.mjs`, `extension/kb/migrations/0059_google_connectors.sql` |
| Vault key pattern | `extension/server/vault.mjs` (`google.acct.<12 hex>.(refreshToken, clientId or clientSecret)`, not settable through `POST /auth/me/secrets`) |
| Routes | `extension/routes/google-connectors.mjs`, dispatched from `extension/routes/router.mjs`, always on |
| Contract | `schema/http/google.schema.json`, fixtures `schema/http/fixtures/google/` |
| Tests | `extension/tests/google-auth.test.mjs`, `google-gmail.test.mjs`, `google-calendar.test.mjs`, `google-drive.test.mjs`, `google-routes.test.mjs`; helper `extension/tests/helpers/google-fixture.mjs`; recorded inputs `extension/tests/fixtures/google/` |

## 2 Scopes (all read-only)

`google-scopes.mjs` is the only place scopes are named. Identity scopes `openid` and `email` are always requested (the account id and the address come from the ID token). Per product:

| Product | Scopes | Tier label shown |
|---|---|---|
| `gmail` | `gmail.readonly` | restricted |
| `gcal` | `calendar.events.readonly`, `calendar.calendarlist.readonly` | sensitive |
| `gdrive` | `drive.metadata.readonly`; `drive.readonly` instead when content indexing is ticked | restricted |

No `gmail.modify`, `gmail.compose`, `gmail.send`, `drive` (write), `drive.file` or calendar write scope exists in the registry (a test scans the full set). The tier labels come from third-party summaries and are unverified. `include_granted_scopes` is never sent; a reconnect or an upgrade requests the union of what the account already had and what is new, so the granted set is always exactly the requested set.

**Granted-scope check** (`checkGranted`): the granted string is compared with the requested list (`email` and `https://www.googleapis.com/auth/userinfo.email` are the same scope). Anything granted that was not requested refuses the connect and revokes the new token. Anything requested but not granted (the user unticked it) only turns that product off; a product is enabled when all its scopes are granted (Drive: metadata, or content). If no product is enabled the connect is refused and the token revoked. The result lists `missingScopes`.

## 3 Outbound requests

Every request goes through `googleOnce` and `googleCall` (`google-fetch.mjs`), which use `makePinnedFetch` (DNS resolved once, every address classified, the checked address dialled; no private-address opt-in exists for Google).

- **Host allowlist**, https only, port 443, no userinfo: `accounts.google.com`, `oauth2.googleapis.com`, `gmail.googleapis.com`, `www.googleapis.com`, `calendar.googleapis.com`. Any other host (including a redirect target) fails with `GOOGLE_FETCH_REFUSED`.
- **Redirects** by hand, 3 hops, every hop re-validated and re-pinned, the bearer dropped when the origin changes (the Box rule).
- **Bodies** read with a streaming byte cap (`maxBytes`, default 8 MiB JSON, 10 MiB text), not only `content-length`. A body over the cap is `GOOGLE_FETCH_REFUSED`; malformed JSON is `GOOGLE_BAD_JSON`. Neither carries the body.
- **Deadline** 30 s per request.
- **Retries** (`googleCall`): one token refresh on 401; HTTP 429, 403 with reason `rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded` or `backendError`, and any 5xx are retried up to 3 times with delay `Retry-After` (capped at 120 s) or `min(1000 * 2^attempt, 16000)` ms, plus up to 250 ms jitter. Other 4xx are not retried. The error `code` is `GOOGLE_UNAUTHORIZED`, `GOOGLE_FORBIDDEN`, `GOOGLE_NOT_FOUND`, `GOOGLE_GONE`, `GOOGLE_RATE_LIMITED` or `GOOGLE_HTTP_ERROR`, with `status` and Google's `reason`, never its text.
- **The core never fetches a URL found in content.** Every URL is a fixed base plus encoded ids (`apiUrl`). Event links, conference links, `webViewLink`, `exportLinks`, attachment ids are stored as text or ignored. A test asserts no request reaches a content host.
- **Test seams** (`NODE_ENV=test` only): `_setGoogleFetchForTests`, `_setGoogleSleepForTests`. With no fixture transport installed a call throws `GOOGLE_TEST_TRIPWIRE` instead of reaching the network, and `tests/helpers/google-fixture.mjs` `installTripwire` makes any direct fetch, `http` or `https` call to a Google host throw and be counted; every suite asserts the count is zero.

## 4 OAuth (G0)

**Client**: bring your own (Desktop app type). `POST /kb/google/start` takes `clientId` and `clientSecret`; with neither, the account's stored pair is reused (reconnect or upgrade), then the legacy `google.email.clientId` and `clientSecret` pair (the user's own client from the old sign-in, cleared once the new connect succeeds). There is no hosted client and `config.googleClientId` is not used.

**Flow** (`startAuthFlow`): PKCE S256 (48 random bytes, base64url verifier), `state` (24 random bytes) and OIDC `nonce` (24 random bytes). The core binds an `http` listener on `127.0.0.1`, an ephemeral port, **for this flow only**, path `/oauth2/callback`, redirect URI `http://127.0.0.1:<port>/oauth2/callback`. The authorization URL (`access_type=offline`, `prompt=consent`, `login_hint` for a reconnect) is returned; **the server never opens a browser**, the client opens it in the system browser.

| Rule | Value |
|---|---|
| Timeout | 5 minutes (`FLOW_TIMEOUT_MS`), then the flow ends with an error and the listener closes |
| Single use | the callback is consumed before any `await`; the listener closes when the flow ends (a replay gets `ECONNREFUSED`); a request during the exchange is refused |
| State | timing-safe compare of hashes; a mismatch is 400 and does not consume the flow; 5 bad callbacks abort it |
| Host and path | only `GET /oauth2/callback` with `Host: 127.0.0.1:<port>`; anything else 404 |
| Flows | one pending flow per user (a new start replaces it), at most 8 in total |
| Page | fixed text, `Cache-Control: no-store`, `Connection: close`, CSP `default-src 'none'`; request values are never reflected |

**Completion** (`finishFlow`): exchange the code at `oauth2.googleapis.com/token` with the PKCE verifier; require `token_type` Bearer, a granted scope string that passes the check, a refresh token, and an ID token whose `aud` is the client, `iss` is Google, `exp` is not past (60 s skew) and `nonce` matches (the signature is not verified: the token came straight from the token endpoint over the pinned connection, OpenID Connect Core 3.1.3.7). Any refusal revokes what Google just minted. `accountId` = first 12 hex of `sha256("google-sub:" + sub)`, derived here. The three credentials go to the vault, the account row to `google_accounts`, the access token to memory.

**Tokens**: refresh token, client id and client secret only in the per-user vault (`google.acct.<id>.*`, AES-GCM with the user's AAD like every vault row). Access tokens only in memory, lifetime `min(expires_in, 55 min)`, refreshed 60 s early, one refresh in flight per account. `invalid_grant` or `invalid_client` marks the account `reconnect_needed` and every later call fails at once with `GOOGLE_RECONNECT_NEEDED` and **no network call** (no retry loop on a dead token; Testing-mode tokens expire after 7 days, unverified).

**Legacy `mail.google.com` token** (`google.email.refreshToken` of `/auth/google/*`): `startAuthFlow` revokes it at `oauth2.googleapis.com/revoke` and deletes it and its client fields **before** the new consent (so a revoke cannot take the new grant with it), whether or not the revoke succeeds. `start` answers `legacyMailTokenRevoked`; `GET /kb/google/accounts` answers `legacyMailToken` while one exists. The legacy `/auth/google/*` routes and the IMAP app-password path are unchanged (the app-password path is the manual fallback); removing `/auth/google/start` waits for a UI that uses the new route (the Mac and the Tauri Library screen still call it).

**Disconnect** (`disconnectAccount`): revoke the refresh token (best effort; `revoked: false` means the grant stays visible at `myaccount.google.com/permissions`), delete the three vault rows, the account row, every cursor, and the cached Calendar and Drive rows (`sources` with ref prefix `gcal:<id>:` and `gdrive:<id>:`). Gmail notes were written into the Library folder by the client and are not touched.

## 5 State

`google_accounts(user_id, account_id, email, scopes JSON, products JSON, drive_content, status connected|reconnect_needed, created_at, updated_at)`, primary key (user, account). `connector_sync_state(user_id, connector_id gmail|gcal|gdrive, account_id, cursor, pending_cursor, options JSON, status, last_error, last_run_at, updated_at)`, primary key (user, connector, account). Both are removed by `deleteUserCascade`. `last_error` holds a stable code (truncated to 300), never text from Google. Audit rows: `connector.google.start`, `connector.sync` (counts only), `connector.revoke`.

## 6 Routes

Ten routes under `/kb/google/`, contract in `schema/http/google.schema.json`. Errors use the `{ error: { code, message } }` envelope; upstream failures are 502 (429 for a rate limit after retries), `GOOGLE_RECONNECT_NEEDED` is 409, a product not granted is 409 `GOOGLE_PRODUCT_NOT_GRANTED`, a second run for the same account is 409 `GOOGLE_SYNC_RUNNING`, an unknown account (or another user's) is 404. Rate-limit buckets: fetch, sync, pickers `dispatch`; start, options, disconnect, seen `kbWrite`.

| Route | Purpose |
|---|---|
| `POST /kb/google/start` | `{ clientId?, clientSecret?, products[], driveContent?, accountId? }` -> `{ authUrl, state, redirectPort, expiresInSec, scopes[], legacyMailTokenRevoked }` |
| `GET /kb/google/status?state=` | `pending`, `unknown`, `error {message}` or `complete {accountId, email, products, grantedScopes, missingScopes, driveContent}`; a terminal result is read once; another user's flow is 403 |
| `GET /kb/google/accounts` | accounts with per-connector `status`, `lastRunAt`, `lastError`, `options`; `legacyMailToken` |
| `POST /kb/google/disconnect` | `{ accountId }` -> `{ ok, revoked, purgedSources }` |
| `POST /kb/google/options` | `{ accountId, product, options }` validated and clamped; a changed Gmail selection resets its cursor |
| `GET /kb/google/calendars?accountId=` | calendars for the picker |
| `GET /kb/google/drive/folders?accountId=&parent=` | folders under a parent (`root` unless `parent` is a valid id) |
| `POST /kb/google/gmail/fetch` | `{ accountId }` -> `{ batchId, mode, pending, stats, tombstones[], notes[] }` |
| `POST /kb/google/gmail/seen` | `{ accountId, batchId }` commits the cursor |
| `POST /kb/google/sync` | `{ accountId, product: gcal or gdrive }` one capped run |

**Command bus tiers** ([command bus](command-bus.md) section on tiers): connect, disconnect and options are desktop-only decisions; a phone-originated sync is a T1 enqueue handled by the bus job kind `sources.update` (slice G7, not built). No route returns a token, a client secret or a raw Google body to any caller.

## 7 Gmail (Pattern B, forward-only)

REST, `https://gmail.googleapis.com/gmail/v1/users/me`. One note per **thread**, file name `gmail-<accountId>-<threadId>.md`, so a new reply rewrites the same file.

**Options** (`normalizeGmailOptions`): `labels` (ids matching `^[A-Za-z0-9_][A-Za-z0-9_. -]{0,99}$`, at most 20, default `INBOX`), `windowDays` 1 to 365 (default 30), `includePromotions` and `includeSocial` (default false). Always excluded: `SPAM`, `TRASH`, `DRAFT`; `CATEGORY_PROMOTIONS` and `CATEGORY_SOCIAL` unless included. A thread is skipped when no remaining message carries a selected label; excluded messages are dropped from a mixed thread.

**Cursor** `{ historyId }`, plus `bootstrap { li, pageToken, done }` while a bootstrap is unfinished.

- **Bootstrap** (no cursor): read `users.getProfile` `historyId` first, then `threads.list` per selected label (`labelIds=<one label>`, `q=after:<epoch> -category:promotions -category:social`), 100 per page, at most 50 threads per run, at most 2 000 in total (`truncated`), resumable by page token.
- **Incremental**: `history.list` from the cursor with `historyTypes` `messageAdded`, `labelAdded`, `messageDeleted`; changed threads fetched with `threads.get format=full` (concurrency 4); a run stops at a history record boundary once 50 threads are collected and reports `pending` with that record as the cursor; a finished run's cursor is the mailbox `historyId`. A thread that answers 404 becomes a tombstone `{ threadId, noteFile, line: "deleted upstream <date>" }` for the client to append (forward-only: nothing is deleted).
- **historyId expired** (404): a bounded re-bootstrap over the window, flagged `rebootstrapped` (notes are idempotent upserts).
- **Create first, then mark seen**: `fetch` stores the next cursor as `pending_cursor` with a random `batchId`; only `POST /kb/google/gmail/seen` with that batch id promotes it. Only the latest batch is accepted, once (409 `GOOGLE_BATCH_UNKNOWN` otherwise). This is the contract of the email source's `/kb/email/seen`.

**Note**: frontmatter keys `source`, `account`, `accountId`, `threadId`, `subject`, `labels`, `participants`, `first_at`, `last_at`, `message_count`, `untrusted: true`, every value JSON-encoded (a hostile subject cannot add a key). Body: `# <subject>` then one `## <sender>, <time>` section per message, oldest first. Caps: 200 KiB per message body, 512 KiB per note (the newest messages kept, the count of omitted older ones stated), at most 50 participants, 50 attachments listed. **Attachments are metadata only** (name, MIME type, size; the unstable `attachmentId` is not stored). Quoted reply tails (`On ... wrote:`, `-----Original Message-----`, Outlook headers, a Japanese `...書きました:` line, `>` lines) and the the `--` signature delimiter line signature are trimmed, never to an empty result. RFC 2047 headers are decoded.

## 8 HTML and text to Markdown (no remote content)

`html-to-markdown.mjs` is a tokenizer, not the regex `stripHtml` of the IMAP source. Dropped with content: `script`, `style`, `iframe`, `object`, `embed`, `form`, `head`, `svg`, `math`, `template`, `noscript`, `title`, `textarea`, `select`, `button`, `applet`, frames, media and `canvas`, plus comments. Only `href`, `alt`, `width`, `height` are ever read. Images become `[image omitted]` or `[image omitted: <alt>]`, 1x1 pixels vanish, `src` is discarded. Links keep only `http`, `https` and `mailto` URLs without userinfo (`javascript:`, `data:`, `vbscript:`, `file:` and the rest drop the URL and keep the text), written as `[text](url)` with `()<>` percent-encoded, and are **never fetched**. All text is escaped (backslash, backtick, `*` `[` `]` `<` `>` `|`, `_` at a word boundary, line-leading `#`, `>`, `+`, `-`, `N.`) so a body cannot return Markdown image syntax or HTML; plain-text mail goes through the same escape. Invisible padding characters (zero width, bidi, soft hyphen, BOM) and control characters are removed, entities decoded (numeric ones range-checked). Output is capped. Secrets are redacted with `redactSecretsForStorage` on the raw text first and again on the whole note (an escaped `ghp_` token would otherwise escape the pattern, so `_` between word characters is left alone).

Redaction covers the shared token shapes (`core/redact-secrets.mjs`); it does **not** catch one-time codes or reset links as such (a `token=` query is kept in a link). Unverified as a privacy control.

## 9 Calendar (Pattern A)

REST `https://www.googleapis.com/calendar/v3`. Rows in `sources` (`kind: doc`), ref `gcal:<accountId>:<enc calendarId>:<enc eventId>`, chunked with `chunkLines`. Meta: `source`, `untrusted`, `accountId`, `calendarId`, `eventId`, `start`, `end`, `status`, `location`, `attendees[{name,email,response,organizer,self}]` (addresses kept, at most 100), `recurringEventId`, `updated`, `link` (text).

**Options**: `calendarIds` (at most 20, default `primary`), `daysBack` 0 to 365 (30), `daysAhead` 0 to 730 (90). **Cursor** `{ cals: { <id>: { syncToken } } }`, or while unfinished `{ pageToken, full {startedAt, timeMin, timeMax} }`.

- Full sync: `events.list` with `singleEvents=true`, `showDeleted=true`, `timeMin`, `timeMax`, 250 per page; recurring events appear as instances.
- Incremental: `syncToken` only (Google rejects `timeMin`/`timeMax` with it).
- **410** (or an expired page token): the cursor for that calendar is cleared and a full resync runs (at most twice per calendar per run, flagged `resynced`). Rows the resync did not write again (`indexed_at` older than its start) are deleted **after** the pass finished, so an interrupted resync never empties the index.
- Cancelled events delete their rows by **exact ref** (an instance id sharing a prefix with its master is safe).
- Run cap 2 000 events; an unfinished run keeps its page token and reports `pending`.
- A deselected calendar loses its cursor, keeps its rows.
- Description: HTML converted as in section 8, plain text escaped; hangout and conference links are stored as text, never opened.

## 10 Drive (Pattern A)

REST `https://www.googleapis.com/drive/v3`. Rows ref `gdrive:<accountId>:<fileId>`.

**Metadata first**: every non-folder file gets a findable note (name, type, modified time, size, folder path, link as text). Folders only feed the path and the "ticked" test (resolved lazily with `files.get`, memoised, at most 500 lookups per run, depth 20; unresolved means not ticked).

**Content** only when the account was granted `drive.readonly` **and** the file is under a ticked folder (`options.folderIds`, at most 50 ids matching `^[A-Za-z0-9_-]{5,100}$`): Docs `files.export` as `text/markdown` (falling back to `text/plain` on 400 or `exportFormatNotSupported`), Slides `text/plain`, Sheets `text/csv` (the first sheet only, a Drive export limit; kept in a code fence, cap 1 MiB), `text/plain`, `text/markdown`, `text/csv` files up to 2 MiB through `alt=media`. Every other MIME type stays metadata-only. Export responses are capped at 10 MiB on the wire and 200 000 characters kept (`[...truncated]`); a response over the cap leaves the metadata note with a marker. Exported text is neutralised: Markdown image syntax and `data:` URIs removed, `<` escaped, secrets redacted. Concurrency 3.

**Cursor** `{ startToken }`, plus `bootstrap { pageToken, done, startedAt }` or `pageToken` while unfinished. `changes.getStartPageToken` is read **before** the first listing. Bootstrap: `files.list` (`q=trashed = false`), at most 1 000 files per run (100 per page when content is on), 20 000 in total; when it finishes, rows older than its start are deleted. Incremental: `changes.list` (`includeRemoved=true`), then `newStartPageToken`. A 400, 404 or 410 on a stored token restarts a bounded bootstrap once (`restarted`; which status Drive uses is unverified). `removed` and `trashed` files delete their rows. **Shared drives are off by default** (`includeSharedDrives`): `includeItemsFromAllDrives=false` and any file with a `driveId` is skipped. Owners and permissions are not read.

## 11 Security summary

Per-user isolation (every row and vault key carries the user; routes take the user from the bearer token; `state` maps to a user and nothing else; the account id is derived server side). Secrets only in the vault; tokens never in a response, a log, an error message, an audit row (a test scans the responses and the audit table). Notes carry `untrusted: true`; an agent grounding on them treats them as data. Notes and rows are redacted before they are stored. Fixtures only in tests, with a tripwire.

## 12 Shipped, unverified, not built

| Item | State |
|---|---|
| G0 OAuth core, G1 Gmail, G2 Calendar, G3 Drive libraries and the ten routes | Shipped with fixture tests; never run against a real Google account |
| Whether Google accepts `http://127.0.0.1:<ephemeral port>/oauth2/callback` for a Desktop client, `prompt=consent` plus `access_type=offline` returning a refresh token every time, the `openid email` ID token with the `nonce` | Expected from Google's installed-app documentation; **unverified** |
| Restricted-scope verification and CASA for a distributed app; the 7-day refresh-token expiry of Testing mode; the 100 test user cap | From third-party summaries; unverified (plan section 2) |
| `files.export` with `text/markdown` for Docs; the `startPageToken` and `changes.list` error status for a stale token; Calendar `showDeleted` with `singleEvents` on a first full sync; Gmail `history.list` returning records after or at `startHistoryId` | Unverified; the code tolerates both readings |
| Whether revoking one refresh token ends the whole grant for that client and user | Unverified; the design avoids depending on it (legacy token revoked before the new consent, no revoke on reconnect) |
| Mac and Tauri screens, the setup guide page, selection-gated catalog rows, `pipelineReady` for `gdrive` and `gcal` (still false: the Mac manifests point at the MCP routes) | Slice G5/G6, not built |
| Scheduled and phone-enqueued sync (`sources.update` bus kind, T1) | Slice G7, not built |
| Removing `/auth/google/start` (full-mailbox scope) | Waits for a UI on `/kb/google/start` |
| Gmail attachments (v2), a Drive Picker mode, MCP adapters (G8), one-time-code redaction, Drive per-sheet export | Not built |
| Activity feed: Gmail uses `email_fetched`; Calendar and Drive use `knowledge_updated`; there is no `connector_fetched` kind | As built |

## Regeneration checklist

- [ ] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [ ] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [ ] Spot-check: one representative piece rebuilt from this page alone matches source.
- [ ] Structured facts link to their extractor-generated reference page (no hand-copied drift).
