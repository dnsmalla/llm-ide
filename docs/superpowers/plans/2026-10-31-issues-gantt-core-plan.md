# Issues and Gantt into the Node core (work-kit K1) for the Tauri app and the command bus

Status: **plan, nothing built.** Date: 2026-10-31, at `main`. Parents: [work-kit map](../../kits/work-kit.md) (decisions W1 to W6), [Tauri Phase 5 plan](2026-10-31-tauri-phase5-macos-plan.md) section 6 (P5-I; this plan refines it and keeps its slice names I1 to I5 as the screen-side slices), [command bus spec](2026-10-31-command-bus-spec.md), [kit-by-kit migration](2026-10-27-kit-by-kit-migration.md).

Everything below cites a path read on 2026-10-31. Counts are lines as stated by the parent docs; nothing was run. Standard (user): "do the best, SECURE, usable for BIG projects"; macOS first; Auto Tasks are phone-commandable.

## 0. Goal and non-goals

**Goal.** Node becomes the only process that talks to GitHub, GitLab, Backlog and Linear for issue **read and write**. The Tauri screens (list, kanban, detail, Gantt) and, later, the phone and the relay are thin clients of core routes and bus commands. Provider tokens live in the core vault. The Swift Issues UI keeps working, untouched (feature freeze), until retirement.

**Non-goals.** No webhooks (a local app has no public address; polling plus ETags). No GitLab dispatch target (W6: GitLab issues are covered by the new routes; `agents/dispatcher.mjs` `ALLOWED_TARGETS` stays `preview, github, backlog, linear`). No change to the plan pipeline (planner, review, codegen), which has no Mac caller (work-kit section 2b). No issue content as source of truth in our database.

## 1. What exists

| Piece | Where | Facts |
|---|---|---|
| Swift Issues UI | `mac/Sources/LlmIdeMac/Features/Issues/` | 4 278 lines, 11 files: `RepoIssueDetailSheet` 925, `RepoIssuesView` 691, `RepoKanbanPanel` 261, Gantt `GanttView` 885, `GanttViewModel` 411, `GanttContainerView` 284, `GanttFilterBar` 252, `IssueScheduleEditorSheet` 212, `RecentIssuesResolver` |
| Swift provider clients | `mac/Sources/LlmIdeMac/Core/Repo/` | 25 files, 5 765 lines, shared with SourceControl, Chat, AutoTask, Loop, MobileControl: `GitHubClient`, `GitLabClient`, `RepoBackend`, `AllowlistedRepoBackend`, `RepoBackendFactory`; **tokens in the Mac Keychain** |
| Schedule overlay | `extension/kb/issue-schedule.mjs` (143), `extension/routes/issue-schedule.mjs` (76), migration `0020_issue_schedule.sql`, feature `gantt_issues` | Table `issue_schedule(user_id, provider, repo, issue_number INTEGER, start_date, due_date, estimate_days, depends_on JSON array of numbers)`, unique per user, provider, repo, number; `ALLOWED_PROVIDERS` is **`github`, `gitlab` only**; `GET`/`PUT /kb/issue-schedule` |
| KB ticket index | `extension/connectors/issues.mjs` (135), `GET /kb/issues`, `POST /kb/connect-github-issues` | Pattern A index of GitHub issues into `sources` for search and planning, `MAX_PAGES` 10 (about 1 000 issues), token passed per call, never stored. **Not an issues API**; stays as the search index feeder |
| Dispatch (create only) | `extension/agents/dispatcher.mjs` (543): targets `preview` (default, idempotent through `meta.dispatched.url`, claim before send), `github`, `backlog`, `linear`; `agents/outcome-providers.mjs` polls state back into `outcomes` | Creates issues and PRs; no list, update, comment, label |
| Tracker pinning | `extension/server/tracker-fetch.mjs` (`makeTrackerFetch`), `server/pinned-fetch.mjs` | DNS once, every address classified, redirects refused by default, `followSameHost` for read GETs (max 3 hops), errors passed through `redactWithKey(secret)`, private-network opt-in needs the connection flag **and** `LLMIDE_ALLOW_PRIVATE_PROVIDERS` |
| Vault keys that exist | `extension/server/vault.mjs`: `github.token`, `backlog.apiKey`, `linear.apiKey` | **No GitLab key and no GitLab host setting**; Backlog needs space and issue type ids too |
| Phone path | `Features/MobileControl/Services/MobileIssuesBridge.swift` (119), `PhoneIssues.swift`; spec kinds `issues.*` read and `issue.comment` T1 (command bus spec, `selfheal.*, scm.*, issues.*` row) | Served by Swift today; moves to the core executor in the bus migration |
| Tests to port | `GanttViewModelProviderParityTests`, `RepoIssueSearchParityTests`, `RepoIssuesLoadGateTests`, `RepoCredentialScopeTests`, `PhoneIssuesTests`, `IssuesGanttGraphFixesTests` | work-kit section 2f; "port before delete" (R5) |

Board and Gantt parity behaviour (from the user's memory notes, repeated here because it is a product rule): **provider routing** must pick the backend from the linked repo, kanban columns are **derived from labels**, scoped with `::` on GitLab and `:` on GitHub (for example `status::doing`, `status:doing`), and GitHub issues get their start, due, estimate and dependencies from the `issue_schedule` overlay because GitHub has none. The port must reproduce both, not redesign them.

## 2. Decisions (recorded answers and proposals)

- **W2 (delegated, answered in Phase 5)**: tokens move to the **core vault**, write-only entry, per-user scope. This plan adds the migration detail (section 6) and one open question.
- **W3 stays**: the overlay stays server SQLite. It is extended, not replaced, to carry Backlog and Linear (their keys are strings such as `PROJ-12` or `ENG-123`, not integers; section 5).
- **Provider interface, one for four providers** (section 4), each adapter behind its own host allowlist and credential scope.
- **Source of truth is the provider.** Our SQLite holds a **derived, rebuildable cache** (section 7) so a 10 000 issue repo can be windowed, searched and shown offline with staleness markers. This **refines** the Phase 5 line "bounded in-memory page cache only" because a 10k list cannot be filtered server-side over an in-memory 5 000 entry LRU; the cache is per user, purged on disconnect, never exported, never fed to a model without the usual grounding path. Flagged as Q-I3 if you disagree.

## 3. Route set (proposed, additive, API version bump, rows in `schema/http`)

Names follow Phase 5 (`/kb/repo/issues*`); `provider` is `github|gitlab|backlog|linear`, `repo` is the provider's project key (`owner/name`, GitLab path or id, Backlog project key, Linear team key).

| Route | Purpose | Notes |
|---|---|---|
| `GET /kb/repo/connections` | which providers are connected, host, scopes known, last sync, rate state | no secret ever; replaces per-client Keychain probing |
| `PUT /kb/repo/connections/:provider` | write-only token (and host or space) entry; `DELETE` removes | vault write, audit `auth.secret_set`; D desktop-only on the bus |
| `GET /kb/repo/issues` | **server-side query over the cache**: `state`, `label`, `assignee`, `milestone`, `q` (FTS), `updatedSince`, `sort`, `cursor`, `limit` (max 200) | returns `{ items, nextCursor, meta: { shown, matched, cachedTotal, complete, syncedAt, stale, rate } }` so the UI says "showing 200 of 10 482" |
| `POST /kb/repo/issues/sync` | start or continue a sync (full or incremental) for one repo | returns a job id (persisted job runner, `extension/kb/job-queue.mjs`); progress by poll, resumable by cursor |
| `GET /kb/repo/issues/:key` | one issue live from the provider with comments page 1, refreshes the cache row | `If-None-Match` ETag use |
| `GET /kb/repo/issues/:key/comments?cursor` | paged comments | |
| `POST /kb/repo/issues` | create | same safety as dispatch (guardrail scan, redaction) |
| `PATCH /kb/repo/issues/:key` | title, body, labels (add and remove arrays), assignees, milestone, **state transition** by named transition | requires `baseUpdatedAt`; stale base returns 409 with the latest issue |
| `POST /kb/repo/issues/:key/comments` | add comment | `idempotencyKey` required |
| `GET /kb/repo/board` | columns derived from labels: `{ columns: [{ name, count, cursor }], uncategorised }`, per-column paging | uses the `::` or `:` separator from the adapter's `capabilities` |
| `GET /kb/repo/gantt?from&to&cursor` | scheduled rows in a date window, sorted, with overlay merged; dependency edges for the returned rows only | `PUT /kb/issue-schedule` stays the write; extended to the new providers |
| `GET /kb/repo/labels`, `/milestones`, `/assignees` | pickers | cached per repo, short TTL |

Not routes: webhooks, bulk delete, repository admin, anything outside issues.

## 4. Provider adapter interface

Directory `extension/connectors/issues/` (new files; the existing `issues.mjs` indexer stays, see section 1): `index.mjs` (registry), `types.mjs` (normalised shape, JSDoc), `github.mjs`, `gitlab.mjs`, `backlog.mjs`, `linear.mjs`, `normalize.mjs`, `rate.mjs`, `scope.mjs` (the ported `RepoCredentialScopeTests` rules).

```
capabilities() -> { nativeDates, scopedLabelSeparator ('::'|':'|null), transitions: 'open-close'|'workflow',
                    commentsPaged, supportsEtag, maxPageSize, writes: {labels, assignees, milestone, transition} }
list({ repo, state, updatedSince, cursor, etag }) -> { items, nextCursor, etag, rate, notModified }
get({ repo, key, etag })        -> { issue, etag, rate }
listComments({ repo, key, cursor })
create(input) / update(key, patch, baseUpdatedAt) / comment(key, body, idempotencyKey)
transition(key, name)           -> adapter maps 'start'|'done'|... to labels, state or workflow ids
labels(repo) / milestones(repo) / assignees(repo)
```

Normalised issue (one shape, tested identical across providers): `provider, repo, key (string, stable), number (int|null), title, body (capped 64 KiB, marked truncated), state ('open'|'closed'|'other'), stateName, labels[], assignees[], author, milestone, createdAt, updatedAt, closedAt, url, commentCount, startDate?, dueDate?, estimateDays?, dependsOn[] (keys)`. Native dates and links are read where the provider has them (GitLab due dates, Linear due date and estimate, Backlog start and due dates; exact field availability per provider is **unverified** here and is confirmed from the recorded fixtures in IC1); the overlay fills in the rest (GitHub always).

Rules every adapter obeys:

1. **Pinned fetch**: all traffic through `makeTrackerFetch({ secret, ... })`; fixed host allowlists: `api.github.com` (GitHub Enterprise only with an explicit configured host), `gitlab.com` or the configured GitLab host, `api.linear.app`, `<space>.backlog.com|.jp|.tool` (the existing `BACKLOG_TLD_RE` validation). **Self-hosted GitLab or Backlog on a private address** needs the connection's private-network opt-in **and** `LLMIDE_ALLOW_PRIVATE_PROVIDERS` (the operator gate); link-local and metadata addresses are refused always.
2. **Credential scope** (R2): a token is only ever sent to its own provider host; the port of `RepoManager.credentialScope` refuses a GitLab token to a GitHub host and plaintext http except loopback.
3. **Repo allowlist**: operations on a repo outside the user's chosen list are refused (port of `AllowlistedRepoBackend`), enforced in the route layer so no adapter can bypass it.
4. **Errors map to fixed text** (`rate_limited`, `auth_failed`, `not_found`, `provider_unavailable`, `bad_response`), never raw body; redaction on every message.
5. **No automatic follow of URLs found in issue content**; images and links in markdown are text for the UI.
6. **Body size caps**: JSON 8 MiB streaming, titles 512 characters, comments page 100.

## 5. Schedule overlay changes

The overlay is keyed by an integer issue number, which cannot hold `ENG-123` or `PROJ-12`. Plan (append-only migration, next free number after `0058`): add `issue_key TEXT` backfilled from `issue_number`, a unique index on `(user_id, provider, repo, issue_key)`, widen `ALLOWED_PROVIDERS` to the four providers, store `depends_on` as an array of keys. Keep the old column and the old `PUT /kb/issue-schedule` body (number) working for the Swift app for the overlap (N-1 readable). Validation and `userId`-first rules stay (`requireUser`). Optimistic Gantt writes carry `baseUpdatedAt` of the overlay row; the server returns 409 with the current row on conflict. Whether to also write a **native** due date to GitLab, Linear and Backlog when the user drags a bar is Q-I2.

## 6. Token storage and the one-way migration

1. **New vault keys** for GitLab (token and host) and for each provider's connection record (`^repo\.(github|gitlab|backlog|linear)\.(token|host|space|projectId|issueTypeId)$` pattern, added like `mcp.*`). Existing `github.token`, `backlog.apiKey`, `linear.apiKey` are reused as the first entries (and still feed the dispatcher).
2. **Write-only entry** from the Tauri Settings screen (never echoed back, never in logs, redacted in errors), per user.
3. **Migration from the Mac Keychain is one way and has no silent path.** The Swift app owns those Keychain items; another binary (the Tauri host) reading them triggers an access prompt and ties us to Swift internals. Options in Q-I1. The Swift copy is never deleted by this work (rollback slot, N-1).
4. Tokens are **never** sent to the phone, the extension, the relay or the webview after entry; the phone gets issue data through bus commands the core executes.

## 7. Big projects: sync, cache, pagination, rate limits

**Targets (not measurements):** 10 000 open issues in one repo; first full sync resumable and bounded; list scroll with at most about 60 rows mounted; Gantt with 2 000 scheduled rows at 60 fps (Phase 5 criterion) and a **stretch** of 50 000 tasks where only the visible window is ever materialised on the client.

- **Cache**: table `issue_cache(user_id, provider, repo, key, json, search_text, updated_at, etag, fetched_at)` plus an FTS5 virtual table over title, labels and a redacted body prefix; per-user scoped, bounded per repo (default 100 000 rows, oldest closed first evicted), rebuildable by a resync, purged on disconnect. A `repo_sync_state(user_id, provider, repo, cursor, last_full_at, last_incremental_at, status)` row keeps the resumable cursor. Bodies are run through `redactSecretsForStorage` before they enter the search text.
- **Incremental**: GitHub list with `since` and `sort=updated`, ETag `If-None-Match` (a 304 is cheap; whether it is free against the quota is a GitHub detail **unverified** here); GitLab `updated_after` with keyset pagination; Linear GraphQL cursors with `updatedAt` filter and query-complexity awareness; Backlog count and offset with `updatedSince`. Closed or deleted issues: a provider that reports deletion marks the row removed; one that does not is reconciled by the periodic full resync (default daily, off-peak) and the row shows `removed upstream?` until then.
- **Staleness**: every list answer carries `syncedAt` and `stale` (older than a TTL, default 5 minutes while the screen is visible, polling backs off to 15 minutes hidden); offline (network error) the screen shows the cache with a banner and disables writes.
- **Rate limits**: read `Retry-After` and each provider's rate headers, token bucket per (user, provider), one in-flight sync per repo, jittered backoff, a visible reset time; **never loop on 403 or 429**; writes are queued behind reads' budget, one write at a time per issue.
- **Windowing**: the list is cursor-paged from the cache (200 per page); the board pages per column (`cursor` per column, 50 at a time); Gantt asks for a date window plus a row range; the client keeps row indexes in typed arrays and mounts only visible rows and arrows. **Dependency arrows**: draw only edges whose both ends are in the row window, capped at 2 000 arrows; beyond that show arrows for the selected row only.
- **Search**: server-side FTS over the cache with the "showing N of M" state; no client-side filtering of a full download.

## 8. Permissions on the command bus

Per the spec tiers: reading (list, get, comments, board, gantt, labels) is **R** for desktop, native phone and extension; the PWA gets R only through the relay later. **Writes from any non-desktop origin are T1**: the phone **enqueues**, the job waits `awaiting_approval`, the desktop shows the typed arguments (repo, issue key, exact diff of labels, assignees, comment text) and re-checks at execution (still connected, repo still allowlisted, switch still on, issue not changed since `baseUpdatedAt`). Already in the spec: `issue.comment` T1. **Needs a spec amendment** (listed here, not made here): new kinds `issue.update`, `issue.transition`, `issue.assign`, `issue.labels` all T1, `issue.create` T1, and connection entry or removal **D** (desktop-only). `issues.implement` stays T2. A **desktop UI** write is a direct user action (the click is the approval); it is still audited (provider, repo, key, action, no body) and still goes through the repo allowlist and the 409 stale check. No write from Chat or Loop without the existing approval path.

## 9. Fixture strategy (no real provider calls in any test)

- Recorded responses under `extension/tests/fixtures/issues/{github,gitlab,backlog,linear}/` as JSON plus header sidecars (ETag, Link, rate headers): 200 page, empty, large page (200), second page, 304, 401, 403 auth, 403 and 429 rate limit with reset header, 404, 5xx, truncated JSON, oversize body, a hostile issue body (script, image URL), label-scheme issues for the board.
- A deterministic **synthetic generator** (`extension/tests/support/issues-synth.mjs`) produces 10 000 and 50 000 issue pages for windowing, cache, FTS and Gantt model tests; fixtures are generated, not stored.
- Tests run with the pinned-fetch test transport (`_setPinnedFetchForTests`), plus a tripwire that fails any test reaching a real tracker host.
- **Adapter contract test**: GitHub and GitLab fixtures of the same logical issues normalise to identical output (Phase 5 requirement); Backlog and Linear get their own expectations.
- **Parity ports**: `RepoCredentialScopeTests` first (R2), then `RepoIssueSearchParityTests`, `RepoIssuesLoadGateTests`, `GanttViewModelProviderParityTests`, `IssuesGanttGraphFixesTests` as node tests, then `PhoneIssuesTests` against the bus kinds. Swift files are not deleted by this work.
- Gantt date math, overlap and drag-clamp tests live with the UI model (slice I4), pure functions in `ui/screens/issues/gantt/model.ts`.

## 10. Tauri screens

Slices I3 to I5 of Phase 5 stay the screen slices:

- **List** with filter chips (state, label, assignee, milestone), saved views (host prefs), search box, "showing N of M" and "synced 2 min ago, stale" markers, windowed rows, keyboard navigation, safe markdown in the detail sheet, images never auto-loaded, links through the host opener allowlist.
- **Kanban** with label-derived columns, per-column windowing and counts, drag between columns calls `PATCH` with the label diff and `baseUpdatedAt`, rollback and message on 409.
- **Detail sheet** with paged comments, add comment (idempotency key), labels, assignees, milestone, transition buttons from `capabilities()`.
- **Gantt** (canvas or SVG, row and time-window virtualisation), overlay editor, dependency arrows under the cap, drag writes the overlay with optimistic update and rollback; today marker; zoom levels; empty state that says which issues have no dates and offers the schedule editor.
- **Connect flow** (`providers-connect`): write-only token, host or space, repo allowlist picker, test connection, shows rate state.
- Everything in the shared kit; no secret in the DOM after entry.

## 11. Slices (core, new `IC` names; screens are Phase 5 I3 to I5)

| Slice | Owns | Work | Exit gate |
|---|---|---|---|
| IC0 | this plan, `docs/spec/issues-core.md` (after code) | Decide Q-I1..I3, amend the command bus spec kinds | Answers recorded |
| IC1 | `extension/connectors/issues/{types,normalize,scope,rate,index,github,gitlab}.mjs`, `extension/tests/fixtures/issues/{github,gitlab}/*`, `extension/tests/repo-issues-*.test.mjs` | Interface, GitHub and GitLab adapters, credential scope port, rate module, contract test | Fixture matrix of section 9 green for both, identical normalised output, `RepoCredentialScopeTests` ported and green, tripwire in place |
| IC2 | `extension/kb/migrations/<next>_issue_cache.sql`, `extension/kb/issue-cache.mjs`, `extension/kb/issue-sync.mjs` | Cache, FTS, sync state, resumable full and incremental sync on the persisted job runner, eviction | 10k and 50k synthetic: bounded memory, resumed sync after a kill, per-user isolation, FTS correct |
| IC3 | `extension/routes/repo-issues.mjs`, `extension/server/vault.mjs` key patterns, `schema/http` rows, `ALL_ENDPOINTS`, API bump | Routes of section 3 except gantt writes, connections, repo allowlist, 409 stale check, audit | Contract gates, auth and tenancy tests, no secret in any response or log, `make docs-check` |
| IC4 | `extension/kb/migrations/<next>_issue_schedule_keys.sql`, `extension/kb/issue-schedule.mjs`, `extension/routes/issue-schedule.mjs` | Section 5 overlay widening, `GET /kb/repo/gantt` window query | Old Swift body still accepted, string keys work, window query correct at 50k rows |
| IC5 | `extension/connectors/issues/{backlog,linear}.mjs`, fixtures | Read-only first, writes after review | Same fixture matrix, host validation, dispatcher shares the module (R1: one implementation of provider writes) |
| IC6 | `extension/llm_agent/`/bus kinds registry (owned by the command bus slices), phone executor | `issues.*` read kinds and `issue.*` T1 kinds in the core executor | Execution-time re-check tests, `needs_desktop_approval` text, parity with `PhoneIssuesTests` |
| I3 to I5 | `ui/screens/issues/**`, `providers-connect/*` (Phase 5) | Screens of section 10 | Phase 5 acceptance plus 10k list and 2 000 row Gantt measured in a real window |

Order: IC0, IC1, IC2, IC3, I3, IC4, I4, I5, IC5, IC6. Swift sources are not edited.

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Two implementations of provider writes (dispatcher and new adapters) drift | IC5 makes the dispatcher call the adapters; one module |
| R2 | A cache holding issue text is a second copy of private data | Per-user, redacted search text, bounded, purged on disconnect, never exported |
| R3 | Provider API facts (native date fields, rate-limit semantics, ETag cost) are unverified | Confirmed from recorded fixtures in IC1; any claim here marked unverified |
| R4 | Writes on a stale view overwrite someone else's edit | `baseUpdatedAt` check and 409 with the latest, never a blind PATCH |
| R5 | A phone-originated write runs after permissions changed | Execution-time re-check (spec section 1.4) |
| R6 | 50 000 row Gantt exceeds the WKWebView budget | Window query, typed arrays, arrow cap; the stretch target is measured in a real window before it is claimed |
| R7 | Moving tokens changes who can call the providers | Per-user scope port first, repo allowlist in the route layer |
| R8 | Hostile issue text (markdown, injection) | Safe renderer, no auto-loaded images, T1 for agent work that reads issues |

## 13. Questions for the user (recommendations)

1. **Q-I1 Token migration.** How do GitHub and GitLab tokens get from the Mac app into the core vault? (a) you paste them once into the Tauri Settings (write-only), (b) the Tauri host imports from `gh auth token` and `glab` where present, (c) a one-time "Export to core" button added to the Swift app (needs a feature-freeze exception). Recommend **(a) with (b) as a convenience**; reading the Swift Keychain items from another process is fragile and prompts.
2. **Q-I2 Gantt write-back.** When you drag a bar, write only our overlay, or also the provider's native due date where it exists (GitLab, Linear, Backlog; GitHub never)? Recommend **overlay only in v1**, native write-back later behind a per-repo switch, because a second writer to your team's tracker needs an explicit decision.
3. **Q-I3 Persistent cache.** OK to keep a per-user, bounded, rebuildable issue cache in our SQLite (needed for 10 000 issue repos, search and offline with stale markers), instead of the Phase 5 in-memory-only cache? Recommend **yes**, with purge on disconnect and an off switch per repo.
