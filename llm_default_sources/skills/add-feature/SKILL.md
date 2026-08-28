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

Each step either (a) edits `system.yaml` and re-runs a generator, or (b) writes hand-code in a predictable location. Generator-emitted files are marked `[GEN]`; code you write is `[HAND]`.

| # | Step | Owner | Input | Output |
|---|------|-------|-------|--------|
| 1 | **Model the entity** | `configure-database` | Feature's core noun(s) | `database.entities[]` in system.yaml |
| 2 | **Emit schema + migration** | `generate:database` | `database.entities[]` | `[GEN]` services/core-api/src/db/schema.ts, `[GEN]` migrations/000_extensions.sql |
| 3 | **Apply migration** | drizzle-kit + psql | schema.ts | Live DB has the new table |
| 4 | **Write repository** | hand | schema.ts | `[HAND]` services/core-api/src/repositories/<entity>Repo.ts |
| 5 | **Write service** | hand | repository | `[HAND]` services/core-api/src/services/<feature>Service.ts |
| 6 | **Add route** | hand | service | `[HAND]` services/core-api/src/routes/<feature>.ts; register in routes/index.ts |
| 7 | **Update OpenAPI contract** | `model-api-contract` | new route | `[HAND]` services/core-api/docs/openapi.yaml |
| 8 | **Build screen** | hand | primitives | `[HAND]` apps/web/app/<feature>/page.tsx (+ iOS / Android mirrors if in scope) |
| 9 | **Wire client** | hand | route contract | `[HAND]` apps/web/services/<feature>-api.ts (or extend auth-api pattern) |
| 10 | **Tests** | `test-driven-development` | all of the above | `[HAND]` services/core-api/tests/<feature>.test.ts + apps/web/app/<feature>/__tests__/ |
| 11 | **Run compliance** | `./master.sh compliance` | — | Pass, or loop on the failure |

## Entity checklist (step 1)

Before declaring, decide:

- **Primary key shape** — `uuid` (default, good for public refs), `int` (smaller index, internal only)
- **Ownership FK** — does this entity belong to a `user`? (nearly always yes for user-generated content)
- **Soft-delete needed?** — add `deleted_at: timestamp, nullable: true`; note your queries must filter it
- **Audit fields** — `created_at` + `updated_at` with `default: "now()"`
- **Unique constraints** — email, slug, external ID — use `unique: true` plus an explicit index for sort performance
- **Indexes** — every FK gets one; every filter column gets one; composite if multi-column queries dominate

## Route scaffold (step 6)

Drop into `services/core-api/src/routes/<feature>.ts` following the shape of the generated `auth.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "http";
import { postsService } from "../services/postsService";
// stub — reach for real auth middleware/guards here

export const handleListPosts = async (req: any, res: ServerResponse) => {
  const rows = await postsService.list({ userId: req.user?.id });
  sendJson(res, 200, { success: true, data: rows });
};

export const handleCreatePost = async (req: any, res: ServerResponse) => {
  const { title, body } = req.body ?? {};
  if (!title) return badRequest(res, "title is required");
  const row = await postsService.create({ userId: req.user.id, title, body });
  sendJson(res, 201, { success: true, data: row });
};
```

Register in `routes/index.ts`:

```ts
if (path === "/v1/posts" && req.method === "GET")  return handleListPosts(req, res);
if (path === "/v1/posts" && req.method === "POST") return handleCreatePost(req, res);
```

## UI scaffold (step 8)

Compose primitives — no raw hex, no `<div style={{padding: 16}}>`. Layer 3 compliance will fail otherwise.

```tsx
import { Screen, Stack, Surface, Text, Button } from "@/components/shared";
import { postsApi } from "@/services/posts-api";
import { useEffect, useState } from "react";

export default function PostsPage() {
  const [items, setItems] = useState([]);
  useEffect(() => { postsApi.list().then(r => setItems(r.data)); }, []);
  return (
    <Screen>
      <Stack gap="m">
        <Text variant="h1">Posts</Text>
        {items.map((p: any) => (
          <Surface key={p.id} elevation={1} radius="m">
            <Text variant="h3">{p.title}</Text>
            <Text role="secondary">{p.body}</Text>
          </Surface>
        ))}
        <Button variant="primary" onClick={() => {/* open compose modal */}}>New post</Button>
      </Stack>
    </Screen>
  );
}
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

## Two ways to get the code — try the generator FIRST

### 1. `generate:feature` (preferred — zero authoring)

The engine already emits the whole layered backend from a declared entity:

```bash
# 1. add the entity to .auto_system/system.yaml (see the snippet below)
# 2. then:
./master.sh generate:feature
```

That writes `src/schemas/<e>.schema.ts`, `repositories/<e>Repo.ts`,
`services/<e>.service.ts`, `routes/<e>.ts` and
`__tests__/<e>.integration.test.ts` — from config, identically every run,
at zero model cost. Use it whenever the entity is expressible as columns.

### 2. Templates (fallback — when the generator cannot express it)

For anything the generator does not cover (custom route shapes, a web screen,
an OpenAPI block), copy the templates instead of retyping them:

```bash
skills/add-feature/scripts/paste-entity.sh <singular> <plural> [project-root]
# e.g. paste-entity.sh comment comments .
```

It copies these and renames `posts`/`Posts`/`post`/`Post` in **paths and
contents**, skipping anything that already exists:

| template | lands at |
|---|---|
| `templates/services/core-api/src/repositories/postsRepo.ts` | `…/repositories/<plural>Repo.ts` |
| `templates/services/core-api/src/services/postsService.ts` | `…/services/<plural>Service.ts` |
| `templates/services/core-api/src/routes/posts.ts` | `…/routes/<plural>.ts` |
| `templates/services/core-api/docs/openapi.yaml` | merge into the existing spec |
| `templates/services/core-api/tests/posts.test.ts` | `…/tests/<plural>.test.ts` |
| `templates/apps/web/services/posts-api.ts` | `apps/web/services/<plural>-api.ts` |
| `templates/apps/web/app/posts/page.tsx` | `apps/web/app/<plural>/page.tsx` |

Two merge into files that already exist, so the script leaves them alone:

- `templates/snippets/system.yaml.entity` → `.auto_system/system.yaml`
- `templates/snippets/routes-index.registration.ts` → `src/routes/index.ts`

**Do not `Read` the template files.** Copying them costs nothing; reading 341
lines of example code into context to retype it as 341 similar lines costs
tokens twice and produces different output every run. Read one only when you
must edit it after copying.

### 3. Verify

```bash
./master.sh compliance
```
