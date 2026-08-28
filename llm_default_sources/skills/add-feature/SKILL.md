---
name: add-feature
description: Add a complete feature end-to-end across DB, API, UI, and tests. Use when the user says "add posts", "users should be able to X", "build a feature that…", "add a CRUD for…", "support uploading avatars", or any request that touches multiple layers (entity + route + screen). Prefer this over separate configure-database + configure-backend + manual UI work — this skill sequences them correctly and catches the drift cases.
---

# Add a feature

A production feature is a **vertical slice**: schema → migration → service/repository → route → OpenAPI → UI → tests. Doing it layer-by-layer out of order creates drift. This skill walks the slice in the one correct order, naming which other skill owns each step.

## When to use

- "Users should be able to post comments"
- "Add a wishlist feature"
- "Support avatar uploads"
- "Let admins invite teammates"
- Any request that will create a new DB table + a new API route + new screens

## When NOT to use

- **Pure UI change** (reorder items, change copy) → skip to direct edit; no slice needed.
- **Pure backend change** (tune a route, add middleware) → `configure-backend` is enough.
- **Infra change** (rate limits, CORS) → `configure-backend` directly.

## The slice (order is binding)

Almost every layer is GENERATED from `database.entities`. Only the web screen
is hand-written. `[GEN]` files must NOT be authored by hand — they get
overwritten, and hand copies drift from what the engine emits.

| # | Step | Owner | Input | Output |
|---|------|-------|-------|--------|
| 1 | **Model the entity** | `configure-database` | Feature's core noun(s) | `database.entities[]` in system.yaml |
| 2 | **Emit schema + migration** | `generate:database` | `database.entities[]` | `[GEN]` services/core-api/src/db/schema.ts, `[GEN]` migrations/000_extensions.sql |
| 3 | **Apply migration** | drizzle-kit + psql | schema.ts | Live DB has the new table |
| 4 | **Repository** | `generate:feature` | `database.entities[]` | `[GEN]` src/repositories/<e>Repo.ts |
| 5 | **Service** | `generate:feature` | repository | `[GEN]` src/services/<e>.service.ts |
| 6 | **Route + registration** | `generate:feature` | service | `[GEN]` src/routes/<e>.ts, and routes/index.ts is wired AUTOMATICALLY — do not hand-wire it |
| 7 | **OpenAPI contract** | `generate:openapi-from-routes` | the route graph | `[GEN]` docs/openapi.yaml paths |
| 8 | **Screen** | hand, from `templates/` | primitives | `[HAND]` apps/web/app/<plural>/page.tsx — the ONLY hand-written layer |
| 9 | **Client registry + models** | `generate:api-client`, `generate:api-models` | the OpenAPI spec | `[GEN]` src/generated/apiEndpoints.ts, src/generated/models.ts |
| 10 | **Tests** | `generate:feature` | all of the above | `[GEN]` src/__tests__/<e>.integration.test.ts; add cases by hand only for behaviour it cannot know |
| 11 | **Run compliance** | `./master.sh compliance` | — | Pass, or loop on the failure |

## Entity checklist (step 1)

Before declaring, decide:

- **Primary key shape** — `uuid` (default, good for public refs), `int` (smaller index, internal only)
- **Ownership FK** — does this entity belong to a `user`? (nearly always yes for user-generated content)
- **Soft-delete needed?** — add `deleted_at: timestamp, nullable: true`; note your queries must filter it
- **Audit fields** — `created_at` + `updated_at` with `default: "now()"`
- **Unique constraints** — email, slug, external ID — use `unique: true` plus an explicit index for sort performance
- **Indexes** — every FK gets one; every filter column gets one; composite if multi-column queries dominate

## UI scaffold (step 8) — the only hand-written layer

Compose primitives: no raw hex, no `<div style={{padding: 16}}>`. Layer 3
compliance fails otherwise.

Do not write the screen from scratch and do not read the template to retype
it — copy it (see the chain section below), then edit the copy:

```bash
skills/add-feature/scripts/paste-entity.sh <singular> <plural> .
```

## Common tasks

- **User-owned list:** declare the FK to `users` with `onDelete: "cascade"` so account deletion cleans up.
- **Admin-only route:** check `req.user.roles` against `auth.roles[].permits` — the router guard belongs in middleware, not the handler.
- **Search:** add a `pg_trgm` extension (`configure-database`) + a GIN index. For heavy search, use a dedicated search service, not `LIKE`.
- **Upload:** don't push file bytes through the route. Have the client PUT to signed URLs (S3/R2) and POST only the metadata row.
- **Pagination:** cursor (`WHERE id > last_id ORDER BY id LIMIT 20`) scales better than offset — default to cursor.

## Guidelines

- **Every FK gets an index.** Missing indexes become N+1 scans at scale — cheap to declare now, expensive to add later.
- **Never mix layers.** UI code doesn't import DB types directly; go through the service. That lets you swap the persistence layer without touching screens.
- **Write the test before wiring the UI.** A failing test pins behavior; a UI pinned by vibes rots fast.
- **Keep `docs/openapi.yaml` in sync** — compliance checks route prefixes exist in OpenAPI. Use `model-api-contract` after step 6.
- **If the feature spans platforms** (iOS + Android too), follow the cascade rule from `mirror-web-to-native` — ship web, then port.

## Hand-off

- Declare entities → `configure-database`
- Write OpenAPI spec → `model-api-contract`
- Unit/integration tests → `test-driven-development`
- Performance of the new endpoint → `performance-budget`
- Deploy the feature → `deploy-prod`

## Output format

1. **Entity declaration** — the `database.entities[]` diff
2. **Generator run** — `generate:database`, `generate:templates`, `compliance` in order
3. **Route contract** — method + path + request/response shape
4. **Files touched** — bullet list separating `[GEN]` (auto) from `[HAND]` (wrote by us)
5. **Tests added** — one line per test
6. **Rule stack** — `.cursorrules → orchestration_policy.mdc → add-feature/SKILL.md → (downstream skills used) → AGENT_GUIDE.md`

---

## Declare the entity, then run the chain — do not author these files

Almost everything a feature needs is GENERATED from
`database.entities`. Authoring it by hand costs tokens twice (reading an
example, then retyping it) and drifts from what the engine emits.

### 1. Declare the entity

Merge `templates/snippets/system.yaml.entity` into
`.auto_system/system.yaml`. This is the generator's INPUT — the only part
you write.

### 2. Run the chain, in order

```bash
./master.sh generate:feature               # schema, repo, service, route, test
./master.sh generate:openapi-from-routes   # OpenAPI paths from the route graph
./master.sh generate:api-client            # ApiEndpoints registry per platform
./master.sh generate:api-models            # typed client models from the spec
```

What that covers, measured on a two-platform project:

| Layer | Emitted by |
|---|---|
| `src/schemas/<e>.schema.ts` | `generate:feature` |
| `src/repositories/<e>Repo.ts` | `generate:feature` |
| `src/services/<e>.service.ts` | `generate:feature` |
| `src/routes/<e>.ts` | `generate:feature` |
| `src/__tests__/<e>.integration.test.ts` | `generate:feature` |
| **route registration in `routes/index.ts`** | `generate:feature` (automatic — do not hand-wire) |
| `docs/openapi.yaml` paths | `generate:openapi-from-routes` |
| `src/generated/apiEndpoints.ts` | `generate:api-client` |
| `src/generated/models.ts` | `generate:api-models` |

### 3. The one thing the chain does NOT emit: the web screen

There is no generator for the UI page, so it is the only template here:

```bash
skills/add-feature/scripts/paste-entity.sh <singular> <plural> [project-root]
# e.g. paste-entity.sh comment comments .
```

Copies `templates/apps/web/app/posts/page.tsx` to
`apps/web/app/<plural>/page.tsx`, renaming the entity in the path and in
identifiers (`postsApi` → `<plural>Api`, `PostsPage` → `<Plural>Page`), and
skips the file if it already exists.

**Do not `Read` the template.** Copying costs nothing; reading it to retype
it costs tokens twice and yields different output each run. Read it only if
you must edit it after copying.

### 4. Verify

```bash
./master.sh compliance
```

## If a layer genuinely cannot be generated

Custom route shapes, a non-CRUD service, a screen that is not a list/detail —
write those by hand, and say in your hand-off which layer you authored and
why the generator could not express it. Do not hand-write a layer the chain
already covers: it will be overwritten or drift.
