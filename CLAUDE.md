# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Product naming:** user-visible **LLM-IDE**, repo slug **llm-ide**, code types **LlmIde**, wire/bundle **llmide** — see [ADR 0016](docs/decisions/0016-naming-convention.md).

## Common Commands

### Development & Building

```bash
# Initial setup (install deps, verify tools, enable git hooks)
./setup.sh

# Extension development (other scripts: extension/package.json)
cd extension
npm run server        # Start the local Node server (127.0.0.1:3456)

# macOS app development
cd mac
swift build           # Build the app
LLMIDE_KEYCHAIN_BACKEND=memory swift test   # Run the tests (XCTest + swift-testing) — see Running Tests
make build-mac-lite   # Build lite app: excludes Graph, Explorer, Gantt, Issues, DocGen, Terminal; leaves Chat, Auto Tasks, Mobile Sync, Live Capture, Library
make build-mac-min    # Build minimum app: Chat only (excludes all 7 excludable features: Graph, Explorer, Gantt/Issues, DocGen, Terminal, Auto Tasks, Mobile Sync)

# Testing (lint/format/docs targets: see Makefile)
make test             # Run extension tests (Node test runner)
make test-mac         # Run macOS app tests (sets the memory keychain for you)
make regression       # Pre-push regression gate
```

### Running Tests

```bash
# macOS app tests (XCTest + swift-testing). ALWAYS set the memory keychain
# (make test-mac does): without it KeychainStore uses the real login keychain,
# and from a terminal a SecItem call blocks in securityd waiting for a prompt
# nobody answers — one test then takes minutes and fails, and a full run
# stretches from ~60 s to 10+ min. Pipe output to a file, not `| grep`.
cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test          # All tests (~60 s)
LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter testAuthFlow   # Filter by name

# Mac↔iOS shared wire types (swift-testing in a standalone SPM package)
make test-shared-protocol                         # builds + tests ios_app/SharedProtocol
```

## Architecture Overview

LLM-IDE is a **local-first AI meeting intelligence system** comprising four surfaces that share a single backend:

1. **Chrome Extension** (React 18 + TypeScript + Vite) — Meeting capture via platform captions, side panel UI
2. **macOS App** (SwiftUI) — Native capture via Accessibility API, full KB + Issues + Gantt + Code Assistant
3. **Local Server** (Node 20+, pure HTTP) — Bound to 127.0.0.1:3456, handles AI orchestration and data persistence
4. **Mobile Control** (iOS + Mac native) — iPhone companion for chat, explorer, and auto-tasks

### Core Data Flow

1. **Capture**: Content scripts read platform CC every 800ms → `CAPTION_FINAL` messages → server writes to SQLite
2. **Processing**: `/generate-notes`, `/extract-entities`, `/generate-questions` endpoints shell out to Claude CLI (`claude -p`)
3. **Planning**: `/kb/generate-plan` grounds planner in FTS5 search results; `/kb/analyze-risks` annotates tasks
4. **Action**: `/kb/generate-code` produces guardrail-scanned diffs; approval dispatches to GitHub/GitLab/Backlog/Linear
5. **Outcome**: Polling writes results back to `outcomes` table for future planning context

**The Library is the hub, not just meetings.** Non-meeting sources (Email, Slack, Box/documents, repos) also land in the KB as searchable notes. Ingestion is unified through `extension/kb/sources.mjs`, with per-source adapters in `extension/connectors/` (e.g. `box.mjs`). Two patterns: **Pattern A** (index into `sources` + scheduled re-fetch, e.g. Box) vs **Pattern B** (fetch-only → note, forward into a folder). Box is the reference connector when adding a new source.

### Key Architectural Decisions

- **Claude CLI default** — Users authenticate via `claude login`; optional per-user API keys stored in encrypted vault
- **Pure Node HTTP** — No framework (Express/Fastify); reduces dependency surface
- **SQLite WAL+FTS5** — Single database per install, full-text search across meetings/code/tickets
- **Per-user tenancy** — Every owned row carries `user_id`; FTS5 hits are hydrated with user-scoped queries
- **Append-only migrations** — Numbered SQL migrations under `extension/kb/migrations/` (0001–0040)

## Project Structure

```
llm-ide/
├── .skills/             # git submodule → dnsmalla/agent-kit (single source of truth)
├── scripts/install-skills.sh  # symlink kit into Claude/Cursor/Codex/.agents/Gemini
├── extension/           # Chrome extension + local server
│   ├── core/            # Framework-free primitives (config, utils, errors, logger)
│   ├── server/          # HTTP server (no framework), routing, middleware
│   ├── kb/              # SQLite knowledge base, migrations, FTS5; sources.mjs = source hub
│   ├── routes/          # HTTP route modules (router.mjs + agent/chat/live/planning/review/…)
│   ├── providers/       # Model-provider layer: dispatch, CLI spawn, retry/backoff, web client
│   ├── agents/          # Server pipeline agents (planner, risk, codegen, dispatcher, …) — not skills
│   ├── llm_agent/       # Claude CLI orchestrator + synced agent-tool defs
│   ├── connectors/      # Inbound source adapters (box, git, issues, qa, scip, email, slack + OAuth)
│   ├── llm-sources/     # LLM source registry + state (feeds kb/sources.mjs hub)
│   ├── mcp/             # MCP server config + Claude MCP source adapter
│   ├── graphkit/        # Server-side graph access (graph.mjs seeds/neighbors, memory reader/writer)
│   ├── graph_generation/ # Graph-engine contract: how an engine is supplied + swapped (README)
│   ├── guardrails/      # Secret/PII/destructive-op pattern scanners
│   ├── plugins/         # Extension plugin loader/installer (claude-adapter, loader, installer, state)
│   ├── src/             # React UI (side panel, popup, content scripts)
│   ├── tests/           # Node test runner (tests/**/*.test.{ts,mjs})
│   └── server.mjs       # Server entry point
├── mac/                 # Native macOS app
│   ├── LocalPackages/
│   │   └── graph-kit/   # THE graph repo — one folder, two products:
│   │       ├── Sources/GraphCore/   # ALWAYS LINKED: canonical model + JSON contract
│   │       │                        #   + layout (2D/3D) + memory-artifact rendering
│   │       ├── Sources/GraphKit/    # PLUGGABLE ENGINE: scanners, extractors,
│   │       │                        #   MemoryGenerator (InfiniteBrain), GraphMerger
│   │       ├── Sources/Graph*Lab/   # graph-layout-lab + graph-engine-lab gates
│   │       ├── typescript/          # TS implementation + CLI (plugin runtime)
│   │       ├── schema/              # canonical JSON schema + conformance fixtures
│   │       └── graph-engine.json    # plugin manifest
│   ├── Sources/LlmIdeMac/     # Shell → Features → Core (see "Module Boundaries (macOS app)" below)
│   │   ├── Core/        # Leaf infrastructure — never build-excluded, importable by ANY layer.
│   │   │   │            #   Subfolders are named by CAPABILITY, not by feature:
│   │   │   ├── Contracts/   #   Cross-feature protocols: LoopRunning, TaskLogWriting,
│   │   │   │                #   MobileFeatureBridge, MobileBridgeHosting,
│   │   │   │                #   LoopLaneControlling, ProjectNotesProviding,
│   │   │   │                #   NoteSourceClassifying (Library's SourceRegistry seam)
│   │   │   ├── DesignSystem/#   Shared SwiftUI chrome: FileTreePanel, EditorTabBar, FileDetailView,
│   │   │   │                #   ColorPalette, Components/ (SettingsSectionCard, ResizableDivider,
│   │   │   │                #   PersistedPanelWidth, …), LibraryItem+UI (category colors)
│   │   │   ├── Editor/      #   CompletionController/Menu, HunkStagingList
│   │   │   ├── Generation/  #   GenerationRegistry + GenerationViewModel (concrete type,
│   │   │   │                #   referenced unconditionally by Shell — see invariants.md)
│   │   │   ├── Incidents/   #   Incident capture + Self-Heal proposals (Loop's backing code,
│   │   │   │                #   like Memory/ and Verification/)
│   │   │   ├── Memory/      #   Fault reports, Q&A store — works with CodeGraph compiled out
│   │   │   ├── Networking/  #   LlmIdeAPIClient + API/ extensions (and the wire models they decode:
│   │   │   │                #   SourceConnectorClassification, LegacyExportRecord), BackendManager,
│   │   │   │                #   AuthRedirectGuard
│   │   │   ├── Notes/       #   On-disk notes store every feature reads (Library's backing code):
│   │   │   │                #   LibraryItem(Store), NoteService, NotesFolderConfig, MeetingIndex,
│   │   │   │                #   FolderIndexer, Markdown/MeetingFrontmatter, FrontmatterCoder,
│   │   │   │                #   NoteAction, MeetingSummary, IngestTemplateRenderer, launch-time
│   │   │   │                #   folder migrations (NotesToLlmDoc, SourceFolder, SourceNestedLlmDoc)
│   │   │   ├── Platform/    #   App lifecycle + shared utilities: AppDelegate, BashService, Config,
│   │   │   │                #   AppIdentity, AppJSON, DateFormatters, PathUtils, SecretRedactor,
│   │   │   │                #   FilesystemSlug, AgentTypes, ActivityStore, SessionStore,
│   │   │   │                #   NotificationNames, LaunchPathResolver, ProcessedActionsRegistry
│   │   │   ├── Project/     #   Project/Plan/CodeTree models, WorkspaceRoot, FileSystemTree,
│   │   │   │                #   ExplorerPaths, ProjectLayout, ProjectScaffolder, ProjectSkillsInstaller,
│   │   │   │                #   ProjectStore, ProjectExporter + ProjectExportBundle (KB → folder export)
│   │   │   ├── Repo/        #   Models/ + Services/ — git clients shared by SourceControl,
│   │   │   │                #   Issues, Gantt, AutoTask behind the RepoBackend protocol
│   │   │   │                #   (GitHub/GitLab adapters + RepoBackendFactory in Services/Repo/),
│   │   │   │                #   RepoFileWatcher, RepoGraphLocator
│   │   │   └── Verification/#   Verify-approval store, RegressionRunner, fault verify/repair (Loop's)
│   │   ├── Features/    # One folder per ShellState.Section menu item + 4 non-menu features
│   │   │   │            #   (Chat, MobileControl, Generation, Terminal). Normally
│   │   │   │            #   {Models,Services,Views}; MUST NOT reference another feature.
│   │   │   ├── Library/ · Live/ · Explorer/ · Search/ · ReviewConflicts/ · SourceControl/
│   │   │   ├── Issues/ · Gantt/ · Visual/ · DocGen/ · AutoTask/ · CodeGraph/ · Loop/ · Settings/
│   │   │   ├── Chat/    #   splits further: Models/ (incl. DiffStats, ProposedEdit, ProposedPlan)
│   │   │   │            #   Engine/ Session/ Transport/ Services/ Views/ (Panel/ = CodeAssistant
│   │   │   │            #   + its action sheets, Quick/ = menu bar + sheet, Shared/)
│   │   │   ├── MobileControl/  # WebSocket server, Bonjour, PIN cache, pairing UI
│   │   │   ├── Generation/     # Doc Gen + Visual's shared generation VIEWS (not the
│   │   │   │                   #   registry/view-model, which stay in Core/Generation)
│   │   │   └── Terminal/       # excludable; Shell/Chrome/TerminalPanelState.swift stays
│   │   │                       #   in Shell — see invariants.md
│   │   ├── Shell/       # Composition root — the ONLY layer permitted to name every feature:
│   │   │   │            #   app entry (LlmIdeMacApp.swift), AppShell, ContentView,
│   │   │   │            #   FeatureCatalog, FeatureRegistry, AppFeature, ShellState,
│   │   │   │            #   DeepLinkRouter, LoginView, ReconnectView, CrashReportStore,
│   │   │   │            #   PassiveModule, ProjectMigrator, Recovery/, Welcome/
│   │   │   └── Chrome/  #   StatusBar, ActivityBell, TerminalPanelState (exempt from the
│   │   │                #   feature/boundary rule, NOT from build-exclusion — see invariants.md)
│   │   └── ClaudeLink/  # Top-level (not under Core/), but declared Core in the feature map —
│   │                    #   Claude SDK/CLI glue incl. ClaudeSubscriptionUsageClient;
│   │                    #   see docs/explanation/claude-linker.md
│   └── Tests/           # XCTest + swift-testing suites
├── docs/                # mkdocs site (Diátaxis framework)
└── kb/                  # Runtime data only (SQLite db, dev secrets)
```

### Central skills (all agents)

Process/domain `SKILL.md` skills are **not** authored in this repo. They live in the
[`.skills`](https://github.com/dnsmalla/agent-kit) submodule. After clone/pull:

```bash
git submodule update --init --recursive .skills
bash scripts/install-skills.sh          # also run by ./setup.sh
```

That creates relative symlinks under `.claude/skills`, `.cursor/skills`,
`.codex/skills`, `.agents/skills`, and `.gemini/skills` so every agent tool
loads the same kit. Agent-loop tool **definitions** still sync with
`cd extension && npm run sync:skills` (handlers stay local). See
[`docs/how-to/install-central-skills.md`](docs/how-to/install-central-skills.md).

### Module Boundaries (Extension)

Arrows indicate "may import". **Enforced by ESLint** (the allow-table in `extension/eslint.config.mjs`); the ratchet is at **zero violations** — never add per-file exemptions; refactor the edge instead.

```
L0 core         → nothing internal
L1 kb           → core                          (data access only)
L2 server libs  → core, kb                      (auth/vault/jwt/rate-limit/metrics)
   providers    → core, kb, server libs         (model dispatch/CLI/retry/web client)
L3 connectors · graphkit · guardrails · plugins · llm-sources · mcp → L0–L2
   agents       → L0–L2 + connectors/graphkit/guardrails   (pipeline orchestration)
   llm_agent    → L0–L2 + graphkit/plugins/llm-sources/mcp (skill/plugin surface)
L4 routes       → any Node layer, never src/    (server.mjs, routes/*,
                                                 server/*-routes.mjs)
                  — nothing may import a route module
```

- **`core/`** — Framework-free primitives only (Node built-ins + 3rd-party libs)
- **`server/`** — HTTP routing, request pipeline (CORS → JWT → rate-limit → route)
- **`kb/`** — SQLite access, every state-mutating helper takes `userId` first; `sources.mjs` owns the non-meeting source hub
- **`agents/`** — Server pipeline modules (`.mjs`, not skills): planner, risk, codegen/codegen-apply, dispatcher, outcome-watcher, meeting-agent, summarize, …
- **`graphkit/`** — Code-graph primitives (graph model, layouts, memory writer); consumed by `agents/planner.mjs` + `agents/code-sync.mjs`, rendered by the Mac app
- **`plugins/`** — Discovers/loads/install extension plugins; `claude-adapter.mjs` bridges the plugin tool surface to the agent runtime

### Module Boundaries (macOS app)

Rule: **`Shell → Features → Core`**. A feature may import `Core`. A feature must **never** reference another feature, and never `Shell`.

Enforced **textually** by `mac/Scripts/feature-boundaries.sh` (run by `make regression`), because Swift has one module here — nothing at the compiler level stops one feature folder from importing another.

Always compiled (never build-excludable): `Shell/`, `Core/`, `ClaudeLink/` and the features **Chat, Library, Live, Settings, ReviewConflicts** — Chat is the product's one non-excludable feature (`agent_chat`), and the other four have no `LLMIDE_FEATURES` key of their own, so they ship in every build, `make build-mac-min` included. Every other `Features/` folder is excluded by one of the seven `LLMIDE_FEATURES` keys in `mac/Package.swift`, which also applies the `file_explorer` dependency closure itself (dropping `file_explorer` drops `code_graph_3d`, `gantt_issues` and `doc_gen` with it, mirroring `AppFeature.requiredDependencies`).

**The gate currently REPORTS but does not yet ENFORCE the feature/feature rule.** Enforcement is per-feature, via a `sealed` third column in `mac/Scripts/feature-map.txt`, and **no feature carries it yet**. 44 known cross-feature references currently emit `warn` and the gate still exits 0 because of them — do not assume a cross-feature reference fails the build today; it does not.

The gate's six checks that **do** fail the build (exit 1) today:
1. Any **always-compiled layer** (`Shell`, `Core`, `ClaudeLink`, Chat, Library, Live, Settings, ReviewConflicts — derived from `feature-map.txt` minus the excludable folders, not hard-coded) referencing a symbol owned by a build-excludable `Features/` folder without the matching `#if FEATURE_*` guard. Before, only `Shell`/`Core` were scanned, so an unguarded edge from an unsealed always-compiled feature passed the gate and surfaced only as a compile error in a reduced build.
2. An `#elseif` anywhere in an always-compiled layer (flag-guard code must fail closed, not branch on an untracked condition).
3. Every `libExcludes` path in `mac/Package.swift` must exist on disk — SwiftPM itself only *warns* on a bad exclude path and still exits 0, so this is the only thing that catches a moved file silently rejoining a build it should be excluded from.
4. Every `testExcludes` entry in `mac/Package.swift` must exist under `mac/Tests/LlmIdeMacTests/`, for the same reason.
5. Every `mac/Sources/LlmIdeMac/….swift` path named by a literal in `scripts/`, `mac/Scripts/`, or `Makefile` must exist — a move never breaks Swift (one module), but it silently breaks anything outside Swift that names a path.
6. Every test file that references a build-excludable feature's top-level type must be in that feature's `testExcludes` in `mac/Package.swift` — the test target is only ever compiled with all features, so a missing entry otherwise stays invisible until someone runs `swift build --build-tests` under a reduced `LLMIDE_FEATURES`.

Known limitation, stated plainly: **the gate cannot see edges that pass through `Core/`.** Several features' backing code legitimately lives in `Core/` today — `Core/Repo/` is Source Control's, `Core/Generation/` is Doc Gen + Visual's, `Core/Memory/` and `Core/Verification/` are Loop's, `Core/Notes/` is Library's — and references into those from other features are invisible to the check by design (it only flags edges from one `Features/` folder into another; every symbol under `Core/` is an allowed target). Sealing every feature will therefore produce a *clean* gate over a tree that still has real coupling running through `Core`.

Cross-feature protocols belong in `Core/Contracts/`: `LoopRunning`, `TaskLogWriting`, `MobileFeatureBridge`, `MobileBridgeHosting` (what the Auto Task / Loop phone bridges — which live in `Features/AutoTask/` and `Features/Loop/` — may ask of the mobile manager, with Foundation-only request/reply enums so they never import `SharedProtocol`), `LoopLaneControlling` (the AutoTask loop lane the Loop's phone bridge drives), `ProjectNotesProviding`. When two features need to talk, add or extend a protocol there rather than importing one feature's concrete type from another — and never un-seal a sealed feature to land a change; move the shared type to `Core/` or add a `Core/Contracts/` protocol instead.

## Critical Invariants

**Before modifying any file, read the relevant section from [`docs/explanation/invariants.md`](docs/explanation/invariants.md).** Each invariant maps to a previous regression.

### Caption Scraper (`extension/src/content/caption-scraper.ts`)
- **Per-speaker state map** — `speakerState: Map<speaker, { sessionId, text, lastSeen }>`
- **SCRAPE_INTERVAL_MS = 800** — One snapshot every 800ms
- **Only send when text changes** — Update `lastSeen` but don't emit if `prev.text === text`
- **Content-based validation, NOT position-based** — `isValidCaption()` checks text against UI patterns
- **Combined-speaker suffix stripping** — Remove `& N others` and `他N名` in `sanitizeSpeaker()`

### Server (`extension/server.mjs`)
- **CORS strict allowlist** — `chrome-extension://<id>` + `localhost` / `127.0.0.1`; echo `Origin`, never `*`
- **Server binds to `127.0.0.1`** — Remote bind requires `LLMIDE_ALLOW_REMOTE=1`
- **`runClaude()` prefers user's stored `claude.apiKey`** — Falls back to operator's Claude CLI; never silent fallback
- **8 MB request body limit** — DoS guard
- **500 k-char prompt cap** — Keep within Claude CLI comfort zone
- **`SERVER_API_VERSION` + `ENDPOINTS` array** — Bump version when wire format changes

### SQLite (`extension/kb/db.mjs`)
- **better-sqlite3 is single-writer** — All writes serialized by V8 event loop
- **WAL mode enabled** — Readers never block writers, writers never block readers
- **DO NOT open second Node process writing same DB** — Corruption risk
- **All multi-step mutations use `db.transaction()`** — Only atomicity mechanism

### TypeScript Code Conventions
- **All LLM hooks accept `language?: string`** — Forward to request body
- **AbortController on every request** — Cancel-on-unmount via `useEffect` cleanup
- **Strict response validation** — `typeof data?.notes !== 'string'` → throw

## macOS App Conventions

Swift type suffixes communicate role — pick matching suffix when adding new types:

- **`*Service`** — Long-lived background work/orchestration (e.g., `BackendManager`, `CodeWorkflowService`)
- **`*Store`** — Owns persistent state, reads/writes on-disk store (e.g., `ChatSessionStore`, `DocTemplateStore`)
- **`*Client`** — Wraps external HTTP/IPC API, no state beyond URL/token (e.g., `GitLabClient`, `LlmIdeAPIClient`)
- **`*Manager`** — Controls system resource needing lifecycle management (e.g., `RepoManager`)
- **`*Mirror`** — Passive shadow of remote state, never mutates (e.g., `LiveSessionMirror`)
- **`*Router`** — Request/event dispatch, pure wiring (e.g., `DeepLinkRouter`)

### Apply & Rebuild (Settings → Workspace)

On a source checkout with a Swift toolchain, Settings → Workspace shows a **Build** card with **"Apply & Rebuild (remove disabled code)"** — an in-app rebuild that actually excludes disabled features from the compiled binary, not just hides them. Owned by `FeatureRebuildService` (`mac/Sources/LlmIdeMac/Features/Settings/Services/FeatureRebuildService.swift`); the card (`BuildRebuildSettingsCard` in `mac/Sources/LlmIdeMac/Features/Settings/Views/FeatureProfileSettingsView.swift`) renders nothing when `isEligible` is false, so it never appears on a non-engineer machine or a distributed release build (`Scripts/release.sh` sets `LLMIDE_OMIT_SOURCE_ROOT=1`, which omits the `LLMIDESourceRoot` Info.plist key eligibility depends on). Flow: confirmation dialog → `mac/Scripts/rebuild-features.sh` stages a release build + `mac/Scripts/sign.sh` off to the side (running app untouched) → "Restart & Install" spawns `mac/Scripts/rebuild-swap.sh` detached, which waits for this process to exit, keeps the previous `.app` as `<name>.app.bak` (one rollback slot), installs the staged bundle, and relaunches — logging to `<install-target-minus-.app>.rebuild.log`. See `docs/spec/macos-app.md` ("Apply & Rebuild") for the full contract.

## Mobile Control System

Mac app ↔ iPhone companion (WebSocket `:3006`, Bonjour, PIN pairing). Details: [`mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md`](mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md) and `docs/mobile/quick-start.md`.

## Entry Points for Development

### Where to Add X

| I want to… | Touch these files |
|---|---|
| Support new meeting platform | `extension/src/content/caption-scraper.ts` (add reader), `detectPlatform()` |
| Add new AI feature | New server endpoint in `extension/server.mjs` + add to `ENDPOINTS` + bump `SERVER_API_VERSION` + add to `REQUIRED_ENDPOINTS` in `extension/src/sidepanel/App.tsx` + new hook under `extension/src/sidepanel/hooks/` (with `language` param + AbortController) |
| Add new UI language | `LANGUAGE_NAMES` in `extension/server.mjs` + `HEADING_LABELS` for questions + LanguageSelector option |
| Change server port | `extension/src/lib/config.ts` default + `extension/server.mjs` `PORT` + CORS origin list |
| Persist UI state | `chrome.storage.local` via the owning hook; do NOT add new store |
| Add new tab | `TABS` array in `extension/src/sidepanel/App.tsx` + new panel block |
| Persist meeting data | Extend `SavedTranscript` in `extension/src/lib/storage.ts`; write in `stopRecording()` |
| Install agent skills into a user project | Auto on New Project / Rebuild via `POST /kb/project/install-skills` (`extension/kb/install-project-skills.mjs`); kit lives in `.skills` |
| Add mobile control feature | `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift` (Mac dispatch) + `ios_app/MyApp/Services/ConnectionService.swift` (iOS client) + `ios_app/SharedProtocol/` (wire types) |
| Extend LLM-IDE mobile API | Add endpoint to `extension/server.mjs` + expose via `LlmIdeAPIClient` on Mac (mobile chat proxies through Mac app) |

### Starting Points for Reading

- **Server internals** — `extension/server.mjs` → follow router into `extension/routes/router.mjs`
- **Claude linker** — [`docs/explanation/claude-linker.md`](docs/explanation/claude-linker.md): the two layers (`extension/llm_agent/sdk/` + `extension/providers/`, `mac/…/ClaudeLink/`) that own ALL Claude SDK/CLI knowledge; SDK updates edit only these
- **KB operations** — `extension/kb/db.mjs` (every state-mutating helper takes `userId` first)
- **Graph generation** — [`extension/graph_generation/README.md`](extension/graph_generation/README.md): the engine contract, how a plugin supplies one, and how to unplug the compiled-in engine. Everything graph lives in `mac/LocalPackages/graph-kit/` — a **git submodule** of `github.com/dnsmalla/graph-kit` (one folder, two products: `GraphCore` always linked, `GraphKit` unpluggable) — and `mac/Sources/LlmIdeMac/Features/CodeGraph/` (app side). Changes to the engine are commits in that repo; land them there, then bump **both** pins here — the `revision:` on the `.package(url:)` in `mac/Package.swift` (what the build actually resolves) and the submodule gitlink (the local working tree)
- **Chat slice** — `mac/Sources/LlmIdeMac/Features/Chat/` (see the structure tree above). Logic lifted out of `ChatEngine` is asserted by `make chat-gates` → `cd mac && swift run chat-contract-lab`, an executable for the same reason the graph labs are: **a Command-Line-Tools-only toolchain has no XCTest, so there `make regression` skips `swift test` entirely** (`test-mac` guards it behind `HAS_XCTEST`) and `swift build --build-tests` fails too — with full Xcode the suite runs, and the lab still gates the lifted logic. A type the lab asserts must be `public` — the lab is a separate target, and `@testable import` is test-target-only
- **Graph layout** — `mac/LocalPackages/graph-kit/Sources/GraphCore/Layout/GraphLayoutEngine.swift` is the single entry point. Verify any change with `cd mac/LocalPackages/graph-kit && swift run -c release graph-layout-lab --compare` (an executable, so the gate also runs on a toolchain without XCTest). **Never prune edges to make a dense graph legible** — weight them (`EdgeWeight`) and filter at render; the previous `capDegree(6)` deleted 82–100% of dependency edges
- **Caption capture** — `extension/src/content/caption-scraper.ts` → `extension/src/sidepanel/hooks/useTranscript.ts`
- **Central skills kit** — `.skills/` submodule + `docs/how-to/install-central-skills.md`
- **Agent-loop tool defs** — `extension/llm_agent/{global,internal/skills}/` (mirrors of central)
- **Mac app entry** — `mac/Sources/LlmIdeMac/Shell/LlmIdeMacApp.swift`
- **Mac services** — `mac/Sources/LlmIdeMac/Core/` (leaf infrastructure) and each `Features/<Name>/Services/` (follow suffix taxonomy)
- **Mobile control** — `docs/mobile/quick-start.md` → `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift` → `ios_app/SharedProtocol/`

## Testing Checklist

Before merging caption/transcript/LLM changes, run the real-meeting checklist in [`extension/CLAUDE.md`](extension/CLAUDE.md).

## Documentation

Comprehensive docs at https://grid-devs.gitlab.io/personal/dinesh/notes-extension/:

- **System architecture** — [`docs/explanation/architecture.md`](docs/explanation/architecture.md)
- **Engineering invariants** — [`docs/explanation/invariants.md`](docs/explanation/invariants.md)
- **API reference** — [`docs/reference/api/overview.md`](docs/reference/api/overview.md)
- **Decisions** — [`docs/decisions/`](docs/decisions/) (ADRs 0001–0017)
- **How-to guides** — [`docs/how-to/`](docs/how-to/)

### Other root-level guides

- [`AGENTS.md`](AGENTS.md) — redirect; points agents at `invariants.md` (do-not-regress list) and `docs/decisions/`
- [`FIRST_TIME_SETUP.md`](FIRST_TIME_SETUP.md) / [`CHANGELOG.md`](CHANGELOG.md) — setup context and release history

## Branch + Commit Conventions

- **Conventional Commits** — `feat(mac):`, `fix(server):`, `docs:`, `refactor:`, `chore:`, `test:`
- **One concern per commit** — If subject line has "and", split it
- **Link issue/task in body** when applicable
- **Ask before pushing to `main`** — Reviewer may want branch first
