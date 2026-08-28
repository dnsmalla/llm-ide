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

The spec's `paths:` are DERIVED from the backend route graph — do not hand-author
them, and do not hand-write the typed client either.

1. **Add or change the route** in `services/core-api/src/routes/` (or declare the
   entity and let `generate:feature` emit the route).
2. **Derive the contract:**
   ```bash
   ./master.sh generate:openapi-from-routes
   ```
   This keeps `docs/openapi.yaml` accurate against the code rather than a
   hand-maintained copy that drifts.
3. **Regenerate the clients** for every active platform:
   ```bash
   ./master.sh generate:api-client     # src/generated/apiEndpoints.ts
   ./master.sh generate:api-models     # src/generated/models.ts
   ```
   Do NOT reach for `openapi-typescript` or any other external generator — the
   engine already emits per-platform clients, and a second generated client
   diverges from the one the compliance check knows about.
4. **Hand-edit the spec only for what the route graph cannot express** —
   descriptions, examples, and `components/schemas/` shapes that are not
   inferable. Those survive regeneration; invented `paths:` do not.
5. **Verify:** `./master.sh compliance` — failures reveal missing prefixes,
   absent auth routes, or client/model drift.


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

## What you hand-edit, and what regeneration overwrites

`generate:openapi-from-routes` rewrites `paths:` from the route graph. Anything
you type there is lost on the next run. These parts persist, so they are where
hand-editing belongs:

```yaml
components:
  schemas:
    Post:                        # shapes the route graph cannot infer
      type: object
      required: [id, title, createdAt]
      properties:
        id:        { type: string, format: uuid }
        title:     { type: string, maxLength: 200 }
        createdAt: { type: string, format: date-time }

tags:
  - name: posts                  # grouping for generated docs
    description: Blog posts owned by the authenticated user
```

Per-operation prose also survives — add `summary`, `description` and `examples`
to an operation the generator created, rather than recreating the operation.

To see the current full shape of the contract, read the generated file:

```bash
./master.sh generate:openapi-from-routes
sed -n '1,80p' services/core-api/docs/openapi.yaml
```

Reading the generated spec is cheaper and always accurate; a pasted example in
this skill would be a snapshot that drifts.


## Typed clients: use the engine, not openapi-typescript

```bash
./master.sh generate:api-client     # ApiEndpoints registry, per active platform
./master.sh generate:api-models     # typed models from components/schemas
```

Emits `src/generated/apiEndpoints.ts` and `src/generated/models.ts` for each
active client platform, and the compliance check verifies the client uses them
(`Client: API path drift`, `Client: model drift`). An `openapi-typescript`
client would pass none of that and adds an npm dependency for work the engine
already does.


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
