---
title: How to contribute
applies_to: all
---

# How to contribute

> Conventions for committing code to Meet Notes.

## Goal

Land a change that's reviewable, doesn't regress invariants, and keeps the docs in sync.

## Steps

### 1. Before you start

- For non-trivial changes, scan [Engineering invariants](../explanation/invariants.md) — especially the section for the file you're about to edit.
- For a new architectural direction, write an ADR first (`docs/decisions/NNNN-<title>.md`, status `proposed`). Get it reviewed before code.

### 2. Code style

- TypeScript: strict mode, no `any`, no widening.
- Server: pure Node `http`, ESM (`.mjs`), no new framework.
- No new dependencies without justification in the PR description.
- One logical change per PR.

### 3. Security ground rules (non-negotiable)

- No wildcard CORS. ([ADR 0005](../decisions/0005-strict-cors-allowlist.md))
- No API key inputs; LLM calls go through `claude -p`. ([ADR 0001](../decisions/0001-claude-cli-not-api-key.md))
- No new vault key without updating the allowlist in `extension/server/vault.mjs`.
- User content is always wrapped in `<<<BEGIN>>>…<<<END>>>` fences and sanitised first.
- No new dispatch path that bypasses the review queue.
- Bump `SERVER_API_VERSION` when changing the wire format; update `REQUIRED_ENDPOINTS` in `App.tsx`.

### 4. Docs accompany code

If you add an endpoint → update [`docs/reference/api/overview.md`](../reference/api/overview.md) and `docs/reference/api/openapi.yaml`. If you change an invariant → update [invariants.md](../explanation/invariants.md). If you make an architectural decision → add an ADR.

### 5. Commits

- Conventional-commit style: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- One logical change per commit when feasible; one logical change per PR always.

### 6. Releasing

1. Bump `extension/package.json` version.
2. Bump `SERVER_API_VERSION` if endpoints changed.
3. Update README badges if major.
4. Tag `vX.Y.Z`.
5. Build the macOS DMG (`mac/build_app.sh`) if shipping a paired release.

## Verification

```bash
cd extension
npm run type-check
npm test
```
Both must pass before opening a PR.

## See also

- [Tutorial: Record your first meeting](../tutorials/01-first-meeting.md)
- [Engineering invariants](../explanation/invariants.md)
- [Decisions index](../decisions/)
