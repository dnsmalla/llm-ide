---
title: How to add a new server endpoint
applies_to: server, extension
---

# How to add a new server endpoint

## Goal

Add an authenticated HTTP endpoint that the side panel can call.

## Steps

1. **Pick the route family.** AI endpoint? → `extension/server/ai-routes.mjs`. KB endpoint? → `extension/kb/router.mjs`. Auth-related? → `extension/server/auth-routes.mjs`.
2. **Write the handler.** Use `req.user.id` for tenancy. Wrap user content in `<<<BEGIN>>>…<<<END>>>` fences before any LLM call. Apply rate-limit profile.
3. **Register the route in `ENDPOINTS`** (`server.mjs`).
4. **Bump `SERVER_API_VERSION`** in `server.mjs`.
5. **Add it to `REQUIRED_ENDPOINTS`** in `extension/src/sidepanel/App.tsx` so stale clients show the restart banner.
6. **Add a hook** under `extension/src/sidepanel/hooks/` with `AbortController` + `language` param.
7. **Document.** Add an entry to [`docs/reference/api/overview.md`](../reference/api/overview.md) and to `docs/reference/api/openapi.yaml`.
8. **Test.** Add a `node:test` file under `extension/tests/`.

## Verification

```bash
cd extension
npm test
curl -sf http://127.0.0.1:3456/health | jq '.endpoints | contains(["<new-route>"])'
```

## See also

- [API overview](../reference/api/overview.md)
- [Engineering invariants — local server](../explanation/invariants.md#local-server-extensionservermjs)
