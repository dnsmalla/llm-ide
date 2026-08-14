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

## Ready-to-paste: complete "posts" feature slice

This is the full vertical slice — every file an agent needs to paste to ship a production-shape CRUD feature. Replace `posts` / `Post` / `/v1/posts` with your feature's noun.

### 1. Declare the entity (`system.yaml`)

```yaml
database:
  entities:
    - name: "posts"
      description: "User-authored posts in the feed"
      columns:
        - { name: "id",         type: "uuid",      primaryKey: true }
        - { name: "user_id",    type: "uuid",      references: { entity: "users", column: "id", onDelete: "cascade" } }
        - { name: "title",      type: "text" }
        - { name: "body",       type: "text",      nullable: true }
        - { name: "is_private", type: "boolean",   default: false }
        - { name: "created_at", type: "timestamp", default: "now()" }
        - { name: "updated_at", type: "timestamp", default: "now()" }
      indexes:
        - { name: "posts_user_id_idx",    columns: ["user_id"] }
        - { name: "posts_created_at_idx", columns: ["created_at"] }
```

Then: `./master.sh generate:database` → schema.ts contains `export const posts = pgTable(...)` → `npx drizzle-kit generate:pg && npx drizzle-kit migrate`.

### 2. Repository (`services/core-api/src/repositories/postsRepo.ts`)

```ts
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../db/client";
import { posts } from "../db/schema";

export const postsRepo = {
  async listForUser({ userId, limit = 20, cursor }: { userId: string; limit?: number; cursor?: string }) {
    const where = cursor
      ? and(eq(posts.userId, userId), lt(posts.id, cursor))
      : eq(posts.userId, userId);
    return db.select().from(posts).where(where).orderBy(desc(posts.createdAt)).limit(limit);
  },
  async get(id: string) {
    const [row] = await db.select().from(posts).where(eq(posts.id, id));
    return row ?? null;
  },
  async create(input: { userId: string; title: string; body?: string; isPrivate?: boolean }) {
    const [row] = await db.insert(posts).values({
      userId: input.userId,
      title: input.title,
      body: input.body ?? null,
      isPrivate: input.isPrivate ?? false,
    }).returning();
    return row;
  },
  async update(id: string, patch: Partial<{ title: string; body: string; isPrivate: boolean }>) {
    const [row] = await db.update(posts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(posts.id, id))
      .returning();
    return row ?? null;
  },
  async remove(id: string) {
    await db.delete(posts).where(eq(posts.id, id));
  },
};
```

### 3. Service (`services/core-api/src/services/postsService.ts`)

```ts
import { postsRepo } from "../repositories/postsRepo";

export const postsService = {
  async list(userId: string, cursor?: string) {
    return postsRepo.listForUser({ userId, cursor, limit: 20 });
  },
  async create(userId: string, input: { title: string; body?: string; isPrivate?: boolean }) {
    if (!input.title || input.title.length > 200) throw new HttpError(400, "title required (≤200 chars)");
    return postsRepo.create({ userId, ...input });
  },
  async update(userId: string, id: string, patch: { title?: string; body?: string; isPrivate?: boolean }) {
    const existing = await postsRepo.get(id);
    if (!existing) throw new HttpError(404, "not found");
    if (existing.userId !== userId) throw new HttpError(403, "forbidden");
    return postsRepo.update(id, patch);
  },
  async remove(userId: string, id: string) {
    const existing = await postsRepo.get(id);
    if (!existing) throw new HttpError(404, "not found");
    if (existing.userId !== userId) throw new HttpError(403, "forbidden");
    await postsRepo.remove(id);
  },
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
```

### 4. Route (`services/core-api/src/routes/posts.ts`)

```ts
import type { IncomingMessage, ServerResponse } from "http";
import { postsService, HttpError } from "../services/postsService";

type AuthedReq = IncomingMessage & { body?: any; user?: { id: string } };

function sendJson(res: ServerResponse, status: number, payload: object) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function handleErr(res: ServerResponse, err: unknown) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.message, code: err.status === 404 ? "not_found" : err.status === 403 ? "forbidden" : "bad_request" });
  }
  console.error("posts route error", err);
  return sendJson(res, 500, { error: "Internal error", code: "internal" });
}

export const listPosts = async (req: AuthedReq, res: ServerResponse) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const data = await postsService.list(req.user.id, cursor);
    sendJson(res, 200, { success: true, data, nextCursor: data.length === 20 ? data[data.length - 1].id : null });
  } catch (err) { handleErr(res, err); }
};

export const createPost = async (req: AuthedReq, res: ServerResponse) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    const { title, body, isPrivate } = req.body ?? {};
    const row = await postsService.create(req.user.id, { title, body, isPrivate });
    sendJson(res, 201, { success: true, data: row });
  } catch (err) { handleErr(res, err); }
};

export const updatePost = async (req: AuthedReq, res: ServerResponse, id: string) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    const row = await postsService.update(req.user.id, id, req.body ?? {});
    sendJson(res, 200, { success: true, data: row });
  } catch (err) { handleErr(res, err); }
};

export const deletePost = async (req: AuthedReq, res: ServerResponse, id: string) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    await postsService.remove(req.user.id, id);
    res.statusCode = 204; res.end();
  } catch (err) { handleErr(res, err); }
};
```

### 5. Register in `routes/index.ts`

```ts
import { listPosts, createPost, updatePost, deletePost } from "./posts";
// … inside handleRequest:
const postMatch = path.match(/^\/v1\/posts(?:\/([0-9a-f-]{36}))?$/);
if (postMatch) {
  const id = postMatch[1];
  if (!id && req.method === "GET")  return listPosts(req, res);
  if (!id && req.method === "POST") return createPost(req, res);
  if (id  && req.method === "PATCH")  return updatePost(req, res, id);
  if (id  && req.method === "DELETE") return deletePost(req, res, id);
}
```

### 6. OpenAPI addition (`services/core-api/docs/openapi.yaml`)

```yaml
paths:
  /v1/posts:
    get:
      summary: "List posts for the current user"
      operationId: "listPosts"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: query, name: cursor, required: false, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: "OK"
          content: { application/json: { schema: { $ref: "#/components/schemas/PostListResponse" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
    post:
      summary: "Create a post"
      operationId: "createPost"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/CreatePostRequest" } } }
      responses:
        "201": { description: "Created", content: { application/json: { schema: { $ref: "#/components/schemas/PostResponse" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /v1/posts/{id}:
    patch:
      summary: "Update a post"
      operationId: "updatePost"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/UpdatePostRequest" } } }
      responses:
        "200": { description: "OK", content: { application/json: { schema: { $ref: "#/components/schemas/PostResponse" } } } }
        "403": { $ref: "#/components/responses/Unauthorized" }
        "404": { description: "Not found", content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }
    delete:
      summary: "Delete a post"
      operationId: "deletePost"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
      responses:
        "204": { description: "Deleted" }
        "403": { $ref: "#/components/responses/Unauthorized" }
        "404": { description: "Not found" }

components:
  schemas:
    Post:
      type: object
      required: [id, userId, title, isPrivate, createdAt]
      properties:
        id:        { type: string, format: uuid }
        userId:    { type: string, format: uuid }
        title:     { type: string, maxLength: 200 }
        body:      { type: string, nullable: true }
        isPrivate: { type: boolean }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
    PostResponse:
      type: object
      properties:
        success: { type: boolean }
        data:    { $ref: "#/components/schemas/Post" }
    PostListResponse:
      type: object
      properties:
        success:    { type: boolean }
        data:       { type: array, items: { $ref: "#/components/schemas/Post" } }
        nextCursor: { type: string, nullable: true }
    CreatePostRequest:
      type: object
      required: [title]
      properties:
        title:     { type: string, minLength: 1, maxLength: 200 }
        body:      { type: string, nullable: true }
        isPrivate: { type: boolean, default: false }
    UpdatePostRequest:
      type: object
      properties:
        title:     { type: string, minLength: 1, maxLength: 200 }
        body:      { type: string, nullable: true }
        isPrivate: { type: boolean }
```

### 7. Client helper (`apps/web/services/posts-api.ts`)

```ts
const base = () => (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export const postsApi = {
  async list(cursor?: string) {
    const url = `${base()}/v1/posts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`list failed: ${r.status}`);
    return r.json();
  },
  async create(input: { title: string; body?: string; isPrivate?: boolean }) {
    const r = await fetch(`${base()}/v1/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(`create failed: ${r.status}`);
    return r.json();
  },
  async update(id: string, patch: { title?: string; body?: string; isPrivate?: boolean }) {
    const r = await fetch(`${base()}/v1/posts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`update failed: ${r.status}`);
    return r.json();
  },
  async remove(id: string) {
    const r = await fetch(`${base()}/v1/posts/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok && r.status !== 204) throw new Error(`delete failed: ${r.status}`);
  },
};
```

### 8. Screen (`apps/web/app/posts/page.tsx`) — primitives only

```tsx
"use client";

import { useEffect, useState } from "react";
import { Screen, Stack, Surface, Text, Button, Input } from "../../components/shared";
import { postsApi } from "../../services/posts-api";

export default function PostsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    postsApi.list().then(r => setItems(r.data)).catch(e => setErr(String(e.message)));
  }, []);

  const submit = async () => {
    setErr("");
    try {
      const res = await postsApi.create({ title, body });
      setItems([res.data, ...items]);
      setTitle(""); setBody("");
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <Screen>
      <Stack gap="l">
        <Text variant="h1">Posts</Text>
        <Surface elevation={1} radius="m">
          <Stack gap="s">
            <Text variant="h3">New post</Text>
            <Input label="Title" value={title} onChange={e => setTitle(e.target.value)} placeholder="What's on your mind?" />
            <Input label="Body"  value={body}  onChange={e => setBody(e.target.value)}  placeholder="(optional)" />
            {err && <Text role="danger" variant="bodySm">{err}</Text>}
            <Button variant="primary" onClick={submit} disabled={!title}>Post</Button>
          </Stack>
        </Surface>
        <Stack gap="m">
          {items.map(p => (
            <Surface key={p.id} elevation={1} radius="m">
              <Stack gap="xs">
                <Text variant="h3">{p.title}</Text>
                {p.body && <Text role="secondary">{p.body}</Text>}
                <Text role="tertiary" variant="caption">{new Date(p.createdAt).toLocaleString()}</Text>
              </Stack>
            </Surface>
          ))}
        </Stack>
      </Stack>
    </Screen>
  );
}
```

### 9. Test (`services/core-api/tests/posts.test.ts`)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { postsService, HttpError } from "../src/services/postsService";
import { postsRepo } from "../src/repositories/postsRepo";

describe("postsService", () => {
  beforeEach(async () => {
    // test db is seeded with fixture users by the setup script
  });

  it("rejects empty titles", async () => {
    await expect(postsService.create("u_1", { title: "" })).rejects.toBeInstanceOf(HttpError);
  });

  it("creates and lists user posts", async () => {
    const row = await postsService.create("u_1", { title: "hi" });
    const list = await postsService.list("u_1");
    expect(list.map(r => r.id)).toContain(row.id);
  });

  it("prevents cross-user updates", async () => {
    const row = await postsService.create("u_1", { title: "mine" });
    await expect(postsService.update("u_2", row.id, { title: "hacked" })).rejects.toMatchObject({ status: 403 });
  });
});
```

### 10. Run compliance

```bash
bash .system-controller/submodules/.auto_system_engine/master.sh compliance
```

Expected passes: `DB: schema covers declared entities` (posts appears), `Backend: OpenAPI route coverage` (/v1/posts in both routes/index.ts and openapi.yaml), `Web: No hardcoded hex in screens`, `Web: No hardcoded px in screens`.
