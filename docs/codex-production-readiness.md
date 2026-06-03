# Codex Agent Brief — Production-Readiness Pass

> **Paste everything below this line into Codex (or any autonomous coding agent).** It is self-contained: the agent does not need to ask you anything to begin work.

---

## Repo

- **Path:** `/Users/dinesh.malla/Desktop/meet-notes`
- **Branches:** Work directly on `main` (this project uses a direct-to-main policy — there is no PR review). Commit per logical unit; push after each commit.
- **Push policy:** `git push origin main` after every commit. Use HEREDOC for multi-line commit messages.
- **Language split:**
  - `mac/` — Swift 5.9 + SwiftUI for macOS 14. Built with SwiftPM (`swift build -c release --package-path mac`).
  - `extension/` — Node 22 + better-sqlite3 ESM modules. Tests via `npm test` from inside `extension/`.

## Build + test commands

Run these from inside `extension/` for the server side:
```
npm test                  # Full node:test suite, 248 tests at session start
node --check kb/db.mjs    # Syntax check a single file
```

For the Mac app:
```
cd mac
swift build -c release    # Release build; emits .build/release/MeetNotesMac
bash Scripts/build.sh     # Produces MeetNotesMac.app bundle + vendors Sparkle
```

For an installed-bundle launch (used to manually verify):
```
pkill -f MeetNotesMac/Contents/MacOS 2>&1; sleep 1
/Users/dinesh.malla/Desktop/meet-notes/mac/MeetNotesMac.app/Contents/MacOS/MeetNotesMac >/dev/null 2>&1 &
```

## Architecture pointers

- **Server entry:** `extension/server.mjs`. Authentication via `server/auth.mjs`, KB routing via `kb/router.mjs`, AI/LLM routes via `server/ai-routes.mjs`.
- **Storage:** `kb/db.mjs` is the public façade — re-exports 8 sibling modules: `personas.mjs`, `plans.mjs`, `meetings.mjs`, `sources.mjs`, `user.mjs`, `reviews.mjs`, `feedback.mjs`, `outcomes.mjs`. `db.mjs` itself keeps the shared helpers + search + findContext + deleteUserCascade.
- **KB routes:** `kb/router.mjs` dispatches to `kb/routes/agent.mjs` / `planning.mjs` / `live.mjs` / `review.mjs`.
- **Mac shell:** `mac/Sources/MeetNotesMac/Views/AppShell.swift` (~430 LOC) owns global state. `ShellState` controls section routing. Library tree lives in `Views/Library/`, settings in `Views/Settings/`.
- **AutoCodeUpdateService** in `mac/Sources/MeetNotesMac/Services/` runs the hourly auto-task loop (Review Code / Doc / Conflicts / Regression).
- **Tests:** `mac/Tests/MeetNotesMacTests/` (35 files) and `extension/tests/` (31 files). Run them after every meaningful change.

Architecture doc: `docs/explanation/server-internals.md`.

---

## What "production-ready" already looks like

Confirm these are still healthy before/after your work. If you break one, you've regressed.

- 248/248 server tests pass on `main` at session start
- Mac release build is clean (no errors; the `ActorIsolatedCall` / `SendableClosureCaptures` warnings are pre-existing and acceptable)
- Auth: JWT + bcrypt + refresh rotation + JTI revocation + rate-limit on auth public routes
- AES-256-GCM per-user vault keys via HKDF; redact secrets in audit log
- SQLite WAL + checksum-verified migrations
- Graceful SIGTERM/SIGINT shutdown (see `server.mjs:549`)
- Sparkle auto-update wired (entitlements + appcast)
- CI exists (`.github/workflows/ci.yml`, `.github/workflows/docs.yml`, `.gitlab-ci.yml`)
- 7 operator runbooks under `docs/runbooks/`

---

## TODO list (in priority order — work top to bottom)

Each task is independent. Run tests + commit + push after each one.

### 1. Silent error paths

**Problem.** Mac client has ~197 `try?` sites and the server has ~57 naked `catch {}` blocks. Most are intentional graceful-degradation (a network blip shouldn't crash the UI), but a sample-sized review found at least three sites where silent failures hide bugs.

**Acceptance.** Find 5–10 high-impact sites where `try?` / `catch {}` swallows information that should reach the user or the log. Convert each to either:
- A structured `Logger.error(...)` call carrying the underlying message, OR
- A user-visible status surface (alert, status banner, settings row).

**Where to look first:**
- `mac/Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift` — registry IO and CLI subprocess paths
- `mac/Sources/MeetNotesMac/Services/ProjectStore.swift` — `try?` around bundle hydration
- `mac/Sources/MeetNotesMac/Views/AskAgentSheet.swift` — history-load fallback
- `extension/server/ai-routes.mjs` — best-effort `ingestGeneratedDoc` calls

**Don't change** `try?` in:
- Test files
- Best-effort cleanup in `defer` blocks
- File-system reveal helpers (it's OK if NSWorkspace.shared.activateFileViewerSelecting fails silently)

**Commit pattern:** one commit per file with the form `fix(<surface>): surface <X> error instead of swallowing`.

### 2. Plugin install sandbox audit

**Problem.** `extension/plugins/installer.mjs` does path-traversal checks and validates the manifest, but the plugin code itself runs in the same Node process as the server. There's no real sandbox.

**Acceptance.** Document the trust boundary in `docs/explanation/security-model.md` (search for "plugin"). State explicitly:
- What a malicious plugin can do (read env vars, fork processes, exfiltrate via outbound HTTP, touch the DB)
- What it cannot do (modify another tenant's user_id rows? Actually it can — confirm and document)
- What the install flow validates (manifest schema, path traversal, name regex)
- What we'd need for real isolation (worker_threads with locked vm.Module loader, or a separate Node process per plugin)

**Don't** actually build the isolation — just document the gap and tag the section `## Known limitations`.

### 3. Database backup CLI

**Problem.** Runbook `docs/runbooks/restore-from-backup.md` references a backup procedure but there's no `extension/scripts/backup.mjs` or equivalent. Users have to know `sqlite3 .backup` syntax by hand.

**Acceptance.** Create `extension/scripts/backup.mjs`:
- Takes `--db <path>` (default: `extension/kb/data.db` resolved from the standard config)
- Takes `--out <path>` (default: `<dbpath>.bak-<iso-timestamp>.db`)
- Uses better-sqlite3's `backup(destFile)` API (it handles WAL correctly)
- Refuses to overwrite an existing `--out` unless `--force` is passed
- Prints the resulting size + checksum to stdout

Update `docs/runbooks/restore-from-backup.md` to reference the new script. Add an entry to `package.json`'s `scripts` block: `"backup": "node scripts/backup.mjs"`.

Tests under `extension/tests/scripts-backup.test.mjs` covering: happy path produces non-empty file, refuses overwrite, accepts --force.

### 4. Mac `try?`-on-storage audit

**Problem.** Storage-layer Mac code (notes folder index, ChatSession persistence, project bundle hydration) uses `try?` extensively. A silent disk-full or permissions issue leaves the user wondering why their data didn't save.

**Acceptance.** In **one** representative file (`mac/Sources/MeetNotesMac/Services/Sessions/ChatSessionStore.swift` is a good candidate — verify the path), replace silent `try?` with a logged failure + a publish to a `@Published var lastIOError: String?`. Surface the error in the matching view (CodeAssistantPanel's chat session picker, for ChatSessionStore).

Add a single unit test under `mac/Tests/MeetNotesMacTests/` covering the publish on a write that throws.

### 5. Recovery test for "AppShell first-render after login"

**Problem.** Session ago we shipped a crash where AppShell injected ShellState only on the post-project subtree, breaking the StatusBar after login. We fixed it but added no regression test.

**Acceptance.** Add a Swift Testing assertion that AppShell exposes ShellState to its full subtree (the StatusBar in particular). The simplest test: instantiate AppShell with a mocked SessionStore that has a non-nil accessToken + a nil active project, render the body, verify it doesn't throw.

If the test infra makes that hard, document the manual repro in `docs/runbooks/` (file: `crash-on-login-shellstate.md`) so a future regressor finds it.

### 6. Mac client: split `CodeAssistantPanel.swift` (1568 LOC) via ViewModel

**Problem.** This file is too big to scan top-to-bottom and its `@State private` properties block file-extension splits. The audit flagged it; the fix needs a real ViewModel migration.

**Acceptance.** Lift the panel's state (history, draft, attachments, sessions, busy, error, pendingTool, recentIssues, etc.) into a new `@Observable @MainActor final class CodeAssistantViewModel`. The View becomes a thin shell that takes a `@Bindable` model. Keep the file size of CodeAssistantPanel itself under 600 LOC; the rest moves to:
- `CodeAssistantViewModel.swift` (state + send/dispatch logic)
- `CodeAssistantTranscript.swift` (the chat scroll view)
- `CodeAssistantInputBar.swift` (the toolbar)

Verify with `swift build -c release` + `bash Scripts/build.sh` + the manual smoke test (Cmd-Shift-A still opens AskAgentSheet, code-assist still streams).

**This is a bigger task — estimate 4–6 hours. Do it last.**

### 7. CI signal review

**Problem.** CI workflows exist but I haven't verified they actually run the full suite.

**Acceptance.** Read `.github/workflows/ci.yml` and `.gitlab-ci.yml`. Confirm both:
- Run `npm test` from `extension/` and fail on any test failure
- Build the Mac app at least at `--package-path mac` level (full `.app` bundle is harder in CI)
- Cache `node_modules` and SwiftPM artifacts

If anything is missing, add it. If a step is duplicating work between the two CIs, decide which one is canonical and shrink the other to a smoke build.

---

## Style + commit guidance

- **Commit messages:** imperative mood ("fix(mac): surface ProjectStore IO errors"). Use `feat(<scope>):`, `fix(<scope>):`, `chore(<scope>):`, `refactor(<scope>):`, `docs(<scope>):` prefixes. Multi-line bodies via HEREDOC.
- **Sign commits with:**
  ```
  Co-Authored-By: Codex <noreply@openai.com>
  ```
- **Run tests before every commit.** If they fail, fix or revert before pushing.
- **No new dependencies** without flagging in the commit body. better-sqlite3 stays the only native dep on the server side.
- **Don't reformat unrelated lines.** Surgical edits only.

## What NOT to touch

- `docs/superpowers/specs/` and `docs/superpowers/plans/` — historical records, append-only.
- `mac/MeetNotesMac.app/` — build output, not source.
- `extension/node_modules/`, `mac/.build/`.
- Migrations once applied — never edit `kb/migrations/*.sql` in-place (add a new numbered file instead).
- The persona / agent / ask-history schema — recently shipped, leave the contracts alone.

## When you finish

Run a final check:
```bash
cd extension && npm test                                                                   # expect: 248+ tests pass
cd ../mac && swift build -c release 2>&1 | grep -E "error:" | grep -v "Actor\|Sendable"   # expect: empty
```

Push the final commit. Reply with a summary: which items you completed, which you skipped and why, what you'd recommend next. Don't claim success on a task whose tests don't pass.

---

*This brief was generated 2026-05-26 by an audit pass over a clean session. The codebase is in good shape; this list closes the remaining gaps to "ship to real users" level.*
