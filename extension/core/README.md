# extension/core

Framework-free primitives shared by every higher layer. Anything in
`core/` is allowed to be imported from *anywhere else* in the
extension; nothing in `core/` is allowed to import from a higher
layer.

## What lives here

- `config.mjs` — env-driven configuration, loaded once at boot.
- `utils.mjs` — HTTP helpers (`sendJSON`, `readBody`, `parseJSON`)
  and input sanitizers (`sanitizeLine`, `sanitizeForPrompt`).
- `errors.mjs` — `AppError` + `sendError` and the typed error
  factories (`errAuth`, `errValidation`, `errRateLimit`, …).
- `logger.mjs` — request-scoped structured logger and request-id
  generator.

## Layering rule

```
core  ←  kb  ←  server  ←  agents / llm_agent / connectors / guardrails
```

Arrows are "imports". A module on the left **must not** import from
anything on the right. Concretely:

- `core/` imports only Node built-ins and 3rd-party libs.
- `kb/` may import from `core/`.
- `server/` may import from `core/` and `kb/`.
- `agents/`, `llm_agent/`, `connectors/`, `guardrails/` may import
  from `core/` and `kb/`. They generally should not reach into
  `server/` internals — request-pipeline concerns are server-only.

When a piece of `server/` looks like it wants to be shared, promote
it down into `core/` rather than letting a lower layer reach up.

## Adding a module

A new file belongs in `core/` if **all** of these hold:

1. It depends only on Node built-ins, npm packages, or other
   `core/` files.
2. It's reasonable for `kb/` (or anywhere else) to call into it.
3. It has no opinion about HTTP routing, auth, or DB schema.

If any of those fail, put it in the layer that owns its concern.
