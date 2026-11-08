# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Product naming:** user-visible **LLM-IDE**, repo slug **llm-ide**, code types **LlmIde**, wire/bundle **llmide** — see [ADR 0016](docs/decisions/0016-naming-convention.md).

## Common Commands

### Development & Building

```bash
# Initial setup (install deps, verify tools, enable git hooks)
./setup.sh

# Extension + core development (other scripts: extension/package.json)
cd extension
npm run server        # Start the local Node core (127.0.0.1:3456)

# Desktop app (Tauri: desktop/ host + ui/ screens)
cd desktop
npm run tauri dev     # app window (starts Vite)
npm test              # desktop + ui/screens node tests

# Web app
cd web && npm run dev

# Testing (lint/format/docs targets: see Makefile)
make test             # Extension/core tests (Node test runner)
make test-desktop     # Desktop node checks + cargo test --lib
make regression       # Pre-push regression gate (contracts, desktop/ui/web, agent/v2, graph-kit)
make test-shared-protocol   # iOS wire types (ios_app/SharedProtocol)

# Generated HTTP inventory (a snapshot, never a push gate)
make inventory        # Regenerate schema/http/INVENTORY.md
make inventory-check  # Full drift check only (not part of contract-gates)
```

## Architecture Overview

LLM-IDE is a **local-first AI meeting intelligence system**: several surfaces share one Node core.

1. **Chrome Extension** (React 18 + TypeScript + Vite) — Meeting capture via platform captions, side panel UI
2. **Desktop app** (Tauri: Rust host in `desktop/src-tauri/`, React screens in `ui/`) — macOS, Windows, Linux; spawns and supervises the core; full KB + Issues + Gantt + Code Assistant
3. **Local core** (`extension/`, Node 20+, pure HTTP) — Bound to 127.0.0.1, handles AI orchestration and data persistence
4. **Web app** (`web/`) and **iPhone app** (`ios_app/`) — pair with the desktop over Host API v1 and read encrypted sync snapshots when it is off (ADR 0020)

The Swift Mac app (`mac/`) was removed on 2026-11-06 (it is in git history); the desktop app replaces it.

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
- **Append-only migrations** — Numbered SQL migrations under `extension/kb/migrations/`
- **Runtime feature set → core** — the desktop host passes the user's enabled features to the core it spawns as `LLMIDE_FEATURES` (`desktop/src-tauri/src/prefs.rs`, `core_env.rs`; unset/empty → all). Disabled route groups answer 404 `feature_disabled`. A toggle applies on the NEXT core start — never auto-restart the core on a feature change (it kills in-flight Loop/agent work); an adopted external core keeps its own env.
- **Encrypted sync, no accounts** — phones and browsers read encrypted snapshots from user-owned storage (MEGA, own server SFTP, Box) and queue prompts; the desktop needs no login (ADR 0020; `extension/CLAUDE.md` "Sync"). The relay v1 byte format (`schema/relay/v1`) survives only as sync's envelope format.

Project layout and folder tree: [docs/reference/project-structure.md](docs/reference/project-structure.md).

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
- **`graphkit/`** — Code-graph primitives (graph model, layouts, memory writer); consumed by `agents/planner.mjs` + `agents/code-sync.mjs`, rendered by the desktop Graph screen
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
- **Server binds to `127.0.0.1`** — Remote bind requires `LLMIDE_ALLOW_REMOTE=1`; with it, self-registration is CLOSED unless `LLMIDE_ALLOW_REMOTE_REGISTRATION=1`
- **`runClaude()` prefers user's stored `claude.apiKey`** — Falls back to operator's Claude CLI; never silent fallback
- **8 MB request body limit** — DoS guard
- **500 k-char prompt cap** — Keep within Claude CLI comfort zone
- **`SERVER_API_VERSION` + `ALL_ENDPOINTS` array** — Bump version when wire format changes; `/health` advertises `ENDPOINTS` = `ALL_ENDPOINTS` minus disabled features' paths
- **Agent SDK + engine are lazy-loaded** — Never on the boot path; prewarmed after listen; `LLMIDE_ENGINE_PREWARM=0` disables the prewarm (see `extension/CLAUDE.md` "Lazy engine")
- **`LLMIDE_FEATURES` honoured** — Parsed once into `config.features` (`null` = all); a disabled feature's route group (`extension/routes/feature-routes.mjs`) is never imported and its paths 404 `{"error":"feature_disabled","feature":…}`; `/health` reports `features`

### SQLite (`extension/kb/db.mjs`)
- **better-sqlite3 is single-writer** — All writes serialized by V8 event loop
- **WAL mode enabled** — Readers never block writers, writers never block readers
- **DO NOT open second Node process writing same DB** — Corruption risk
- **All multi-step mutations use `db.transaction()`** — Only atomicity mechanism

### TypeScript Code Conventions
- **All LLM hooks accept `language?: string`** — Forward to request body
- **AbortController on every request** — Cancel-on-unmount via `useEffect` cleanup
- **Strict response validation** — `typeof data?.notes !== 'string'` → throw

### Generated artifacts (`schema/http/INVENTORY.md`)
- **`schema/http/INVENTORY.md` is a generated snapshot, never a reviewed artifact** — do not hand-edit it and do not commit it just to make a push pass. `make inventory` regenerates it; `make inventory-check` is the full drift check only.
- **The contract gate checks coverage, not the committed diff** — `make contract-gates` runs `node scripts/http-inventory.mjs --coverage`, which validates every roster route/handler and client path from the generator output. A stale snapshot is not a failure; CI regenerates it and uploads the `http-inventory` artifact (no bot commit to `main`). See [invariants.md](docs/explanation/invariants.md#generated-artifacts-http-inventory).

## Mobile and web

- **Host API v1** (`schema/host-api/v1`, gateway `extension/routes/host-api/`): the desktop's pinned WSS listener the iPhone and web app pair with; see `extension/CLAUDE.md` "Host API v1 (desktop)".
- **Sync** (`schema/sync/v1`): see `extension/CLAUDE.md` "Sync".
- **iPhone** (`ios_app/`): wire types and sync envelope in `ios_app/SharedProtocol/` (`make test-shared-protocol`). Its v2 Mac link (`:3006`, Bonjour, PIN) is dead since the Mac app's removal and is scheduled for removal.

## Entry Points for Development

### Where to Add X

| I want to… | Touch these files |
|---|---|
| Support new meeting platform | `extension/src/content/caption-scraper.ts` (add reader), `detectPlatform()` |
| Add new AI feature | New server endpoint in `extension/server.mjs` + add to `ALL_ENDPOINTS` (a route owned by one excludable feature: own route module registered in `extension/routes/feature-routes.mjs`) + bump `SERVER_API_VERSION` + add to `REQUIRED_ENDPOINTS` in `extension/src/sidepanel/App.tsx` + new hook under `extension/src/sidepanel/hooks/` (with `language` param + AbortController) |
| Add new UI language | `LANGUAGE_NAMES` in `extension/server.mjs` + `HEADING_LABELS` for questions + LanguageSelector option |
| Change server port | `extension/src/lib/config.ts` default + `extension/server.mjs` `PORT` + CORS origin list |
| Persist UI state | `chrome.storage.local` via the owning hook; do NOT add new store |
| Add new tab | `TABS` array in `extension/src/sidepanel/App.tsx` + new panel block |
| Persist meeting data | Extend `SavedTranscript` in `extension/src/lib/storage.ts`; write in `stopRecording()` |
| Install agent skills into a user project | Auto on New Project / Rebuild via `POST /kb/project/install-skills` (`extension/kb/install-project-skills.mjs`); kit lives in `.skills` |
| Add a desktop screen or section | `ui/screens/<section>/` + `ui/screens/shell/sections.ts`; host commands in `desktop/src-tauri/src/` (registered in `lib.rs`, listed in `build.rs` COMMANDS, granted in `capabilities/default.json`) |
| Add a Host API v1 command | `schema/host-api/v1` + `node scripts/generate-host-api.mjs` + `extension/routes/host-api/` + the web/iOS clients |

### Starting Points for Reading

- **Server internals** — `extension/server.mjs` → follow router into `extension/routes/router.mjs`
- **Claude linker** — [`docs/explanation/claude-linker.md`](docs/explanation/claude-linker.md): `extension/llm_agent/sdk/` + `extension/providers/` own ALL Claude SDK/CLI knowledge; SDK updates edit only these
- **KB operations** — `extension/kb/db.mjs` (every state-mutating helper takes `userId` first)
- **Graph generation** — [`extension/graph_generation/README.md`](extension/graph_generation/README.md). Everything graph lives in `graph-kit/` — a **git submodule** of `github.com/dnsmalla/graph-kit` — and `ui/screens/graph/` (app side). graph-kit is a **separate repository, and it stays one** (user decision 2026-10-28, reusable by other consumers). Changes are commits in that repo; then `make graphkit-bump` (`COMMIT=1` to commit) pushes graph-kit `main` and moves the one pin, the submodule gitlink. `make graphkit-pin-check` (offline in `make regression`, `ONLINE=1` for the remote) must pass. Workflow: [`docs/how-to/graph-kit-workflow.md`](docs/how-to/graph-kit-workflow.md)
- **Graph layout** — `graph-kit/Sources/GraphCore/Layout/GraphLayoutEngine.swift` is the single entry point. Verify any change with `cd graph-kit && swift run -c release graph-layout-lab --compare` (an executable, so the gate also runs on a toolchain without XCTest). **Never prune edges to make a dense graph legible** — weight them (`EdgeWeight`) and filter at render; the previous `capDegree(6)` deleted 82–100% of dependency edges
- **Caption capture** — `extension/src/content/caption-scraper.ts` → `extension/src/sidepanel/hooks/useTranscript.ts`
- **Central skills kit** — `.skills/` submodule + `docs/how-to/install-central-skills.md`
- **Agent-loop tool defs** — `extension/llm_agent/{global,internal/skills}/` (mirrors of central)
- **Desktop host** — `desktop/src-tauri/src/lib.rs` (commands), `core_host.rs` (core spawn/supervision); packaging `desktop/PACKAGING.md`
- **Desktop UI** — `ui/screens/shell/Shell.tsx` → `ui/screens/<section>/`; shared components `ui/kit/`

## Testing Checklist

Before merging caption/transcript/LLM changes, run the real-meeting checklist in [`extension/CLAUDE.md`](extension/CLAUDE.md).

## Documentation

Comprehensive docs at https://grid-devs.gitlab.io/personal/dinesh/notes-extension/:

- **System architecture** — [`docs/explanation/architecture.md`](docs/explanation/architecture.md)
- **Engineering invariants** — [`docs/explanation/invariants.md`](docs/explanation/invariants.md)
- **API reference** — [`docs/reference/api/overview.md`](docs/reference/api/overview.md)
- **Decisions** — [`docs/decisions/`](docs/decisions/) (ADRs 0001–0020)
- **How-to guides** — [`docs/how-to/`](docs/how-to/)

### Other root-level guides

- [`AGENTS.md`](AGENTS.md) — redirect; points agents at `invariants.md` (do-not-regress list) and `docs/decisions/`
- [`FIRST_TIME_SETUP.md`](FIRST_TIME_SETUP.md) / [`CHANGELOG.md`](CHANGELOG.md) — setup context and release history

## Branch + Commit Conventions

- **Conventional Commits** — `feat(ui):`, `fix(server):`, `docs:`, `refactor:`, `chore:`, `test:`
- **One concern per commit** — If subject line has "and", split it
- **Link issue/task in body** when applicable
- **Ask before pushing to `main`** — Reviewer may want branch first
