# Tauri Phase 5: the remaining screens, macOS first and finished

Status: **plan, nothing built.** Date: 2026-10-31, at `main`. Parents: [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md), [Tauri plan](2026-10-24-tauri-desktop-and-relay.md), [Phase 3 plan](2026-10-31-tauri-phase3-plan.md), [parity checklist](2026-10-31-tauri-parity-checklist.md) (sections 7 to 12 are this plan's rows), [kit-by-kit migration](2026-10-27-kit-by-kit-migration.md), [Phase 7 design](2026-10-31-phase7-desktop-control-design.md), [live-then-archive](2026-10-29-live-then-archive.md), kit maps [graph-kit](../../kits/graph-kit.md), [work-kit](../../kits/work-kit.md), [docs-kit](../../kits/docs-kit.md), [capture-kit](../../kits/capture-kit.md), [automation-kit](../../kits/automation-kit.md), [os-kit](../../kits/os-kit.md), [data-lifecycle](../../kits/data-lifecycle.md).

Sizes are bytes or lines read with `wc` on `mac/Sources/LlmIdeMac/Features/*` at this commit. Route names come from `extension/server.mjs` `ALL_ENDPOINTS` and the kit maps. Nothing was run; every acceptance number below is a target, not a measurement.

## 0. Decision recorded (user, 2026-10-31)

1. **macOS first and finished, then Windows and Linux.** The user must be able to see the whole scenario in the Tauri app on a Mac before any other OS is polished. Windows and Linux builds keep compiling in CI (`desktop-ci.yml`) but get no screen work in this phase.
2. ADR 0018 is accepted for the Phase 3 start. Phase 5 is the same decision applied to the screens Phase 3 did not cover.
3. Standard: "do the best, SECURE, usable for BIG projects". Where speed and safety conflict, safety wins; where a screen would break at scale it is not done until it does not.
4. The Swift feature freeze (MASTER-PLAN, in force) stays. The Swift app keeps working and keeps the things this plan defers.

## 1. Scope

In: Code Graph, Issues + Gantt, Doc Gen + Visual, Live capture on macOS, Loop + Auto Tasks, Mobile control bridge (decision only), Home and menu-bar quick chat, System page. Already built in Phase 3 and not repeated: Chat, Explorer (+ Search, Terminal, Source Control), Library, Settings, Extensions, Review Conflicts (Library entry).

Out (explicitly deferred, section 13): Windows and Linux screen work, Phase 7 desktop control, relay and phone PWA (ADR phase 4), hosting `:3006` in the Tauri app, `Apply & Rebuild`, Sparkle-style updater (T6), Swift retirement (Phase 6).

## 2. What exists to build on

- **Shell and kit**: `ui/kit`, `ui/screens/{shell,chat,explorer,library,settings}`, section registry, `SectionProps`, theme tokens, windowed lists, typed API client and decoders.
- **Host (Rust, `desktop/src-tauri/src/`)**: root-confined `fs_ops`, `fs_watch`, `git`, `git_scm`, `project_search`, `pty`, `notes_fs`, `notes_write`, `chat_store`, `secrets`, `graph_file` (hardened `graph.json` read inside the active project root), `ax_probe` (Phase 0 Accessibility FFI probe: `AXIsProcessTrusted`, `AXUIElementCreateSystemWide`), `tray`, `os_open`, `proc_tree`.
- **Core (Node)**: all server routes; the persisted job runner library (`extension/kb/job-queue.mjs`, `job-runner.mjs`, `core/process-group.mjs`, migration 0055, `docs/spec/job-runner.md`, 10 tests) which is **not yet wired to any route**; `POST /kb/loop/agent-run`; `GET /kb/os/state` and `/kb/os/stream`; live routes `/kb/live/*` with acks.
- **graph-kit**: Rust `graph-layout` kernel (`mac/LocalPackages/graph-kit/rust/graph-layout`) with native and WASM builds and conformance; `os-graph` crate; the Phase 0 graph view in `desktop/src/graph` (`layout.ts`, `realGraph.ts`, `synthetic.ts`, `fps.ts`) which proved sigma/WebGL rendering.
- **os-kit page** in `ui/os-view` (host `OsHost` interface), data from `GET /kb/os/state`.

## 3. Common rules for every screen in this plan

1. **UI is a section** registered in the shell, built on `ui/kit`, in its own `ui/screens/<name>/` folder. No `dangerouslySetInnerHTML`; markdown through the existing safe renderer.
2. **Secrets never reach the webview** except write-only entry (existing pattern: key goes in one POST body, never listed). Tokens for GitHub, GitLab, Backlog, Linear live in the core vault or the host Keychain wrapper (`secrets.rs`), never in webview storage.
3. **Filesystem only through root-confined host commands** (canonicalise, re-check on the open descriptor, symlink and hard-link refusal, too-broad-root refusal). No screen reads a path the webview chose without the host re-checking it against the active project root or the notes root.
4. **Bounded memory everywhere**: lists are windowed (5,000+ rows must not mount more than a window), streams are micro-batched and capped, large payloads are paged, binary contracts carry an explicit size limit.
5. **State rule** (Phase 3 section 4.1): durable content is a file in the project (`system/`, `llm-doc/`); derived or queryable state is the core's SQLite; per-user UI state is a host pref; webview storage holds only per-viewer conveniences (last tab, filters). Nothing user-valuable lives only in webview storage.
6. **Feature gating**: a section is hidden when `/health` features say its feature is off (404 `feature_disabled`), same as Phase 3.
7. **Behaviour change rides separately**: a port never changes a prompt, a stage kind, a guardrail or a wire shape (kit plan rule). New routes are additive with fixtures and an API version bump.
8. **Test posture**: the model is faked (the core's stub seam used by the agent-run fixtures, scripted fake provider for chat-like flows); fixtures for GitHub, GitLab, Backlog and Linear are recorded and replayed, never live; no live dispatch in tests. Real-Claude runs are user-run and listed in section 12.
9. **Fable review** for anything that can write outside the project or run a process (Loop, Auto Tasks, Live helper, tokens).

## 4. Order (recommended) and why

1. **P5-G Code Graph** (smallest risk, kernel and renderer already proven, unblocks System page graph and Loop graph snapshots).
2. **P5-I Issues + Gantt** (needs token-to-core decision W2; mostly UI; big lists).
3. **P5-D Doc Gen + Visual** (server routes exist; UI plus source tree; reuses Chat panel embedding).
4. **P5-L Live capture on macOS** (needs Phase 7 spike 1 result for TCC attribution; the real meeting verification waits for the user).
5. **P5-A Loop + Auto Tasks** (largest, last, needs automation-kit K1 slices and the job-runner wiring).
6. **P5-H Home and menu-bar quick chat** and **P5-S System page** run in parallel with any step (small, independent); **P5-M Mobile bridge** is a decision plus a notice, no build.

Waves for parallel agents: Wave A = P5-G, P5-S, P5-H, and the core half of P5-I (token vault route). Wave B = P5-I UI, P5-D, P5-L helper spike. Wave C = P5-A K1 slices (core), then P5-A screens. Wave D = integration, macOS exit gate (section 11).

---

## 5. P5-G Code Graph (graph-kit)

**Mac source** (`Features/CodeGraph/`, 6,280 lines, 308 KB): `Views/UAGraphView.swift` 1,907, `CodeGraphCanvas.swift` 592, `Graph3DView.swift`, `GraphSessionStore`, `GraphSettingsSection`, `Engine/PluginGraphEngine.swift` 462, `GraphEngineLocator` 210, `Services/KnowledgeGraphService` 372, `CodeGraphUploadService` 358, `GraphAutoUpdater` 321, `LoopGraphRescanner`, `ProjectGraphExport`, `Notes/CodeNoteGenerator` 371 (+ `CodeNoteService`, `BatchPlanner`). Layout kernel in `graph-kit/Sources/GraphCore/Layout/` (about 1,700 lines of Swift, now also Rust).

**Server routes**: `POST /kb/ingest-scip`, `POST /kb/ingest-code-graph`, `POST /kb/code-sync`, `GET /kb/os/state` (graph counts); planner reads the graph in-process. The graph itself is a **file**: `<project>/system/graph.json` plus memory artifacts under `system/` (graph-kit writes; the host reads through `graph_file.rs`).

**Host commands**: existing `read_graph_file` (cap raised and paged if a real 50k-node file exceeds the current bound: measure first); new `graph_scan_start/cancel` only if the scan runs host-side (recommendation: scan runs in the core as a job, not in the host, see below); `graph_layout_cache_read/write` for a rebuildable layout cache under the app data dir (not the project).

**Layout engine decision (graph-kit Q1, T0 spike)**: run the Rust kernel as **WASM in a Web Worker in the webview** for interactive layout (no main-thread work, no IPC copy of 50k nodes beyond one transfer), and the **native build inside the Node sidecar** only for headless callers (Loop snapshots, System page server side). Same crate, same conformance goldens. Compact binary request (graph-kit Q6) with an explicit route limit for the sidecar path. Metric-level parity with the Swift picture (graph-kit Q5), announced once at the release boundary; no positions are persisted, so no user data changes.

**Rendering**: sigma/WebGL (the Phase 0 view), edges weighted (`EdgeWeight`) and **filtered at render, never pruned** (CLAUDE.md rule). Level of detail: labels only above a zoom threshold and for top-PageRank or hovered nodes; edge culling by weight band; node picking through the spatial index, not DOM.

**2D and 3D parity options** (`CGSimulation3D` is not ported; graph-kit Q4 says retire it in K3):

| Option | What the user gets | Cost | Risk |
|---|---|---|---|
| A. 2D only for macOS-finished | Same graph, same filters, the System page orbit view as the only 3D | 0 extra | The user loses the Swift 3D view in Tauri until K3 |
| B. WebGL 3D force view (K3) using the Rust kernel with a 3D mode | 3D graph in Tauri | 2 to 3 weeks of graph-kit work (graph-kit plan K3) | Layout quality and perf at 50k need the T0 spike first |
| C. Port `CGSimulation3D` to Rust | Closest to Mac picture | Highest | Duplicates a kernel the plan decided to retire |

**Recommendation: A for the macOS exit gate, B scheduled right after as K3 (not in the exit gate), never C.** The Swift app keeps its 3D view during the overlap (freeze allows it: nothing changes). If the user wants 3D in the exit gate, B moves up and the gate slips by that slice.

**State**: `graph.json` and memory artifacts are project files (truth); layout positions are a cache, never committed; per-user view settings (filters, zoom) host prefs.

**Big-project criteria**: 50,000 nodes and 250,000 edges: first frame within 3 s of file load on the reference Mac (target), 30+ fps pan and zoom (Phase 0 measured the bar), main thread blocked less than 50 ms per frame during layout (worker), peak webview memory under 600 MB, file load streamed and decoded in the worker, cancel works mid-layout. A 1 MB real graph (Phase 0) is the floor, a synthetic 50k graph the ceiling fixture.

**Security**: `graph.json` is untrusted data (a repo can ship one): decode with a strict typed decoder, unknown node kinds map to `other` (graph-kit Q8), caps on node, edge and string sizes, labels rendered as text only. The host confines the read to the project root (already done). WASM loaded from the app bundle only, no remote code. Plugin graph engines (`PluginGraphEngine`, manifest `graph-engine.json`) run as the existing plugin trust path demands (consent, pinned commit): **not ported in P5**; the built-in engine only. Deferred row recorded.

**Acceptance**: opens a real project graph and a 50k synthetic one; select, search, focus neighbours, community colouring, node detail with "open in Explorer" glue; Rescan runs as a core job with progress and cancel; code-note generation (`CodeNoteService`) is **deferred** to a later slice unless the user says otherwise (it is a model-driven batch; belongs with automation job runner).

**Tests**: Rust conformance goldens for the kernel (exist); worker contract test with the 50k fixture; decoder tests with hostile files (huge, cyclic, unknown kinds, NaN positions); render smoke through the existing fps harness; fixture `graph.json` files from the lab and one real graph.

**Slices** (ownership):

| Slice | Owns | Work |
|---|---|---|
| G1 | `ui/screens/graph/model/*`, `ui/screens/graph/decode.ts` | Strict decoder, caps, view model, filters, selection |
| G2 | `ui/screens/graph/render/*`, `ui/screens/graph/worker/*` | sigma view from `desktop/src/graph`, WASM worker, LOD, picking |
| G3 | `graph-kit` repo (`rust/graph-layout`), `desktop/src-tauri/src/graph_file.rs` | T0 spike numbers at 8k and 50k, paged read if needed, WASM `--check` |
| G4 | `ui/screens/graph/index.tsx`, `panels/*` | Section, detail panel, search, Explorer glue, Rescan job UI |
| G5 | `extension/routes/graph-job.mjs` (new), tests | Rescan as a core job (after the job-runner route slice A0, section 10) |

---

## 6. P5-I Issues + Gantt (work-kit)

**Mac source** (`Features/Issues/`, 4,278 lines, 185 KB, 11 files): `Views/RepoIssueDetailSheet` 925, `RepoIssuesView` 691, `RepoKanbanPanel` 261, `Gantt/Views/GanttView` 885, `GanttViewModel` 411, `GanttContainerView` 284, `GanttFilterBar` 252, `IssueScheduleEditorSheet` 212, `Services/RecentIssuesResolver`. Backing code in `Core/Repo/` (25 files, 5,765 lines: `GitHubClient`, `GitLabClient`, `RepoBackend`, `AllowlistedRepoBackend`, `RepoBackendFactory`).

**Server routes**: `GET/POST /kb/issue-schedule` (only route the Mac calls today; feature `gantt_issues`), `GET /kb/issues`; planning and dispatch for the extension exist (`/kb/dispatch` with modes `preview`, `github`, `backlog`, `linear`), `/kb/outcomes/*`. **Gap**: the Mac calls GitHub and GitLab directly from Swift; Node has only dispatch (create), not list, update, comment, label.

**Answer to work-kit W2 (delegated)**: tokens move to the **core vault** (write-only entry, per-user scope, one-way Keychain-to-vault migration, N-1 readable) because the Tauri app and later the relay must not hold provider tokens in the webview, and Node is the only process allowed to call the providers (single egress with the allowlist and redaction already in the core). The Swift Keychain copy stays untouched during the overlap.

**New core module** `extension/connectors/issues/` (new files only): one provider interface (`list`, `get`, `create`, `update`, `comment`, `labels`, `milestones`) with adapters GitHub, GitLab, Backlog, Linear; each behind an allowlisted host list and a per-user credential scope; **reads and writes the same wire shapes the Mac decodes today** so the Swift path can later call it. New additive routes `GET /kb/repo/issues`, `GET /kb/repo/issues/:id`, `POST /kb/repo/issues`, `PATCH /kb/repo/issues/:id`, `POST /kb/repo/issues/:id/comments` (API bump, fixtures with errors including rate limit, 401, 404, truncated pages). Dispatch stays preview-by-default and idempotent (R4).

**Host commands**: none new (no filesystem). Open in browser uses `open_external_url` with an allowlisted-scheme check.

**UI**: list with filters and saved views, kanban with label-derived columns (`::` GitLab, `:` GitHub, per the board parity memory), detail sheet with comments, schedule editor, Gantt with the `issue_schedule` overlay (SQLite, W3 stays). **Gantt rendering**: canvas or SVG with row and time-window virtualisation (render only visible rows and the visible time range); drag to reschedule writes the overlay with optimistic update and rollback on error.

**State**: provider tokens in the vault; issue data is **never cached as the truth**, only a bounded in-memory page cache (LRU, 5,000 issues max) plus ETag use; `issue_schedule` stays server SQLite; filters and saved views are host prefs.

**Big-project criteria**: 10,000+ open issues in a repo: paged fetch (cursor), list windowed, filter and search server-side or over the page cache with a "showing N of M" state; Gantt with 2,000 scheduled rows scrolls at 60 fps (window of about 60 rows mounted); kanban columns windowed per column; rate-limit aware (read `Retry-After`, back off, show the reset time, never hammer).

**Security**: issue titles and bodies are untrusted markdown: safe renderer only, images not auto-loaded, links through the host opener allowlist. Token never in logs (redaction), never in error messages (map provider errors to fixed text like the providers screen). Writes (create, comment, label) need an explicit user action; **no automatic write from Chat or Loop without the existing approval path**. Repo allowlist (`AllowlistedRepoBackend`) is ported as a core rule: an operation on a repo outside the user's chosen list is refused.

**Acceptance**: connect GitHub and GitLab (and Backlog, Linear read-only first), list and filter a large repo, open detail, comment, change labels and assignee, schedule on the Gantt, same results as the Swift Issues view on two fixture repos; token never visible after entry.

**Tests**: recorded provider fixtures (200, empty, large page, 401, 403 rate limit, 404, 5xx, truncated JSON); `RepoCredentialScopeTests` ported first (R2); adapter contract test that GitHub and GitLab produce identical normalised issues; windowing tests at 10k; Gantt model tests (date math, overlap, drag clamps).

**Slices**:

| Slice | Owns | Work |
|---|---|---|
| I1 | `extension/connectors/issues/*`, `extension/routes/repo-issues.mjs`, `extension/tests/repo-issues*.test.mjs`, `schema/http/` rows (append) | Provider interface, GitHub and GitLab adapters, vault scope, routes, fixtures |
| I2 | same dir, Backlog and Linear adapters | After I1 |
| I3 | `ui/screens/issues/list/*`, `kanban/*` | List, filters, kanban, detail sheet |
| I4 | `ui/screens/issues/gantt/*` | Windowed Gantt, schedule editor |
| I5 | `ui/screens/issues/index.tsx`, `providers-connect/*` | Section, connect flow (write-only token), saved views |

---

## 7. P5-D Doc Gen + Visual (docs-kit)

**Mac source** (`Features/Generation/`, 3,298 lines, 144 KB): `Views/GenerationEditorPanel` 640, `GenerationTemplateSection` 427, `GenerationPromptBar` 309, `GenerationSourceTree` 296, `DocTemplateManagerSheet` 223, `GenerationSetupSection` 162, `Visual/Views/VisualView` 360, `VisualSourcePanel` 194; Core backing `Core/Generation/` (`GenerationRegistry`, `GenerationViewModel`).

**Server routes**: `POST /generate-doc` (feature `doc_gen`, no source cap since v52, optional `command`, `prompt`), `POST /generate-docx` (always on), `GET /kb/agent/generation-library`, markdown export, `GET /kb/meeting/:id`. Ingest of generated docs through `ingestGeneratedDoc`.

**Host commands**: reuse `notes_write` (CAS save, create never overwrites) to save a generated doc into the notes folder; reuse `attach_pick_files`. No new command.

**UI**: source tree (Library items, project files) with multi-select and "fits the model window?" notice (`sourceFitNotice`), template manager (user templates are files under the project `llm-doc/`), prompt bar with command, editor panel with live preview and save, Visual (diagram) panel rendering Mermaid. **Mermaid**: the Mac downloads the runtime on demand; in Tauri the runtime ships **in the app bundle** (no network fetch of executable code) and renders in a sandboxed iframe with `securityLevel: 'strict'` and no network access.

**State**: templates and generated docs are project files; in-progress generation request state is in memory; the prompt and last selection are host prefs.

**Big-project criteria**: a selection of thousands of sources: tree windowed, selection kept as a set of ids (not nodes), the server's context selection does the fit, the UI shows token estimates not content; generation streams are micro-batched; editor handles a 5 MB document through Monaco's large-file mode (reuse the Explorer editor).

**Security**: model output rendered by the safe markdown path; Mermaid strict mode in an isolated frame; **guardrail scan** (`scanForSecrets`) result shown before save and before export, unchanged server behaviour; file saves confined to the notes or project root by the host; no source content leaves the machine except to the chosen provider (existing consent text shown).

**Acceptance**: generate a doc from a meeting and from a project folder with the fake model, edit, save into Library, export DOCX through the core; Visual renders a diagram from a fixture; templates add, edit, delete; same server calls as Swift (checked by a request-shape test).

**Tests**: fake provider; request-shape tests against `schema/http` fixtures; windowing test with 10k sources; Mermaid hostile-input fixtures (script in labels, `click` callbacks, `javascript:` links) must render inert.

**Slices**: D1 `ui/screens/docgen/{tree,prompt,editor}/*` (owner Doc Gen), D2 `ui/screens/docgen/visual/*` and `ui/vendor/mermaid/*` (bundled runtime, sandbox frame), D3 `ui/screens/docgen/templates/*` plus index. No Rust or core change expected; if a route gap appears it is requested from the core owner.

---

## 8. P5-L Live capture on macOS (capture-kit)

**Mac source** (`Features/Live/`, 2,751 lines, 121 KB, 14 files): `Services/CaptionScraper` 598 (`CaptionOrchestrator`), `AXCaptionReader` 206, `TeamsCaptionScraper` 106, `ZoomCaptionScraper`, `PlatformDetector`, `CaptionDeltaState` 281, `AutoCaptureService` 257, `PermissionsService`, `LiveSessionMirror` 318, `Views/TranscriptView` 413, `PermissionsView` 208, `LiveCaptureGateView`, `MeetingCaptureMatrixView`. Core backing: `Core/Notes/Services/MeetingFileStore`, `PartialRecovery`, `MeetingSummarizationService`, `MeetingNoteWriter`.

**Server routes** (all exist, always on): `/kb/live`, `/kb/live/unacked`, `/kb/live/:id/append`, `/finalize`, `/stream`, `/ack`, `/status`; `POST /kb/summarize`; `POST /kb/ingest`; meeting agent `/kb/agent/dispatch`, `/stop`, `/runs`. `LLMIDE_LIVE_ACK=1` keeps rows until the Mac acks.

**The capture mechanism: options**

| Option | Description | Pros | Cons |
|---|---|---|---|
| H. Tiny Swift helper binary shipped inside the `.app` (`Contents/MacOS/llmide-capture` or `Contents/Helpers/`), JSON lines over stdio to the Rust host | Reuses the 800 ms cadence, `CaptionDeltaState` and per-app scrapers as they are today; separate process so a crash or AX hang cannot take the app down; can be killed on revoke | Lowest port risk (R2: no change of dedupe or cadence); isolation; Phase 7 will need a similar helper anyway | Second signed binary; TCC attribution must be proven; Swift code remains after Swift app retirement (about 1.5k lines) |
| R. Rust with `objc2` or direct Accessibility FFI in the host | One binary, one signature; `ax_probe.rs` already links `AXUIElement*` | No second process; Windows and Linux backends later share a trait | Rewriting scrapers and delta logic changes behaviour risk; AX calls on a UI thread of the host; hang takes down the app unless done in a thread with a watchdog |
| Hybrid: Rust host owns the permission check and the process; helper is the only AX caller | H with the permission UX in Rust | | |

**Recommendation: H (hybrid shape) now, R after Windows and Linux backends exist.** Reason: the 800 ms cadence, dedupe rules and per-app quirks are the product's hard-won invariants (CLAUDE.md caption invariants); a port is a regression risk with no user benefit, while a helper is a build artefact. The helper protocol is a small versioned JSON-lines contract (`hello`, `permission`, `start{app, language}`, `caption{speaker, text, seq}`, `stop`, `error`) defined first and tested with a fake helper, so a Rust backend can replace it without touching the UI.

**TCC attribution** is decided by Phase 7 spike 1 (attribution matrix: which process must hold Accessibility under dev, release, Finder launch, terminal launch). Until that result exists the plan assumes the worst case: **the helper must hold the permission itself, signed with the same Developer ID and a stable bundle identifier, and the permission UI must say which entry to enable**. If the spike shows attribution to the parent app, the UI text changes and nothing else. **Do not start L2 before spike 1 is read** (it also gates Phase 7, so the spike is shared work). Hardened runtime and notarisation entitlements are confirmed in the same spike, not assumed.

**Host commands**: `capture_status` (permission trusted, helper present, version), `capture_open_settings` (opens the Privacy pane via `open_external_url`-class command with a fixed URL), `capture_start/stop` (the host spawns the helper with a sanitised environment and process-group kill), events `capture://caption` forwarded to the screen. The host buffers nothing beyond a small ring; the **core** holds the live working copy through `/kb/live/:id/append`.

**State and persistence (live-then-archive)**: captions flow helper to host to webview to `POST /kb/live/:id/append` (or host direct to loopback with the core token). The Mac writes the **durable meeting file** into the notes folder via `notes_write` at finalize, then acks the core with `lines` and `hash` (live-then-archive Phase 5 Mac side). **That ack and the real-meeting verification wait for the user's recorded meetings** (MASTER-PLAN `(wait)`): the code is built against fixtures and the fake helper; it is switched on for daily use only after the user's real runs.

**Live take-over of the Library meeting detail**: the Library meeting pane wraps its content in a `LiveCaptureGate` equivalent (a registry slot in `ui/kit` or the shell, not a Library import of Live): while a session is live for that meeting, the recording banner and streaming transcript replace the static body; at finalize it returns to the file view. Same contract as `LiveCaptureProviding` on the Mac.

**Big-project criteria** (long meetings): a 4-hour meeting (about 20k lines): transcript windowed, appends O(1), per-session caps respected (`MAX_CAPTIONS_PER_SESSION`, 2,000-line finalize cap, 413 `CAPTURE_TOO_LARGE`, already tested), crash recovery from `PartialRecovery` files, memory bounded by a ring plus disk.

**Security**: captions are untrusted text (a speaker can type anything into a caption): rendered as text only, never as markdown by default in the live pane; the helper takes no input from the network, only start/stop JSON from the host; the helper is spawned by the host only, from the signed bundle path (path is not user-configurable); the permission is never requested programmatically (there is no API; the UI explains). Revocation while recording: the helper reports `permission_denied`, the host stops capture, the screen shows the state and **keeps what was captured** (finalize with a partial flag). Meeting content never goes to a provider except through the summarise action the user starts.

**Acceptance**: with a fake helper: permission states shown correctly, start, stream, stop, finalize, file written, ack sent, crash mid-meeting recovers on next start with no duplicates. With the real helper (user-run): Teams, Zoom and Meet-in-Safari/Chrome captions captured at the 800 ms cadence with the same text as the Swift app side by side on one meeting.

**Tests**: helper protocol tests with a fake helper (scripted lines, malformed lines, oversized lines, helper crash, hung helper killed by timeout); port `CaptionDeltaStateTests` as fixtures consumed by the helper's own Swift test (the helper keeps the logic, so the existing tests stay valid); host test that revoke kills the helper; transcript windowing test at 20k lines.

**Slices**: L1 `ui/screens/live/*` + gate registration (UI owner); L2 `desktop/src-tauri/src/capture_host.rs` (spawn, protocol, kill, events) with a fake-helper test binary; L3 `desktop/capture-helper/` (new Swift package, extracts `Features/Live/Services` logic into the helper; **the one Swift code addition allowed by the freeze because it is parity work**); L4 permission UX and `PermissionsView` equivalent; L5 finalize/ack wiring (blocked on the user's meetings for switch-on).

---

## 9. P5-H Home and menu-bar quick chat, P5-S System page, P5-M Mobile bridge

### 9.1 P5-H Home and menu-bar quick chat

Mac source: `Features/Chat/Views/Quick/` (`MenuBarChatView`, `MenuBarChatWindowHandle`, `LlmChatSheet`, `LlmChatViewModel`, `LlmChatStatusBadge`, `QuickChatSendPolicy`); Home resolution `ShellSection.resolveHome` (parity row 1 exists). Server routes: the chat routes Phase 3 uses (`/agent/v2/*` with `detach`). Host commands: `tray.rs` exists; add `quick_chat_window_show/hide` (a second small Tauri window, global shortcut registered with the user's consent, configurable). State: the quick chat is a normal chat scope (`ChatScope`) stored by the same archive store as the main chat; no separate store. Big-project: the quick window mounts the same windowed message list, so a long chat is safe; it does not load project trees. Security: the quick window has a **smaller capability set than the main window** (no fs, no shell, no pty); approvals show in the main window or inline with the same confirm component; paste of images follows the attach path with size limits. Acceptance: shortcut opens the window in under 300 ms (target), send and stream work, switching to the main chat keeps the thread, closing does not stop a detached turn. Tests: capability test that the quick window cannot invoke fs commands; send-policy port tests (`QuickChatSendPolicy`). Slice H1 owns `ui/screens/quick/*` and `desktop/src-tauri/src/quick_window.rs`, `capabilities/quick.json` (capabilities file coordinated with the single owner of `capabilities/*`).

### 9.2 P5-S System page

Mac source `Features/System/` (1,533 lines, 74 KB): `SystemBridge` 938, `SystemWebView` 396, `SystemEventStream` 165, `SystemView` 34. The page itself already lives in `ui/os-view` (host interface `OsHost`), so Tauri mounts it **as a section, not in a WebView bridge**: `ui/screens/system/index.tsx` implements `OsHost` over the typed client (`GET /kb/os/state`, `GET /kb/os/stream` SSE with the 4-streams-per-user cap and heartbeat). Host commands: none beyond existing. Cancel actions on running turns use the existing cancel requests the state carries. State: read-only; no persistence. Big-project: the stream carries `{type, at}` only and the page re-fetches (coalesced at 250 ms server-side), so a busy system does not flood; the page windows the activity list (max 100 server-side). The code-structure panel reads the project graph through `graph_file` (P5-G decoder, shared). Known cross-repo coupling G8 (page imports graph-kit source) stays recorded, `os-view-check` stays the gate. Security: the page renders only server aggregates as text; the cancel buttons are the only writes and go through the normal authenticated client. Acceptance: same sections as the Swift System page on one fixture state; stream reconnect works; stream cap 429 shown in words. Tests: the existing os fixtures (200, 400 bad window, 429); host fake for `OsHost`. Slice S1 owns `ui/screens/system/*` only.

### 9.3 P5-M Mobile control bridge

Mac source `Features/MobileControl/` (6,976 lines, 346 KB): WebSocket server `:3006`, Bonjour advertise, PIN pairing, `MobileControlManager`, bridges for chat, explorer, auto tasks, loop, issues, generation. **For macOS-first the Tauri app does NOT host `:3006`.** The relay (ADR phase 4) replaces the direct socket later and has its own design and security review ([relay design](2026-10-31-relay-design.md)); building a second native socket server in Rust now would duplicate a surface that is being replaced and would need its own review for LAN exposure and PIN brute force.

What the iPhone does meanwhile: **the Mac Swift app keeps hosting `:3006`** (feature freeze allows it: unchanged). Both apps can be installed; only the Swift app serves the phone. The Tauri app shows in Settings a plain notice "Phone pairing is provided by the Mac app until the relay ships" and a link to the relay status when that exists. To avoid a port clash the Tauri app never binds `:3006`; the core never binds it either. If the user runs only the Tauri app, the phone is not connected: this is explicit in the exit gate's deferred list. A mismatch risk exists: the phone's chat history lives in the Swift store while the Tauri chat store is separate during the overlap; the data-lifecycle rule (one durable copy) decides migration in Phase 6, not here. Slice M1 is one docs/notice change under `ui/screens/settings/` owned by the Settings owner.

---

## 10. P5-A Loop + Auto Tasks (automation-kit): the largest, last

**Mac source**: `Features/Loop/` 23,245 lines, 1.26 MB, 83 files (`LoopEngineRunner` 3,271, `LoopStageDetector` 1,964, `RepairScopeGuard` 946, `LoopEngineRunner+CodeGraph` 612, `RegressionRunner` 534, `LoopRunJournal` 420, `LoopRunService` 286, `LoopShipCoordinator` 269, `LoopWorktreeManager` 219, `LoopRunQueue` 133, `LoopEngineView` 2,167) and `Features/AutoTask/` 9,710 lines, 472 KB, 30 files (`AutoCodeUpdateService` 1,195 + `+CLI` 1,286 + `+PipelineTasks` 1,105, `AutoCodeView` 1,117, `ModelLimitsPanel` 699, `AutoTaskSettings` 502, `AutoTaskTemplateStore` 399, `CronExpression` 138, `TaskLogStore` 101). Total 32,955 lines. 77 Mac test files plus `LoopContractLab` (4,062 lines) are the safety net. `Core/Repo` (shared) supplies worktrees and ship.

**Server today**: only `POST /kb/loop/agent-run` and the new job runner **library** (not routed). There is no Node Loop engine, scheduler, journal, queue, or Auto Task runner (automation-kit 2a).

### 10.1 Answers to automation-kit decisions A1 to A8 (delegated, secure; for the user to override)

| # | Answer | Why |
|---|---|---|
| A1 | **Node core**, in the slice order below; the Swift path stays **one release behind a preference** (`automation.engine = swift|core`, default `swift` until the exit criteria of that slice pass) | The Tauri app and the relay can only start a run if the core owns it; Swift stays a fallback |
| A2 | **Files under the project are the truth** (`system/loop.json`, `system/loop-runs/index*.jsonl`); the core keeps a rebuildable SQLite index | data-lifecycle rules 1 and 4; the contract and journal travel with the project |
| A3 | **Move Auto Tasks to the SDK engine** (confined, metered, `/kb/loop/agent-run` style); keep the CLI path only for `codex` and `gemini` and only as an explicit opt-in per task | The CLI path runs a user-login binary with broad tools; the SDK path is confined and metered. Fewer unconfined processes is the secure answer |
| A4 | Nothing is scheduled on the relay; the relay may **queue a request** for the desktop to drain when on | ADR 0018: desktop is the worker; no unattended cloud execution |
| A5 | Repair approvals for edits outside scope stay **desktop-only**; phone may approve only read-only snapshot approvals already opted in | Relay permission re-check is unproven |
| A6 | Keep all 13 tasks for the move until the usage evidence is in (audit 2026-10-31 proposes 5 KEEP, 5 MERGE, 3 REMOVE, none removed yet); mark `generateDoc`, `reviewConflicts`, `generateKnowledge` as thin triggers of their kit's route | Do not decide product scope inside a port; ask the user about daily use before K4 |
| A7 | FIFO per git root by default; worktree parallelism stays opt-in | Matches `LoopRunQueue`; fewer race surfaces |
| A8 | **One shared job runner** for Loop, Auto Tasks and later ingest | The plan says job runner is core |

### 10.2 Slices to move logic into the Node core behind the job runner

Each slice ships with the Swift path still default; a slice is switched on only after its own exit gate; nothing deletes Swift (K4 is later and waits).

| Slice | Content | Exit gate (all with fakes, no paid model call) |
|---|---|---|
| **A0 Job runner routes** | Wire the existing library: `POST /kb/jobs`, `GET /kb/jobs`, `GET /kb/jobs/:id`, `POST /kb/jobs/:id/cancel`, `GET /kb/jobs/stream` (SSE, capped streams), kinds registry, per-user quota, boot-time reconcile that writes `.aborted` | Kill the server mid-run twice: both runs end `.aborted`, no orphan processes (process-group kill test), no duplicate run; flake gate (10 repeated runs) green; fixtures with errors |
| **A1 Cron and scheduler** | Port `CronExpression` first with the same fixtures (R7: timezone, DST), then the scheduler tick that enqueues jobs; persisted `schedules` table; missed-run policy (run once, never storm) | Cron fixtures identical to Swift; DST and timezone cases; 60 s tick drift test |
| **A2 Loop contract store and journal** | `system/loop.json` read/write with CAS and migration (Swift format kept, N-1 readable), `system/loop-runs/` journal writer (fail-open, crash-safe event logs), interrupted-run reconcile, index rebuild | `LoopRunJournalTests` ported; round-trip of Swift-written files in both directions; corrupt-file fixtures |
| **A3 Auto Task config and history** | One-way export of the UserDefaults blob to a project/server file (K1a, R8), run history, task logs, custom tasks, templates | Export is idempotent; corrupt copies stashed not dropped; Swift can still read |
| **A4 Stage detector and test map** | `LoopStageDetector` (1,964), test map, code-graph snapshot stage using P5-G data | Detector fixtures from the Swift tests produce identical stage lists |
| **A5 Repair scope guard and verify approvals** | `RepairScopeGuard` (946), protected paths, no-reward-hacking checks, `VerifyApprovalStore` (fail-closed) | `RepairScopeGuardTests` ported **first, byte-for-byte cases**; adversarial corpus: path traversal, symlink escape, rename of protected files, test-weakening edits; independent Fable review required |
| **A6 Runner** | `LoopEngineRunner` (3,271), queue, worktree manager, ship coordinator; steps run through the job runner; agent steps through `/kb/loop/agent-run` | `LoopContractLab` checks ported (or a node lab); regression sweep run of a fixture repo end to end with the stubbed engine; cancel mid-stage kills the process group and journals `.aborted` |
| **A7 Auto Task pipelines** | The 13 tasks on the SDK engine (A3 above), source update through the ingestion route, plan-status refresh through `/kb/outcomes/refresh` | Each task has a fake-model fixture run; metering rows appear under the right run id |
| **A8 Screens** | `ui/screens/loop/*`, `ui/screens/autotasks/*`: runs list (windowed), live run view over the job stream, stage detail, journal browser (paged), loop editor and "New Loop" wizard, per-stage enable/disable, run single stage, Auto Tasks config, schedule, model limits panel, task logs | Parity rows; 10,000 journal entries paged; a 2 MB stage log windowed |
| **A9 Switch default** | Preference defaults to `core` for macOS only after user-run real runs pass | User-run (section 12) |

**Unattended-run safety invariants carried unchanged**: confined agent (no shell, no network, approvals denied by default), repair scope guard fail-closed, journal fail-open, one run per git root, process-group kill on cancel and on quit, the sidecar never restarts under an in-flight run (feature toggle does not restart the backend), budget gate and per-user caps before any scheduled run (R5), nothing runs when the desktop is off.

**Big-project criteria**: a repo with 100k files: stage detection and test map stream and cap (no whole-tree load into memory), journal index paged, worktrees isolated per run, disk quota for worktrees and logs with cleanup, run output truncated with a pointer to the file.

**Security**: process spawn only through the job runner (sanitised child env, per-job timeout, process-group kill, per-user quota: already in the library's hardening commit). Loop and jobs **cannot be started by the Phase 7 agent or by a remote-tier request** (Phase 7 design 5.4). Repair edits only inside the loop's declared scope, protected-path list from the contract file, and the contract file itself is protected. Tokens needed for ship (MR/PR) come from the core vault (same as P5-I), never from the webview.

**Slice ownership** (parallel agents): A0 `extension/kb/job-*.mjs`, `extension/routes/jobs.mjs`, `extension/tests/jobs-routes.test.mjs`; A1 `extension/automation/cron.mjs`, `scheduler.mjs`; A2-A3 `extension/automation/{loop-contract,journal,task-config}.mjs`; A4-A5 `extension/automation/{stages,repair-guard}.mjs` (A5 has a single owner and a reviewer); A6-A7 `extension/automation/{runner,tasks/*}.mjs`; A8 `ui/screens/loop/*`, `ui/screens/autotasks/*`. New files only; `extension/routes/feature-routes.mjs` and `schema/http/*` append-only through one coordinator. ESLint layer rules apply (`automation/` sits at L3 beside `agents/`: it needs an allow-table row, added by the coordinator, never a per-file exemption).

---

## 11. What "macOS finished" means (exit gate)

The user can use the Tauri app **daily on macOS for everything except what is explicitly deferred**. Checklist, all must hold:

1. Every non-deferred row in parity sections 1 to 12 is `x+w` (verified and with a written evidence line), including the Phase 3 sections.
2. A release `.app` built, signed with Developer ID, hardened runtime, **notarised**, installs and launches on a clean Mac account, starts the sidecar, survives quit and relaunch, and the helper (if present) is inside the signed bundle.
3. The full scenario runs in one sitting with no Swift app open: open project, chat with a real provider, edit in Explorer, Library meeting with a live capture and archive, graph, Issues and Gantt on a real repo, Doc Gen from a meeting, a Loop run and an Auto Task run through the core runner, System page.
4. Big-project checks at the targets in each section pass on the reference Mac: 50k-node graph, 10k issues, 20k-line meeting, 100k-file repo search (Phase 3), 5,000-row lists.
5. No known Critical or High finding open; independent security review of the Loop/Auto Tasks runner (A5, A6) and the capture helper passed.
6. The Swift app still runs and still serves the phone; nothing was deleted.
7. The two user-run measurements in section 12 are recorded.

**Explicitly deferred past the macOS gate** (named, so the gate is honest): Windows and Linux; phone control from the Tauri app (the Swift app keeps `:3006` until the relay); 3D graph (option B scheduled right after); plugin graph engines; code-note generation batch (until the runner moves it); `Apply & Rebuild`; self-heal proposals and incident UI beyond what Settings has; GitHub/GitLab provider cards; the updater (T6); deep links (`llmide://`) unless the user wants them in the gate; Phase 7 control; relay.

## 12. User-run measurements and checks still owed

1. **Mac autobench** with the window frontmost (confirms Phase 0 numbers and the 30 s hidden phase) and the 50k-node graph fps/memory numbers (P5-G).
2. **Accessibility cadence** on a real meeting: the 800 ms read cadence holds, CPU use, AX call latency per app (Teams, Zoom, Meet) with the helper, and Phase 7 spike 1 (TCC attribution) results.
3. **Real meetings** for the live-then-archive ack (`lines`, `hash`) and dedupe: the user records meetings (MASTER-PLAN `(wait)`).
4. One real-Claude run for Loop agent steps and one Auto Task on a throwaway repo (A9).
5. Real GitHub and GitLab accounts for the Issues acceptance (read, comment).

## 13. Risks

1. **Largest port (about 33k Swift lines) carries safety invariants.** Mitigation: slice order, tests first, A5 gets its own reviewer, Swift stays default until each gate.
2. **Live helper adds a second signed binary and TCC attribution may differ per launch path.** Mitigation: spike 1 before L2, clear permission copy, helper isolation.
3. **graph-kit WASM does not hit the 50k budget in a worker.** Mitigation: T0 spike numbers first; fall back to the sidecar-native layout with a binary contract.
4. **Token move to the vault changes who calls providers.** Mitigation: per-user scope tests first, one-way migration, Keychain copy kept.
5. **Two writers on one worktree during the Swift/core overlap.** Mitigation: one engine owner per project by the preference, shown in the UI.
6. **Docs-check and the full gate read these docs**: keep tables regular; new parity rows are append-only.
7. **Scope creep from "finished"**: the deferred list above is the contract; adding to the gate requires the user.
8. **Phone dependence**: a user who only runs Tauri loses phone control; stated in the exit gate and the Settings notice.

## 14. Test strategy summary

Fake model and recorded fixtures only in CI; hostile-input fixtures for every parser (graph, issues, Mermaid, captions, journal files); windowing tests at the stated sizes; contract fixtures with errors for every new route (API bump, additive); ported Swift tests as fixtures where logic moves (cron, journal, repair guard, delta state, detector); node lab for the Loop contract; Rust unit tests for host modules; kill-mid-run, orphan-process and restart tests for the job runner; capability tests that restricted windows cannot call fs, shell or pty commands.

## 15. Open questions for the user (with recommendations)

1. **3D graph in the macOS exit gate?** Recommend no: 2D in the gate, WebGL 3D right after (option B); Swift 3D stays meanwhile.
2. **Live helper (Swift binary in the bundle) vs pure Rust capture?** Recommend the helper now, Rust later; approve the one allowed Swift addition (parity work under the freeze).
3. **Move Auto Tasks from the `claude` CLI to the SDK engine (A3)?** Answered 2026-10-31: **yes for Claude (SDK becomes the default engine); multi-engine is kept**: codex, gemini and the others stay first-class (CLI-login and API-key paths both), not opt-in extras. The engine interface and the Node gaps (write mode for codex/gemini, metering parity, key vs login) are in [the Auto Tasks audit](2026-10-31-auto-tasks-audit.md) section 4.
4. **Issues provider tokens into the core vault (W2)?** Recommend yes with the one-way Keychain migration; Swift keeps its own copy.
5. **Which of the 13 Auto Tasks do you use daily (A6)?** Answered in part 2026-10-31: the phone-command surface is kept (what Auto Tasks are for) and removals wait for evidence. The audit proposes 5 KEEP, 5 MERGE, 3 REMOVE (generateKnowledge, generateDoc, updatePlanStatus) and gives you `node scripts/auto-task-usage.mjs` to print your own per-task run counts; decide per task before A7 ([audit](2026-10-31-auto-tasks-audit.md) sections 2, 5, 7, 8).
6. **Is it acceptable that the phone works only through the Swift app until the relay?** Recommend yes. The target phone surface is a job API (enqueue named tasks with typed args, list, cancel, status, result) with tiers: read-only `review` from the native app with no approval, everything that writes or posts approved on the desktop ([audit](2026-10-31-auto-tasks-audit.md) section 3).
7. **When will you record real meetings** so the live archive ack can be switched on?
