# Per-Provider Repo Operation Allow-List — Design

Date: 2026-07-03
Status: **Designed** (awaiting implementation plan)
Branch: `feat/repo-operation-allowlist`

## Problem

The GitLab and GitHub settings sections let the user connect a token and add
repos/projects, but there is no control over *which* repo operations the app may
perform on its own. The primary automation engine —
`AutoCodeUpdateService` (a timer-driven background run gated only by a single
`autoCodeUpdateEnabled` flag) — will, when enabled, automatically create issues,
cut branches, and auto-commit AI-generated changes. Other operations (push,
PR/MR creation, merge) are manual today but are still ungated per provider.

The user wants a checklist at the bottom of each provider section (GITLAB and
GITHUB) listing the repo operations (pull, push, merge, create issue, …). An
**unchecked** operation must not run — both during automated runs and via the
matching manual button. This turns the coarse "automation on/off" switch into a
per-operation allow-list the user controls per provider.

## Decisions (locked with the user)

1. **Scope** — **Per-provider.** One checklist at the bottom of the GITLAB
   section and one at the bottom of the GITHUB section. The allow-list applies to
   all repos/projects under that provider. (Not per-repo.)
2. **Gating strength** — **Hard lock (automation + manual).** An unchecked
   operation is skipped by automation AND its matching manual button is disabled
   (greyed) in the UI. It is not merely an "automation only" gate.
3. **Operation set** — Four groups, expanding to individual toggles:
   - **Sync** — Pull / Re-sync (fetch, clone, re-sync locally)
   - **Code writes** — Push · Create branch · Auto-commit AI changes
   - **Issues** — Create issue/ticket (incl. tracker dispatch) · Comment on issue
   - **PR/MR** — Create pull/merge request · Merge / close
4. **Default state** — **All enabled.** Preserves today's behavior; on upgrade
   nothing changes. Users opt OUT of operations they don't want.
5. **Storage** — **Mac-local**, matching the existing provider-config pattern
   (tokens in Keychain, repos/projects in UserDefaults JSON). No backend change.
6. **Retry-sweep edge — out of v1.** The backend dispatch retry sweep re-attempts
   dispatches that were already initiated before a toggle was turned off. v1 gates
   at *initiation* only; it does not retroactively cancel an already-queued failed
   dispatch. Closing that would require sending the allow-list to the backend and
   is deferred.

## Architecture

Everything lives in the SwiftUI app (`mac/`). The allow-list is stored on
`AppConfig` (the same object that already holds `gitHubSavedRepos`,
`gitLabSavedProjects`, tokens, and `autoCodeUpdateEnabled`), persisted to
UserDefaults. A single predicate, `AppConfig.isAllowed(_:provider:)`, is the one
source of truth consulted by both the automation engine and the UI.

```
   Settings UI (per provider)              Enforcement sites
   ┌───────────────────────────┐          ┌────────────────────────────────┐
   │ GitHubSettingsSection      │          │ AutoCodeUpdateService.run()     │
   │ GitLabSettingsSection      │          │   guard isAllowed(.createIssue) │
   │   └ OperationsAllowlistView │          │   guard isAllowed(.createBranch)│
   │        (Toggles)           │          │   guard isAllowed(.autoCommit)  │
   └─────────────┬─────────────┘          │ dispatch: withhold createIssue  │
                 │ binds to               ├────────────────────────────────┤
                 ▼                        │ Manual buttons (.disabled):     │
   ┌───────────────────────────┐  reads  │   Re-sync/Clone   (.sync)       │
   │ AppConfig                  │◀────────│   New Issue       (.createIssue)│
   │  gitHubAllowedOps: Set<Op> │         │   Comment         (.commentIssue)│
   │  gitLabAllowedOps: Set<Op> │         │   Push & MR       (.push/.createPR)│
   │  isAllowed(op, provider)   │         │   Merge/Close     (.merge)      │
   └───────────────────────────┘         └────────────────────────────────┘
```

## Components

### Data model — `RepoOperation`

```swift
enum RepoOperation: String, Codable, CaseIterable {
  case sync          // pull / re-sync / clone
  case push
  case createBranch
  case autoCommit
  case createIssue   // create issue/ticket, incl. tracker dispatch
  case commentIssue
  case createPR      // create PR / MR
  case merge         // merge / close PR / MR
}
```

UI grouping (display only — the model stays flat):
`Sync → [sync]`, `Code writes → [push, createBranch, autoCommit]`,
`Issues → [createIssue, commentIssue]`, `PR/MR → [createPR, merge]`.

### `AppConfig` additions

```swift
@Published var gitHubAllowedOps: Set<RepoOperation> = Set(RepoOperation.allCases)
@Published var gitLabAllowedOps: Set<RepoOperation> = Set(RepoOperation.allCases)

func isAllowed(_ op: RepoOperation, provider: RepoProvider) -> Bool
```

- Persisted to UserDefaults as JSON arrays under keys `gitHubAllowedOps` /
  `gitLabAllowedOps` via `didSet`, read in `AppConfig.init()`.
- **Tolerant decode:** unknown operation strings in stored JSON are ignored
  (forward/backward compatibility if the op set changes).
- **Default = all cases**, applied when the key is absent (fresh install or
  upgrade), so existing behavior is unchanged on first launch after upgrade.
- `isAllowed` selects the set by `provider` and returns membership.

### UI — `OperationsAllowlistView`

- New file `mac/Sources/LlmIdeMac/Views/Settings/OperationsAllowlistView.swift`.
- Takes the provider; reads/writes the matching `AppConfig` set via bindings.
- Renders a header ("AUTOMATION & ACTIONS") over four labeled groups, each a
  row of `Toggle`s. Toggling updates the set (which persists via `didSet`).
- Inserted after the divider and above the repo/project list:
  `GitHubSettingsSection.swift:93`, `GitLabSettingsSection.swift:105`.

### Enforcement

**Automation — `AutoCodeUpdateService`:** the run loop guards each step with
`config.isAllowed(op, provider:)` for the active provider; a disallowed step is
skipped and a structured log line is emitted (so the skip is observable, not
silent). Before initiating a tracker dispatch, the Mac withholds any
`createIssue` dispatch that is not allowed.

**Manual buttons:** each relevant button gets
`.disabled(!config.isAllowed(op, provider))` plus a help tooltip
("Enable in Settings → \<Provider\> → Automation & Actions"):
- Re-sync / Clone (`GitHub/GitLabSettingsSection`) → `.sync`
- New Issue (`RepoIssuesView`) / fault→issue (`CodeAssistantPanel`) → `.createIssue`
- Comment sheet → `.commentIssue`
- Push & MR (`CodeWorkflowService` entry sheets) → `.push` / `.createPR`
- Merge / Close → `.merge`

The active provider for enforcement is derived the same way the app already
routes provider-specific views (the persisted `repoProvider` selection /
`RepoBackend`).

## Error handling & edge cases

- **Unknown stored ops** decode-ignored (tolerant `Set<RepoOperation>` decode).
- **Skipped automation steps** emit a structured log line naming the op and
  provider; the run continues with the remaining allowed steps.
- **All-off provider:** automation for that provider becomes a no-op; manual
  buttons all greyed. This is a valid, intended state.
- **Retry-sweep edge (deferred, see Decision 6):** an already-initiated failed
  dispatch may still be retried by the backend after the user unchecks
  `createIssue`. Documented limitation for v1.

## Testing

- **AppConfig unit tests:** default is all-enabled when keys absent; set
  persistence round-trips through UserDefaults; tolerant decode drops unknown op
  strings; `isAllowed` returns correct membership per provider.
- **Enforcement test:** with `createIssue` disabled for the active provider,
  `AutoCodeUpdateService.run()` skips issue creation (and logs the skip).
- Follows the repo's opt-in Swift pre-push regression gate.

## Out of scope (v1)

- Per-repo/per-project granularity (per-provider only).
- Backend-side enforcement / sending the allow-list to the server (only the
  retry-sweep edge would need it).
- Any change to token/secret storage.
