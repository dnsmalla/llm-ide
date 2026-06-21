# System Docs — Unit 1 (KB + API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first layered documentation unit — a rebuild-grade spec layer + deepened explanation layer for the Knowledge Base (`kb/`) and the API/server (`server/`, `core/`), with drift fixed and extractor-backed validation.

**Architecture:** Harvest the existing generated/reference docs, fix accuracy drift, extend the `docs/_scripts/` extractors so structured facts can't drift, then write two new `docs/spec/` pages whose acceptance test is a "regeneration checklist." Documentation tasks that touch structured sources are test-driven against the existing `docs/_scripts/test_*.py` harness.

**Tech Stack:** mkdocs (material + awesome-pages), Python 3 extractors under `docs/_scripts/` (pytest), Node/SQLite source under `extension/`.

---

## Scope

This plan covers documentation units #1 (API & server) and #2 (Knowledge base) from the design spec [`docs/superpowers/specs/2026-06-21-layered-system-docs-design.md`](../specs/2026-06-21-layered-system-docs-design.md). Units #3–#6 are out of scope and get their own plans reusing the template proven here.

## File structure

| File | Responsibility | New? |
|------|----------------|------|
| `docs/explanation/architecture.md` | Fix stale "Schema version 4" | modify |
| `docs/decisions/0008-append-only-migrations.md` | Fix `_migrations` → `schema_migrations` | modify |
| `extension/core/errors.mjs` | Add `//` doc-comment above each error factory | modify |
| `docs/_scripts/test_extract_error_codes.py` | Assert every code has a non-empty description | modify |
| `docs/reference/error-codes.md` | Regenerated with descriptions | regenerate |
| `docs/_scripts/check_api_coverage.py` | Diff `server.mjs` ENDPOINTS ↔ `openapi.yaml` paths | create |
| `docs/_scripts/test_check_api_coverage.py` | Test the coverage checker | create |
| `docs/reference/api/openapi.yaml` | Fill any missing endpoint contracts | modify |
| `docs/_scripts/extract_schema.py` | Ensure indexes + FTS5 + triggers are emitted | modify (if needed) |
| `docs/reference/database-schema.md` | Regenerated, regen-complete | regenerate |
| `docs/spec/index.md` | Define "generative-grade" + the regeneration test | create |
| `docs/spec/knowledge-base.md` | Unit #2 spec | create |
| `docs/spec/api-server.md` | Unit #1 spec | create |
| `docs/spec/.pages` | awesome-pages title/order for the Spec section | create |
| `docs/index.md` | Add the two-layer note pointing to `spec/` | modify |

> **Nav note:** `mkdocs.yml` has no explicit `nav:` — it uses the `awesome-pages` plugin, so creating `docs/spec/*.md` auto-adds a section. The `.pages` file only sets the title and page order.

---

## Task 1: Fix the schema-version drift

**Files:**
- Modify: `docs/explanation/architecture.md:72`
- Modify: `docs/decisions/0008-append-only-migrations.md:15`

**Background (verified):** `extension/kb/migrations.mjs` tracks applied migrations in a `schema_migrations` table (one row per migration), with head migration `0013_email_state.sql`. There is no single "schema version 4" constant and no `PRAGMA user_version`. The number `4` is stale; the ADR's `_migrations` table name is wrong.

- [ ] **Step 1: Fix `architecture.md`**

Replace line 72:
```
SQLite, WAL mode, FTS5, foreign keys on. Schema version **4**; migrations under `extension/kb/migrations/` apply on server start.
```
with:
```
SQLite, WAL mode, FTS5, foreign keys on. There is no single schema-version number — each migration under `extension/kb/migrations/` (currently `0001`–`0013`) is recorded in the `schema_migrations` table and applied on server start. The head migration is the effective schema version.
```

- [ ] **Step 2: Fix ADR-0008**

In `docs/decisions/0008-append-only-migrations.md:15`, change `tracked in a `_migrations` table` to `tracked in a `schema_migrations` table`.

- [ ] **Step 3: Verify no other stale "version 4" remains for the DB**

Run: `grep -rniE "schema version \**4|schema version[^s]*4" docs README.md extension/docs`
Expected: no matches (the per-project-workspaces `schemaVersion: 1` hits are a different, Mac-app schema — leave them).

- [ ] **Step 4: Commit**

```bash
git add docs/explanation/architecture.md docs/decisions/0008-append-only-migrations.md
git commit -m "docs: correct stale DB schema-version claims (no v4; schema_migrations table)"
```

---

## Task 2: Fill error-code descriptions (extractor TDD)

**Files:**
- Modify: `docs/_scripts/test_extract_error_codes.py`
- Modify: `extension/core/errors.mjs`
- Regenerate: `docs/reference/error-codes.md`

**Background (verified):** `extract_error_codes.py` already collects consecutive `//` comment lines immediately above each `export const err...` factory as the description. The factories in `core/errors.mjs` mostly lack those comments, so the generated table's Description column is empty.

- [ ] **Step 1: Write the failing test**

Add to `docs/_scripts/test_extract_error_codes.py`:
```python
def test_every_code_has_a_description():
    from extract_error_codes import extract
    from pathlib import Path
    rows = extract(Path("extension/core/errors.mjs"))
    missing = [r["code"] for r in rows if not r["description"].strip()]
    assert not missing, f"error codes missing descriptions: {missing}"
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `python -m pytest docs/_scripts/test_extract_error_codes.py::test_every_code_has_a_description -v`
Expected: FAIL listing codes like `AUTH_REQUIRED`, `FORBIDDEN`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`.

- [ ] **Step 3: Add a one-line `//` doc comment above each error factory**

In `extension/core/errors.mjs`, add a comment line directly above each `export const err...` (no blank line between). Example:
```javascript
// Missing or invalid bearer token; client must (re)authenticate.
export const errAuth = (msg = 'Authentication required') =>
  new AppError('AUTH_REQUIRED', msg, { status: 401 });

// Authenticated, but the resource isn't owned by this user.
export const errForbidden = (msg = 'Forbidden') =>
  new AppError('FORBIDDEN', msg, { status: 403 });
```
Cover every factory: `errAuth`, `errForbidden`, `errNotFound`, `errValidation`, `errConflict`, `errRateLimit`, `errInternal`, and any others present. Reuse the wording from `docs/reference/api/overview.md`'s error table as the source of truth for meaning.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `python -m pytest docs/_scripts/test_extract_error_codes.py -v`
Expected: PASS.

- [ ] **Step 5: Regenerate the reference page**

Run: `python docs/_scripts/extract_error_codes.py`
Expected: `docs/reference/error-codes.md` now has populated Description cells.

- [ ] **Step 6: Commit**

```bash
git add extension/core/errors.mjs docs/_scripts/test_extract_error_codes.py docs/reference/error-codes.md
git commit -m "docs: document error factories so extractor fills descriptions"
```

---

## Task 3: API coverage checker + fill OpenAPI gaps

**Files:**
- Create: `docs/_scripts/check_api_coverage.py`
- Create: `docs/_scripts/test_check_api_coverage.py`
- Modify: `docs/reference/api/openapi.yaml`

**Background (verified):** `server.mjs:34` declares the live `ENDPOINTS` array; `SERVER_API_VERSION = 18` (server.mjs:33). `openapi.yaml` currently documents 20 paths. The checker proves the OpenAPI spec is complete against the live endpoint list.

- [ ] **Step 1: Write the checker**

Create `docs/_scripts/check_api_coverage.py`:
```python
"""Diff the live ENDPOINTS array in extension/server.mjs against the
paths documented in docs/reference/api/openapi.yaml.

Run from repo root:  python docs/_scripts/check_api_coverage.py
Exit 0 if every live endpoint has an OpenAPI path; exit 1 + list otherwise.
"""
from __future__ import annotations
import re, sys
from pathlib import Path

SERVER = Path("extension/server.mjs")
OPENAPI = Path("docs/reference/api/openapi.yaml")

def live_endpoints(text: str) -> set[str]:
    # ENDPOINTS = [ '/health', '/kb/search', ... ]
    m = re.search(r"ENDPOINTS\s*=\s*\[(?P<body>.*?)\]", text, re.DOTALL)
    if not m:
        raise SystemExit("could not find ENDPOINTS array in server.mjs")
    return set(re.findall(r"['\"](/[^'\"]+)['\"]", m.group("body")))

def documented_paths(text: str) -> set[str]:
    # top-level "  /path:" entries under the paths: block
    return set(re.findall(r"^\s{2}(/[A-Za-z0-9_{}/-]+):", text, re.MULTILINE))

def main() -> int:
    live = live_endpoints(SERVER.read_text())
    documented = documented_paths(OPENAPI.read_text())
    missing = sorted(live - documented)
    if missing:
        print("Endpoints missing from openapi.yaml:")
        for p in missing:
            print(f"  {p}")
        return 1
    print(f"OK: all {len(live)} live endpoints documented.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Write a test for the checker's parsers**

Create `docs/_scripts/test_check_api_coverage.py`:
```python
from check_api_coverage import live_endpoints, documented_paths

def test_live_endpoints_parses_array():
    src = "const ENDPOINTS = ['/health', '/kb/search', '/auth/login'];"
    assert live_endpoints(src) == {"/health", "/kb/search", "/auth/login"}

def test_documented_paths_parses_yaml():
    y = "paths:\n  /health:\n    get: {}\n  /kb/search:\n    post: {}\n"
    assert documented_paths(y) == {"/health", "/kb/search"}
```

- [ ] **Step 3: Run the test**

Run: `python -m pytest docs/_scripts/test_check_api_coverage.py -v`
Expected: PASS.

- [ ] **Step 4: Run the checker against the real files**

Run: `python docs/_scripts/check_api_coverage.py`
Expected: either "OK" or a list of missing endpoints.

- [ ] **Step 5: Document the gaps**

For each missing path the checker prints, add a complete entry to `docs/reference/api/openapi.yaml` — method(s), summary, `security` (bearer or public), request body schema, response schema, and the error codes it can return. Mirror the style of an existing entry (e.g. `/kb/search`). If a live endpoint is intentionally undocumented (internal/bot-relay), add it under a clearly-labelled `x-internal: true` and exclude it in the checker.

- [ ] **Step 6: Re-run the checker to green**

Run: `python docs/_scripts/check_api_coverage.py`
Expected: `OK: all N live endpoints documented.`

- [ ] **Step 7: Commit**

```bash
git add docs/_scripts/check_api_coverage.py docs/_scripts/test_check_api_coverage.py docs/reference/api/openapi.yaml
git commit -m "docs: add API coverage checker and close openapi gaps vs live ENDPOINTS"
```

---

## Task 4: DDL completeness for regeneration

**Files:**
- Modify (if needed): `docs/_scripts/extract_schema.py`
- Regenerate: `docs/reference/database-schema.md`

**Goal:** `database-schema.md` must be complete enough to recreate the DB: columns + types + constraints (already present), PLUS indexes, FK on-delete actions, CHECK constraints, and the FTS5 virtual table + its sync triggers.

- [ ] **Step 1: Audit current output**

Run: `grep -ciE "CREATE INDEX|FTS5|TRIGGER|fts" docs/reference/database-schema.md`
Also inspect the migrations for these constructs:
Run: `grep -liE "CREATE INDEX|USING fts5|CREATE TRIGGER" extension/kb/migrations/*.sql`
If migrations contain indexes/FTS/triggers that the doc omits, the extractor needs extending.

- [ ] **Step 2: Write a failing assertion (only if Step 1 shows omissions)**

Add to `docs/_scripts/test_extract_schema.py`:
```python
def test_schema_doc_includes_indexes_and_fts():
    from pathlib import Path
    doc = Path("docs/reference/database-schema.md").read_text()
    # The search FTS5 virtual table must be documented.
    assert "search" in doc and ("fts5" in doc.lower() or "FTS5" in doc)
    # At least the plan_tasks indexes (migration 0011) must appear.
    assert "INDEX" in doc.upper() or "Indexes" in doc
```

- [ ] **Step 3: Run it**

Run: `python -m pytest docs/_scripts/test_extract_schema.py -v`
Expected: FAIL if the extractor drops these; PASS if already complete (then skip Step 4).

- [ ] **Step 4: Extend `extract_schema.py`**

Add regexes for `CREATE INDEX ...`, `CREATE VIRTUAL TABLE ... USING fts5(...)`, and `CREATE TRIGGER ...`, and emit an "Indexes", "Full-text search", and "Triggers" subsection per table (or a dedicated section). Keep the existing column tables unchanged.

- [ ] **Step 5: Regenerate and verify**

Run: `python docs/_scripts/extract_schema.py && python -m pytest docs/_scripts/test_extract_schema.py -v`
Expected: PASS; `database-schema.md` now shows indexes, the FTS5 table, and triggers.

- [ ] **Step 6: Commit**

```bash
git add docs/_scripts/extract_schema.py docs/_scripts/test_extract_schema.py docs/reference/database-schema.md
git commit -m "docs: make database-schema regen-complete (indexes, FTS5, triggers)"
```

---

## Task 5: Create the spec section + `spec/index.md`

**Files:**
- Create: `docs/spec/index.md`
- Create: `docs/spec/.pages`
- Modify: `docs/index.md`

- [ ] **Step 1: Write `docs/spec/.pages`**

```yaml
title: Spec (rebuild-grade)
nav:
  - index.md
  - knowledge-base.md
  - api-server.md
```

- [ ] **Step 2: Write `docs/spec/index.md`**

Content must cover, in this order:
1. **What this layer is** — rebuild-grade contracts, the complement to `explanation/`. One reader = a fresh engineer/AI with only these pages + linked reference pages.
2. **The "generative-grade" bar** — a page passes when every symbol/endpoint/table/prompt it governs is present with exact shape, every magic number/pattern/crypto-param is stated, and a spot-check rebuild of one piece from the page alone matches source. (Lift the wording from the design spec's Validation section.)
3. **The Regeneration checklist template** — reproduce verbatim so every spec page ends with it:
   ```markdown
   ## Regeneration checklist
   - [ ] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
   - [ ] Every magic number, timeout, cap, regex, and crypto parameter is stated.
   - [ ] Spot-check: one representative piece rebuilt from this page alone matches source.
   - [ ] Structured facts link to their extractor-generated reference page (no hand-copied drift).
   ```
4. **How it stays in sync** — extractor-first for structured facts; `docs/_scripts/check_api_coverage.py` + `test_*.py` guard drift in CI.

- [ ] **Step 3: Add the two-layer note to `docs/index.md`**

After the "How this site is organised" table, add:
```markdown
## Two reading depths

- **Explanation** (`explanation/`) — understand, navigate, port, and safely change the system.
- **Spec** (`spec/`) — rebuild-grade contracts. Read these when reproducing a subsystem exactly.
```

- [ ] **Step 4: Build the site to verify nav**

Run: `mkdocs build -f mkdocs.yml --strict 2>&1 | tail -20`
Expected: build succeeds; a "Spec (rebuild-grade)" section appears with the index page. (If `--strict` flags the not-yet-created `knowledge-base.md`/`api-server.md` nav entries, that's expected until Tasks 6–7; drop them from `.pages` temporarily or proceed and re-run after Task 7.)

- [ ] **Step 5: Commit**

```bash
git add docs/spec/index.md docs/spec/.pages docs/index.md
git commit -m "docs: add spec/ section, generative-grade definition, regen checklist"
```

---

## Task 6: `docs/spec/knowledge-base.md` (unit #2)

**Files:**
- Create: `docs/spec/knowledge-base.md`

Write the page with these sections. Each bullet states the exact content and its source — fill from source, do not summarize.

- [ ] **Step 1: Scope** — list the files this unit governs: `extension/kb/db.mjs` + the sibling domain modules (`meetings/sources/plans/personas/feedback/reviews/outcomes/user.mjs`), `kb/migrations/*.sql`, `kb/router.mjs` + `kb/routes/*`, `core/errors.mjs`, `server/vault.mjs`.

- [ ] **Step 2: Storage contract** — embed/transclude the table list and link to `reference/database-schema.md` for full DDL (do not copy DDL — link). State the SQLite pragmas verbatim from `server-internals.md` (WAL, synchronous=NORMAL, busy_timeout=5000, wal_autocheckpoint=1000, mmap_size=64MB, temp_store=MEMORY).

- [ ] **Step 3: Migration protocol** — `schema_migrations` table (version PK, name, checksum, applied_at), lexical order, checksum-mismatch is a warning not a failure, append-only, no down-migrations. Source: `kb/migrations.mjs`.

- [ ] **Step 4: Tenancy contract (rebuild-grade)** — state the three invariants as MUST: every state-mutating helper takes `userId` first and `requireUser` throws if absent; FTS index is shared but hydration is `user_id`-scoped (cross-tenant hits dropped); router reads `req.user.id` → 401 if missing; legacy rows back-filled to `user_id='legacy'`.

- [ ] **Step 5: Search/FTS algorithm** — document `buildMatchExpr`: tokenizes on `\p{L}\p{N}_`, quotes terms, joins with AND (or OR), max 12 terms; the empty-query list path (meetings/entities/outcomes by date DESC); the kind filter values (meeting/action/decision/blocker/outcome). Source: `kb/db.mjs` search().

- [ ] **Step 6: Vault crypto (rebuild-grade)** — ciphertext byte layout `version(1) ‖ iv(12) ‖ aes-256-gcm(plaintext) ‖ tag(16)`; per-user key `HKDF-SHA256(masterKey, salt=userId, info='llmide-vault-v1', length=32)`; allow-listed keys list. Source: `server/vault.mjs`.

- [ ] **Step 7: Append the Regeneration checklist** (verbatim from `spec/index.md`).

- [ ] **Step 8: Verify spot-check** — confirm the page lets you re-state the `meetings` table and the vault layout without opening source. Run `mkdocs build --strict 2>&1 | tail -5`.

- [ ] **Step 9: Commit**

```bash
git add docs/spec/knowledge-base.md
git commit -m "docs: add rebuild-grade Knowledge Base spec (unit #2)"
```

---

## Task 7: `docs/spec/api-server.md` (unit #1)

**Files:**
- Create: `docs/spec/api-server.md`

- [ ] **Step 1: Scope** — `server.mjs` + `server/{auth,auth-routes,ai-routes,export-routes,rate-limit,jwt,vault,audit,metrics,users,control-plane}.mjs`, `core/{config,errors,logger,utils}.mjs`.

- [ ] **Step 2: Request pipeline (ordered MUST list)** — CORS → request-id+logger child → authenticate (attach req.user) → /auth/* → rate-limit per (profile, scope) → /kb/* router → legacy LLM endpoints → metrics+audit. Note `SERVER_API_VERSION = 18` and the stale-server detection contract (`ENDPOINTS` + `REQUIRED_ENDPOINTS`).

- [ ] **Step 3: Endpoint contracts** — link `reference/api/openapi.yaml` as the authoritative per-endpoint schema (now coverage-checked in Task 3). State the global conventions: base URL `http://127.0.0.1:3456`, `Authorization: Bearer`, error envelope `{ error: { code, message, details } }`.

- [ ] **Step 4: Auth + token lifecycle (rebuild-grade)** — HS256 JWT, claims (`iss`,`sub`,`role`,`typ='access'`,`iat`,`exp`), 15-min access TTL, alg locked to HS256, constant-time compare, 10s skew; opaque base64url refresh token sha256-hashed at rest, rotates every refresh with old-token revocation; bcrypt cost 12 + sentinel-hash compare for unknown emails. Source: `server/{jwt,auth}.mjs`.

- [ ] **Step 5: Rate-limit profiles** — link `reference/rate-limit-profiles.md`; state scope rule (userId authed / IP unauthed) and the 429 `Retry-After` contract.

- [ ] **Step 6: Error codes** — link the now-described `reference/error-codes.md`; state that `AppError` is the only thrown type and anything else becomes `INTERNAL_ERROR`.

- [ ] **Step 7: Limits & guards** — 2 MB body limit (5 MB for plugin install), 500 k-char prompt cap, CORS echo-origin allowlist, 127.0.0.1 bind unless `LLMIDE_ALLOW_REMOTE=1`.

- [ ] **Step 8: Append the Regeneration checklist** (verbatim).

- [ ] **Step 9: Verify + build**

Run: `python docs/_scripts/check_api_coverage.py && mkdocs build --strict 2>&1 | tail -5`
Expected: coverage OK + clean build with both spec pages in nav.

- [ ] **Step 10: Commit**

```bash
git add docs/spec/api-server.md
git commit -m "docs: add rebuild-grade API & server spec (unit #1)"
```

---

## Task 8: Deepen the explanation layer + cross-link

**Files:**
- Modify: `docs/explanation/server-internals.md`
- Modify: `docs/explanation/architecture.md`

- [ ] **Step 1: Add explanation↔spec cross-links**

At the top of `server-internals.md`, add an admonition:
```markdown
!!! info "Rebuild-grade detail"
    This page explains *how and why*. For exact contracts (auth lifecycle, error codes, DDL, vault layout) see [`spec/api-server.md`](../spec/api-server.md) and [`spec/knowledge-base.md`](../spec/knowledge-base.md).
```
Add the reciprocal "See also" link from each spec page back to `server-internals.md` (if not already added in Tasks 6–7).

- [ ] **Step 2: Fill explanation gaps surfaced during spec writing**

If writing Tasks 6–7 exposed any behavior not yet explained in prose (e.g. the empty-query search path, the circuit-breaker semantics referenced from KB), add a short explanatory paragraph to `server-internals.md`. Do not duplicate the spec; explain the rationale.

- [ ] **Step 3: Build + final coverage gate**

Run: `mkdocs build --strict 2>&1 | tail -10 && python docs/_scripts/check_api_coverage.py && python -m pytest docs/_scripts/ -q`
Expected: clean build, API coverage OK, all extractor tests green.

- [ ] **Step 4: Commit**

```bash
git add docs/explanation/server-internals.md docs/explanation/architecture.md
git commit -m "docs: cross-link explanation↔spec layers for KB + API"
```

---

## Cleanup note (outside this plan's commits)

The published System Guide artifact and the design spec both mention "schema v4". After Task 1 lands, update the artifact's stack table + footnote to match the corrected statement, so the front-door overview doesn't reintroduce the drift.

## Self-review

- **Spec coverage:** design-spec first-unit gaps 1–6 map to Tasks 1 (drift), 2 (error descriptions), 3 (OpenAPI completeness), 4 (DDL completeness), 5 (FTS/tenancy via spec/index regen test + Task 6 §4–5), 6 (vault via Task 6 §6). Deliverables (`spec/index.md`, `spec/knowledge-base.md`, `spec/api-server.md`, deepened explanation, extractor fixes) map to Tasks 5/6/7/8/2/3. ✓
- **Placeholder scan:** every code/script step has literal content; doc-authoring steps give exact sections + sources + the verbatim regeneration checklist (a contract, not a placeholder). ✓
- **Type/name consistency:** `schema_migrations`, `check_api_coverage.py`, `SERVER_API_VERSION = 18`, `errAuth/errForbidden/...`, `buildMatchExpr` used consistently across tasks. ✓
