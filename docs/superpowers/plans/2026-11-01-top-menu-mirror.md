# Top-menu mirror — per-section status (2026-11-01)

The Mac's top bar is `ShellSection.toolbarOrder` (Explorer, Graph, Auto Tasks, Conflicts, Issues, Gantt, Loop,
Doc Gen, Visual, Library). Each section is its own layout, not a shared shell with an optional tree. This tracks
the desktop port section by section. Source of truth: `mac/Sources/LlmIdeMac/Shell/AppShell.swift` `sectionView`,
and each feature's `Views/`.

| Menu | Mac layout (panes / tree / actions) | Desktop now | Next |
|---|---|---|---|
| **Explorer** | Left: panel tabs (Explorer / Source Control / Search), file tree rooted at the project's `code/`, git decorations, Project folders sheet, Collapse All; center: editor tabs; right: Code Assistant panel. | Real. Tree rooted at `code/` (falls back to the project root when absent); panel tabs; Project folders sheet (host layout, missing marked, Reveal); Collapse All; Monaco editor; Terminal dock; Code Assistant. | Root row label; Project Memory entry point. |
| **Graph** | Two pages (System default, Code graph) via a segmented toggle. System: graph-kit's Agentic OS page. Code graph: left Library tree (Code / Data / All categories) + repo quick-pick + run footer; center 3D graph; right node details. | Both pages and the segmented toggle (System default, persisted). System page is graph-kit's React view mounted with a desktop `OsHost` (core state/cancel/SSE, skills, project graph/file, shell navigation). Code graph has canvas + search/filters/details and a file tree of the graph's own paths. Still missing: modes, repo quick-pick, run footer. | Modes and quick-pick/run footer; verify System page in a real window. |
| **Auto Tasks** | Task lanes, schedules, source updates, loop engineering/regression sweeps. | “Soon”. | Needs a core/API model for schedules and runs (the Mac state is local); documented in the audit. |
| **Review Conflicts** | Left tree over code + LLM Doc, center file viewer/editor, right Code Assistant; New Change workflows and linked-repo banner. | Real read-only: the Mac's code/llm-doc tree, a read-only viewer, Open in Explorer, and the Code Assistant dock. Reviewing is conversational; no New Change/provider workflows. | Diff/hunk staging and the linked-repo workflows. |
| **Issues** | Board of repo issues (GitHub/GitLab) with create/edit/close; dispatch to trackers. | Real read + import: provider/state/search/repository filters, kanban columns from the label namespace (else Open/Closed), cards with links, and a GitHub import form that uses the token saved in Settings → Repositories (the server falls back to the vault token when the desktop sends none). GitLab import and create/edit/close are not in the desktop core yet and the card says so. | GitLab import; create/edit/comment/close with provider write clients. |
| **Gantt** | Gantt timeline over issues (`/kb/issue-schedule`), project/provider filters, day/week zoom, today marker, undated issues, schedule editing. | Real: cached issues merged with the scheduling overlay, day/week zoom, today/weekend tint, dependency marker, provider/repository filters, an undated list, and a schedule editor (start/due/estimate/dependencies) that writes the overlay via PUT/DELETE. | Dependencies as drawn arrows; provider-native GitLab dates. |
| **Loop** | Loop runs, verification/repair dashboards, regression sweep. | “Soon”. | Needs a core/API model for runs/verification; only `/kb/loop/agent-run` exists today. |
| **Doc Gen** | Sources (Code / LLM Doc / Data), template, command/prompt, "Steps to generate" checklist, result + history; save to `llm-doc/`. | Real. Setup + Sources, the Mac's three-step checklist (template/command, sources, prompt), result/history, save, mermaid. | Refine/save-as-new affordance review. |
| **Visual** | Same generation views, sources Data / Code, image viewer; save under `llm-doc/`. | Real. Same category restriction now. | Image viewer parity. |
| **Library** | Sidebar categories (Sources, Code, Data, LLM Doc, extensions), file trees with add-file/folder, list/detail, write side. | Real notes sidebar/list/viewer/write/extensions, plus **Project files** (Code/Data) lazy trees with a read-only viewer and Open in Explorer. Add-file/folder menus and the Mac's tree-integrated list remain. | Add-file/folder actions; tree/list integration. |
| **Chat** | Code Assistant panel, role labels, markdown, approvals. | Real (Mac-like typography landed). | Turn actions parity. |

## Done in this pass

- Explorer tree roots at `code/` (Mac `ExplorerView.root` → `activeProjectCodeDir`).
- Doc Gen/Visual Files pane limited to the Mac's categories; no climbing to the project root.
- Explorer: Project folders sheet + Collapse All (the Mac's folder.badge.gearshape and rectangle.compress.vertical actions).
- Graph: a bounded file tree of the graph's paths in the left panel (folders first, click focuses the file through search, Clear); `path-tree.ts` with tests. This is the Mac's tree position, backed by graph content so no row is empty.
- Graph: the Mac's System / Code graph page toggle (System default, persisted) and the System page itself — graph-kit's Agentic OS view mounted in-process with a desktop OsHost (state + cancel + filtered SSE feed, skills, project graph and file preview, shell navigation/file open), plus page/host tests.
- Issues: read/import board (columns, filters, GitHub import through the vault token).
- Gantt: timeline + scheduling overlay editor (start/due/estimate/dependencies).
- Review Conflicts: code + LLM Doc tree, read-only viewer, Open in Explorer, Code Assistant.
- Doc Gen/Visual: the Mac's three-step "Steps to generate" checklist with per-tab copy and done states.
- Library: Code/Data project-file trees (read-only) beside the notes sections, with Open in Explorer.
- Repositories settings rebuilt as the Mac's GitLab/GitHub card (see below).

## Repositories (Settings → Project)

`RepoSettingsSection` is a tabbed card, not a folder list. The desktop now has both provider tabs, write-only token
fields (core vault `github.token` / `gitlab.token`), the primary-provider switch, the full per-provider
automation checklist, and saved repository rows (display name, URL, clone path, active, remove). Verification
(“Save & verify”) and clone/sync remain Mac-only; the card says so. The core index allow-list stays below the card
as a desktop-only safety control.
