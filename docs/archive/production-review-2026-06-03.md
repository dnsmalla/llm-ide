# llm-ide Production-Readiness Review — 2026-06-03

Fresh 3-pass review (services, persistence/security, UI/quality). Codebase is high quality;
findings below are the real gaps. Graph/memory engine is shared via GraphKit (reviewed separately).

## Data integrity (fix first — low risk)

- [x] **DB1 — SQLite has no `busy_timeout`.** `MeetingIndex` opens WAL but no busy_timeout; two
  connections (AppEnvironment/FolderIndexer + AutoCodeUpdateService) → a concurrent write throws
  SQLITE_BUSY immediately and `fullScan` aborts mid-loop → index diverges. Add `PRAGMA busy_timeout=5000`.
- [x] **DB2 — `FolderIndexer.fullScan` is non-atomic.** Each upsert/delete is its own autocommit txn;
  a crash/throw/BUSY mid-scan leaves a partial index (ghost/missing rows) + N fsyncs. Wrap the whole
  scan+reap in one transaction with rollback on throw.

## Summarization pipeline (behavior-sensitive — confirm before changing)

- [ ] **S1 — Fallback summary masks API failure as success** (MeetingSummarizationService): on error it
  writes a fallback summary with `model: "unavailable"` and returns it as if real; no caller checks. Surface failure.
- [ ] **S2 — Summary lost on quit during the 5-min window**: detached summarize task killed on quit, no
  "pending" marker, no relaunch recovery. Persist a pending marker + re-drive at launch (like PartialRecovery).
- [ ] **S3 — Double summarization on `stopAndIngest`**: both local MeetingSummarizationService AND server
  ingestMeeting summarize the same meeting; index notification races. Pick one source of truth.

## Meeting capture (behavior-sensitive — confirm)

- [x] **CAP1 — Auto-capture stops on app focus-switch** (AutoCaptureService.handleDeactivation): switching
  to a browser/Slack mid-call stops capture, fragments the meeting into multiple files, and drops captions
  spoken while away. Gate stop on the meeting app terminating, not losing frontmost focus.

## AutoCode (behavior-sensitive — confirm)

- [x] **AC1 — CLI runs against a dirty/unknown repo state**: no `git status --porcelain` clean check or
  base-branch verification; can commit the user's unrelated WIP. Consecutive issues share clone state.
- [ ] **AC2 — `parseDiffFiles` re-writes new files from `+` diff lines** (lossy): drops content lines not
  starting with `+`, fragile `\n---` split. CLI already wrote the files — just `git add -A`, don't reconstruct.
- [ ] **AC3 — `fetchAllIssues` pagination**: breaks only on empty page (up to 1000 issues/run), comment says
  "<10"; no 403/429 backoff. Break on `batch.count < pageSize` + rate-limit handling.

## UI / quality (low risk)

- [x] **UI1 — ImageDetailView loads NSImage(contentsOf:) in body getter** (main-thread, re-runs each render;
  bad on iCloud/Dropbox folders). Load once into @State via `.task(id:)`.
- [x] **UI2 — Backend port 3456 hardcoded in 7 sites.** One constant.
- [ ] **UI3 — SRP: CodeAssistantPanel (1567 lines), UAGraphView (1389).** Extract opportunistically.

## Verified GOOD (do not re-litigate)

Tokens in Keychain (ThisDeviceOnly) not UserDefaults; no token logging (redacted); no /bin/sh -c (argv arrays);
nonce-fenced untrusted issue prompts; backend loopback-only + remote-exposure guard; PathValidator blocks ../~/abs;
atomic writes + PID-liveness recovery; subprocess double-resume guarded; no print()/try!/TODO; exemplary ViewModels
(defer isLoading=false, surfaced errors). Entitlements: sandbox off + library-validation off (deliberate, revisit pre-ship).

---

## 2026-06-04 — performance + central-skills review

### Performance (fixed)

- [x] **P2 — `FolderIndexer.fullScan` re-read/re-parsed every `.md` on every event.** Now skips
  unchanged files by comparing mtime+size against the indexed row (schema already stored them).
  Turns an O(library) re-parse into O(changed). Biggest win.
- [x] **P1a — double full-scan per fs event.** `AppEnvironment.startWatching` ran `fullScan()` AND
  the AppShell `onChange` closure ran it again. Removed the duplicate in AppShell.
- [x] **P1b — no debounce on the watcher.** Live caption writes fired a scan per append. Added a
  0.6s trailing debounce in `FolderIndexer.startWatching` so bursts collapse to one scan.

Net: a live meeting previously triggered a full-library re-parse storm on the main path; now an
unchanged library costs ~one cheap stat-only scan per debounced burst.

Remaining perf (not done, lower priority): P3 (`.meetingIndexChanged` does 2 folder enumerations +
JSON rewrites on main — largely mitigated by P1/P2 cutting frequency), P4 (caption AX snapshot on
@MainActor — move off-main + O(1) dedup), P5 (`LibraryViewModel.groupedRows` recomputed per render),
P6 (plugin skills re-parsed per `/code-assist` request — cache by dir+mtime), P7 (highlight.js from CDN).

### Settings (fixed)

- [x] `Config.swift` default server URL now interpolates `BackendManager.defaultBackendPort`
  (was a second hardcoded `3456`).
- [x] `route.mjs` stale comment ("default of 5" → DEFAULT_MAX_ITERATIONS 10).

Remaining small config (not done): lift CLI/agent timeouts + summary maxTokens to named
constants/env; user-facing model picker for server summarization.

### Central skills — finding

llm-ide loads skills only server-side (`extension/llm_agent/runtime/skill-loader.mjs` →
`buildSystemPrompt`); the Swift mac app has NO SkillRunner. Its skills are agent-loop tools:
`search-kb` is a `.md`+handler pair (read), the 3 GitLab ones are prompt-only write skills. There is
no current shared content to pull from the central repo's `runtime/` family (that's InfiniteBrain's
graph prompt-skills, irrelevant to llm-ide). To consume central later: a sync of a central
`agent-tools/` family into a new gitignored `external/skills/` added as a third `loadSkills` source —
safe for write/prompt-only skills, but read skills must keep their local handler. Not worth doing
until there's actually shared content.
