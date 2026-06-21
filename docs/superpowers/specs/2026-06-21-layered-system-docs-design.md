---
title: Layered system documentation — design
date: 2026-06-21
status: draft
---

# Layered system documentation — design

## Context

LLM IDE has substantial documentation already (the curated `docs/`
Diátaxis tree, ~45 design specs under `docs/superpowers/`, an
auto-generated 171-file `extension/.code-notes/` code-graph index, and
per-layer READMEs). What it lacks is a **single coherent doc set that
explains the whole system at two depths**:

- a **human-explanation layer** — enough for any engineer (or AI) to
  understand, navigate, port, and safely change the system, and
- a **generative-spec layer** — rebuild-grade detail (prompts verbatim,
  full DDL, every endpoint contract, exact algorithms, invariants as
  hard constraints) such that the system could be regenerated from the
  docs rather than re-imagined.

A whole-system visual guide already exists as a Claude artifact (the
"System Guide") and serves as the front-door overview. This effort
turns that overview into a durable, version-controlled, layered doc set
in the mkdocs tree.

### Why now / the motivating finding

A blueprint-level doc lets an AI produce something *architecturally*
like LLM IDE but not a faithful reproduction — because the system's
behavior lives in details a blueprint omits: the **prompts** (the agent
*is* its prompts), the **full DDL**, the **wire contracts**, and the
**exact algorithms** (caption filters, FTS tokenizer, rate-limit
numbers). The generative-spec layer exists to close precisely that gap.

## Goals

1. A layered doc set covering the entire system, organized by subsystem.
2. The explanation layer is complete enough to onboard, port, and change.
3. The spec layer is complete enough to **regenerate** each subsystem.
4. Maximum reuse of what already exists; minimum duplication.
5. Spec pages stay in sync with code (extend the existing extractor
   pattern wherever the source is structured).

## Non-goals (YAGNI)

- Rewriting the ~70 existing `docs/` pages. We harvest and fill gaps.
- Documenting every one of the 1000 files by hand. The
  `.code-notes/` index already covers per-file navigation.
- An end-user / customer manual. This is engineering documentation.
- A new docs toolchain. We stay on mkdocs + the existing extractors.

## Design

### Decomposition — 6 documentation units

Each unit maps to a natural system boundary and gets one explanation
page and one spec page.

| # | Unit | Source areas | Spec layer must capture |
|---|------|--------------|-------------------------|
| 1 | **API & server** | `server/`, `core/` | Every endpoint's request/response contract, auth + token lifecycle, error codes (with descriptions), rate-limit profiles, middleware order |
| 2 | **Knowledge base** | `kb/` | Full DDL (columns/types/indexes/FKs), every migration, tenancy rules, FTS5 tokenizer + match-expr, vault crypto layout |
| 3 | **Agent runtime** | `llm_agent/`, `agents/` | **Prompts verbatim**, skill frontmatter schema, depth model, sub-model cascade, fence protocol, dispatch + outcome-poll logic |
| 4 | **Chrome extension** | `src/` | `MsgType` enum + message payloads, caption-scraper algorithm + every content filter, `chrome.storage` shapes, build/manifest |
| 5 | **macOS app** | `mac/` | Service contracts, platform-coupling interfaces, server IPC, capture pipeline |
| 6 | **Cross-cutting** | config, security, build | Security model, env/config matrix, build/deploy, invariants restated as hard constraints |

### Two-layer template (identical for every unit)

- **Explanation** — `docs/explanation/<unit>.md`. The human "what & why."
  Deepened from existing explanation pages. Diátaxis "explanation" type.
- **Spec** — `docs/spec/<unit>.md` (new section). The rebuild-grade
  "exactly what." Each spec page ends with a **Regeneration checklist**
  (see Validation) and links to its explanation page and to the
  structured reference pages it draws on.

Cross-link, never duplicate: when a fact is already in a generated
reference page (e.g. `reference/database-schema.md`), the spec page
*includes or links* it rather than restating it.

### docs/ tree changes

```
docs/
  explanation/        # deepen existing + add gaps
  spec/               # NEW — one rebuild-grade page per unit
    index.md          # what "generative-grade" means + the regen test
    api-server.md
    knowledge-base.md
    agent-runtime.md
    chrome-extension.md
    macos-app.md
    cross-cutting.md
  reference/          # extend existing extractors to fill gaps
  _scripts/           # extend extract_*.py; add extract_prompts, etc.
```

mkdocs nav gains a top-level **Spec** section. `docs/index.md` gains a
"two-layer" note pointing humans at explanation, rebuilders at spec.

### Approach — harvest + extend extractors

Much of the spec layer already exists and is **auto-generated**:

- `reference/database-schema.md` — full DDL from `kb/migrations/*.sql`.
- `reference/api/openapi.yaml` + generated `error-codes.md`,
  `env-vars.md`, `guardrail-rules.md`, `rate-limit-profiles.md`,
  `message-protocol.md` — via `docs/_scripts/extract_*.py`.

So each unit's work is: **audit the existing generated/reference
material for completeness and accuracy → fill gaps → add the genuinely
missing pieces.** Where a source is structured (SQL, error tables,
config), prefer a new/extended extractor over hand-written prose so the
spec can't drift. The one large unavoidably hand-curated piece is the
**agent prompts** (unit 3), which nothing documents today.

### Relationship to the visual System Guide

The visual guide stays as the linked front-door overview. Its content
graduates into `docs/explanation/` (whole-system + portability) as
Markdown so it is version-controlled and searchable. The artifact is
not the system of record; the mkdocs tree is.

## First unit (this spec's implementation target): KB + API contracts

We fully build units #2 (Knowledge base) and #1 (API & server)
together first — they are the spine every other unit references, and
their gaps are concrete and verifiable.

### What already exists (harvest)

- `reference/database-schema.md` — generated full DDL for all tables.
- `reference/api/openapi.yaml` + `api/overview.md` + generated
  `error-codes.md`.
- `explanation/server-internals.md` — pipeline, tenancy, vault, audit,
  rate-limit narrative.
- `reference/{env-vars,rate-limit-profiles,persistence}.md`.

### Gaps to fill (the actual work)

1. **Schema-version drift.** Docs and the System Guide say "schema
   version 4," but `kb/migrations/` contains `0001`–`0013`. Resolve:
   determine the true `SCHEMA_VERSION` constant vs. migration count,
   correct every doc that states it, and document what the version
   number actually tracks.
2. **Error-code descriptions.** Generated `error-codes.md` has empty
   Description cells; `api/overview.md` has rich ones. Make the
   extractor capture descriptions from `server/errors.mjs` so the two
   stop disagreeing.
3. **OpenAPI completeness.** Audit `openapi.yaml` against the live
   `ENDPOINTS` array in `server.mjs`: every route present, every
   request/response body schema'd, auth + rate-limit profile noted.
   List any endpoint missing a contract.
4. **DDL completeness for regeneration.** Confirm `database-schema.md`
   includes indexes, FK actions, CHECK constraints, and the FTS5
   virtual-table definition + triggers — not just columns.
5. **FTS + tenancy as spec.** Document `buildMatchExpr` tokenization
   rules and the "shared index, scoped hydration" contract precisely
   enough to re-implement.
6. **Vault crypto layout.** State the exact ciphertext byte layout and
   HKDF parameters as a spec (already narrated in server-internals;
   promote to spec-grade with test vectors if feasible).

### Deliverables for the first unit

- `docs/spec/index.md` — defines "generative-grade" and the regen test.
- `docs/spec/knowledge-base.md` — unit #2 spec.
- `docs/spec/api-server.md` — unit #1 spec.
- Deepened `docs/explanation/server-internals.md` (or split) as the
  explanation layer for these two units.
- Extractor fixes: error-code descriptions; a completeness check script
  that diffs `openapi.yaml` ↔ `server.mjs` ENDPOINTS and
  `database-schema.md` ↔ migrations.
- Every doc stating "schema version 4" corrected.

## Per-unit doc template (so units 3–6 are mechanical)

Each spec page follows:

1. **Scope** — which source files this unit governs.
2. **Contracts** — the interfaces a rebuilder must reproduce exactly
   (schemas, signatures, wire formats, prompt text).
3. **Algorithms** — step-precise descriptions of any non-obvious logic.
4. **Invariants** — the hard constraints (lifted from
   `explanation/invariants.md`), stated as MUST.
5. **Data/state** — what is persisted and where.
6. **Regeneration checklist** — see Validation.

## Validation — how we know a spec is "generative-grade"

The acceptance test for each spec page is a **regeneration checklist**:
a fresh reader with only that spec page (+ its linked reference pages)
must be able to reproduce the subsystem's contracts without inventing
detail. Concretely, the page passes when:

- Every public symbol / endpoint / table / prompt it governs is present
  with its exact shape (no "etc.", no "see code").
- Every magic number and pattern is stated (timeouts, caps, regexes,
  crypto params).
- A spot-check rebuild of one representative piece (e.g. recreate the
  `meetings` table DDL, or one endpoint's handler signature) from the
  spec alone matches the source.

Automated guardrails:

- Extend `docs/_scripts/` extractors so structured facts regenerate from
  source (DDL, error codes, env vars, endpoint list, message types).
- Add CI checks that fail when an extractor's output drifts from the
  committed doc (the repo already runs the extractors' tests under
  `docs/_scripts/test_*.py`).

## Phasing

1. **Now:** units #1 + #2 (this spec), proving the template + extractors.
2. Unit #3 Agent runtime (prompts verbatim — the biggest gap).
3. Units #4 + #5 (the two clients).
4. Unit #6 cross-cutting + whole-system explanation graduation.

Each subsequent unit gets its own short plan; the template + validation
defined here are reused, so later units are largely mechanical.

## Risks

- **Staleness.** Hand-written spec prose drifts from code. Mitigation:
  extractor-first for structured facts; the prompts (unavoidably
  hand-linked) live next to the code and are referenced, not copied.
- **Scope creep.** "Explain everything" tempts per-file prose.
  Mitigation: the `.code-notes/` index owns per-file navigation; the
  spec layer owns contracts only.
- **Accuracy debt surfaced mid-write** (like the schema-version drift).
  Mitigation: treat each discovered drift as a fix in the owning doc,
  not a TODO in the new one.
