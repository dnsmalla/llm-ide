# Changelog

All notable changes to LLM-IDE are tracked here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Decisions role + Jev provider + `decide` agent tool (server API v73).** The new `decide` tool makes
  calibrated yes/no, pick-one or score decisions about material the agent already has, returning
  probabilities and confidence (`{ engine, model, answers, fallback? }`, one answer shape whichever engine
  answered). It runs on Jev (jev-ai.pro, vault `jev.apiKey`) when the `decisions` tier role points at a Jev
  tier, otherwise on the role's LLM; a transient Jev failure or an over-size request falls back to the LLM
  and says so. Jev is decision-only: every chat/completion path refuses it, and a Jev tier on any other
  role reports `decision_only` and keeps that role's default. Tool schemas may now declare `type: object`.

- **iPhone app redesign + much more from the Mac.** Chat is the first screen; project work lives in a
  Project tab (Explorer, Auto Tasks, Loop, Docs, Files, Git, Issues, Self-Heal) with a project switcher;
  a new Activity tab mirrors the bell; Settings has Usage & limits. The phone can run Doc Gen / Visual
  (saved to `llm-doc/generated/`), browse `llm-doc/`, read project files and git status/diffs, read issues,
  review Self-Heal proposals, and answer tool/edit permission prompts.
- **Settings → Mobile Control → Phone access.** Every capability that edits files, posts as you or
  approves a tool (apply/discard Self-Heal fixes, comment on issues, approve tool requests) is a Mac-side
  switch, **off by default**; read-only/reversible ones (files, git, issues, project switch) default on.
  The Mac re-checks the switch on every request and tells the phone when one changes.
- Wire protocol: `Connected` now carries `protocolVersion` and `capabilities`, and `mac_capabilities` is
  pushed when a switch changes, so a phone only shows what its Mac serves. New message families are
  additive; an older Mac or phone ignores them.
- Phone reads are bounded and safe by construction: paths resolve inside the project (symlink targets
  are re-checked), dotfiles/secret names/PEM keys are never shown, git runs with literal pathspecs and no
  textconv/fsmonitor, and all redaction is line-bounded (`PhoneRedaction`).

### Fixed

- **Plugin subagent tool grants now work.** A subagent's `allowed_tools` (e.g. `[search-kb]`) never
  actually reached its loop — every granted tool answered "Unknown tool". Granted tools are now callable;
  `decide` can be granted the same way (`allowed_tools: [decide]`).

### Changed

- **Settings: tiers replace the default provider (Mac).** Model Providers now only connects providers
  (keys, Check CLI, readiness); the ◉ default, the Default model and the Planning / Coding / Reviewing /
  Documents model pickers are gone, and so is Custom Providers' "Code Assistant provider" picker. Tier
  Routing is now **Tiers & Roles**: **Standard** is required and is the default for new chats (choosing a
  custom provider as Standard is how chats use it, on Standard's model) and for Loop, Auto Tasks and Quick
  chat when left unset — a custom Standard those roles can't run (e.g. Auto Tasks need a local CLI) is
  skipped, and Settings names what runs instead. The shared Custom (OpenAI-compatible) endpoint stays
  selectable as Standard; it runs only on the Mac, so server roles on its tier keep their built-in default.
  The four chat modes are roles that pick a tier, used only in chats on that tier's provider. Server roles
  left unset keep their built-in default. Existing settings migrate once at launch with no change in what
  chats or Mac roles run: Standard is built from the old default provider + model, and a composer already
  on a custom provider stays on it (Settings shows "New chats still use …" until you choose Standard).
  One exception: if Standard was already set to a custom provider AND the composer was already on that
  same provider, that Standard is in effect, so Loop, Quick chat and the phone now follow it too.
  A model picked in the chat composer no longer changes the default: it overrides Standard in the composer
  until Standard or a chat role changes, and the phone and quick chat follow the Quick chat role (or Standard) instead of the last composer pick.
- Server `runClaude` now honours an explicit `custom:<id>` provider for EVERY caller, not only tier
  routes: a composer chat on a custom provider whose model id looks like Claude (`claude-*`) now runs on
  that custom provider instead of being re-derived to Anthropic from the model id.
- Tier routing (API v67): a tier on OpenAI/Google without an API key is unusable and keeps the role on
  its default (it used to fall back to the codex/gemini CLI); `GET /kb/routing-tiers` reports per-tier
  usability; the Mac app routes nothing on a server older than v67.
- Tier routing (API v68): subscription providers work as tiers. A tier on OpenAI/Google without an API
  key runs on the logged-in `codex`/`gemini` CLI when it is installed — with the routed model passed
  (`-m`) and, when no project workspace is involved, in an empty private temp directory (codex
  read-only) instead of the server's own directory. `GET /kb/routing-tiers` adds `via: key | cli` per
  usable tier, shown next to each tier in Settings → Tier Routing.
- Tier routing (API v69): a subscription tier must pass a CLI health check (`codex --version` /
  `gemini --version`) before it is used, and a routed call whose provider fails (CLI broken or logged
  out, auth/network failure) is retried once on the role's default and that route is skipped for ~10
  minutes; the Mac's quick chat, phone chat and Loop replay likewise retry once without the route.
  Keyless codex/gemini routes are never used for Internal or Pipeline roles (untrusted email/connector
  text; plan/code output goes to issue trackers). CLI error messages name the right login command
  (`codex login`, `gemini`) and no longer show stack traces or file paths. Usage rows recorded as
  `cli-default` (the CLI ran its own default model) do not count against same-provider quota chains.
- Tier routing (API v70): the streaming Code Assistant now tells the Mac when a routed provider cannot
  run, so the quick chat, menu bar, sheet and phone chats retry once on their default (only if nothing
  had started yet). A routed plugin subagent inside the Code Assistant now gets the same one-time
  fallback. A temporary provider error (rate limit, 5xx, network) skips the route for about a minute,
  not ten; failures are tracked per model, so one bad model id no longer disables the provider's other
  tiers; a usage-limit pause on a routed provider uses the default. Summaries and email classification
  report the model that actually answered.
- Tier routing: a routed chat whose provider's API key was revoked, or whose custom provider was
  removed or disabled since the Mac last checked, now retries once on its default too; the
  "thinking…" status line no longer blocks that retry. Settings says a failed route is "retried
  automatically shortly" instead of promising ten minutes.
- Loop reliability (Mac app). Loop agent runs are headless and confined to the
  run's git root; a stage whose agent call errored ends the run `error` unless
  that stage later ran cleanly (a passing verify stage no longer launders it);
  the protected-path guard also checks edits on the throw path; shell stages run
  in their own process group with capped capture; structured per-runner failure
  extraction and a per-stage repair ledger feed the next repair; a flake gate,
  stall/no-progress stops and run budgets bound every run. Loops run on their own
  lane (no longer blocking Auto Tasks) with a crash-safe run journal. New in-app
  **artifact check** stage for the Plan and Doc Optimization loops (follows the
  generate stages' editable Outputs), versioned default stages with "update
  available", and the Loop page now shows and stops runs started from the phone
  or the schedule; a phone Stop also cancels a start still pending.
- **Downgrade note:** `system/loop.json` files written by this build may contain
  `kind: "artifactCheck"` stages and `schemaVersion: 2`. Builds older than this
  one cannot decode them and quarantine the file — upgrade every machine that
  shares a project together.

### Added

- Auto Task per-task settings and prompt templates. Each prompt-driven task's
  detail pane now has a **Settings** card (input path, output path, agent skill
  — paths picked from the project's Library folders and stored project-relative)
  and a **Template** card that selects, edits, renames, duplicates, and deletes
  reusable prompts stored as markdown in `<project>/templates/auto_task/`. An
  **Effective prompt** card shows exactly what the run will send. Cron and log
  sections are unchanged. Templates support `{{INPUT_PATH}}`, `{{OUTPUT_PATH}}`,
  and `{{PROJECT_ROOT}}`. An unconfigured task composes to exactly its previous
  prompt, so the feature is inert until used.
- iPhone control of the above: the Auto Tasks screen's per-task ⚙ opens the same
  settings, and templates can be created, edited, renamed, and deleted from the
  phone. New `auto_task_setup_*` / `auto_task_config_set` /
  `auto_task_template_*` wire messages; the Mac stays the source of truth and
  answers every mutation with a fresh snapshot.
- SCIP code-graph ingestion: `POST /kb/ingest-scip` consumes a Sourcegraph `.scip`
  index (via the local `scip` CLI) into per-user symbol FTS rows + a node/edge graph,
  giving code-sync compiler-derived relationship grounding. Server API version 21.

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
