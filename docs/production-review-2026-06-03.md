# meet-notes Production-Readiness Review — 2026-06-03

Fresh 3-pass review (services, persistence/security, UI/quality). Codebase is high quality;
findings below are the real gaps. Graph/memory engine is shared via GraphKit (reviewed separately).

## Data integrity (fix first — low risk)
- [ ] **DB1 — SQLite has no `busy_timeout`.** `MeetingIndex` opens WAL but no busy_timeout; two
  connections (AppEnvironment/FolderIndexer + AutoCodeUpdateService) → a concurrent write throws
  SQLITE_BUSY immediately and `fullScan` aborts mid-loop → index diverges. Add `PRAGMA busy_timeout=5000`.
- [ ] **DB2 — `FolderIndexer.fullScan` is non-atomic.** Each upsert/delete is its own autocommit txn;
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
- [ ] **CAP1 — Auto-capture stops on app focus-switch** (AutoCaptureService.handleDeactivation): switching
  to a browser/Slack mid-call stops capture, fragments the meeting into multiple files, and drops captions
  spoken while away. Gate stop on the meeting app terminating, not losing frontmost focus.

## AutoCode (behavior-sensitive — confirm)
- [ ] **AC1 — CLI runs against a dirty/unknown repo state**: no `git status --porcelain` clean check or
  base-branch verification; can commit the user's unrelated WIP. Consecutive issues share clone state.
- [ ] **AC2 — `parseDiffFiles` re-writes new files from `+` diff lines** (lossy): drops content lines not
  starting with `+`, fragile `\n--- ` split. CLI already wrote the files — just `git add -A`, don't reconstruct.
- [ ] **AC3 — `fetchAllIssues` pagination**: breaks only on empty page (up to 1000 issues/run), comment says
  "<10"; no 403/429 backoff. Break on `batch.count < pageSize` + rate-limit handling.

## UI / quality (low risk)
- [ ] **UI1 — ImageDetailView loads NSImage(contentsOf:) in body getter** (main-thread, re-runs each render;
  bad on iCloud/Dropbox folders). Load once into @State via `.task(id:)`.
- [ ] **UI2 — Backend port 3456 hardcoded in 7 sites.** One constant.
- [ ] **UI3 — SRP: CodeAssistantPanel (1567 lines), UAGraphView (1389).** Extract opportunistically.

## Verified GOOD (do not re-litigate)
Tokens in Keychain (ThisDeviceOnly) not UserDefaults; no token logging (redacted); no /bin/sh -c (argv arrays);
nonce-fenced untrusted issue prompts; backend loopback-only + remote-exposure guard; PathValidator blocks ../~/abs;
atomic writes + PID-liveness recovery; subprocess double-resume guarded; no print()/try!/TODO; exemplary ViewModels
(defer isLoading=false, surfaced errors). Entitlements: sandbox off + library-validation off (deliberate, revisit pre-ship).
