# Google connectors: Gmail, Google Calendar, Google Drive into the Library

Status: **server side built 2026-10-31 (slices G1 to G4 and the routes of G5), fixture-tested, never run against a real Google account.** Spec of what was built: [google-connectors](../../spec/google-connectors.md). Open: catalog flip and selection gate, G6 screens and setup guide, G7 scheduled sync, G8, removal of the legacy `/auth/google/start`, a real-account test. Q-G1 to Q-G3 were answered by the user on 2026-10-31 (delegated, "do the best, SECURE"): bring your own client; replace the Gmail OAuth and revoke the old token; Drive metadata for everything and content only for ticked folders. Deviations from the text below, made while building: the loopback listener is per flow on an ephemeral port (not the server port), the legacy token is revoked before the new consent (a revoke cannot take the new grant with it), a reconnect never revokes the old refresh token, `include_granted_scopes` is not sent, the routes live under `/kb/google/*` (the plan's `/auth/google/*` per-account routes were not added), Gmail attachments and the Picker mode are not built. Original plan header: plan, nothing built. Date: 2026-10-31, at `main`. Parents: [connector catalog spec](../../spec/connector-catalog.md), [knowledge-kit map](../../kits/knowledge-kit.md), [Tauri Phase 5 plan](2026-10-31-tauri-phase5-macos-plan.md), [command bus spec](2026-10-31-command-bus-spec.md), [data lifecycle](../../kits/data-lifecycle.md).

Facts read in the repo on 2026-10-31 are cited by path. Facts about Google come from the pages linked in section 2 and are marked **unverified** where only a third-party page or the search summary said so. No Google call was made. Standard (user, 2026-10-31): "do the best, SECURE, usable for BIG projects"; macOS first; Auto Tasks are phone-commandable.

## 0. User facts that bound the design

1. The user's Google account is for **Gmail, Calendar and (likely) Drive connectors only**. LLM providers are API keys and subscriptions (CLI login). **Google sign-in is never an app login and never a model provider.** The existing `/auth/google/*` routes are an email-connector helper, not an identity system, and stay that way.
2. Connectors are ingest sources ([data-lifecycle](../../kits/data-lifecycle.md) rule 3): data lands in the Library as notes; nothing is written back to Google in v1 (read-only everywhere).
3. The core (Node) is the only process that talks to Google. The Tauri webview, the phone and the Chrome extension never see a Google token.

## 1. What exists today

| Piece | Where | State |
|---|---|---|
| Gmail OAuth (PKCE, loopback, bring-your-own Desktop client or an operator-configured hosted client) | `extension/connectors/google-oauth.mjs` (91 lines), routes `/auth/google/{start,status,callback}` in `extension/server/auth-routes.mjs` | Works, but the scope is **`https://mail.google.com/`** (full mailbox, IMAP XOAUTH2). That is far more than reading needs; this plan replaces it |
| Gmail over IMAP (app password or XOAUTH2) | `extension/connectors/email-source.mjs` (387 lines): `fetchRecentEmails`, `normalizeParsed`, `stripHtml`, caps `MAX_BODY_CHARS` 20 000, `MAX_MESSAGES` 200, `MAX_SOURCE_BYTES` 2 000 000, deadlines 30 s / 90 s, private-address host check, vault host binding | Pattern B (forward-only fetch to a folder, then note). `stripHtml` is regex-based: not a sanitiser |
| Refresh token storage | vault key `google.email.refreshToken`, per-user BYO client in `google.email.clientId` / `clientSecret` (`getGoogleAccessToken`, `email-source.mjs:204`) | Encrypted per user (`extension/server/vault.mjs`); the key set is a fixed list, so new keys need a pattern (as `mcp.*` has) |
| Catalog rows `gdrive`, `gcal` | `extension/connectors/connector-catalog.mjs`: `authKind: google-oauth`, `pipelineReady: false` | Placeholders; Mac Settings shows "Coming soon" |
| Mac manifests `gdrive.json`, `gcal.json` | `mac/Sources/LlmIdeMac/Resources/source_connectors/` | Point at the `/kb/mcp-connector/*` endpoints; those answer 400 "Unknown MCP connector id" for these ids (no descriptor) |
| MCP-backed pipeline | `extension/connectors/mcp-client.mjs` (563), `mcp-connector-defs.mjs` (283, Miro only), table `mcp_connector_seen`, pinned fetch | Shipped for Miro; tool names unverified; no cursor (the seen set is the only incrementality) |
| Outbound pinning | `extension/server/pinned-fetch.mjs` (`makePinnedFetch`), `tracker-fetch.mjs`, Box allowlist pattern in `box.mjs` (`isAllowedBoxUrl`, hand-followed redirects, capped bodies) | Reusable as is |
| Redaction at index build | `extension/kb/note-index.mjs` uses `redactSecretsForStorage` from `core/redact-secrets.mjs` on body and meta (`BODY_CAP_BYTES` 200 KiB, `MAX_NOTE_BODY_BYTES` 512 KiB) | Reuse; do not add a second pattern set |
| Source hub | `extension/kb/sources.mjs` (Pattern A rows), Box is the reference connector | Reuse for Calendar and Drive |
| Tauri screen | Library "Connections" group exists under `ui/screens/library/` (sources) | Needs the new Google cards (section 9) |

## 2. Google facts and what they decide

| Fact | Source | Consequence |
|---|---|---|
| Google publishes **official remote MCP servers**, one per product: Gmail `https://gmailmcp.googleapis.com/mcp/v1`, Calendar `https://calendarmcp.googleapis.com/mcp/v1`, Drive `https://drivemcp.googleapis.com/mcp/v1`. Status: **Developer Preview** ("available as part of the Google Workspace Developer Preview Program") | [Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers) | An MCP route exists. Not stable, enrolment may be required (unverified for an individual account) |
| Their required scopes: Gmail `gmail.readonly` **and `gmail.compose`**; Drive `drive.readonly` **and `drive.file`**; Calendar `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly` | same page | The Gmail and Drive servers demand **write-capable scopes** we do not want to hold. Calendar's set is read-only |
| The servers need a **custom OAuth client** (Web application type, "Use this client for an AI-powered agent"); the page does not mention dynamic client registration (unverified: it may not exist) | same page | Same bring-your-own-client burden as REST; no saving. Our MCP client's dynamic registration path (`byoClient: false`) would not work; `byoClient: true` plus a Web client with our loopback redirect is untested |
| Gmail read scopes (`gmail.readonly`, `gmail.metadata`, `mail.google.com`) are **restricted** scopes; restricted scopes need verification and, for apps that access that data **from or through a third-party server**, an annual CASA security assessment. Testing-mode apps: 100 test users, and refresh tokens expire after **7 days** unless only basic identity scopes are requested. Gmail refresh tokens are invalidated when the user changes the password | [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) (CASA wording confirmed there; the exact scope list and the 7-day and 100-user numbers are from third-party summaries such as [Nylas](https://developer.nylas.com/docs/cookbook/use-cases/build/fix-google-access-denied/) and are **unverified** against Google's own pages) | A self-hosted app with the user's own client in "Testing" works for that user but needs re-consent weekly. The page does not list "data stays on the user's device" as an exemption (it does list personal use and development/testing); whether a local-only distributed app triggers CASA is **unverified and must be asked of Google or a lawyer before any public release** |
| Calendar read scopes are sensitive (verification, no CASA); `drive.readonly` and `drive.metadata.readonly` are restricted; `drive.file` is non-sensitive but only reaches files the app created or the user opened with the Picker | Google scope tables, **unverified** here (not fetched) | Drive full-text indexing of a user's whole drive needs a restricted scope; a Picker mode (`drive.file`) is the safe alternative but needs an in-browser Picker, see Q-G3 |

## 3. Decisions per product

Common rule: **our own OAuth client (bring your own, per user) plus the official REST APIs, read-only, scopes minimal.** The core owns the client; the connector code owns mapping to notes.

| Product | Transport decision | Why not the others | Pattern | Scopes |
|---|---|---|---|---|
| **Gmail** | Gmail REST API (`gmail.googleapis.com`) with our OAuth client. Keep IMAP app-password as the **fallback for users who will not create a Google Cloud project** | MCP: requires `gmail.compose` (can create drafts), preview, tool names unverified, no `historyId` access so no incremental sync. IMAP + XOAUTH2: needs `mail.google.com` (full read, write, delete). IMAP + app password: no OAuth, but needs 2-step verification and is a long-lived all-access credential | **B, forward-only** (fetch, write notes into the Library folder; matches the shipped email path and "one copy" rule) with `historyId` as the cursor | `gmail.readonly` (restricted, v1). `gmail.metadata` is smaller but returns no bodies. No `gmail.modify`, no send |
| **Calendar** | Calendar REST API v3 with our client | MCP: acceptable later; read-only scopes, but no `syncToken` and no cursor, event updates and deletions would be invisible | **A** (events change and are cancelled; upsert by event id in `sources`, delete on cancel) | `calendar.events.readonly` plus `calendar.calendarlist.readonly` (the same narrow pair Google's MCP page names; sensitive tier, unverified) |
| **Drive** | Drive REST API v3 with our client; text via `files.export` (Docs, Sheets as CSV, Slides as text) and `files.get?alt=media` for plain text, Markdown, PDF text only when the core has an extractor | MCP: needs `drive.file` as well (write-capable), preview | **A** (document content changes; re-fetch by the changes feed; same shape as Box) | v1 **`drive.metadata.readonly` first** (restricted, but no content), `drive.readonly` when the user turns on content indexing; Picker/`drive.file` mode is Q-G3 |

One Google account holds one refresh token for all three products (incremental authorisation: ask for the scopes of the product being connected, `include_granted_scopes=true`). **Multi-account**: each account is an `accountId` (hash of the Google subject id); connectors are per (user, account, product).

The MCP route stays a **documented option, not built**: revisit when the Workspace MCP servers leave preview and offer read-only scope sets. The catalog entry keeps `authKind: google-oauth`, not `mcp`.

## 4. Security design

1. **OAuth**: authorization code with **PKCE (S256)** and `state`, loopback redirect `http://127.0.0.1:<port>/auth/google/callback`, **handled by the core's HTTP server**, opened in the **system browser** by the host (`open_external_url` with the `accounts.google.com` host check), **never in the webview**. Keep the existing `putState`/`takeStatus` single-use 10 minute TTL map; add a check that `redirect_uri` is built from `config.port`, not from a request header.
2. **Scopes shown before consent**: the Connect dialog lists each scope, its Google tier label, and "read-only; Auto Tasks and the phone cannot change this". The authorisation URL is built only from the registry in `google-scopes.mjs`; the callback verifies that the granted `scope` string is a subset of what was requested and refuses the connect if Google granted **more** (and records that it granted less, e.g. the user unticked a box on the consent screen).
3. **Tokens**: refresh token only in the core vault, per user, per account (new vault key pattern `^google\.acct\.[a-f0-9]{12}\.(refreshToken|clientId|clientSecret)$`, added the way `mcp.*` is). Access tokens in memory only, 55 minute lifetime. The migration of the existing `google.email.refreshToken` (scope `mail.google.com`) is **not** carried over: the Gmail connect asks for consent again with `gmail.readonly`, then **revokes the old token** at `https://oauth2.googleapis.com/revoke`. **Never** sent to the phone, the extension, the Tauri webview, the relay, logs, audit detail, error text (`redactSecrets` plus `redactWithKey`).
4. **Revoke flow**: Disconnect calls the revoke endpoint, deletes the vault rows, deletes the sync cursors, keeps the notes (deselect never deletes data, same rule as `connector-catalog`) unless the user ticks "also delete imported notes" (deletes by `source` prefix). If revoke fails (offline) the local credentials are still deleted and the screen says the grant remains visible at `myaccount.google.com/permissions`.
5. **Pinned fetch for every Google endpoint** through `makePinnedFetch`, **host allowlist, https only, port 443, no userinfo**: `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com` (email address only), `gmail.googleapis.com`, `www.googleapis.com` (Drive v3 and the Calendar path), `calendar.googleapis.com` if the client library uses it (unverified which host Calendar v3 serves from; keep both). Redirects followed by hand, 3 hops, each hop re-validated and re-pinned, bearer dropped on an origin change (the Box rule, `extension/connectors/box.mjs`). No private-address opt-in exists for Google.
6. **SSRF on attachment and URL fields**: a message, event or file can carry a URL (event `conferenceData` links, `htmlLink`, Drive `webViewLink`, `exportLinks`, attachment ids). **The core never fetches a URL found in content.** Only calls the three APIs by id. Links are stored as text in the note and opened only through the host opener allowlist.
7. **Size caps**: JSON bodies 8 MiB, one message body 200 KiB before redaction (plus the existing note caps), one Drive export 10 MiB of text, per sync run caps (messages, events, files) with a "showing N of M, more pending" state. Streaming size check, not only `content-length`.
8. **PII and secret redaction at index build**: all text goes through `redactSecretsForStorage` before it is stored or chunked (same call `note-index.mjs` makes), and the metadata too. Mail often carries tokens, one-time codes and card numbers; add Google-specific fixtures to the redaction tests (reset links, OTP lines).
9. **HTML mail to Markdown, no remote content**: bodies are converted by a real parser (not the regex `stripHtml`) that drops `script`, `style`, `iframe`, `object`, forms, event attributes, `data:` and `javascript:` URLs; images become `[image omitted]` (alt text kept), links become Markdown text plus URL, **no tracking pixel or image is ever fetched**. Plain-text part preferred when present. Quoted replies and signatures trimmed by the standard `>` and "On ... wrote:" patterns, never dropping a message's own text.
10. **Prompt injection**: mail, event descriptions and shared documents are written by third parties. Notes carry `source: gmail|gcal|gdrive`, `untrusted: true` in frontmatter; any agent grounding on them already treats notes as data, and Auto Tasks that read these notes keep the T1 desktop approval (section 8). A classify step, if used, runs without tools (connector-catalog spec section 6 recommendation).
11. **Attachments: metadata only in v1** (name, MIME type, size, a stable id). No download, no extraction, no virus-scan problem to own. v2 may fetch a small allowlist of types (PDF, text) with the Drive-style cap.
12. **Per-user isolation**: every row and vault key carries `user_id`; routes take the user from the bearer token; the callback maps `state` to a user and nothing else; accountId is derived server-side from the token response, never from the client.
13. **Audit**: `connector.select`, `auth.secret_set` (resource `google.acct.<id>`), new `connector.sync` (counts only, no content), `connector.revoke`.
14. **Tests with recorded fixtures only, no real calls**: `NODE_ENV=test` pinned-fetch stub, JSON fixtures under `extension/tests/fixtures/google/`, a tripwire that fails any test that reaches a real Google host.

## 5. Mapping to notes

**Gmail (thread to note).** One note per **thread** (not per message): title = subject, frontmatter `source: gmail`, `account`, `threadId`, `labels`, `participants` (display names and addresses), `first_at`, `last_at`, `message_count`, `untrusted: true`; body = messages oldest first, each under a heading with sender and date. Default scope: labels `INBOX` and any the user selects; **excluded by default** `SPAM`, `TRASH`, `DRAFT`, and category tabs `Promotions`, `Social` (switchable). Backfill window default 30 days, cap 2 000 threads for the first run; later runs are incremental. Thread edits (a new reply) update the **same** note file by thread id (the note path is derived from the thread id so it is stable).

**Calendar (event to note).** One note per event in the selected calendars; frontmatter `source: gcal`, `calendarId`, `eventId`, `start`, `end`, `attendees` (names, response status), `location`, `status`; body = description (HTML to Markdown), links as text. **Linking a calendar event to a meeting recording is the Live feature's concern** (capture-kit), not this connector: the plan only guarantees stable ids and ISO start/end times so Live can match by time window. Recurring events: store the master plus expanded instances inside the sync window (`singleEvents=true`), window default 60 days back to 180 days ahead.

**Drive (file to note).** One note per file (Docs as Markdown-ish text via export `text/plain` or `text/markdown` where offered, Sheets as CSV per sheet capped at 1 MiB with a "truncated" marker, Slides as text); other types become **metadata-only notes** (name, owner, modified time, link) so they are findable. Folder path kept in frontmatter. **Shared drives**: `supportsAllDrives=true`, `includeItemsFromAllDrives=true`, off by default per drive, listed in the picker the user ticks. Owner and `permissions` are **not** read in v1 (smaller scope, no leak of who has access).

## 6. Incremental sync, deletion, quota

| Product | Cursor | Full-resync trigger | Deletion |
|---|---|---|---|
| Gmail | `historyId` from `users.getProfile` / `history.list` (`messageAdded`, `labelAdded`, `messagesDeleted`) | `history.list` 404 (history too old; Google keeps it about a week, unverified) | **Forward-only**: a message deleted upstream does **not** delete the note by default (setting "mirror deletions" is off); a tombstone line `deleted upstream <date>` is added to the note when the thread disappears |
| Calendar | `syncToken` per calendar from `events.list` | `410 GONE` clears the token and does a full sync | `status: cancelled` events delete the `sources` row and its chunks (Pattern A) |
| Drive | `changes.getStartPageToken` / `changes.list` `pageToken`, `newStartPageToken` | invalid token error | `removed: true` or trashed deletes the row; shared-drive removal likewise |

Cursors live in a new per-user table `connector_sync_state(user_id, connector_id, account_id, cursor, updated_at, status, last_error)` (next free migration number; **append-only**, `requireUser` scoping), never in the vault. Scheduled re-fetch uses the existing `sources.update` job kind; the manual button enqueues the same job.

Rate limits: read `Retry-After`, exponential backoff with jitter, honour 429 and `403 userRateLimitExceeded` / `rateLimitExceeded`, concurrency 4 per account, batch HTTP only where the API offers it (Gmail messages.get fan-out is the cost; per-user quota-unit numbers in Google docs were not fetched, **unverified**). A run has a wall-clock budget (Box uses the route budget as the model); an unfinished run stores its cursor and says "N more pending". **BIG mailboxes** (100k messages): never list everything; backfill by window and label, resumable by page token.

## 7. The Google Cloud reality for a self-hosted app

- **Recommendation: bring your own client.** Each user (or the operator for a team) creates one Google Cloud project, enables Gmail, Calendar and Drive APIs, creates an OAuth client of type **Desktop app** (Google's loopback flow; the existing code already says "bring-your-own Desktop client"), pastes the client id and secret into a write-only field. The client secret in a Desktop client is not a real secret, but it is stored in the vault anyway.
- **Testing mode**: up to 100 test users, and (unverified, see section 2) refresh tokens expire after 7 days, so the Connectors screen must show "reconnect needed" cleanly and the sync must fail closed with a clear status, never retry the dead token in a loop. **"In production" without verification** (personal use) removes the 7-day expiry and shows the "unverified app" screen with the 100-user cap; that is the practical personal-use setup and the doc must say it plainly. Both statements are from third-party pages and need the user's own check at setup.
- **No hosted client we operate** until Google confirms whether a local-only app needs the annual CASA assessment for `gmail.readonly` and `drive.readonly` (Q-G1). The existing `config.googleClientId` hosted mode stays untouched for the old email path and is not extended to the new scopes.
- Setup guide (a docs page, written with slice G6) with screenshots-free steps and the exact redirect URI the app shows.

## 8. Command bus tiers

Per [the command bus spec](2026-10-31-command-bus-spec.md): connect, disconnect, client id and secret entry, scope changes, account removal are **D desktop-only** (`tier_denied` for any other origin). "Sync now" and a scheduled sync are `sources.update`, **T1 desktop approval** when phone-originated (the phone only enqueues). Reading the connector list and the last-sync status is R. A phone never receives a token, a client secret or a message body through connector routes.

## 9. What the Tauri screen needs

In `ui/screens/library/sources` (the Connections group):

- A **Google card** per account with product toggles (Gmail, Calendar, Drive), status (`connected`, `reconnect needed`, `testing-mode token expires`, `syncing`, `N pending`), last run counts, errors in fixed text.
- **Connect dialog**: step 1 client id and secret (write-only, never shown again, a link to the setup guide), step 2 scope list with tier labels, step 3 "Continue in your browser", then polls `GET /auth/google/status?state=` (existing shape). Disconnect with the two-choice delete dialog.
- Per-product options: Gmail labels and window; Calendar picker of calendars and window; Drive folder and shared drive picker, content on/off.
- Library list rows for notes with `source` badges; untrusted marker on detail view; links through the host opener.
- All text states in the shared kit; list windowing already exists for large result sets.

## 10. Slices

Files under `extension/connectors/google/` are new; routes in a new `extension/routes/google-connectors.mjs` registered under `routes/feature-routes.mjs` rules (L4 may import any Node layer). No code, schema or test is touched by this plan itself.

| Slice | Owns | Work | Exit gate |
|---|---|---|---|
| G0 | this doc, `docs/spec/google-connectors.md` (after code) | Decide Q-G1..G3, write the user setup guide | Answers recorded in the plan |
| G1 | `extension/connectors/google/google-auth.mjs`, `google-scopes.mjs`, `google-fetch.mjs`, vault key pattern in `extension/server/vault.mjs`, `extension/tests/google-auth*.test.mjs` | PKCE and loopback flow per account, scope registry and subset check, revoke, pinned and allowlisted fetch with backoff, hand-followed redirects | Fixture tests: granted-scope superset refused, state replay refused, revoke and delete, no token in any error string, tripwire on real hosts |
| G2 | `extension/connectors/google/gmail.mjs`, `html-to-markdown.mjs`, fixtures `extension/tests/fixtures/google/gmail/*` | Thread listing, history sync, message to note, HTML sanitising, caps, metadata-only attachments | 200, empty, large page, 401, 403 quota, 404 history, 5xx, truncated JSON, hostile HTML corpus (script, remote image, `javascript:`), redaction fixtures |
| G3 | `gcal.mjs`, fixtures | `syncToken` sync, recurring window, cancelled deletion, 410 resync | Same error set plus 410 and cancelled |
| G4 | `gdrive.mjs`, fixtures | Changes feed, export per type with caps, shared drives, metadata-only notes | Same plus export too large, removed file |
| G5 | `extension/kb/migrations/<next>_connector_sync_state.sql`, `extension/kb/connector-sync-state.mjs`, `extension/routes/google-connectors.mjs`, `connector-catalog.mjs` rows, `schema/http` rows, `ALL_ENDPOINTS` and API bump | Cursor table, routes (`/auth/google/*` per account, `/kb/google/{accounts,sync,options,disconnect}`), catalog `pipelineReady` true, `sources.update` job wiring | Contract gates, per-user isolation test, selection-gate decision (Q-G2) |
| G6 | `ui/screens/library/sources/google/*`, setup guide docs | Section 9 | Fixture-backed screen tests, a11y pass, no secret in DOM after entry |
| G7 | automation hook (job kind `sources.update` handling) | Scheduled sync, phone enqueue, T1 approval path | Execution-time re-check test (connection still present, scope still granted) |
| G8 (later) | MCP adapter descriptors | Only if Workspace MCP leaves preview with read-only scope sets | Separate decision |

Order: G0, G1, then G2 (most valuable), G3, G5, G6, G4, G7. Swift Mac sources are **not** touched (feature freeze); the `gdrive.json` and `gcal.json` manifests are left as they are and noted as dead until retirement.

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Google rules (CASA for local apps, 7 day expiry, scope tiers) are from third-party summaries | Mark unverified; verify in the user's own Cloud console at G0 |
| R2 | Restricted scope blocks distribution beyond the user's own client | BYO client is the product position; no hosted client |
| R3 | Mail HTML or event text carries injected instructions | Untrusted marker, T1 for agent work on it, no tool-bearing classify |
| R4 | The old `mail.google.com` token stays alive | Mandatory revoke at the first new connect; Settings shows it as legacy |
| R5 | Whole-drive indexing is large and sensitive | Metadata first, content opt-in per folder, caps, per-run budget |
| R6 | Token expiry loops | Fail closed, one status, no retry on `invalid_grant` |

## 12. Questions for the user (recommendations)

1. **Q-G1 Distribution.** Is this connector for your own accounts and a few people you know (bring-your-own client, no Google review), or must a stranger be able to install the app and connect Gmail with one click? Recommend **bring your own client now**; one-click needs Google verification and possibly the annual CASA assessment, a business decision for later.
2. **Q-G2 Gmail path.** Replace the existing Gmail OAuth (`mail.google.com` over IMAP) with the REST read-only connector, keeping IMAP with an app password only as a manual fallback? Recommend **yes**, and revoke the old broad token.
3. **Q-G3 Drive reach.** Index your whole Drive read-only (`drive.readonly`, a restricted scope, strongest for BIG projects) or only files and folders you pick (`drive.file`, non-sensitive, needs a Picker page)? Recommend **metadata for everything, content only for folders you tick**, whole-drive scope with BYO client; the Picker mode is a later add.
