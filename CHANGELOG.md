# Changelog

All notable changes to LLM IDE are tracked here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] - 2026-07-02

### Added

- Visual section in the Mac app sidebar (Data group): three-panel layout
  with the library folder tree (Data + Code), an image viewer with a
  sibling-thumbnail strip (thumbnails decoded off the main thread,
  downsampled via ImageIO), and the shared Code Assistant chat with the
  selected file auto-attached. User-hideable, deep-linkable
  (`?to=visual`), documented in the in-app Help guide.
- Plugin system v1: skills, slash commands, and named subagents.
  Server-side install/uninstall via `POST /auth/me/plugins/install` (zip
  upload) and `DELETE /auth/me/plugins/uninstall/<name>`. Mac UI exposes
  Install-from-zip + per-plugin Uninstall.
- Per-user encrypted credential vault keys (`github.token`, `slack.webhookUrl`,
  etc.) via `POST /auth/me/secrets`. Vault errors return a sanitised
  `publicMessage` to clients.
- `/generate-docx` produces real Word documents via the `docx` package.
  Previously returned a placeholder string with Word's MIME type.
- Generated notes/docs ingested into the KB as `kind: 'doc'` so future
  searches surface them. Per-user ref prefix (`u:<userId>:`) keeps the
  global UNIQUE constraint tenancy-safe.
- Graphify memory inlined into the in-app agent's system prompt when a
  user has registered the corresponding repo path. Allow-list gated
  against `userRepoAllowlist`.
- Search-tenancy enforcement: hydrates plans/tasks/outcomes through
  their own user-scoped tables (was a single meetingMap that dropped
  plan/task/outcome kinds entirely).
- Per-user SSE stream cap (4) on `/kb/live/:id/stream` to bound listener
  + idle-timer slots.
- Rate limit profiles, per-user JTI revocation, refresh-token rotation,
  audit log.
- Opt-in per-route handler timeout budgets for bounded `/kb` POST routes —
  a stuck handler now returns a clean 504 envelope instead of holding its
  slot until the 300 s socket cap.
- HTTP-level test coverage for `/auth/*` routes: register/login,
  refresh-token rotation-on-use, logout JTI + refresh revocation, password
  change, vault secret roundtrip, prefs allow-list, per-IP register rate
  limit.
- Doc→code mention links: backticked paths/symbols in project docs now resolve
  against the code graph's symbol inventory (graph-kit 1.6.0 `DocCodeLinker`) —
  `graph-notes.md` carries real cross-references instead of an always-empty
  section, plus a "Dependency hubs" summary of the most-imported code files.
- Doc routing: `graph-only: true` frontmatter and meeting-style chunks are kept
  in the interactive code graph but excluded from the agent's memory artifact;
  `related-modules:` frontmatter renders a "Doc ↔ module affinity" section so
  the agent knows which docs govern which code.
- `search-kb` is now a first-class Code Assistant tool (previously
  implemented and tested, but never wired into the global agent) — the agent
  can search meetings/decisions/action items directly instead of a costlier
  `ask-internal` round-trip; the base role prompt now states a clear
  preference for it on overlapping trigger phrasing.
- IDF-weighted chat-memory ranking: a query token carried by few stored facts
  now outweighs one carried by most, instead of raw match-count scoring.
- Write-time memory supersede: the fact extractor can identify an outdated
  stored fact (e.g. an npm → pnpm switch) and retire it instead of letting
  both accumulate until FIFO eviction — validated against only the facts the
  model actually saw in its prompt, so it can't invent a removal.

### Changed

- graph-kit bumped to 1.6.0: re-export import edges (including multi-line and
  `export type` re-exports), fence-aware doc parsing (headings/tags/wikilinks
  no longer misread fenced code), multi-word-only title matching and generic-
  tag noise cuts in the doc graph, `graph-only`/`related-modules` routing
  metadata, and the new `DocCodeLinker` API.
- `AutoCodeUpdateService` refactored to use `RepoBackend` so GitHub repos
  participate in the hourly auto-issue → branch → PR flow. GitLab default
  page size set to `per_page=100` to avoid premature pagination cutoff.
- `withTimeout` in the extension's `authFetch` no longer applies the 15s
  default when the caller has supplied its own `AbortSignal`. Long-running
  endpoints (`/generate-plan`, `/kb/connect-git`, SSE streams) keep their
  caller-provided deadlines.
- Search `kind` validation now includes `'doc'`. Unknown kinds fall back
  to no-filter (back-compat) but `'doc'` filters as expected.
- `/health` response trimmed to `{status, apiVersion, uptimeSec, checks}`.
  Verbose fields (`pid`, `env`, `schema`, `endpoints`) removed — operators
  use authenticated `/metrics` for that.
- `SessionStore` annotated `@MainActor` to eliminate torn-read races
  between concurrent token reads and `adopt(session:)`.
- `DeepLinkRouter.pendingTab` is now read-only; callers ack via
  `pendingEvent = nil`. Prevents silent session clobbering.

### Fixed

- Code Assistant no longer collapses every backend failure into the
  generic "The assistant is temporarily unavailable." A server-sent SSE
  `{type:"error"}` event now surfaces its real (already-redacted) reason:
  it maps to a new `APIError.agent` case instead of `.http`, so
  `codeAssistRoundTrip` no longer mistakes it for a transport failure and
  retries on the buffered endpoint (which re-ran the same failing call and
  replaced the reason with the 502 envelope). E.g. an expired Claude CLI
  login now shows "Claude error: …" rather than a dead end.
- Code Assistant prompt-history recall (↑ / ↓) walks through *all* prior
  prompts again. The composer is now backed by an `NSTextView`
  (`HistoryTextEditor`) that intercepts the arrows in `keyDown`; SwiftUI's
  `TextEditor` swallowed them for caret movement once the field had text,
  capping recall at a single prompt. The placeholder is also kept in the
  view tree (opacity toggle) instead of `if draft.isEmpty`, which had
  rebuilt the editor subtree on first recall and dropped first-responder.
- Chat sessions flush synchronously before switching / starting a new
  chat, so the last reply is no longer lost — the `.onChange(of: history)`
  persist is deferred and could miss the final turn on same-runloop
  navigation.
- macOS GUI-launched backend prepends the standard CLI dirs
  (`~/.local/bin`, Homebrew, …) to `PATH`, so the spawned Node server can
  resolve `claude` / `git` / `codex`. Finder/launchd hand the app a
  minimal `PATH` that omits them, which made every CLI-backed AI call fail
  with `ENOENT`.
- `readBody` no longer calls `req.destroy()` before writing the 413
  envelope; clients now receive proper "Request body too large" instead
  of hanging after `100 Continue`.
- `FolderIndexer.fullScan` serialised via `NSLock` to prevent reap-step
  deleting rows another in-flight scan just inserted.
- `MeetingFileStore.Handle` gains an idempotent `close()` + `deinit`
  fallback to plug FD leaks on partial-recovery throws.
- SSE counter rollback math: no longer permanently consumes a slot on
  initial-write failure.
- `unhandledRejection` no longer calls `process.exit(1)` — logs and
  continues. Eliminates a DoS vector from any dangling Promise.
- `authFetch` `_refreshPromise` cleared via `queueMicrotask` to close a
  microtask race where a parallel caller saw `null` and proceeded with
  a stale token.
- `setSession` / `clearSession` now reset `_refreshFailedAt` so a post-
  login 401 within 30s isn't gated by a pre-login refresh failure.
- Shutdown cleanup failures (agent stop, rate-limit bucket save) are now
  logged instead of silently swallowed.
- Plugin `agents/*.md` discovery, validation, sandboxed tool whitelist
  (default empty), and `maxIterations` server-side cap of 5.
- Orphan entries in `plugin-state.json` are pruned automatically on
  plugin reload — removed plugins no longer leave dead enable rows.
- Slack webhook URL validated against `hooks.slack.com` host (SSRF gate).
- `project_memory` log line now includes the actual removed-fact text
  (`removedFacts`) alongside a count, not just a bare number — a capture that
  supersedes a stored fact is now forensically debuggable.

### Security

- All vault decryption errors mapped to a generic `VaultError` envelope
  so internal cipher state (blob length, GCM auth-tag mismatch, key
  version) never reaches the client.
- Extension manifest `host_permissions` and `content_scripts.matches`
  narrowed to actual meeting URL prefixes (`/wc/*`, `/j/*`, `/_*`,
  `/v2/*`, `/l/*`). `web_accessible_resources` emptied. CSP `connect-src`
  pinned to port 3456 in production builds.
- Refresh token rotation on use: replay of a previously-rotated token
  returns 401 "Refresh token revoked".
- Plugin install zip pipeline: path-traversal entries rejected
  pre-extraction; staging dir outside plugin root; atomic rename only
  after manifest re-validation; rollback to backup on rename failure.
- Backup SQL (`VACUUM INTO`) now binds the target path as a parameter
  instead of interpolating an escaped string (admin endpoint +
  auto-backup).
- Shared `AuthRedirectGuard` replaces the duplicated GitHub/GitLab
  redirect delegates; both clients strip credential headers on
  cross-host redirects through one audited code path.

## How to read this file

Until we cut tagged releases, every commit on `main` is implicitly part of
`Unreleased`. On the first tagged release we'll cut a `[1.0.0]` heading and
start dating subsequent entries.
