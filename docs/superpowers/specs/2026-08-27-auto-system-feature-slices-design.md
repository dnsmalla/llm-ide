# Auto-System Feature-Slice Library — Design

**Date:** 2026-08-27
**Status:** Approved in brainstorming (approach C + upgrade mechanism)
**Implementation target:** `dnsmalla/auto-system` (engine) + `dnsmalla/skills` (kit skill). No llm-ide code changes.
**Spec lives in llm-ide** because the driving requirement (LLM-driven app generation with low token burn) originates here.

## Context & motivation

Multiplatform app generation today burns tokens on code that never varies between apps. When an llm-ide agent generates an app, it writes login screens, auth middleware, and legal pages token-by-token — every time, slightly differently. Three pains follow:

1. **Token burn** — boilerplate the LLM should never author enters every generation.
2. **Slowness** — copy is instant; generation is not.
3. **Inconsistency** — each app's "fixed" features drift.

`auto-system` (V5) already contains complete, working, config-parameterized feature implementations — but they live inline in a 5,889-line monolith (`core/src/templates/generator.ts`). The same file has **no upgrade path**: `generate:templates` skips existing files, so template improvements (e.g. a security fix in auth middleware) never reach already-generated apps.

**Decision from review:** `system-controller` is NOT part of this work. llm-ide already covers its orchestration role natively (project skills install, plugin system, agents). It stays as the standalone distribution wrapper for non-llm-ide host repos and picks up this work via engine pin bumps.

## Goals

1. Extract the monolith's feature implementations into a **feature-slice library** — individually installable, versioned vertical slices (web + iOS + Android + backend).
2. **Upgrade over time** (explicit user requirement): fixed files update mechanically when a slice ships a new version; user-customized files are never overwritten.
3. **Strict byte parity**: `generate:templates` output for a given `system.yaml` is byte-identical before and after extraction, proven by golden tests.
4. **LLM-facing catalog**: llm-ide agents discover and install slices via a central-kit skill, reading only manifest metadata — template bodies never enter LLM context.

## Non-goals

- No new features (chat, payments, notifications) — later slices join the same format; this spec only extracts what exists.
- No change to `system-controller`.
- No llm-ide server/extension code changes.
- No automatic upgrades or automatic conflict merging — upgrades are explicit; conflicts are reported, and optional LLM-assisted resolution happens on demand.
- No new template language beyond existing `{{PLACEHOLDER}}` substitution.

## Approach decision

Three approaches were considered:

- **B — per-feature emitter modules** (split monolith, stay TypeScript): cheapest, but templates remain code — not diffable artifacts, weak upgrade story, defers the actual goal.
- **A — pure file trees** with template conditionals (`{{#if}}`): uniform, but invents a template language for genuinely conditional code (scrypt-vs-argon2 variants, per-OAuth-provider routing) and risks parity drift.
- **C — hybrid** *(chosen)*: linear files become real file trees; gnarly conditionality stays as small per-feature TypeScript emitters.

The upgrade requirement is the tiebreaker: upgradable template bodies must be diffable, provenance-tracked files. Emitters don't block that — their output is deterministic given config and is hash-tracked like any file.

## Slice package format

```
features/<slice-id>/
├── manifest.yaml
├── files/                    # platform-keyed source trees
│   ├── web/…
│   ├── ios/…
│   ├── android/…
│   └── backend/…
├── emit/                     # OPTIONAL: conditional-code emitters (TS)
│   └── <name>.ts
└── WIRING.md                 # post-install manual steps for agent/user
```

### manifest.yaml schema

| Field | Type | Meaning |
|---|---|---|
| `id` | string (kebab) | Slice identity; matches directory name |
| `version` | semver | Per-slice version, independent of engine version |
| `description` | string | One line for the catalog / LLM |
| `platforms` | list | Subset of `web, ios, android, backend` |
| `requires` | list of slice ids | Installed first by `feature:add` (e.g. account requires auth-core) |
| `config-keys` | list | `system.yaml` paths this slice reads (documents the placeholder surface) |
| `emitters` | list | Names in `emit/` that run during install, in order |
| `upgrade-notes` | string | Optional; surfaced by `feature:upgrade` |

### files/

Real source files with `{{PLACEHOLDER}}` markers, paths relative to each platform's declared root in `system.yaml`. Placeholders resolve from the same map `generateTemplates` builds today (auth policy, TTLs, CORS, jobs schedules, narrative copy, theme tokens, project identifiers).

### emit/

Small TypeScript modules for code that varies structurally with config — e.g. `password-hash.ts` emits scrypt or argon2 implementations, OAuth routing wires only declared providers. Each emitter is deterministic for a given config so its output participates in provenance hashing normally.

### WIRING.md

Everything install cannot do mechanically: register routes in existing indexes, add nav entries, set env vars, run migrations. Written for the agent to execute (or a human at a terminal). This is the only slice content the LLM routinely reads besides the manifest.

## Initial slice inventory (carved from the monolith)

| Slice | Contents | Notes |
|---|---|---|
| `auth-core` | Login/signup/MFA/forgot/reset (web pages, SwiftUI views, Compose screens), backend auth routes, sessions, lockout, password-reset tokens, OAuth routing, email send | requires backend-middleware + db-core; largest; extract last |
| `backend-middleware` | Security headers, rate limiting, payload guard, audit log, performance timer, JSON body, error handler, health routes | Foundation; auth-core requires it |
| `account` | Account security/payment/data/delete pages + views | requires auth-core |
| `legal` | Privacy/terms/cookies + legal hub | Standalone |
| `support` | Support + help pages/views | Standalone |
| `settings` | Settings page/screen | Standalone |
| `jobs` | Background job runner, cleanup schedules | requires backend-middleware |
| `webhooks` | Webhook handling + idempotency cache | requires backend-middleware |
| `db-core` | DB bootstrap, users/sessions/reset-token repositories, schema | requires backend-middleware |

Exact boundaries finalized during extraction planning; the constraint is golden-test parity, not this table.

## Engine commands

All under `master.sh`, implemented in `core/src/feature-library/`:

| Command | Behavior |
|---|---|
| `feature:list [--json]` | Catalog from manifests. Metadata only — template bodies never included. |
| `feature:add <id> [--force]` | Topologically resolve `requires`, substitute placeholders, run emitters, write files. Skip-if-exists per file (today's semantics), unless `--force`. Record provenance in the lockfile for every written file. |
| `feature:status` | Installed slices with version vs available version |
| `feature:upgrade [id]` | Upgrade semantics below. No id = all installed slices. |

### Lockfile: `.auto_system/features.lock`

Per installed slice:

- slice id + version + installed-at engine version
- per-file record: relative path, sha256 of the written content, emitter name if emitter-generated
- placeholder snapshot (resolved values) — guards against silent re-substitution drift when config changes

### Upgrade semantics (the "upgrade time to time" requirement)

For each file owned by an upgradable slice:

1. Compute the new template output (new slice version, current config).
2. **Current file hash == recorded hash** → user never touched it → replace mechanically. Zero LLM involvement.
3. **Current file hash != recorded hash** → user customized it → **never overwrite**; record a conflict with old/new/template diffs.
4. Files added by the new version are written; files removed by it are reported (not deleted).

Exit report: `updated N / conflicts M / added K / removed J`, conflicts listed with paths and diffs. Conflicts are where llm-ide agents earn their tokens afterward: on request, an agent reads a conflict's three-way context and applies the template change to the customized file.

## Compatibility: strict parity

- `generate:templates` remains and becomes an orchestrator installing the legacy default bundle (all slices above in one shot, same skip-if-exists behavior).
- **Golden fixtures:** three representative `system.yaml` snapshots — (a) defaults, (b) `securityLevel: high` + argon2 + OAuth declared, (c) minimal web-only. Full output trees captured pre-extraction; extraction must reproduce them **byte-identical**.
- The self-hosted `apps/` tree keeps regenerating from slices; existing CI (vitest) and compliance checks stay green.

## llm-ide integration

One new skill in the central kit (`dnsmalla/skills`, `scaffold:` family) — e.g. `scaffold/feature-slices`:

- Agent flow: read project goal → `feature:list --json` (≈40 lines per slice) → select slices → `feature:add <id>` per slice → execute `WIRING.md` steps → write only custom code.
- Upgrades: `feature:status` on demand; agent resolves reported conflicts only.
- Reaches llm-ide through the existing path: kit submodule pin bump + `npm run sync:skills`; projects receive the kit via `POST /kb/project/install-skills` as today. **No llm-ide code changes.**

Token economics: fixed code is copied, never generated, never present in context. The LLM sees manifests + WIRING.md + its own custom code.

## Testing

1. **Golden parity** — the hard gate; runs in auto-system CI.
2. **Lockfile/upgrade unit tests** — unmodified file → mechanically updated; modified → conflict, content preserved byte-for-byte; added/removed files; placeholder-snapshot mismatch → warning.
3. **Slice lint** — manifest schema valid, declared `platforms` have files, no absolute paths, every `{{PLACEHOLDER}}` resolvable from declared `config-keys`, `requires` graph acyclic.
4. **Kit tests** — skill surfaces in catalog; `feature:list --json` output shape stable.
5. Existing suites (auto-system vitest, kit tests, llm-ide regression) untouched and green.

## Rollout order

1. Stand up `feature-library/` core: manifest loading, placeholder substitution shared with the legacy path, lockfile, golden fixture capture (pre-extraction snapshot!).
2. Extract easy slices first (`legal`, `support`, `settings`, `backend-middleware`, `db-core`, `jobs`, `webhooks`), parity check after each.
3. Extract `account`, then `auth-core` (the monster).
4. Convert `generate:templates` to the orchestrator; delete the monolith body.
5. `feature:upgrade` + lockfile conflict tests.
6. Kit skill + sync.
7. Engine version bump; system-controller picks it up via pin bump (no changes there).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Byte-parity drift during extraction (whitespace, escaping) | Golden fixtures captured **before** any extraction; parity checked after every slice, not only at the end |
| Slice boundary mistakes force churn | Boundaries are provisional until parity passes; inventory table is a plan, not a contract |
| Placeholder map shared between legacy and slice paths diverges | Single substitution module, both paths call it; placeholder snapshot in lockfile makes drift visible |
| Lockfile merge conflicts / hand-editing | Treat unparsable lockfile as "all files suspect" → full conflict report, never silent overwrite |
| Catalog JSON shape churn breaking the kit skill | `feature:list --json` shape is versioned with the slice manifest schema |
