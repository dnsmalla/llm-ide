# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Product naming:** user-visible **LLM-IDE**, repo slug **llm-ide**, code types **LlmIde**, wire/bundle **llmide** — see [ADR 0016](docs/decisions/0016-naming-convention.md).

## Common Commands

### Development & Building

```bash
# Initial setup (install deps, verify tools, enable git hooks)
./setup.sh

# Extension development
cd extension
npm run dev           # Vite dev server with hot reload
npm run build         # TypeScript check + production build
npm run type-check    # TypeScript type checking only
npm run server        # Start the local Node server (127.0.0.1:3456)

# macOS app development
cd mac
swift build           # Build the app
swift test            # Run XCTest suite
make build-mac-lite   # Build lite app: excludes Graph, Explorer, Gantt, Issues, DocGen, Terminal; leaves Chat, Auto Tasks, Mobile Sync, Live Capture, Library
./build_app.sh        # Legacy build script (use `swift build` instead)

# Testing
make test             # Run extension tests (Node test runner)
make test-mac         # Run macOS app tests (XCTest)
npm test              # Extension tests directly
make regression       # Pre-push regression gate

# Linting & Formatting
make lint             # Check linting and formatting
make format           # Auto-format and fix linting issues
npm run lint          # ESLint with max-warnings 0
npm run lint:fix      # Auto-fix ESLint issues

# Documentation
make docs-serve       # Start mkdocs dev server (localhost:8000)
make docs-build       # Production docs build with strict mode
make docs-check       # Validate all docs (links, frontmatter, API coverage)
```

### Running Tests

```bash
# Extension tests (Node built-in test runner)
cd extension && npm test                           # All tests
node --test tests/**/*.test.{ts,mjs}              # Direct test invocation
npm run test:watch                                # Watch mode

# Single test file
node --test tests/auth-routes.test.mjs

# macOS app tests (swift-testing)
cd mac && swift test                              # All tests
swift test --filter testAuthFlow                  # Filter by test name

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
- **Append-only migrations** — Numbered SQL migrations under `extension/kb/migrations/` (0001–0028)

## Project Structure

```
llm-ide/
├── .skills/             # git submodule → dnsmalla/skills (single source of truth)
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
│   ├── Sources/LlmIdeMac/
│   │   ├── Graph/       # ALL app-side graph code, one folder:
│   │   │   ├── Engine/  #   GraphEngine protocol + builtin/plugin impls
│   │   │   ├── Services/#   KnowledgeGraphService, GraphAutoUpdater, upload, watcher
│   │   │   ├── Notes/   #   Code-notes writer (CodeNoteService/Generator, Analyze)
│   │   │   └── Views/   #   UAGraphView, canvas, 3D view, palette, session store
│   │   ├── AutoTask/    # ALL Auto Task code, one folder:
│   │   │   ├── Models/  #   AutoTask, AutoTaskConfig/Settings, templates, run history
│   │   │   ├── Services/#   AutoCodeUpdateService(+ext), config/template stores, catalogs
│   │   │   └── Views/   #   AutoCodeView, settings/template sections, cron field
│   │   ├── LoopEngine/  # ALL Loop Engine code, one folder (same shape as AutoTask/):
│   │   │   ├── Models/  #   LoopDefinition, stages, config store, templates, status
│   │   │   ├── Services/#   LoopEngineRunner, journal, repairers, guards, parsers
│   │   │   └── Views/   #   LoopEngineView(+panes), wizard, budget editors
│   │   ├── Models/      # Data models
│   │   ├── Services/    # Long-lived work (*Service, *Store, *Client, *Manager, *Router);
│   │   │                #   also RepoFileWatcher, RepoGraphLocator, and Memory/ (core-owned
│   │   │                #   faults/ + q&a/ store, fault reports — works with Graph compiled out)
│   │   ├── Views/       # SwiftUI views
│   │   └── ViewModels/  # View models
│   └── Tests/           # XCTest suite
├── docs/                # mkdocs site (Diátaxis framework)
└── kb/                  # Runtime data only (SQLite db, dev secrets)
```

### Central skills (all agents)

Process/domain `SKILL.md` skills are **not** authored in this repo. They live in the
[`.skills`](https://github.com/dnsmalla/skills) submodule. After clone/pull:

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
- **`agents/`** — Markdown skill files with frontmatter (`name`, `description`, `tools`, `applies_to`)
- **`graphkit/`** — Code-graph primitives (graph model, layouts, memory writer); consumed by `agents/planner.mjs` + `agents/code-sync.mjs`, rendered by the Mac app
- **`plugins/`** — Discovers/loads/install extension plugins; `claude-adapter.mjs` bridges the plugin tool surface to the agent runtime

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

On a source checkout with a Swift toolchain, Settings → Workspace shows a **Build** card with **"Apply & Rebuild (remove disabled code)"** — an in-app rebuild that actually excludes disabled features from the compiled binary, not just hides them. Owned by `FeatureRebuildService` (`mac/Sources/LlmIdeMac/Services/FeatureRebuildService.swift`); the card (`BuildRebuildSettingsCard` in `mac/Sources/LlmIdeMac/Views/Settings/FeatureProfileSettingsView.swift`) renders nothing when `isEligible` is false, so it never appears on a non-engineer machine or a distributed release build (`Scripts/release.sh` sets `LLMIDE_OMIT_SOURCE_ROOT=1`, which omits the `LLMIDESourceRoot` Info.plist key eligibility depends on). Flow: confirmation dialog → `mac/Scripts/rebuild-features.sh` stages a release build + `mac/Scripts/sign.sh` off to the side (running app untouched) → "Restart & Install" spawns `mac/Scripts/rebuild-swap.sh` detached, which waits for this process to exit, keeps the previous `.app` as `<name>.app.bak` (one rollback slot), installs the staged bundle, and relaunches — logging to `<install-target-minus-.app>.rebuild.log`. See `docs/spec/macos-app.md` ("Apply & Rebuild") and `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Phase 3) for the full contract.

## Mobile Control System

LLM-IDE includes a native mobile companion: the **Mac app** runs a WebSocket server on `:3006` by default (configurable in Settings → Mobile Control; if busy, the next free port up to +9 binds automatically and Bonjour `_llmide._tcp` + the pairing QR advertise the actual port; PIN pairing), and the **iOS app** in `ios_app/` connects as a client. Chat requests are proxied to the local backend at `http://127.0.0.1:3456`.

> The external Node `computer-agent` (`auto_swift_aicontrol`) is **retired**. Remote desktop / screen streaming / input injection were cancelled; the iPhone is a chat/explorer/auto-tasks companion only.

### Architecture

```
iPhone App (SwiftUI, ios_app/)
    │ Bonjour + WebSocket + PIN auth
    ▼
LLM-IDE Mac app (native NWListener WebSocket on :3006)
    │ MobileControlManager.handleInbound
    ├──► LLM-IDE Chat → LlmIdeAPIClient (:3456)
    ├──► Explorer sessions → ChatSessionStore
    ├──► Auto Tasks → AutoCodeUpdateService / AutoTaskSettings
    └──► Loop → the loopEngineering auto task + LoopRunJournal
        │
        ▼
LLM-IDE Server (Node.js @ :3456)
    └── Main backend server
```

### Quick Start

```bash
# Terminal 1: Start LLM-IDE server
cd ~/llm-ide/extension && node server.mjs

# Terminal 2: Mac app — Settings → Mobile Control → Start
# (or launch LlmIdeMac with mobile control auto-start enabled)

# Terminal 3: iOS app (Xcode)
cd ~/llm-ide/ios_app && open MyApp.xcodeproj
# Run on physical iPhone (same Wi-Fi or Tailscale)
```

### Features

- **LLM-IDE Chat** — Ask questions from iPhone (streamed via Mac → :3456)
- **Explorer** — List and chat with Mac explorer sessions
- **Auto Tasks** — Toggle and inspect scheduled auto-code tasks
- **Loop** — Start/stop the active project's Loop — the whole run or a single stage — watch the live log, read finished runs (control only; stages and budgets are edited on the Mac)
- **Device Discovery** — Bonjour/mDNS (`_llmide._tcp`) or Direct IP + PIN
- **PIN Authentication** — 6-digit PIN + QR code (`llmide://pair?…`)

### Permissions Required

- **macOS**: None for mobile chat (Accessibility/Screen Recording are for caption capture elsewhere, not mobile pairing)
- **iOS**: Local Network (Bonjour discovery)

### Documentation

- **Quick Start**: `docs/mobile/quick-start.md`
- **Verification**: `docs/mobile/verification.md`
- **Loopback check**: `scripts/mobile/verify-native-pairing.swift`
- **Historical (Node agent)**: `docs/archive/compact-mobile-integration.md`, `docs/archive/mobile-control-complete.md`

### Key Files (Mac)

```
mac/Sources/LlmIdeMac/Services/
├── MobileControlManager.swift   # WebSocket dispatch + backend proxy
├── MobileWebSocketServer.swift  # NWListener on :3006
├── MobileBonjourAdvertiser.swift
└── MobilePin.swift              # Pairing PIN (Keychain)

ios_app/SharedProtocol/          # Codable wire types (Mac + iOS)
ios_app/MyApp/Services/
├── ConnectionService.swift      # WebSocket client + pairing
└── DeviceDiscovery.swift        # Bonjour browser
```

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
| Add mobile control feature | `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` (Mac dispatch) + `ios_app/MyApp/Services/ConnectionService.swift` (iOS client) + `ios_app/SharedProtocol/` (wire types) |
| Extend LLM-IDE mobile API | Add endpoint to `extension/server.mjs` + expose via `LlmIdeAPIClient` on Mac (mobile chat proxies through Mac app) |

### Starting Points for Reading

- **Server internals** — `extension/server.mjs` → follow router into `extension/routes/router.mjs`
- **Claude linker** — [`docs/explanation/claude-linker.md`](docs/explanation/claude-linker.md): the two layers (`extension/llm_agent/sdk/` + `extension/providers/`, `mac/…/ClaudeLink/`) that own ALL Claude SDK/CLI knowledge; SDK updates edit only these
- **KB operations** — `extension/kb/db.mjs` (every state-mutating helper takes `userId` first)
- **Graph generation** — [`extension/graph_generation/README.md`](extension/graph_generation/README.md): the engine contract, how a plugin supplies one, and how to unplug the compiled-in engine. Everything graph lives in `mac/LocalPackages/graph-kit/` (one folder, two products: `GraphCore` always linked, `GraphKit` unpluggable) and `mac/Sources/LlmIdeMac/Graph/` (app side)
- **Graph layout** — `mac/LocalPackages/graph-kit/Sources/GraphCore/Layout/GraphLayoutEngine.swift` is the single entry point. Verify any change with `cd mac/LocalPackages/graph-kit && swift run -c release graph-layout-lab --compare` (this toolchain has no XCTest, so the gate is an executable). **Never prune edges to make a dense graph legible** — weight them (`EdgeWeight`) and filter at render; the previous `capDegree(6)` deleted 82–100% of dependency edges
- **Caption capture** — `extension/src/content/caption-scraper.ts` → `extension/src/sidepanel/hooks/useTranscript.ts`
- **Central skills kit** — `.skills/` submodule + `docs/how-to/install-central-skills.md`
- **Agent-loop tool defs** — `extension/llm_agent/{global,internal/skills}/` (mirrors of central)
- **Mac app entry** — `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- **Mac services** — `mac/Sources/LlmIdeMac/Services/` (follow suffix taxonomy)
- **Mobile control** — `docs/mobile/quick-start.md` → `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` → `ios_app/SharedProtocol/`

## Testing Checklist

Before merging caption/transcript/LLM changes, run through this against a real meeting:

### Caption Fidelity
- [ ] Short Japanese captions (`はい。`) appear
- [ ] Long multi-sentence captions appear as ONE line
- [ ] Same speaker continuous updates stay on one line
- [ ] Different speakers produce different lines with real names
- [ ] Combined-speaker labels stripped to just speaker
- [ ] UI text does NOT appear (toolbar, clocks, meeting ID, effects)
- [ ] Works when extension loaded AFTER Meet tab opened
- [ ] Works on Teams and Zoom web

### LLM Output
- [ ] Primary language change → Notes/chat respond in that language
- [ ] Questions H2 headings localized (対立/要確認/要説明)
- [ ] DOCX export produces correct font (MS Gothic for JA)
- [ ] Stale server shows yellow "restart" banner

### Security
- [ ] `GET http://evil.example/` does NOT reach server (CORS)
- [ ] Setting `serverUrl` to evil URL rejected by `isSafeServerUrl()`
- [ ] Meeting with `<<<END>>>` spoken does not break AI output

## Documentation

Comprehensive docs at https://grid-devs.gitlab.io/personal/dinesh/notes-extension/:

- **System architecture** — [`docs/explanation/architecture.md`](docs/explanation/architecture.md)
- **Engineering invariants** — [`docs/explanation/invariants.md`](docs/explanation/invariants.md)
- **API reference** — [`docs/reference/api/overview.md`](docs/reference/api/overview.md)
- **Decisions** — [`docs/decisions/`](docs/decisions/) (ADRs 0001–0016)
- **How-to guides** — [`docs/how-to/`](docs/how-to/)

### Other root-level guides

- [`AGENTS.md`](AGENTS.md) — redirect; points agents at `invariants.md` (do-not-regress list) and `docs/decisions/`
- [`CONTRIBUTING.md`](CONTRIBUTING.md) / [`FIRST_TIME_SETUP.md`](FIRST_TIME_SETUP.md) / [`CHANGELOG.md`](CHANGELOG.md) — contributor + setup context

## Branch + Commit Conventions

- **Conventional Commits** — `feat(mac):`, `fix(server):`, `docs:`, `refactor:`, `chore:`, `test:`
- **One concern per commit** — If subject line has "and", split it
- **Link issue/task in body** when applicable
- **Ask before pushing to `main`** — Reviewer may want branch first
