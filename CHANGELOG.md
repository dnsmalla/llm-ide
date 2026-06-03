# Changelog

All notable changes to Meet Notes are tracked here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project does not
yet have published releases so dates are commit-day-of-merge.

## [Unreleased]

### Added

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

### Changed

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
- Plugin `agents/*.md` discovery, validation, sandboxed tool whitelist
  (default empty), and `maxIterations` server-side cap of 5.
- Orphan entries in `plugin-state.json` are pruned automatically on
  plugin reload — removed plugins no longer leave dead enable rows.
- Slack webhook URL validated against `hooks.slack.com` host (SSRF gate).

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

## How to read this file

Until we cut tagged releases, every commit on `main` is implicitly part of
`Unreleased`. On the first tagged release we'll cut a `[1.0.0]` heading and
start dating subsequent entries.
