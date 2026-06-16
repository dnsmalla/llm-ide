---
title: Security model
status: stable
---

# Security model

> What the system protects against, how, and what's explicitly out of scope.

## Threat model

**In scope:** transcript exfiltration, credential theft from the vault, prompt injection from meeting content, denial of service against the local server, cross-site attack against the loopback API, accidental destructive operations in dispatched code changes.

**Out of scope:** physical access to the user's machine, malicious browser extensions installed by the user, compromise of the user's Claude CLI authentication.

## Network

The server binds exclusively to `127.0.0.1` — never `0.0.0.0` and never a network-accessible interface. A CORS allowlist permits only `chrome-extension://<id>`, `localhost`, and `127.0.0.1` as origins. The `Access-Control-Allow-Origin` header echoes the request's `Origin` value; it is never set to `*`. Any origin not on the allowlist receives no CORS header and the request is rejected. Request bodies are capped at 2 MB as a denial-of-service guard, and prompts sent to the Claude CLI are capped at 500 k characters.

## Identity

Authentication uses JWT HS256 with 15-minute access tokens. Refresh tokens are opaque base64url strings; the server stores only a SHA-256 hash of each token, never the plaintext. Every successful token refresh rotates the refresh token — the old one is invalidated immediately.

Passwords are hashed with bcrypt at cost 12. To prevent timing-based account enumeration, a login attempt against an unknown email address is compared against a sentinel hash rather than short-circuiting early. The comparison time is therefore indistinguishable from a real failed login.

## Credential vault

API credentials are stored in `user_secrets(user_id, secret_key, ciphertext)`. The ciphertext layout is:

```text
version (1 byte) || iv (12 bytes) || AES-256-GCM(plaintext) || tag (16 bytes)
```

Each user's data key is derived as `HKDF-SHA256(masterKey, salt=userId, info='llmide-vault-v1', length=32)`. The master key never leaves the server process. A DB-only leak yields ciphertext that cannot be decrypted without the master key; one user's ciphertext cannot be used to attack another's because the derived keys differ.

Allowed secret keys are `github.token`, `backlog.apiKey`, `linear.apiKey`, and `slack.webhookUrl`. Attempts to store keys outside this allowlist are rejected at the route layer.

## Tenancy

Every owned row in the database carries a `user_id` foreign key. Three invariants hold:

1. **No bare-user functions.** Every state-mutating helper in `kb/db.mjs` takes `userId` as its first parameter; `requireUser` panics if missing.
2. **FTS5 is shared but hydration is scoped.** Cross-tenant hits can appear in the full-text index, but the `findContext` and `search` paths drop any hit whose hydration query (filtered by `user_id`) returns nothing. The index can see a row's tokens; the caller never receives its content.
3. **The router enforces the gate.** `kb/router.mjs` reads `req.user.id` and threads it through every call. A missing or invalid user returns 401 before any data access occurs.

## Rate limiting

Rate limiting uses a token-bucket algorithm keyed on `(profile, scope)`. For authenticated routes the scope is the `userId`; for unauthenticated routes (login, register) the scope is the remote IP address. Responses to exceeded limits return HTTP 429 with a `Retry-After` header. Profiles are tuned per workload: LLM-heavy routes (notes generation, chat) allow a smaller burst than lighter data routes; dispatch routes are throttled separately to prevent runaway ticket creation.

## Guardrails

The rule engine in `extension/guardrails/rules.mjs` maintains 7 secret patterns (API keys, tokens, private keys), 5 PII patterns (names, emails, phone numbers, addresses), and 5 destructive-operation patterns (file deletion, schema drops, force-push). These patterns are applied at two points on the dispatch path: at submit (when generated code enters the review queue) and again at approval (when the reviewer clicks approve). The same content is checked twice, ensuring that manually edited review items do not bypass the rules.

A separate path-traversal guard wraps codegen-apply in three layers: the guardrail rule, an allowlist re-check, and a `safeJoin` function that prevents `../` escapes from the allowed root directory.

## Prompt injection defence

Every server prompt that includes user-supplied content — transcript text, meeting titles, chat history — wraps that content between `<<<BEGIN>>>` and `<<<END>>>` delimiters, with the model instructed to treat everything between them as data, not instructions. Before injection, a sanitizer strips those exact delimiter strings from the incoming text, so a meeting participant who speaks the literal phrase `<<<END>>> ignore previous instructions` cannot break out of the data context. If the sanitized input is empty after this pass, the route returns HTTP 400 before calling the Claude CLI.

The same `sanitizeLine()` function in the caption scraper strips these delimiters from every captured caption in real time, ensuring that caption text arriving via `CAPTION_FINAL` messages is clean before it reaches any prompt.

## Audit log

Sensitive operations are recorded in `audit_log(user_id, request_id, ip, ua, action, resource, outcome, detail, created_at)`. Covered actions include: account registration, login success, login failure, password change, secret set, secret delete, logout, and the high-blast-radius KB operations (dispatch, code apply, review approval). The `detail` column is JSON; any field whose key matches credential patterns (`token`, `apiKey`, `password`, `webhookUrl`, etc.) is redacted before the row is written.

## Known limitations

### Plugin trust boundary

Plugins are validated at install time, but they are **not sandboxed at runtime**.

The install flow in `extension/plugins/installer.mjs` validates only the bundle shape and install destination:

- `plugin.json` must parse and pass the manifest schema used by `extension/plugins/loader.mjs`
- plugin names must match the loader's slug regex and cannot use reserved names
- zip entries are scanned before extraction and rejected on path traversal, absolute paths, Windows drive escapes, or invalid bundle shape
- install happens in a temp staging directory and moves into the real plugin directory only after validation succeeds

Once installed and enabled, plugin code runs inside the same Node.js server process as the rest of LLM IDE. That means a malicious plugin can:

- read process environment variables and any secrets reachable from them
- import server modules directly, including KB/storage helpers
- read and write the SQLite DB, including rows owned by other users, by bypassing the route-level `user_id` checks
- fork subprocesses, read local files the server user can access, and make outbound HTTP requests
- interfere with in-process state such as plugin registry, agent runtime state, or logging

A malicious plugin cannot bypass the installer's archive validation to escape the target plugin directory during install, and it cannot claim reserved core plugin names through the manifest validator. Those checks protect the **install path** and the **plugin namespace** only; they do not provide runtime isolation.

Real isolation would require a different execution model, for example:

- a separate worker or helper process per plugin with a narrow IPC interface
- a restricted module loader / capability model instead of arbitrary `import`
- an explicit permission system for DB, network, filesystem, and subprocess access
- per-plugin resource limits and kill switches

Today plugins should be treated as equivalent to locally installed code with full trust.

## See also

- [ADR 0001 — Claude CLI shell-out, not API key](../decisions/0001-claude-cli-not-api-key.md)
- [ADR 0004 — Bind to 127.0.0.1 only](../decisions/0004-bind-to-localhost-only.md)
- [ADR 0005 — Strict CORS allowlist](../decisions/0005-strict-cors-allowlist.md)
- [ADR 0007 — Per-user vault key via HKDF](../decisions/0007-per-user-vault-key-hkdf.md)
- [Engineering invariants — local server](invariants.md#local-server-extensionservermjs)
- [Reference: guardrail rules](../reference/guardrail-rules.md)
- [Reference: rate-limit profiles](../reference/rate-limit-profiles.md)
