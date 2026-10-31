# os-kit

Status: **K0 Map**, written 2026-10-31. No code was changed. Citations are `path:line` or path only; read on 2026-10-31 at `main` (`de7d1f38`), graph-kit checkout `51ff372`. Counts say how they were taken (`wc -l`, `grep -c`, `ls`). Section 9 lists where the migration plan's premises do not match the code; section 10 lists what was not verified.

## 1. Purpose

os-kit is the **System page**: one read-only screen that shows what the system is doing and has done, with no model call. The Mac app shows it as the default page of the Graph section; the data comes from one server aggregate and one change stream. Its plan row (`docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md`, kit 1) is `GET /kb/os/state` plus a live stream, a Mac web panel and "the Agentic OS view". Its own plan is `docs/superpowers/plans/2026-10-27-os-kit.md` (steps OS-1 to OS-4, then revisions 2 and 3).

The key finding of this map: **os-kit is split across three owners today** (the server aggregate in LLM-IDE, the React page in the graph-kit repository, the host and bridge in LLM-IDE), and the plan's revision 3 chose that split on purpose (the page lives in graph-kit; LLM-IDE keeps only the host).

## 2. Code on every side

### 2a. Server (`extension/`)

| Piece | Path | Lines (`wc -l`) | Notes |
|---|---|---|---|
| Aggregate reads | `extension/kb/os-state.mjs` | 185 | `KIT_TABLE` (10 kits, `:33`), `kitStatus(features)`, `usageForWindow`, `rollupTurnComposition`, `knowledgeCounts`, `TOKEN_WINDOWS`, `billableOf`. SQL only. |
| Routes | `extension/routes/os.mjs` | 264 | `GET /kb/os/state?window=day\|week&activity=<n>` (default 30, max 100; 400 `VALIDATION_FAILED` for a bad window) and `GET /kb/os/stream`. Always on: not owned by any `LLMIDE_FEATURES` group (file header). |
| Response sections | `extension/routes/os.mjs:184-264` | | `generatedAt`, `apiVersion`, `system` (features, kits, status, checks), `running` (chat turns, meeting-agent runs, live sessions, each with its `cancel` request or null), `activity`, `tokens` (window usage plus turn composition of the last 50 turns), `knowledge` (counts plus per-repo project memory), `macOnly` (`loop` and `autoTasks`: "on this Mac"), `storage`, `agents.recentRuns`. Storage and recent runs are guarded: a store failure empties them, the rest answers. |
| Stream | `extension/routes/os.mjs:64-` | | SSE; `MAX_OS_STREAMS_PER_USER` 4 (429 `TOO_MANY_STREAMS`), idle timeout 10 minutes, heartbeat 30 s, coalescing window 250 ms. Events carry `{type, at}` only; the page re-fetches state. |
| Event bus | `extension/core/os-events.mjs` | | `onOsEvent`; emitters are `recordActivity`, `recordUsage`, turn start and end, agent runs, live sessions (`schema/os/os-events.schema.json` header). |
| Contract | `schema/http/os.schema.json`, `schema/os/os-events.schema.json` | | Event schema sets `additionalProperties: false` on every variant. |
| Endpoints | `extension/server.mjs:449-450` | | Both routes in `ALL_ENDPOINTS`. v79 introduced them (`server.mjs:284`); v83 added `storage` and `agents.recentRuns` (`:290`). |
| Tests | `extension/tests/os-state.test.mjs` (10 `test(`), `os-state-running.test.mjs` (1), `os-stream.test.mjs` (14) | | `grep -c`; not run here. |

### 2b. Page and host

| Piece | Path | Size | Notes |
|---|---|---|---|
| The page (source) | `mac/LocalPackages/graph-kit/web/src/` | 9 017 lines of TS, TSX, CSS (graph-kit map, `docs/kits/graph-kit.md` 2a) | `controller.ts` (1 056), `systemGraph.ts` (288), `host.ts` (113, the `OsHost` interface), `components/` (`Brain`, `CodeStructure`, `HubOverview`, `NodeSearch`, `Recent`, `Selection`), `orbit/` (three.js), `wasm/` (the Rust core as embedded bytes). Own `theme.css`, `os-tokens.css`, `theme.ts`. |
| OS graph core | `mac/LocalPackages/graph-kit/rust/os-graph/` | 6 037 lines Rust | Community detection, orbit layout, viz graph; WASM. See the graph-kit map. |
| Host package | `ui/os-view/` | `src/` 984 lines over 11 files (`api.ts` 123, `bridge.ts` 187, `hosts.ts` 285, `stream.ts` 118, `sse.ts` 58, `boot.ts` 73, `main.tsx` 32, `components/DevConnect.tsx` 88) | Supplies graph-kit's `OsHost` over the native bridge (Mac) and over HTTP (dev). Aliases `@dnsmalla/graph-kit-web` to the graph-kit source (`ui/os-view/vite.config.ts`). |
| Host tests | `ui/os-view/tests/os-view.test.mjs` | 919 lines, 64 `test(`/`it(` | |
| Built bundle | `mac/Sources/LlmIdeMac/Resources/os-view/` | | Committed; `make os-view` writes it, `make os-view-check` fails when stale (`Makefile:245-262`). Runs from `file://` in a WKWebView, so one classic IIFE script (`vite.config.ts`). |
| Tokens | `ui/os-view/src/tokens.generated.css` | | From `schema/design/tokens.json`; the page also carries graph-kit's own theme (see the ui-kit map). |

### 2c. Mac app (`mac/Sources/LlmIdeMac/`)

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Bridge | `Features/System/Services/SystemBridge.swift` | 938 | Messages `ready`, `open`, `openFile`, `request`, `native`, `subscribe`, `unsubscribe`. Server calls the page may make: `state`, `cancelChat`, `stopAgentRun`, `skillLibrary`, `agentHistorySettings`, `setAgentHistoryRetention`, `clearAgentHistory`, `compactAgentHistory`. Native calls: `projectGraph`, `routines`, `file(path)`. |
| Event stream | `Features/System/Services/SystemEventStream.swift` | 165 | Subscribes to `/kb/os/stream` for the page. |
| Views | `Features/System/Views/SystemView.swift` (34), `SystemWebView.swift` (396) | 430 | WKWebView host. |
| Section switch | `Shell/GraphSectionView.swift` | 78 | Graph section: System page or code graph. |
| Contract seam | `Core/Contracts/ProjectGraphProviding.swift` | 39 | Lets the System page get the project graph without naming CodeGraph. |
| Tests | `SystemBridgeFileTests` (37 `func test`/`@Test` by `grep -c`), `SystemBridgeNativeTests` (34), `SystemBridgeStorageTests` (36), `SystemViewTests` (38) | | Not run here. |
| Feature key | none: `System` is in `mac/Scripts/feature-map.txt` as a sealed feature (CLAUDE.md lists it among the 17) | | |

### 2d. Extension and desktop

The Chrome extension has no System tab (plan, "The Chrome extension gets nothing for now"). `desktop/` has no os view; it would host the same bundle (plan: "the same bundle is the future desktop page").

## 3. Cross-kit edges

| # | From to | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| O1 | os-kit server to every kit's tables | direct SQL and in-process registries (`listInFlightChatTurns`, `listRuns`, `listActiveSessions`, `memoryLedgerRepos`) | ok (server layering: routes may import any Node layer) | `extension/routes/os.mjs:12-19` |
| O2 | os-kit to graph-kit (code graph freshness) | SQL read of `code_graph_meta` | **✗ under K0**: reads a graph-kit table directly, no route | `extension/kb/os-state.mjs:165` (graph-kit map G9) |
| O3 | os-kit page source to graph-kit repo | build-time source alias across a repository boundary | **✗ under K0** (graph-kit map G8, decision Q2) | `ui/os-view/vite.config.ts` |
| O4 | System page to CodeGraph (Mac) | `ProjectGraphRegistry` seam | C | `Core/Contracts/ProjectGraphProviding.swift` |
| O5 | System page to Loop and Auto Tasks | none: `macOnly` placeholders and the native `routines` call | gap | `extension/routes/os.mjs` (`macOnly`) |
| O6 | System page to Chat and agent runs | `cancel` requests carried in the state, executed through the bridge | C | `SystemBridge.swift` |
| O7 | System page to Storage and agent history | `GET /kb/storage` content inlined, plus clear and compact calls | C | `extension/routes/os.mjs:256-262` |

Cycles: none found. Every kit is read by os-kit; os-kit is read by none, except that the graph-kit repository holds the page (O3), which is an ownership loop rather than a code cycle.

## 4. Delegated vs owned

| Piece | Label | Reason |
|---|---|---|
| Aggregation, token windows, kit table | Owned | The system's own accounting; no model. |
| Kit table (`KIT_TABLE`) | Owned, **hand-copied** from the plan | Needs a generated source (section 9). |
| Change stream and coalescing | Owned | Cost control: no polling, no tokens. |
| Page, controller, orbit renderer | Owned (graph-kit) | One look and one renderer for Mac and desktop. |
| Community detection and layout (Rust core) | Owned | A computation (graph-kit map). |
| Cancel actions | Owned, permission-relevant | A stop button is an action on the user's runs; the bridge passes only requests the server put in the state. |
| File read for the code preview (`native file`) | Owned, permission-relevant | Reads project files for the page; confinement to the repo root is checked on use (`SystemBridge.swift` comment on `SystemOpenFileRequest`); the check itself was not read in full. |
| Model use | none | No model call anywhere in this kit. |

## 5. State and data (feeds K1a)

os-kit owns **no stored data**. The state is derived from `usage_ledger`, `turn_composition`, `activity`, `code_graph_meta`, `project_memory_ledger`, `sources`, the agent store (`agent.db`) and in-memory registries. Under [data-lifecycle](data-lifecycle.md) it is a rebuildable view with no unique data. The page keeps view state (range, selection) in the web view only.

## 6. What K1 would move (proposal)

The plan sizes os-kit at 3 to 4 tasks (K0 to K2) and 2 to 3 for K3, K4. The server and the page are already built; K1 is therefore **closing gaps, not moving code**:

1. **Kit health from the kits themselves.** Replace the hard-coded `KIT_TABLE` with the list the kit READMEs and the feature matrix define, and add the two rows it lacks (ui-kit and desktop-shell). A drift check compares the table with `docs/kits/README.md`.
2. **Close O2.** Read code-graph freshness through a graph-kit helper (a function the kit exports), not SQL in os-kit.
3. **Decide O3** (graph-kit decision Q2): where the page source lives. Until decided, keep `os-view-check`.
4. **Fill the `macOnly` gap** when automation-kit's job runner moves Loop and Auto Task state server-side (plan, Gaps): no page change needed.
5. **Desktop host.** A third `OsHost` implementation over HTTP for the Tauri app (the HTTP host exists for dev, `ui/os-view/src/hosts.ts`).

## 7. Decisions needed from the user

Options and the recommended answer; the recommendation is mine.

| # | Question | Options | Recommended |
|---|---|---|---|
| S1 | Where does the System page source live: graph-kit (revision 3, today), `ui/os-view` in LLM-IDE, or a new `os-kit` repository? | keep; move to LLM-IDE; new repo | keep in graph-kit for now. You decided this on 2026-10-27 (revision 3); the cost is O3 (a build across a repo boundary), which `os-view-check` already gates. Revisit only if a second consumer of the OS graph appears. |
| S2 | Should the kit table become generated (single list shared with the kit README index and the feature matrix)? | generate; keep hand-copied | generate, with a test that fails when `docs/kits/README.md` and `KIT_TABLE` disagree. It is the one place where "what kits exist" is duplicated. |
| S3 | Should the System page be reachable from the Chrome extension and the phone (relay)? | no; extension tab; phone view | no for the extension. For the phone, only after sync-kit and only a **view with no cancel actions** (the cancel and clear calls are destructive; see the Phase 7 design for the rule that the phone tier never approves destructive classes). |
| S4 | Is the `file` native call acceptable as is for the preview? | yes; add a size and type cap and an audit line; drop the preview | keep, add a size cap and log one line per read; confirm the root-confinement test covers symlinks (not verified here). |
| S5 | Add `ui-kit` and `desktop-shell` rows to the kit table now? | yes; wait for K1 of each | yes, with `features: []`, so the map shows what the migration plan lists. |
| S6 | Loop and Auto Task are "on this Mac": show them through a Mac-pushed summary now, or wait for the job runner? | push now; wait | wait. A push path would be thrown away when the job runner lands, and the placeholder is honest. |

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A change in graph-kit `web/` ships only after a pin bump and a rebuild of the committed bundle; `os-view-check` fails when they disagree | `make graphkit-bump` moves all pins and rebuilds the bundle (CLAUDE.md) |
| R2 | The aggregate reads many tables per call; cost grows with data | one call under 50 ms on a seeded DB was an OS-1 exit gate; the gate's test was not re-run here (section 10) |
| R3 | Cancel and clear are actions reachable from a web view | the bridge executes only request shapes it knows; keep the allow-list in `SystemBridge.swift` and cover new calls with tests |
| R4 | A stream client per window leaks slots | cap 4 per user, idle timeout and cleanup exist (`routes/os.mjs`) |
| R5 | `KIT_TABLE` drifts from the real kit list | S2 |

## 9. Drift, gaps and corrections to the plan's premises

1. The plan says the page is "React + ui-kit". The page is graph-kit's, with its own theme files; ui-kit tokens reach it only through `ui/os-view`'s generated CSS (ui-kit map, UI4).
2. The plan's os-kit row says "mac web panel". It lives in the Graph section as the default page (revision 2), not on Home.
3. `KIT_TABLE` has 10 kits; the plan's table also lists ui-kit, desktop-shell and Settings, and the file's comment says it mirrors the plan's table.
4. The plan's "kits as rings: delegated vs owned" is not in the state response: `kits` carries `id`, `requires`, `enabled` only.
5. `macOnly` placeholders still stand for Loop and Auto Tasks (known, plan "Gaps").
6. `/kb/os/*` has no feature gate and no `LLMIDE_FEATURES` key, so a `mobile_sync`-only or lite build still serves it; not a defect, but the plan's "always" column should say so.

## 10. What I could not verify

- Live behaviour of any route or the page; no server, app or browser was run, and no test was run.
- The path-confinement logic of the `file` native call (only its comment and the test file names were read).
- Whether the 50 ms OS-1 gate still holds on a large database.
- The completeness of the `os-events` emitter list (read from the schema header, not traced).
- Whether OS-4 (polish: cancel buttons, empty states, kit README) was finished; this file is the kit README.
