# Project structure

Moved from the root `CLAUDE.md` so the agent instructions stay focused. See [`CLAUDE.md`](https://github.com/dnsmalla/llm-ide/blob/main/CLAUDE.md) for the architecture summary.

```text
llm-ide/
├── .skills/             # git submodule → dnsmalla/agent-kit (single source of truth)
├── scripts/install-skills.sh  # symlink kit into Claude/Cursor/Codex/.agents/Gemini
├── extension/           # Chrome extension + local server
│   ├── core/            # Framework-free primitives (config, utils, errors, logger)
│   ├── server/          # HTTP server (no framework), routing, middleware
│   ├── kb/              # SQLite knowledge base, migrations, FTS5; sources.mjs = source hub
│   ├── routes/          # HTTP route modules (router.mjs + agent/chat/live/planning/review/…; extension-routes.mjs = plugin/MCP/LLM-source)
│   ├── providers/       # Model-provider layer: dispatch, CLI spawn, retry/backoff, web client
│   ├── agents/          # Server pipeline agents (planner, risk, codegen, dispatcher, …) — not skills
│   ├── llm_agent/       # Agent engine glue: sdk/ adapter/ tools/ modes/ memory/ plan/ tasks/ skills/ + synced agent-tool defs
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
├── graph-kit/           # git submodule → dnsmalla/graph-kit (separate repo): TypeScript CLI + schema,
│                        #   web/ (graph page), rust/graph-layout (layout kernel → ui/screens/graph/wasm),
│                        #   Swift GraphCore/GraphKit + labs (make graph-gates)
├── desktop/             # Tauri desktop app (macOS, Windows, Linux)
│   ├── src-tauri/       #   Rust host: core spawn/supervision, OS secrets, files, git, PTY, capture
│   ├── src/             #   Webview entry, design CSS, bench
│   └── scripts/         #   core staging, security checks, release helpers (+ tests)
├── ui/                  # React UI shared by desktop and web
│   ├── kit/             #   @llmide/ui-kit: tokens CSS, components, icons
│   └── screens/         #   One folder per section (shell, chat, library, explorer, graph, …);
│                        #   factory/ is the Factory board (section id `conflicts`; its Docs vs code tab embeds review/)
├── web/                 # Browser app: Host API v1 pairing, encrypted sync reader
├── ios_app/             # iPhone app (MyApp/) + SharedProtocol (wire types, sync envelope)
├── schema/              # Wire contracts: http, agent-v2, host-api, sync, relay (sync byte format), design tokens
├── deploy/vps/          # llm-ide.com VPS units (static web, own-server sync)
├── docs/                # mkdocs site (Diátaxis framework)
└── kb/                  # Dev/test runtime data (repo kb). On first boot with LLMIDE_DATA_DIR (the app data
                         #   directory) the DB, agent.db, secrets and agent-sdk
                         #   are MOVED there (originals kept as *.pre-move for one boot); kb/backups/ is left alone (see the how-to)
```

Task catalog (one registry, generated copies, prompts in `schema/tasks/prompts/`): [task-registry.md](task-registry.md).
