# Mac ↔ desktop end-to-end audit (2026-11-01, overnight)

## Mac app baseline

- `swift test --disable-sandbox` (memory keychain): **2662 tests, 0 failures, 2 skipped** (see below), plus the
  swift-testing suites (982) from the same run.
- Mac labs: `api-contract-lab` PASS, `chat-contract-lab` PASS, `generation-contract-lab` PASS,
  `loop-contract-lab` PASS; graph-kit `graph-layout-lab` / `graph-engine-lab` / memory conformance run separately.
- Reduced Mac builds: `LLMIDE_FEATURES=agent_chat` (min), `agent_chat,auto_tasks,mobile_sync` (lite), and
  `agent_chat,mobile_sync` (mobile-only) all compile with `--disable-sandbox`.
- Contract gates: `make contract-gates` passes (HTTP inventory regenerated after the issues-token change; os-view
  bundle current).

### Fixed in the Mac app

- **Notes-folder bookmarks.** `setFolder` threw when the app-scope bookmark entitlement was missing, so folder
  selection could fail; the test caught it. Added `com.apple.security.files.bookmarks.app-scope` and the
  security-scoped variant to `LlmIdeMac.entitlements`, and made `setFolder` fall back to the stored path (clearing a
  stale bookmark) exactly like `setFolderFromPath`. `ConfigHardeningTests` passes.
- **Trash test under restricted sessions.** A macOS/CI sandbox that cannot reach the Trash reports
  `NSFileWriteNoPermission`; the test now skips with that reason instead of failing. The app still uses the system
  Trash; no fallback to permanent deletion.

### Skips

- `testTrashRemovesItem`: the DSH session cannot move files to the user Trash (afpAccessDenied).
- One pre-existing skipped test elsewhere in the suite.

## Desktop baseline

- `make test-desktop`: **1362 node tests, 31 ui-kit, 378 Rust**, tsc and capability gate green.
- Build + core smoke green; app signed with the stable Apple Development identity (Keychain approval survives
  rebuilds).
- The desktop app could not be exercised past sign-in/Keychain in this session: the Keychain dialog is a system
  prompt the agent cannot click, and credentials are the user's.

## Per-menu status

| Menu | Desktop | Remaining |
|---|---|---|
| Explorer | Real: code-rooted tree, Project folders sheet, Collapse All, editor/terminal/Code Assistant, search/SCM panels | Root-row label, Project Memory entry |
| Graph | System page (graph-kit OS view, default) + Code graph toggle, graph file tree, canvas/filters/details | Graph scan/generation, modes, repo quick-pick, run footer |
| Auto Tasks | **Soon** | Needs a core/API model for schedules and runs (Mac state is local) |
| Review Conflicts | Real read-only: code + LLM Doc tree, viewer, Open in Explorer, Code Assistant | Diff/hunk staging, New Change/provider workflows |
| Issues | Real: board by label namespace, filters, links, GitHub import via vault token | GitLab import; create/edit/comment/close (provider write clients) |
| Gantt | Real: issues + `/kb/issue-schedule`, day/week zoom, today/weekend, undated list, overlay editor | Drawn dependency arrows; provider-native GitLab dates |
| Loop | **Soon** | Needs a core/API model for loop runs/verification (Mac state is local) |
| Doc Gen / Visual | Real: setup, sources (Code/LLM Doc/Data; Visual Data/Code), result/history, save, Mermaid | Step chrome and remaining Mac affordances |
| Library | Real: notes sidebar/list/viewer/write, extension panes | Mac file-tree sidebar with add-file/folder menus |
| Chat | Real, Mac-like layout/typography | Turn-action parity |

## Blocked by missing core/host state (not UI work)

- **Auto Tasks** and **Loop** orchestrate Mac-local state (`AutoCodeUpdateService`, loop runners/verification);
  the core exposes only `/kb/loop/agent-run`, no schedule/run list. Mirroring their pages needs a server-side
  model first; a read-only page would be an empty shell.
- **Code graph generation** is GraphKit-side (Swift) and writes `system/graph/graph.json`; the desktop only reads
  that file. A desktop scan needs the graph engine ported or a core generation route.
- **Live capture** and **Mobile Control** are Mac/Chrome/iOS surfaces; not desktop top-menu pages.

## Next

1. Graph scan/modes/quick-pick if a generation path exists; otherwise keep the read-only page and its System view.
2. Library file-tree sidebar parity (add-file/folder, category sections).
3. Doc Gen/Visual step chrome.
4. Auto Tasks/Loop only after a core state model is designed.
