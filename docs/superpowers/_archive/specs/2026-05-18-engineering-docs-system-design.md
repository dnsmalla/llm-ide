---
title: Engineering Documentation System
status: accepted
audience: internal
date: 2026-05-18
---

# Engineering Documentation System

## Context

LLM IDE is heading toward productisation: multiple surfaces (Chrome extension, macOS app, planned dashboard), a growing engineering team, and four eventual audiences (end users, integrators, customers/admins, internal engineering). The current documentation is good content trapped in an unscalable shape:

- The top-level `README.md` references files that didn't exist at the stated paths (recently fixed).
- The same architecture diagram lives in three places.
- `AGENTS.md` mixes hard invariants, historical context, and architectural decisions into one 389-line file.
- There is no canonical place to record *why* a non-obvious decision was made.
- API documentation is at risk of drifting from `openapi.yaml`.
- No build, no search, no link checking — engineers grep the repo to find docs.

This spec defines a structured documentation system that scales with the project. The first deliverable serves the **internal engineering** audience; end-user, API-integrator, and customer/admin doc sites are explicitly deferred to later phases.

## Goals

- One canonical home for every piece of engineering documentation.
- Diátaxis-shaped IA (tutorials, how-to, reference, explanation) so contributors know where new content belongs.
- A static site, deployed automatically, with full-text search and link checking.
- Numbered, append-only Architecture Decision Records so the *why* survives staff turnover.
- Reference pages for env vars, schema, error codes, etc. extracted *from source code* once at migration, so they start accurate.
- Light process: structure and tooling, no mandated workflows.

## Non-goals

- End-user help site, customer/admin docs, public API docs site (separate later phases).
- Versioned documentation (single `latest` for now).
- Japanese translations (English-only at start; locale support added when an owner exists).
- Per-PR preview deploys.
- Prose linting (Vale).
- Auto-generated API SDKs.
- A `CODEOWNERS`-style enforcement layer.

## Audience and stage

| | |
|---|---|
| **Audience (this phase)** | Internal engineering team |
| **Audiences (later phases)** | End users · API integrators · Customers / admins |
| **Project stage** | Productised / commercial, pre-GA |

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | MkDocs Material for the static site | Python-light, gorgeous defaults, mermaid, search; team doesn't maintain a second JS toolchain |
| D2 | Diátaxis IA (`tutorials/`, `how-to/`, `reference/`, `explanation/`) plus `decisions/` for ADRs | Diátaxis is the strongest known framework for splitting doc types; ADRs are durable decision history |
| D3 | English-only at start | No Japanese-translation owner today; MkDocs Material supports i18n when the time comes |
| D4 | GitHub Pages for hosting | Zero infra cost; deploys via Actions on merge to `main` |
| D5 | Hand-written API narrative + generated OpenAPI reference *both* | User explicitly chose redundancy over a single source of truth; drift accepted |
| D6 | Split `AGENTS.md` into `explanation/invariants.md` + numbered ADRs | Invariants and decisions are different concerns; ADRs are discoverable per topic |
| D7 | Light process — templates and lint, no mandated workflows | Heavy process gets ignored at this team size; can grow into ADR-for-every-change later |
| D8 | Source-extracted reference pages generated *once at migration*, not on every build | Keeps CI fast and the generated diff reviewable; refresh on demand via `make docs-refresh-reference` |
| D9 | No per-PR docs preview | GH Pages doesn't natively support it; adding Cloudflare/Netlify just for previews isn't worth the complexity now |

## Information architecture

```
docs/
├── index.md                       Landing — what is LLM IDE, where to go
│
├── tutorials/                     Learning-oriented
│   ├── 01-first-meeting.md
│   ├── 02-generate-a-plan.md
│   └── 03-add-an-endpoint.md
│
├── how-to/                        Task-oriented
│   ├── add-a-language.md
│   ├── add-a-meeting-platform.md
│   ├── add-a-migration.md
│   ├── add-a-vault-key.md
│   ├── add-an-endpoint.md
│   ├── run-the-server-locally.md
│   ├── build-the-macos-app.md
│   ├── debug-captions-not-appearing.md
│   ├── rotate-jwt-secret.md
│   └── contribute.md
│
├── reference/                     Lookup
│   ├── api/
│   │   ├── overview.md            Hand-written narrative (auth, rate limits, error envelope)
│   │   ├── openapi.yaml           Source of truth
│   │   └── (generated pages via neoteroi-mkdocs)
│   ├── database-schema.md         Extracted from kb/migrations/*.sql
│   ├── env-vars.md                Extracted from server/config.mjs
│   ├── error-codes.md             Extracted from server/errors.mjs
│   ├── guardrail-rules.md         Extracted from guardrails/rules.mjs
│   ├── message-protocol.md        Extracted from src/lib/messages.ts
│   ├── rate-limit-profiles.md     Extracted from server/rate-limit.mjs
│   └── cli-scripts.md             setup.sh · run.sh · start.sh
│
├── explanation/                   Understanding the why
│   ├── architecture.md            System-wide
│   ├── server-internals.md        From extension/docs/ARCHITECTURE.md
│   ├── meeting-agent.md           From extension/docs/meeting-agent-plan.md
│   ├── caption-capture.md         From AGENTS.md scraper section
│   ├── security-model.md
│   └── invariants.md              Remaining AGENTS.md "do not regress" content
│
├── decisions/                     ADRs — Michael Nygard format, abbreviated
│   ├── 0001-claude-cli-not-api-key.md
│   ├── 0002-no-server-framework.md
│   ├── 0003-sqlite-fts5-not-elastic.md
│   ├── 0004-bind-to-localhost-only.md
│   ├── 0005-strict-cors-allowlist.md
│   ├── 0006-snapshot-diff-caption-scraper.md
│   ├── 0007-per-user-vault-key-hkdf.md
│   ├── 0008-append-only-migrations.md
│   ├── 0009-sessionid-keyed-transcript-updates.md
│   ├── 0010-shared-react-bundle-side-panel-popup.md
│   └── _template.md
│
├── _templates/                    Skeletons, excluded from build
│   ├── tutorial.md
│   ├── how-to.md
│   ├── reference.md
│   ├── explanation.md
│   └── adr.md
│
└── _stubs.txt                     Allow-list of intentionally incomplete pages
```

## Tooling

**Stack.** Python venv at the repo root for docs only; engineers never need to touch Python directly. All operations are Make targets.

**Core MkDocs plugins:**

| Plugin | Purpose |
|---|---|
| `mkdocs-material` | Theme, search, navigation |
| `mkdocs-material[imaging]` | Auto-generated social cards |
| `neoteroi-mkdocs` | Renders `openapi.yaml` as the API reference |
| `mkdocs-mermaid2-plugin` | Mermaid diagrams in markdown |
| `mkdocs-glightbox` | Click-to-zoom for screenshots |
| `mkdocs-git-revision-date-localized-plugin` | Last-updated timestamp from git |
| `mkdocs-awesome-pages-plugin` | Per-folder nav without rewriting `mkdocs.yml` |

**Repo additions:**

```
llm-ide/
├── docs/                          (content — IA above)
├── mkdocs.yml                     site config
├── docs-requirements.txt          pinned Python deps
├── Makefile                       docs-serve · docs-build · docs-lint · docs-deps · docs-refresh-reference
└── .github/workflows/docs.yml     PR: lint + build; main: build + deploy
```

**Make targets:**

| Target | What it does |
|---|---|
| `make docs-serve` | Live-reload preview at `127.0.0.1:8000` |
| `make docs-build` | One-shot build to `site/` |
| `make docs-lint` | `markdownlint-cli2` + `lychee` + frontmatter check |
| `make docs-deps` | Rebuild Python venv from `docs-requirements.txt` |
| `make docs-refresh-reference` | Re-run source extractors for the six generated reference pages |

## Conventions

**File names.** `lowercase-kebab-case.md`. ADRs are `NNNN-short-title.md`.

**Frontmatter — required per type:**

| Type | Required keys |
|---|---|
| Tutorial | `title`, `audience`, `time` |
| How-to | `title`, `applies_to` |
| Reference | `title`, `source` (path to source-of-truth file, if any) |
| Explanation | `title`, `status` (`stable` / `draft`) |
| ADR | `title`, `status` (`proposed` / `accepted` / `superseded-by: NNNN`), `date` |

**Diagrams.** Mermaid in markdown, never images of text. Screenshots are PNG or SVG.

**Code blocks.** Language always specified. Blocks over 40 lines carry an `<!-- include from <path> -->` hint for future tooling.

**Internal links.** Relative paths, `.md` extension included.

**Code references in prose.** Link to GitHub blob URL pinned to a tag for release notes; pinned to `main` for evergreen pages.

**Generated pages.** Start with `<!-- generated from <path> — do not edit by hand -->`.

## Lint enforced in CI

| Check | Tool | Action on failure |
|---|---|---|
| Markdown style | `markdownlint-cli2` (recommended config, line-length disabled) | PR red |
| Broken links | `lychee` (3× retry with exponential backoff for external) | PR red |
| Frontmatter completeness | Small Python script under `docs/_scripts/` | PR red |
| Unresolved TODOs | Same script; ignored for files listed in `docs/_stubs.txt` | PR red |

No "you must update docs in this PR" rule. Lint only enforces well-formedness of what is committed.

## Content migration

Every existing markdown file either moves, splits, or becomes a redirect stub. Nothing is deleted.

| Today | After migration | Action |
|---|---|---|
| `README.md` (top-level) | `README.md` | Stays. Trimmed to: what is this, install, link to docs site. |
| `AGENTS.md` | `docs/explanation/invariants.md` + 10 ADRs | Split. Hard rules become `invariants.md`; decisions become numbered ADRs. Old file becomes a stub. |
| `docs/README.md` | `docs/index.md` | Replaced. MkDocs nav handles indexing. |
| `docs/ARCHITECTURE.md` | `docs/explanation/architecture.md` | Moved. |
| `docs/API.md` | `docs/reference/api/overview.md` | Moved and trimmed; companion to generated reference. |
| `docs/CONTRIBUTING.md` | `docs/how-to/contribute.md` + `docs/tutorials/01-first-meeting.md` | Split. Setup → tutorial; conventions → how-to. |
| `extension/docs/ARCHITECTURE.md` | `docs/explanation/server-internals.md` | Moved. |
| `extension/docs/meeting-agent-plan.md` | `docs/explanation/meeting-agent.md` | Moved. |
| `extension/docs/openapi.yaml` | `docs/reference/api/openapi.yaml` | Moved next to its rendered output. |
| `extension/README.md` | Same path, trimmed | Pointer at docs site + scripts table. |
| `extension/dashboard/README.md` | Same path | Stays — placeholder is fine. |
| `mac/README.md` | Same path | Stays; gets a link to docs site. |

**New content generated from source code at migration time** (see Phase 3):

| Page | Source |
|---|---|
| `reference/env-vars.md` | `extension/server/config.mjs` |
| `reference/database-schema.md` | `extension/kb/migrations/*.sql` |
| `reference/error-codes.md` | `extension/server/errors.mjs` |
| `reference/guardrail-rules.md` | `extension/guardrails/rules.mjs` |
| `reference/message-protocol.md` | `extension/src/lib/messages.ts` |
| `reference/rate-limit-profiles.md` | `extension/server/rate-limit.mjs` |

Tutorials and how-tos that aren't directly migrated start as stubs with a one-line "what this will cover" header, listed in `docs/_stubs.txt`.

## ADRs to write at migration

Each is short — context, decision, consequences, no more than ~400 words.

1. Claude CLI shell-out, not Anthropic API
2. Pure Node `http`, no framework
3. SQLite + FTS5, not Postgres / Elasticsearch
4. Bind to `127.0.0.1` only
5. CORS strict allowlist, never `*`
6. Snapshot-diff caption scraper (replaced buffer / dedup heuristics)
7. Per-user vault key via HKDF
8. Migrations append-only
9. `sessionId`-keyed transcript updates
10. Side panel and popup share one React bundle

## Rollout phases

Each phase ships independently and is reviewable as its own PR.

**Phase 1 — Skeleton + tooling (≈1 day)**

- `mkdocs.yml`, `docs-requirements.txt`, `Makefile`, `.github/workflows/docs.yml`
- Empty Diátaxis folders + `docs/index.md`
- Templates under `docs/_templates/`
- `docs/_scripts/check_frontmatter.py`
- `docs/_stubs.txt` (empty initially)
- One real end-to-end page (`explanation/architecture.md`) to prove the build
- GitHub Pages deploy verified

**Phase 2 — Migrate existing content (≈2–3 days)**

- Split `AGENTS.md` into invariants + 10 ADRs
- Move all existing markdown to its new home; old paths become 1-line redirect stubs
- Trim top-level + per-component READMEs to pointers
- Write the API narrative + wire `neoteroi-mkdocs` for the generated reference
- Populate `docs/_stubs.txt` with the planned tutorial / how-to filenames so lint passes

**Phase 3 — Source-extracted reference pages (≈1 day)**

- Six extractor scripts under `docs/_scripts/extract_*.py`
- One-shot run produces the six generated reference pages
- `make docs-refresh-reference` re-runs them on demand
- CI does *not* run extractors on every build (kept fast, output diff-reviewable)

## Ownership

No `CODEOWNERS`. One convention only: each top-level docs folder lists a maintainer name in its `index.md` frontmatter. That person is the tie-breaker on structure questions in their area, not the writer for everything in it.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stubs proliferate; site looks empty | `_stubs.txt` is reviewed weekly during phase 2; pages either get written or removed from nav |
| Generated reference pages drift from source after Phase 3 | `make docs-refresh-reference` is a 5-second command; CI nag if last-updated timestamp on a generated page is older than the source file (deferred enhancement) |
| Hand-written `api/overview.md` drifts from `openapi.yaml` | Accepted (D5). Reviewed when adding new endpoints; `docs/how-to/add-an-endpoint.md` reminds the author. |
| Python venv becomes a friction point for Node-only engineers | `make docs-deps` and `make docs-serve` hide it entirely; CI also caches the venv |
| MkDocs Material major-version upgrade breaks the site | `docs-requirements.txt` pins versions; upgrade is its own PR with visual diff |

## Success criteria

- `make docs-serve` works on a fresh clone after one `make docs-deps`.
- Every page passes lint; `make docs-lint` is green in CI.
- Public docs site reachable at the GitHub Pages URL.
- Zero broken internal links across the migrated site.
- `AGENTS.md` content is fully represented in `invariants.md` + ADRs (no information lost).
- The six source-extracted reference pages match the current state of the code.

## Open questions

None at design time. Implementation may surface friction points (Python venv on Apple Silicon, GH Pages CNAME, OpenAPI rendering edge cases); those will be addressed during Phase 1.
