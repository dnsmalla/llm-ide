# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
```

## Architecture Overview

LLM IDE is a **local-first AI meeting intelligence system** comprising four surfaces that share a single backend:

1. **Chrome Extension** (React 18 + TypeScript + Vite) — Meeting capture via platform captions, side panel UI
2. **macOS App** (SwiftUI) — Native capture via Accessibility API, full KB + Issues + Gantt + Code Assistant
3. **Local Server** (Node 20+, pure HTTP) — Bound to 127.0.0.1:3456, handles AI orchestration and data persistence
4. **Mobile Control** (iOS + Node.js) — Remote desktop + LLM IDE chat via existing auto_swift_aicontrol system

### Core Data Flow

1. **Capture**: Content scripts read platform CC every 800ms → `CAPTION_FINAL` messages → server writes to SQLite
2. **Processing**: `/generate-notes`, `/extract-entities`, `/generate-questions` endpoints shell out to Claude CLI (`claude -p`)
3. **Planning**: `/kb/generate-plan` grounds planner in FTS5 search results; `/kb/analyze-risks` annotates tasks
4. **Action**: `/kb/generate-code` produces guardrail-scanned diffs; approval dispatches to GitHub/GitLab/Backlog/Linear
5. **Outcome**: Polling writes results back to `outcomes` table for future planning context

### Key Architectural Decisions

- **Claude CLI default** — Users authenticate via `claude login`; optional per-user API keys stored in encrypted vault
- **Pure Node HTTP** — No framework (Express/Fastify); reduces dependency surface
- **SQLite WAL+FTS5** — Single database per install, full-text search across meetings/code/tickets
- **Per-user tenancy** — Every owned row carries `user_id`; FTS5 hits are hydrated with user-scoped queries
- **Append-only migrations** — Numbered SQL migrations under `extension/kb/migrations/` (0001–0022)

## Project Structure

```
llm-ide/
├── extension/           # Chrome extension + local server
│   ├── core/            # Framework-free primitives (config, utils, errors, logger)
│   ├── server/          # HTTP server (no framework), routing, middleware
│   ├── kb/              # SQLite knowledge base, migrations, FTS5
│   ├── agents/          # Markdown agent skills (YAML frontmatter)
│   ├── llm_agent/       # Claude CLI orchestrator (shell-out wrapper)
│   ├── connectors/      # Outbound integrations (GitHub, GitLab, Backlog, Linear, Slack)
│   ├── guardrails/      # Secret/PII/destructive-op pattern scanners
│   ├── src/             # React UI (side panel, popup, content scripts)
│   ├── tests/           # Node test runner (tests/**/*.test.{ts,mjs})
│   └── server.mjs       # Server entry point
├── mac/                 # Native macOS app
│   ├── Sources/LlmIdeMac/
│   │   ├── Models/      # Data models
│   │   ├── Services/    # Long-lived work (*Service, *Store, *Client, *Manager, *Router)
│   │   ├── Views/       # SwiftUI views
│   │   └── ViewModels/  # View models
│   └── Tests/           # XCTest suite
├── docs/                # mkdocs site (Diátaxis framework)
└── kb/                  # Runtime data only (SQLite db, dev secrets)
```

### Module Boundaries (Extension)

Strict layering rule — arrows indicate "imports":

```
core  ←  kb  ←  server  ←  agents / llm_agent / connectors / guardrails
```

- **`core/`** — Framework-free primitives only (Node built-ins + 3rd-party libs)
- **`server/`** — HTTP routing, request pipeline (CORS → JWT → rate-limit → route)
- **`kb/`** — SQLite access, every state-mutating helper takes `userId` first
- **`agents/`** — Markdown skill files with frontmatter (`name`, `description`, `tools`, `applies_to`)

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

## Mobile Control System

LLM IDE includes mobile control capabilities using the existing `auto_swift_aicontrol` system (located at `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/`).

### Architecture

```
iPhone App (SwiftUI)
    │ Bonjour + WebSocket + PIN auth
    ▼
Computer Agent (Node.js @ :3006)
    │ WebSocket server
    ├──► Screen capture (screenshot-desktop)
    ├──► Input injection (@nut-tree-fork/nut-js)
    └──► LLM IDE API client (http://127.0.0.1:3456)
        │
        ▼
LLM IDE Server (Node.js @ :3456)
    └── Main backend server
```

### Quick Start

```bash
# Terminal 1: Start LLM IDE server
cd ~/llm-ide/extension && node server.mjs

# Terminal 2: Start computer agent
cd ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent && npm start

# Terminal 3: Open iOS app (Xcode)
cd ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios && open MyApp.xcodeproj
# Run on physical iPhone (same Wi-Fi)
```

### Features

- **Remote Desktop** - Screen streaming (800×600 @ 10fps) + touch control
- **LLM IDE Chat** - Ask questions, get responses on mobile
- **Meeting Assistant** - AI co-pilot during video calls
- **Device Discovery** - Automatic Bonjour/mDNS discovery
- **PIN Authentication** - 6-digit PIN + QR code fallback
- **Input Control** - Mouse + keyboard via @nut-tree-fork/nut-js

### Configuration

Computer agent uses `.env` file:
```bash
PORT=3006
PIN=123456
LLMIDE_URL=http://127.0.0.1:3456
LLMIDE_EMAIL=your@email.com
LLMIDE_PASSWORD=yourpassword
```

### Permissions Required

- **macOS**: Screen Recording + Accessibility (System Settings → Privacy & Security)
- **iOS**: Local Network (for Bonjour discovery)

### Documentation

- **Quick Start**: `docs/mobile/quick-start.md`
- **Verification**: `docs/mobile/verification.md`
- **Verification Script**: `scripts/mobile/verify-mobile-control.sh`
- **Integration Plan**: `docs/compact-mobile-integration.md`
- **Complete Summary**: `docs/mobile-control-complete.md`
- **Original System**: `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/`

### Key Files (Computer Agent)

```
~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/
├── src/index.ts              # Entry point (Bonjour, QR code, server startup)
├── src/server.ts             # WebSocket server with PIN auth
├── src/llmide-client.ts     # LLM IDE API client
├── src/command-handler.ts   # Command routing
└── .env                      # Configuration (PIN, port, etc.)
```

### Key Files (iOS App)

```
~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp/
├── MyAppApp.swift           # App entry point
├── Views/ContentView.swift  # Remote desktop UI
├── Services/ControlService.swift  # WebSocket client
└── Services/DeviceDiscovery.swift  # Bonjour discovery
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
| Add mobile control feature | Modify `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/src/` (computer agent) or `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp/` (iOS app) |
| Extend LLM IDE mobile API | Add endpoint to `extension/server.mjs` + expose via `llmide-client.ts` in computer agent |

### Starting Points for Reading

- **Server internals** — `extension/server.mjs` → follow router into `extension/kb/router.mjs`
- **KB operations** — `extension/kb/db.mjs` (every state-mutating helper takes `userId` first)
- **Caption capture** — `extension/src/content/caption-scraper.ts` → `extension/src/sidepanel/hooks/useTranscript.ts`
- **Agent skills** — `extension/agents/*.md` (YAML frontmatter declares intent)
- **Mac app entry** — `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- **Mac services** — `mac/Sources/LlmIdeMac/Services/` (follow suffix taxonomy)
- **Mobile control** — `docs/mobile/quick-start.md` → `docs/compact-mobile-integration.md` → `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/`

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
- **Decisions** — [`docs/decisions/`](docs/decisions/) (ADRs 0001–0015)
- **How-to guides** — [`docs/how-to/`](docs/how-to/)

## Branch + Commit Conventions

- **Conventional Commits** — `feat(mac):`, `fix(server):`, `docs:`, `refactor:`, `chore:`, `test:`
- **One concern per commit** — If subject line has "and", split it
- **Link issue/task in body** when applicable
- **Ask before pushing to `main`** — Reviewer may want branch first
