# Top-menu mirror — per-section status (2026-11-01)

The Mac's top bar is `ShellSection.toolbarOrder` (Explorer, Graph, Auto Tasks, Conflicts, Issues, Gantt, Loop,
Doc Gen, Visual, Library). Each section is its own layout, not a shared shell with an optional tree. This tracks
the desktop port section by section. Source of truth: `mac/Sources/LlmIdeMac/Shell/AppShell.swift` `sectionView`,
and each feature's `Views/`.

| Menu | Mac layout (panes / tree / actions) | Desktop now | Next |
|---|---|---|---|
| **Explorer** | Left: panel tabs (Explorer / Source Control / Search), file tree rooted at the project's `code/`, git decorations, Project folders sheet, Collapse All; center: editor tabs; right: Code Assistant panel. | Real. Tree rooted at `code/` (falls back to the project root when absent); panel tabs; Project folders sheet (host layout, missing marked, Reveal); Collapse All; Monaco editor; Terminal dock; Code Assistant. | Root row label; Project Memory entry point. |
| **Graph** | Two pages (System default, Code graph) via a segmented toggle. System: graph-kit's Agentic OS page. Code graph: left Library tree (Code / Data / All categories) + repo quick-pick + run footer; center 3D graph; right node details. | Both pages and the segmented toggle (System default, persisted). System page is graph-kit's React view mounted with a desktop `OsHost` (core state/cancel/SSE, skills, project graph/file, shell navigation). Code graph has canvas + search/filters/details and a file tree of the graph's own paths. Still missing: modes, repo quick-pick, run footer. | Modes and quick-pick/run footer; verify System page in a real window. |
| **Auto Tasks** | Task lanes, schedules, source updates, loop engineering/regression sweeps. | “Soon”. | Port the task cards and run controls. |
| **Review Conflicts** | Left conflicts file tree (`FileTreePanel`), center diff/hunk staging, review actions. | “Soon”. | Port the conflict tree + diff (Explorer has the diff machinery). |
| **Issues** | Board of repo issues (GitHub/GitLab) with create/edit/close; dispatch to trackers. | “Soon”. | Board + issue forms on the core repo endpoints. |
| **Gantt** | Gantt timeline over issues (`/kb/issue-schedule`), filters. | “Soon”. | Timeline read model + view. |
| **Loop** | Loop runs, verification/repair dashboards, regression sweep. | “Soon”. | Loop runs + verify views. |
| **Doc Gen** | Sources (Library categories Code / LLM Doc / Data), template, command/prompt, result + history; save to `llm-doc/`. | Real. Setup + Sources (same categories now), result/history, save, mermaid. | Step chrome and the Mac's refine/save-as-new affordances review. |
| **Visual** | Same generation views, sources Data / Code, image viewer; save under `llm-doc/`. | Real. Same category restriction now. | Image viewer parity. |
| **Library** | Sidebar categories (meetings, code, docs, data, input sources, plugins, LLM/MCP sources), item list, detail; write side. | Real. Sidebar, virtualised list, viewer/write side, extensions. | Audit sidebar grouping/order against `LibraryView.swift`. |
| **Chat** | Code Assistant panel, role labels, markdown, approvals. | Real (Mac-like typography landed). | Turn actions parity. |

## Done in this pass

- Explorer tree roots at `code/` (Mac `ExplorerView.root` → `activeProjectCodeDir`).
- Doc Gen/Visual Files pane limited to the Mac's categories; no climbing to the project root.
- Explorer: Project folders sheet + Collapse All (the Mac's folder.badge.gearshape and rectangle.compress.vertical actions).
- Graph: a bounded file tree of the graph's paths in the left panel (folders first, click focuses the file through search, Clear); `path-tree.ts` with tests. This is the Mac's tree position, backed by graph content so no row is empty.
- Graph: the Mac's System / Code graph page toggle (System default, persisted) and the System page itself — graph-kit's Agentic OS view mounted in-process with a desktop OsHost (state + cancel + filtered SSE feed, skills, project graph and file preview, shell navigation/file open), plus page/host tests.
- Repositories settings rebuilt as the Mac's GitLab/GitHub card (see below).

## Repositories (Settings → Project)

`RepoSettingsSection` is a tabbed card, not a folder list. The desktop now has both provider tabs, write-only token
fields (core vault `github.token` / `gitlab.token`), the primary-provider switch, the full per-provider
automation checklist, and saved repository rows (display name, URL, clone path, active, remove). Verification
(“Save & verify”) and clone/sync remain Mac-only; the card says so. The core index allow-list stays below the card
as a desktop-only safety control.
