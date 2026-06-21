---
title: Cross-cutting concerns
status: draft
---

# Cross-cutting concerns

> System-wide properties that no single subsystem owns — the local-first security posture, the shared configuration and data model, how the system is built and run, and where the operational invariants live.

!!! info "Rebuild-grade detail"
    Exact security controls, the config matrix, build/deploy, and invariants are in [`../spec/cross-cutting.md`](../spec/cross-cutting.md).

---

## Local-first security posture

LLM IDE is designed around a strict local-first principle: **nothing leaves the user's machine unless the user explicitly triggers a delivery action** (opening a pull request, sending an export, or firing an agent skill that reaches an external service). All other data — transcripts, AI outputs, credentials — stays on disk or in memory on the local host.

This posture rests on three interlocking controls:

**Loopback binding.** The server binds exclusively to `127.0.0.1`. A CORS allowlist permits only loopback origins and the installed Chrome extension — never a wildcard. Any request arriving from a non-loopback host is rejected before authentication runs. Operators can override this for a TLS-terminating reverse-proxy deployment, but the override requires an explicit environment variable and the server rejects a non-loopback host at startup without it.

**Per-user encrypted vault.** API credentials (Claude key, GitHub token, third-party service keys) are never stored in plaintext. Each user's secrets are encrypted with a key derived from a master vault key that never touches the database. A compromise of the database alone yields only ciphertext. Secret keys are allow-listed — the vault rejects anything outside the set of recognised key names.

**Guardrails before any outbound action.** Every code-change dispatch passes through a rule engine that scans for secrets, PII patterns, and destructive operations. The scan runs twice — when generated code enters the review queue, and again at approval — so manually edited items cannot bypass it. Prompt injection is defused by wrapping all user-supplied content in fence delimiters and stripping those delimiters from the content before injection.

For the threat model, audit log schema, and known limitations (including the plugin trust boundary): [`security-model.md`](security-model.md).

---

## One config / one DB / one backend

Both clients — the Chrome extension side panel and the macOS desktop app — talk to the same local Node.js server. There is no separate backend for the Mac app and no separate database. This means:

- **One SQLite database** (`LLMIDE_DB_PATH`) holds all knowledge-base data, user accounts, vault ciphertext, and audit log rows. Both clients read and write through the same server API.
- **One configuration surface** — environment variables and the runtime config object — controls both client paths. There is no per-client config file.
- **One JWT / auth lifecycle** — access tokens, refresh tokens, and rate-limiting profiles are shared. A token issued while the Chrome extension is the active client is equally valid for macOS app requests.

The practical consequence for changes: a schema migration, a rate-limit change, or a new endpoint is a single change in the server and immediately visible to both clients.

---

## Build, run, and deploy at a high level

Development setup follows a straightforward path:

1. `npm install && npm run build` inside `extension/` builds the Chrome extension and the Node.js server bundle.
2. `node server.mjs` (or `npm start`) starts the local server, which auto-generates development secrets on first run if none are present.
3. Load the unpacked extension from `extension/dist/` in Chrome.
4. The macOS app is a separate Swift target built with `swift build` inside `mac/`.

The server requires Node.js 20 or later. `better-sqlite3` is a native module compiled against the running Node ABI — do not swap Node versions between install and run, and route dependency bumps for that package through CI where the native build is verified.

For production (systemd, environment variable wiring, native-module considerations): [`../spec/cross-cutting.md`](../spec/cross-cutting.md).

For running the server locally step by step: [`../how-to/run-the-server-locally.md`](../how-to/run-the-server-locally.md).

---

## Where the operational invariants live

The system-wide invariants are catalogued in [`invariants.md`](invariants.md). The ones that cross subsystem boundaries and matter most for safe changes:

- **Per-row tenancy.** Every owned row carries a `user_id`. No query reaches data without threading a validated user identity through from the route layer.
- **Single-writer SQLite.** One server process, one connection, no pool. A second process opening the same database file will corrupt the WAL.
- **Append-only migrations.** Migrations are numbered, applied once, and never edited. Schema changes always add a new file.
- **Stale-server detection.** The server exposes an API version on `GET /health`. Clients compare it against their expected version and surface a "restart the server" message rather than silently failing on shape mismatches.

---

## See also

- [`security-model.md`](security-model.md) — threat model, vault crypto, guardrails, audit log, plugin trust boundary
- [`invariants.md`](invariants.md) — full engineering invariants catalogue, per-component MUSTs and DO NOTs
- [`../how-to/run-the-server-locally.md`](../how-to/run-the-server-locally.md) — step-by-step local setup
- [`../spec/cross-cutting.md`](../spec/cross-cutting.md) — rebuild-grade detail: exact security controls, config matrix, build targets, and invariants
