# Allow-List Hardening — Make the Hard-Lock Real — Design

Date: 2026-07-03
Status: **Designed** (awaiting implementation plan)
Branch: `feat/allowlist-hardening` (based on `fix/github-pr-secret-patterns`, so the final merge folds both)

## Problem

The per-provider repo-operation allow-list (spec `2026-07-03-repo-operation-allowlist-design.md`, merged in `71cd91d`) promises a **hard lock**: an unchecked operation must not run — via automation *or* the matching manual button. A round-2 audit found the guarantee does not hold across the app: enforcement is scattered at individual button `.disabled` calls, so every write path that does not go through a specifically-gated button is unguarded. Confirmed ungated write surfaces (zero `isAllowed` references):

- **Source Control panel** — Push / Sync / Create-Branch / Publish (`SourceControlView.swift`, `SourceControlService.swift`), a primary always-visible surface.
- **Kanban drag-to-move** (`RepoKanbanPanel.swift:247`) — `client.updateIssue` on drop rewrites labels and, into the Closed column, closes the issue. The view injects no `config` at all.
- **Report Fault → "Also file as issue"** (`CodeAssistantPanel.swift:461`, `fileFaultAsIssue`).
- **Issue-detail sidebar "Status → Edit"** menu (`RepoIssueDetailSheet.swift:291`) — bypasses the `.merge` gate the header Close button enforces.
- **Automation post-commit comment** (`AutoCodeUpdateService.swift:442`, `createNote`) — `commentIssue` never checked.
- **CodeWorkflowService** internal steps (`createBranch`/`commitChanges`/`pushAndCreateMR`/`closeIssueIfNeeded`, and "Retry PR/MR only") — no internal checks; `QuickFixSheet` "Run" gates only `.push`+`.createPR` though it runs branch/commit/comment/close.
- **Issue metadata edits** (assignee/label/milestone/weight/due) — ungated (no op existed).

Root cause: UI-only enforcement with no defense-in-depth. The fix is a single write-layer chokepoint plus gating the one non-`RepoBackend` write path (local git).

## Decisions (locked with the user)

1. **Enforcement** — Chokepoint at the data layer, keeping the UI `.disabled` calls as UX polish. A disallowed op is blocked no matter which path reaches it.
2. **Blocked-write behavior** — Throw a clear error (`RepoBackendError.operationNotAllowed`), surfaced through the existing error UI. Fail loud, no silent no-op.
3. **`.merge` semantics** — Rename `.merge` → `.closeIssue` ("Close / reopen issue"). No PR-merge code path exists in the app, so the op is made honest (YAGNI; add `.mergePR` if a real merge feature is ever built).
4. **Metadata** — Add an `.editIssue` op gating issue metadata edits AND kanban drag-relabel (both are `updateIssue` writes without a `stateChange`).

## Architecture

Two write layers get a guard:

```
   Manual UI (buttons/menus/drag)  ─┐
   AutoCodeUpdateService           ─┤──▶  AllowlistedRepoBackend (decorator)
   CodeWorkflowService             ─┘       reads → pass through
                                            writes → isAllowed(op, kind)?
                                                       yes → delegate to real client
                                                       no  → throw operationNotAllowed
   SourceControlView (local git)   ──────▶  SourceControlService
                                            push/branch/sync/publish → isAllowed? else throw
```

`AllowlistedRepoBackend` conforms to `RepoBackend`, wraps a concrete `GitLabClient`/`GitHubClient`, and holds `AppConfig` + the wrapped client's `kind`. Every consumer receives the *guarded* backend via a single factory, so automation and every manual path are covered without per-site duplication.

## Components

### 1. `RepoOperation` changes (`Models/RepoOperation.swift`)
- Rename `case merge` → `case closeIssue`; label "Close / reopen issue".
- Add `case editIssue`; label "Edit issue (labels, assignee, milestone…)".
- `groups`: `Issues → [.createIssue, .editIssue, .commentIssue, .closeIssue]`, `PR / MR → [.createPR]`, plus unchanged Sync/Code-writes groups.
- `AppConfig` decode (`Config.swift`): when reading a stored rawValue, map legacy `"merge"` → `.closeIssue` (so an existing custom set that disabled merge keeps close/reopen disabled). Unknown strings still drop (tolerant decode unchanged).

### 2. Error type (`Services/Repo/RepoBackend.swift`)
```swift
enum RepoBackendError: Error, LocalizedError {
    case operationNotAllowed(RepoOperation, provider: RepoBackendKind)
    var errorDescription: String? {
        switch self {
        case let .operationNotAllowed(op, provider):
            return "\(op.label) is disabled for \(provider.displayName). Enable it in Settings → \(provider.displayName) → Automation & Actions."
        }
    }
}
```
(If a `RepoBackendError`/equivalent already exists, extend it rather than add a second type.)

### 3. `AllowlistedRepoBackend` (`Services/Repo/AllowlistedRepoBackend.swift`, new)
- `struct`/`final class` conforming to `RepoBackend`, `@MainActor`.
- Holds `wrapped: RepoBackend`, `config: AppConfig`, `kind: RepoBackendKind` (= `wrapped.kind`).
- Capability flags + all read methods delegate verbatim.
- Each write guards then delegates:
  - `createIssue` → `.createIssue`
  - `createNote` → `.commentIssue`
  - `createBranch` → `.createBranch`
  - `createMergeRequest` → `.createPR`
  - `updateIssue(payload)` → `payload.stateChange != nil ? .closeIssue : .editIssue`
  - Guard helper: `try require(_ op)` → `guard config.isAllowed(op, provider: kind) else { throw RepoBackendError.operationNotAllowed(op, provider: kind) }`.

### 4. Factory + injection (`Services/Repo/RepoBackendFactory.swift`, new)
- `static func guarded(_ client: RepoBackend, config: AppConfig) -> RepoBackend` → returns `AllowlistedRepoBackend(wrapping: client, config: config)`.
- Route all backend construction/resolution through it: `CodeWorkflowTarget.resolveActive`, `AutoCodeUpdateService` resolved client, `CodeAssistantPanel.swift:1846`, sheets/panels handed a `client` (RepoIssueDetailSheet, RepoIssuesView, RepoKanbanPanel), `GanttContainerView` (read-only — harmless to wrap). `LlmIdeMacApp.swift:93` constructs the base clients; wrap at the point each is handed to a consumer.

### 5. `SourceControlService` gating (`Services/SourceControlService.swift`)
- Inject `config: AppConfig` and the active repo's `RepoBackendKind` (derive from the linked project/repo the SCM panel operates on).
- Guard `push`→`.push`, `createBranch`→`.createBranch`, `publish`(push)→`.push`, `sync`(pull)→`.sync`, throwing `RepoBackendError.operationNotAllowed`. Local-only reads (status/diff/stage) untouched.

### 6. UI (`Views/…`)
- Keep every existing `.disabled` gate.
- Add `.disabled` (+ help tooltip) to discrete missed buttons: SourceControlView Push/Sync/Create-Branch/Publish; RepoIssueDetailSheet sidebar Status "Edit"; QuickFix "Run" widened to require all ops it performs (`.createBranch && .autoCommit && .push && .createPR && .commentIssue && .closeIssue` — or the subset `runEndToEnd` actually invokes); "Retry PR/MR only".
- Non-button paths (kanban drag): rely on the chokepoint throw; catch and surface `error.localizedDescription` via the existing error banner/alert. Inject `config` into `RepoKanbanPanel` only if it needs to show a pre-emptive message; otherwise the caught throw suffices.
- Update the checklist copy for `.closeIssue`/`.editIssue`.

## Error handling
Every write site already has a `do/catch` that surfaces backend errors (that's how network failures show today). `RepoBackendError.operationNotAllowed` flows through the same path — its `errorDescription` names the op + provider + where to enable it. No new error UI needed. Verify each of the newly-covered call sites actually surfaces (not swallows) the throw; where one uses `try?` and drops the error (e.g. `CodeWorkflowService.swift:671` `createNote` via `try?`), the operation is simply skipped when disallowed, which is acceptable for a fire-and-forget comment — document that.

## Testing
- `AllowlistedRepoBackend`: for each write, throws `operationNotAllowed` when the op is disallowed and delegates (via a mock `RepoBackend`) when allowed; `updateIssue` routes to `.closeIssue` vs `.editIssue` by payload; reads always pass through. (There is an existing mock `RepoBackend` in the test suite — reuse it.)
- `Config` decode: legacy `"merge"` → `.closeIssue`; `.editIssue` present in the default all-enabled set.
- `SourceControlService`: push/branch/sync throw when disallowed, proceed when allowed (inject a config with a custom set).
- Full mac suite stays green.

## Migration / compatibility
The allow-list shipped <1 day ago; realistically no user has a stored custom set. The `"merge"→.closeIssue` decode alias covers the one legacy rawValue. `.editIssue` is in the default (absent-key) all-enabled set, so fresh installs and untouched configs allow it; only a pre-existing *custom* set (none expected) would have `.editIssue` absent → treated as disabled, which the user can re-enable.

## Out of scope
- A real PR/MR-merge feature (and a `.mergePR` op) — none exists today.
- Server-side enforcement — the allow-list remains Mac-local (the retry-sweep edge from the original spec stays deferred).
- Gating purely-local SCM reads (status/diff/stage/commit-local) — only remote-affecting ops (push/branch/sync/publish) are gated.
