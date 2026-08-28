---
name: model-api-contract
description: >-
  Maintain `services/core-api/docs/openapi.yaml` — the single HTTP contract
  read by the client, the compliance check, and (eventually) API-gateway
  tooling. Use when the user says "update API docs", "add a /v1/* endpoint
  to OpenAPI", "the openapi.yaml is failing compliance", "change
  request/response schema", or any time server routes change and the
  contract must follow. Keep contract-first: spec describes, code matches —
  not the other way around.
---

# Model the API contract

`services/core-api/docs/openapi.yaml` is the system's HTTP contract. The compliance checker already verifies:

- Every prefix in `routes/index.ts` appears in the contract
- The five required auth routes exist under `/v1/auth/*`
- `/health`, `/ready`, `/status`, `/metrics` are declared

Keeping the spec honest makes the TypeScript client (`apps/web/services/*-api.ts`) generatable, the compliance check meaningful, and future API-gateway wiring trivial.

## When to use

- Added or renamed a route → spec must follow
- Changed request or response body shape
- Added a new status code (e.g. 409, 422)
- Compliance fails with "OpenAPI route coverage" or "OpenAPI auth routes"
- `auth.apiPrefix` or `backend.apiPrefix` changed

## Baseline structure

```yaml
openapi: "3.1.0"
info:
  title: "{{project.name}} API"
  version: "1.0.0"
servers:
  - url: "http://localhost:3001"
    description: "Local dev"

paths:
  /v1/auth/login:      { $ref: "#/components/paths/AuthLogin" }
  /v1/auth/register:   { $ref: "#/components/paths/AuthRegister" }
  /v1/auth/forgot-password:
    post:
      summary: "Request a password reset email"
      operationId: "forgotPassword"
      tags: ["auth"]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ForgotPasswordReq" }
      responses:
        "202": { description: "Accepted (response is identical whether email exists or not)" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
  # … reset-password, mfa/verify, health/ready/status/metrics

components:
  schemas:
    Error:
      type: object
      required: [error, code]
      properties:
        error: { type: string }
        code:  { type: string }
    LoginReq:
      type: object
      required: [email, password]
      properties:
        email:    { type: string, format: email, maxLength: 255 }
        password: { type: string, minLength: 8 }
    LoginRes:
      type: object
      required: [success, data]
      properties:
        success: { type: boolean }
        data:
          type: object
          required: [accessToken, tokenType, expiresIn, user]
          properties:
            accessToken:      { type: string }
            refreshToken:     { type: string }
            expiresIn:        { type: integer }
            refreshExpiresIn: { type: integer }
            tokenType:        { type: string, enum: [Bearer] }
            user:             { $ref: "#/components/schemas/User" }
    User:
      type: object
      required: [id, email, name, roles]
      properties:
        id:    { type: string, format: uuid }
        email: { type: string, format: email }
        name:  { type: string }
        roles: { type: array, items: { type: string } }

  responses:
    BadRequest:
      description: "Validation failed"
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    Unauthorized:
      description: "Auth required or invalid"
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    RateLimited:
      description: "Too many requests"
      headers:
        X-RateLimit-Limit:     { schema: { type: integer } }
        X-RateLimit-Remaining: { schema: { type: integer } }
        X-RateLimit-Reset:     { schema: { type: integer } }
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
```

## Rules of the contract

1. **Every route in `routes/index.ts` MUST appear in `paths:`** (compliance enforces). Run `compliance` after any route change.
2. **Request/response schemas live under `components/schemas`**, referenced by operations. Inline schemas rot faster.
3. **Error shape is one type**, used by every non-2xx. The generated server's `sendJson(res, 4xx, {error, code})` matches this shape.
4. **Pagination is cursor-based**: request `cursor` (optional) + `limit` (bounded 1–100); response wraps `{ items, nextCursor }`.
5. **Security**: `bearerAuth` scheme + per-operation `security: [{ bearerAuth: [] }]` for protected routes. Declare once under `components.securitySchemes`; reference everywhere.
6. **Status codes**: use the narrow set. 200 (ok), 201 (created), 202 (accepted for async/idempotent), 204 (no content), 400 (validation), 401 (auth missing/invalid), 403 (auth OK but not allowed), 404 (not found), 409 (conflict), 422 (semantic error), 429 (rate), 500 (internal).

## Steps

1. **Read the route you just added** — method, path, request/response shapes, error modes.
2. **Add `paths:` entry** under the correct prefix (e.g. `/v1/posts/{id}`). Parameterize path params (`{ in: path, required: true, schema: { type: string, format: uuid } }`).
3. **Define request/response schemas** in `components/schemas/` — lift any shared shape (User, Post) to a named ref.
4. **Add to `tags:`** at root level if the route's tag is new (helps generated docs group logically).
5. **Run compliance:** `./master.sh compliance` — fails reveal missing prefixes or absent auth routes.
6. **Generate a client (optional):** `openapi-typescript docs/openapi.yaml -o src/generated/api.ts` → typed client stubs that match the server.

## Common tasks

- **New endpoint for an existing feature:** add to `paths:`, reuse schemas where possible.
- **Breaking change** (rename field, change type): bump `info.version`, add a note in CHANGELOG, deploy server first so old clients get an error instead of malformed data.
- **Add rate-limit docs to a route:** reference `RateLimited` response; document the bucket in `description:`.
- **Webhooks:** declare under `webhooks:` (OpenAPI 3.1) rather than `paths:`; they're inbound to *us* from a third party.

## Guidelines

- **Contract first.** When the user asks "add an endpoint for …", write the OpenAPI entry before the route handler. The shape constrains the implementation, not the other way around.
- **Don't leak internals.** Internal IDs, debug flags, timestamps used only for caching — keep them out of the response unless the client needs them.
- **Error codes are stable.** `bad_request`, `unauthorized`, `rate_limit`, `conflict`, `not_found` — treat them like feature flags. Renaming breaks clients.
- **Version the API, not individual fields.** If you need "both the old and new shape", that's a new route (`/v2/…`), not a polymorphic response.

## Hand-off

- Implementing the route itself → `add-feature` or direct hand-edit
- Rate-limit policy → `configure-backend`
- Auth requirements change → `configure-auth`
- Response-time budgets → `performance-budget`

## Output format

1. **Diff of `docs/openapi.yaml`** — paths + schemas added/changed
2. **Compliance result** — pass/fail on OpenAPI coverage
3. **Generated client?** — note whether you ran the generator and what file changed
4. **Version bump?** — was this a breaking or additive change; is `info.version` correct
5. **Rule stack** — `.cursorrules → orchestration_policy.mdc → model-api-contract/SKILL.md → AGENT_GUIDE.md → AUTH_SYSTEM.md`

---

## Ready-to-paste: full CRUD OpenAPI block for a new resource

Replace `posts` / `Post` with your resource. Drop under `paths:` and `components/schemas:` of `docs/openapi.yaml`.

```yaml
paths:
  /v1/posts:
    get:
      summary: "List posts for the authenticated user"
      operationId: "listPosts"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: query, name: cursor, required: false, schema: { type: string, format: uuid } }
        - { in: query, name: limit,  required: false, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
      responses:
        "200":
          description: "OK"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PostListResponse" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "429": { $ref: "#/components/responses/RateLimited" }
    post:
      summary: "Create a post"
      operationId: "createPost"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreatePostRequest" }
      responses:
        "201":
          description: "Created"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PostResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "429": { $ref: "#/components/responses/RateLimited" }

  /v1/posts/{id}:
    get:
      summary: "Get a single post"
      operationId: "getPost"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: "OK"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PostResponse" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: "Not found"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
    patch:
      summary: "Update a post"
      operationId: "updatePost"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/UpdatePostRequest" }
      responses:
        "200":
          description: "OK"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PostResponse" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403":
          description: "Forbidden (not the owner)"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "404":
          description: "Not found"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
    delete:
      summary: "Delete a post"
      operationId: "deletePost"
      tags: [posts]
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
      responses:
        "204": { description: "Deleted" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403":
          description: "Forbidden"
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "404": { description: "Not found" }

components:
  schemas:
    Post:
      type: object
      required: [id, userId, title, isPrivate, createdAt]
      properties:
        id:        { type: string, format: uuid }
        userId:    { type: string, format: uuid }
        title:     { type: string, minLength: 1, maxLength: 200 }
        body:      { type: string, nullable: true, maxLength: 10000 }
        isPrivate: { type: boolean }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
    PostResponse:
      type: object
      required: [success, data]
      properties:
        success: { type: boolean }
        data:    { $ref: "#/components/schemas/Post" }
    PostListResponse:
      type: object
      required: [success, data, nextCursor]
      properties:
        success:    { type: boolean }
        data:       { type: array, items: { $ref: "#/components/schemas/Post" } }
        nextCursor: { type: string, nullable: true, description: "Pass back as ?cursor= to fetch the next page" }
    CreatePostRequest:
      type: object
      required: [title]
      properties:
        title:     { type: string, minLength: 1, maxLength: 200 }
        body:      { type: string, nullable: true, maxLength: 10000 }
        isPrivate: { type: boolean, default: false }
    UpdatePostRequest:
      type: object
      description: "PATCH semantics — only the provided fields are updated"
      properties:
        title:     { type: string, minLength: 1, maxLength: 200 }
        body:      { type: string, nullable: true, maxLength: 10000 }
        isPrivate: { type: boolean }
```

## Ready-to-paste: generate a typed client from this contract

```bash
# One-time:
npm i -D openapi-typescript

# Every time the contract changes:
npx openapi-typescript services/core-api/docs/openapi.yaml -o apps/web/src/generated/api.d.ts
```

Use in the web client:

```ts
import type { paths } from "./generated/api";

type ListPostsResponse = paths["/v1/posts"]["get"]["responses"]["200"]["content"]["application/json"];
```

## Ready-to-paste: contract test (vitest + undici, `services/core-api/tests/contract.test.ts`)

Verifies the running server actually matches what the YAML says.

```ts
import { describe, it, expect } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import fetch from "node-fetch";

const BASE = process.env.API_BASE ?? "http://localhost:3001";

describe("contract", () => {
  it("spec is valid", async () => {
    await SwaggerParser.validate("services/core-api/docs/openapi.yaml");
  });

  it("health contract matches server", async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body).toHaveProperty("status", "ok");
  });

  it("auth/login returns spec-shaped error on bad input", async () => {
    const r = await fetch(`${BASE}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "", password: "" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("code");
  });
});
```
