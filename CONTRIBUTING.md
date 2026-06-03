# Contributing to Meet Notes

This guide is for engineers landing changes in the Meet Notes
repository. Read it once; refer back when you're unsure where a new
file belongs.

For setup, see `README.md`. For architecture, see
[`docs/explanation/architecture.md`](docs/explanation/architecture.md).

## Repo layout

```
meet-notes/
├── extension/        Chrome MV3 extension + local Node server
│   ├── core/           Framework-free primitives (config, utils, errors, logger)
│   ├── server/         HTTP server (no framework), routing, middleware
│   ├── kb/             SQLite knowledge base, migrations, FTS5
│   ├── agents/         Markdown agent skills (frontmatter-configured)
│   ├── llm_agent/      Meeting-agent runtime (Claude CLI shell-out)
│   ├── connectors/     Outbound integrations (GitHub, GitLab, Backlog…)
│   ├── guardrails/     Secret/PII/destructive-op scanners
│   ├── src/            React side-panel + popup UI (TS + Vite)
│   └── tests/          Node test runner
├── mac/              Native macOS SwiftUI app
│   ├── Sources/MeetNotesMac/  Models, Services, Views, ViewModels
│   ├── Scripts/        Phased build pipeline (build / sign / notarize / dmg)
│   ├── Tests/          XCTest target
│   └── build_app.sh    Backward-compat shim for the old monolithic build
├── docs/             mkdocs site (Diátaxis: tutorials / how-to / reference / explanation / decisions)
├── kb/               Runtime data (.dev-secrets.json, SQLite db, vault)
└── site/             Generated mkdocs output (gitignored)
```

## Mac code conventions

We use suffixes to communicate the *role* of a type. When you add a
new top-level type under `mac/Sources/MeetNotesMac/Services/`, pick
the suffix that matches its job — code review will ask you to rename
if it doesn't fit.

- **`*Service`** — long-lived background work or orchestration.
  Examples: `BackendManager` (… technically a Manager because it owns
  a system resource), `AutoCodeUpdateService`, `CodeWorkflowService`.
- **`*Store`** — owns persistent state. Reads and writes a specific
  on-disk store; nothing else should touch its files. Examples:
  `ChatSessionStore`, `LibraryItemStore`, `DocTemplateStore`,
  `SessionStore`.
- **`*Client`** — wraps an external HTTP / IPC API. No state beyond a
  base URL and an auth token. Examples: `GitLabClient`,
  `MeetNotesAPIClient`.
- **`*Manager`** — controls a system resource that needs lifecycle
  management (process, file watcher, child binary). Examples:
  `RepoManager`, `BackendManager`.
- **`*Mirror`** — passive shadow of remote state. Reads from a source
  of truth that lives elsewhere; never mutates it. Example:
  `LiveSessionMirror`.
- **`*Router`** — request or event dispatch. No business logic; pure
  wiring. Example: `DeepLinkRouter`.

`AppConfig` and `Theme` are intentionally suffix-less because they
*are* the convention they'd otherwise reference (a Config / Theme).

## Server code conventions

Module boundaries in `extension/` follow a strict layering rule:

```
core  ←  kb  ←  server  ←  agents / llm_agent / connectors / guardrails
```

Arrows are "imports". A module on the left must not import from
anything on the right. See
[`extension/core/README.md`](extension/core/README.md) for what
qualifies as a `core/` primitive and when to promote a shared
helper down into it.

- **`core/`** — framework-free primitives: config, HTTP helpers,
  sanitizers, error factories, logger. Imports only Node built-ins
  and 3rd-party libs.
- **`server/`** — HTTP routing, request pipeline (CORS → JWT →
  rate-limit → route). Pure Node `http`, no framework.
- **`kb/`** — SQLite access, migrations, FTS5 indexing, per-user
  vault crypto. Every state-mutating helper takes `userId` first.
- **`agents/`** — markdown skill files. Each carries YAML frontmatter
  (`name`, `description`, `tools`, `applies_to`).
- **`llm_agent/`** — Claude CLI shell-out and prompt assembly.
- **`connectors/`** — outbound integration clients. One file per
  external service.
- **`guardrails/`** — secret/PII/destructive-op pattern scanners; run
  at submit AND at approval.

## Documentation conventions

We follow [Diátaxis](https://diataxis.fr): every doc lives in exactly
one of these directories.

- `docs/tutorials/` — learning-oriented, hand-holding walk-throughs.
- `docs/how-to/` — task-oriented recipes.
- `docs/reference/` — information-oriented lookup tables (e.g. the
  configuration and persistence references introduced in this
  rev).
- `docs/explanation/` — understanding-oriented prose (architecture,
  invariants, security model).
- `docs/decisions/` — numbered ADRs (`NNNN-slug.md`). New ADRs get
  the next sequential number; never rewrite past ADRs, supersede
  them with a new one.

Every doc carries YAML frontmatter:

```yaml
---
title: <human-readable title>
applies_to: server, mac, extension   # optional, comma-separated
status: stable | draft               # optional
---
```

`applies_to` is what the docs site uses to badge a page; pick the
surfaces the content is relevant to.

## Branch + commit conventions

- **Conventional Commits** for every commit message:
  `feat(mac): …`, `fix(server): …`, `docs: …`, `refactor: …`,
  `chore: …`, `test: …`.
- **One concern per commit.** If you find yourself writing "and" in
  the subject line, split it.
- **Link the issue / Backlog task** in the body when applicable.
- **Ask before pushing to `main`.** The reviewer might want the
  branch first.

## Where do I put X?

```text
new file
├── persists user data
│       → mac/Sources/MeetNotesMac/Services/<Name>Store.swift
│       → or server-side: a new table in extension/kb/migrations/
│
├── wraps an external API
│       → mac: Services/<Name>Client.swift
│       → server: extension/connectors/<name>.mjs
│
├── orchestrates a multi-step workflow
│       → mac: Services/<Name>Service.swift
│
├── view-only React or SwiftUI
│       → extension/src/components/ or mac/.../Views/
│
├── agent prompt / skill
│       → extension/agents/<slug>.md (with YAML frontmatter)
│
├── documents a decision
│       → docs/decisions/NNNN-<slug>.md (next sequential N)
│
├── documents a procedure
│       → docs/how-to/<slug>.md
│
└── documents a lookup table
        → docs/reference/<slug>.md
```

A change that doesn't fit cleanly is usually a sign that two
concerns are tangled — split it before review.
