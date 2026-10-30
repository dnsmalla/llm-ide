---
title: Provider catalog and multi-provider adapter — spec
status: draft
---

This is the contract for connecting non-Anthropic model providers (agent-kit K1 Phase 6, first half): the built-in catalog, per-user connections and keys, model listing with capability flags, tool-capable chat through a maintained library adapter, and opt-in cross-provider fallback. Server API version 90.

Not covered here: the Claude path (`llm_agent/sdk/`, see [claude-linker](../explanation/claude-linker.md)), and the classic loop, which keeps serving these providers until the second half of Phase 6 moves the Mac onto the adapter and deletes it.

---

## §1 Scope

| File | Role |
|---|---|
| `extension/server/provider-catalog.json` | The catalog: 11 entries (OpenAI, Google, Mistral, Groq, DeepSeek, OpenRouter, xAI, Cerebras, Together, Ollama local, generic OpenAI-compatible endpoint) |
| `extension/server/provider-catalog.mjs` | Loads the catalog; chat-model filter; `modelCapability()`; `TOOL_MODES` |
| `extension/server/ip-classifier.mjs` | The one classifier for every IP spelling |
| `extension/server/base-url-guard.mjs` | Literal base-URL guard, operator gate, `joinBaseUrl` |
| `extension/server/pinned-fetch.mjs` | Connect-time pin: classify every resolved address, dial the checked one |
| `extension/server/provider-connections.mjs` | Per-user connections, settings, vault key placement |
| `extension/server/custom-providers.mjs` | Falls back to a connection for `custom:cat-…` ids |
| `extension/providers/provider-models.mjs` | Live model list (cached), static fallback, connection test |
| `extension/providers/provider-fallback.mjs` | The start-of-turn provider pick |
| `extension/providers/adapter/index.mjs` | The only module that imports the Vercel AI SDK |
| `extension/llm_agent/adapter/tool-bridge.mjs` | Our tool registry as the adapter's tools, behind our permission gate |
| `extension/llm_agent/adapter/provider-turn.mjs` | One provider-backed turn |
| `extension/routes/provider-catalog.mjs` | The eight routes |
| `mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderCatalogSettingsCard.swift` | The Settings card (slot `providerCatalog`) |

## §2 Adapter decision

Evaluated 2026-10-29 against the registry and the installed tree (`npm view`, `npm ls --all`, `npm audit`, `npm audit signatures`).

| Question | Answer |
|---|---|
| Version used | `ai@6.0.317` and `@ai-sdk/openai-compatible@2.0.87`, both pinned exactly (no caret). The newest line is `ai@7.0.156`, whose `engines` is `node >=22`; this project's floor is `node >=20` (`extension/package.json`), so the 6.x line (`engines node >=18`, still receiving patches) is used until the floor moves. `@ai-sdk/openai-compatible` must match the major of `ai` (its `latest` tag, 3.x, needs `ai@7`) |
| Licence | Apache-2.0 for every package in the new tree |
| New packages | 10: `ai`, `@ai-sdk/gateway`, `@ai-sdk/openai-compatible`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@opentelemetry/api`, `@standard-schema/spec`, `@vercel/oidc`, `json-schema`, `undici`. `zod` and `eventsource-parser` were already installed. Unpacked size about 12 MB |
| Install scripts | None in any of them (`hasInstallScript` is absent); installed with `--ignore-scripts` regardless |
| `npm audit` result | Re-run after the fix commits: 15 advisories, identical to the baseline before the dependency was added; none in `ai`, `@ai-sdk/*`, `@opentelemetry/api`, `@vercel/oidc`, `@standard-schema/spec`, `json-schema` or `undici` |
| Provenance | `npm audit signatures`: all packages have verified registry signatures; 75 attestations verified (the `ai` package carries a SLSA v1 provenance statement) |
| `npm audit` | No new advisory. The 15 existing advisories (including `zod` 4.4.3, GHSA-mrhx-c7xc-m3w5) are unchanged and are not caused by this change |
| Tool calling | The library runs the model/tool loop (`streamText` with `stopWhen: stepCountIs(n)`), validates nothing itself unless told (our bridge checks arguments), and streams tool input deltas. Every catalog provider has a dedicated `@ai-sdk/*` package with tool support; this implementation uses the single OpenAI-compatible package for all of them, verified against a recorded `/chat/completions` stream (`extension/tests/fixtures/provider-adapter/`). Gemini is reached through its documented OpenAI-compatible endpoint, which accepts `tools` |
| Streaming | Yes, SSE, mapped to the agent/v2 events (`delta`, `tool_use_start`, `tool_args_delta`, `tool_result`, `usage`, `result`) |
| Versus keeping only our OpenAI-compatible path | Our `callOpenAI` is non-streaming and returns a tool call as a text fence for a loop we are deleting. Re-implementing streaming tool-call assembly, multi-step looping, per-provider quirks and abort handling is the part the library is maintained for. Cost: the dependency above and one thin module |
| Seams | Imports are confined to `extension/providers/adapter/` by an ESLint rule (`AI_SDK_IMPORT` in `eslint.config.mjs`); the library's default `console.error` of failures is silenced because a provider's error body can echo a key; `maxRetries: 0` so retry and fallback stay ours; the fetch handed to it refuses redirects and any host other than the connection's |
| Decision | **Adopt the Vercel AI SDK, behind `providers/adapter/`.** LiteLLM stays ruled out |

If the adapter ever has to go, only `providers/adapter/index.mjs` changes: its public surface is `createChatModel`, `runToolTurn`, `mapStreamPart`, `toWireError`.

## §3 Data

All state is per user (`user_flags` flag `provider.catalog`, JSON), plus the vault:

```json
{ "connections": [{ "id": "cat-groq", "catalogId": "groq", "name": "Groq",
                    "baseURL": "https://api.groq.com/openai/v1", "allowPrivate": false, "enabled": true }],
  "settings": { "toolsEnabled": false, "fallbackEnabled": false,
                "fallbackOrder": [{ "provider": "custom:cat-groq", "model": "llama-3.3-70b-versatile" }],
                "toolOverrides": { "cat-groq/some-model": true } } }
```

- Connection id: `cat-<catalog id>`; the generic endpoint adds `-<slug>` (1 to 24 lowercase letters or digits, default `default`) so a user can hold several. At most 20 connections per user.
- The API key is stored with `setSecret` under `custom.<id>.apiKey` (the existing custom-provider vault pattern, `CUSTOM_PROVIDER_KEY_RE`), encrypted per user. It is never in the flag JSON, never returned, never logged. A keyless entry (Ollama) stores the non-secret placeholder `not-required`, which is never sent as a credential.
- The Mac's whole-list `POST /kb/custom-providers` sync cannot remove a connection: it writes a different flag. `getCustomProvider('custom:cat-…')` falls back to the connection, so the existing `resolveCustomProviderDispatch` serves it unchanged.
- `fallbackOrder` accepts only the caller's own connections (anything else is dropped on write and on disconnect); at most 20 entries. `toolOverrides` holds at most 400 `'<connection id>/<model id>'` booleans.

## §4 Base URL and network rules

Three layers, one classifier. `extension/server/ip-classifier.mjs` canonicalises every IP spelling to 16 bytes (IPv4 in decimal, hex or octal as the URL parser normalises it, IPv6 with `::`, embedded dotted quads, IPv4-mapped `::ffff:a.b.c.d` and `::ffff:7f00:1`, IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) and applies one table:

| Class | Ranges | Hosted entries | `allowPrivate` + operator gate |
|---|---|---|---|
| public | everything else | allowed | allowed |
| private | `127/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (CGNAT), `fc00::/7` (ULA, except the metadata address), `fec0::/10` | refused | allowed |
| never | `169.254/16` and `fe80::/10` (link-local, cloud metadata `169.254.169.254`, `fd00:ec2::254`), `0/8`, `::`, `224/4` and `ff00::/8` (multicast), `240/4` incl. broadcast, `192.0.0/24`, `192.0.2/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `2001:db8::/32`, Teredo | **refused** | **refused** |

1. **Literal check** (`assertProviderBaseUrl`, and `assertSafeBaseUrl` for the legacy custom provider): scheme (`https`; `http` only to a private target under the opt-in), no credentials, **no query string or fragment** (so a `#` or `?` cannot swallow the path a request URL is built from; request URLs are built with `joinBaseUrl`, which uses the URL API), and an IP-literal host is classified.
2. **Connect-time pin** (`server/pinned-fetch.mjs`): the model list, the connection test and every chat request of a turn go through one fetch whose socket `lookup` resolves the name once, classifies EVERY returned address, refuses the connection if any is refused, and dials exactly the checked address. There is no second resolution, so a DNS-rebinding answer cannot change the target; each new connection is checked again. Redirects are refused. A refusal is an error with `code: 'SSRF_BLOCKED'`.
3. **Abort, never fall back.** A refusal ends the operation: `POST /kb/providers/catalog/models` and `/turn` answer 403 `PROVIDER_BLOCKED`, a streaming turn ends with an `error` event of the same code, and `test` reports `ok:false`. A refused target is never answered from the static model list or a cached list.
4. **Operator gate** `LLMIDE_ALLOW_PRIVATE_PROVIDERS` (`1` on, `0` off). Unset, private targets are allowed exactly when the server is bound to this machine only (no `LLMIDE_ALLOW_REMOTE=1`). On a remotely bound server they are refused (at connect, and again at use for an existing connection) unless the variable is `1`. A private target needs both the connection's own opt-in and this gate.

A hosted entry has a fixed base URL: a connect request naming another host is a 400, so a key cannot be pointed at a host the catalog never named. `openai-compatible` takes one. Ollama's own address is `localhost`; another host (even another loopback spelling is fine, a LAN or public host is not) needs the same explicit private-network opt-in as the generic endpoint. Every outgoing request uses no redirects.

## §5 Routes

All token-protected, additive, in `ALL_ENDPOINTS`. Shapes: `schema/http/provider-catalog.schema.json`; error envelope `{ error: { code, message } }`.

| Route | Purpose | Notes |
|---|---|---|
| `GET /kb/providers/catalog` | Entries, each with the caller's connections; plus settings | |
| `POST /kb/providers/catalog/connect` | `{ catalogId, apiKey?, baseURL?, slug?, name?, allowPrivate? }` | 400 `VALIDATION_FAILED` (no key, bad URL, fixed-URL entry, key with whitespace or over 512 chars), 404 `NOT_FOUND`, 409 `LIMIT`. Omit `apiKey` on a reconnect to keep the stored key |
| `POST /kb/providers/catalog/disconnect` | `{ id }` | Removes the key and the fallback slot; `removed:false` when the caller had no such connection |
| `POST /kb/providers/catalog/test` | `{ id }` | One free `GET <base>/models`. Always 200 `{ ok, detail, modelCount? }`; `detail` is redacted |
| `POST /kb/providers/catalog/models` | `{ id, refresh? }` | `{ models:[{ id, toolsSupported, toolsSource, streaming, contextWindow }], source, detail? }` |
| `GET` and `PUT /kb/providers/settings` | `toolsEnabled`, `fallbackEnabled`, `egressAutoApprove` (all default false), the order, the overrides | PUT is a patch; unknown fields ignored |
| `POST /kb/providers/turn` | A tool-capable turn (SSE) | See §7 |

Rate limits: `test` and `models` use `llmFast`; `connect`, `disconnect` and `PUT settings` use `kbWrite`; `turn` uses `agentTurn`. `test` and `models` have a 30 s route budget.

## §6 Capability flags

`modelCapability(entry, id, { live, override })` returns `{ id, toolsSupported, toolsSource, streaming, contextWindow }`. `toolsSource`, in precedence order:

1. `override`: the user's own yes or no (`settings.toolOverrides`).
2. `provider`: the provider's live list says so (OpenRouter `supported_parameters` contains `tools`).
3. `catalog`: the entry's static table lists the model.
4. `inferred`: the id matches one of the entry's `toolPatterns` (a family known to support tools).
5. `unknown`: nothing says so. **Treated as not supported.**

Model lists come from `GET <base>/models`, cached ten minutes per user and connection (a stale list answers when the provider is briefly down, marked `source:'cache'` with a `detail`), narrowed to chat models by the entry's patterns (embeddings, speech, moderation and guard models dropped), and fall back to the entry's static table (`source:'static'`) with no key, on an error, or when the list is empty. `streaming` is true for every entry. `contextWindow` comes from the live list when it has one (OpenRouter, Together), else the static table, else `null`.

`TOOL_MODES` = `execute`, `plan`, `assist_plan`, `review`. A model without tools in one of these is refused (400 `MODEL_LACKS_TOOLS`); in `ask` and `document` the turn runs without tools and says so (`notice` kind `tools_unavailable`).

## §7 The provider turn

`POST /kb/providers/turn` body `{ provider: 'custom:cat-…', model, message, mode?, history?, agentContext? }` (`history`: the last 40 `user`/`assistant` messages; `agentContext.workspaceRoot` bounds the file tools; `agentContext.chatSessionId` keys the chat's task list).

Order of checks, each refused with a plain JSON error before any event: message and model present (400), the connection exists (404 `PROVIDER_NOT_CONNECTED`), the user's `toolsEnabled` switch for a mode that needs tools (409 `PROVIDER_TOOLS_DISABLED`, default off; ask and document still run, without tools), the key is present (400 `PROVIDER_NO_KEY`), the fallback pick (§8), the capability check (400 `MODEL_LACKS_TOOLS`). Then it streams the agent/v2 vocabulary:

- `notice` kind `provider_fallback` (only after a switch), then `init` (`sessionId` is the approval session id; `capabilities:['provider-adapter']`), then `delta`, `tool_use_start`, `tool_args_delta`, `tool_result`, `usage` and `approval_request` (`ToolApproval`), ending in `result` or one `error` (`code`, `message`, `retryable`; codes `PROVIDER_AUTH`, `PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `ABORTED`).
- `agentContext.workspaceRoot` is normalised exactly as the Claude engine does (`path.resolve(expandTilde(root))`) before the readable roots, the `run-bash` cwd and the saved-rule scope are derived; a relative root is a 400.
- Tools are the registry (`llm_agent/tools/registry.mjs`) minus `ask-internal` and `ask-subagent` (nested Claude loops). A restricted mode (`ask`, `plan`, `assist_plan`, `review`, `document`) mounts `allowedToolNames(mode)`; `execute` mounts the rest, including `run-bash`.
- The permission gate is the registry's: `run-bash` gates itself (blocked patterns, auto-safe commands, saved project rules, else parks an approval); any other `act` entry with a `gate` is gated in the bridge the same way. A parked approval is answered with `POST /agent/v2/decision` using `init.sessionId`; the registry checks user and session. Arguments are checked against the skill schema before a handler runs.
- **Untrusted tool output.** What the model is shown of a tool result is framed (`<<<TOOL_RESULT name="…">>>` … `<<<END_TOOL_RESULT>>>`) with a line saying it is untrusted data to be used as information and never followed, and any `<<<`/`>>>` inside it is neutralised so it cannot close the frame. The UI event keeps the raw result.
- **Network-egress tools ask first.** `fetch-url` and `web-search` park an approval in a provider turn (a hostile page can steer a model into leaking through them) unless the user sets `egressAutoApprove`.
- Step cap 12 per turn, 8192 output tokens per call, no library retries. Usage is metered through `recordUsage` under the connection's provider id and endpoint `/kb/providers/turn`.
- Client disconnect aborts the turn and unparks its approvals.

Gaps against a Claude turn, for the second half: no memory or project-context injection, no session resume or compaction, budget is a step and token cap rather than USD, and the Mac chat does not use this route yet.

## §8 Cross-provider fallback

Off by default (`fallbackEnabled`). `pickTurnProvider(userId, { provider, model, needsTools })` runs once, at the start of a provider turn:

1. Candidates: the requested provider, then `fallbackOrder` in the user's order.
2. A candidate is skipped when it is not connected or disabled (`not_connected`), has no key (`no_key`), has no suitable model (`no_suitable_model`; an entry without a model gets the first catalog model that has tools when tools are needed), lacks tools in a tool mode (`no_tools`), is quota-flagged for the current daily or monthly window in `quota_state` (`quota`, set by `flagQuota` on a quota 429), or is rate limited (`rate_limited`: a header snapshot that shows zero remaining and a reset still ahead, ten minutes fresh at most; or an in-memory cooldown of 60 s, up to 15 min, set when a turn ended in a 429).
3. The first eligible candidate runs. If it is not the requested one, the turn emits a `notice` (`provider_fallback`, with `from`, `to`, `model`, `skipped`) before `init`, and records a `model_fallback` activity row.
4. If none is eligible the requested provider runs and its own error is the answer.

A turn never changes provider or model while it streams. A 429 mid-turn ends that turn with a retryable `error`; the next turn's pick sees the cooldown. Same-provider limits (`model_limits`, the reactive step-down in `completeViaApi`) are unchanged and still apply to the classic path. Per-model limits are not yet configurable for catalog connections (`getLimits` knows only the built-in provider ids); the fallback reads quota flags and rate-limit state, which work for any provider id.

## §9 Terms of use and quality risks

- **Free tiers.** Stacking several providers' free tiers to get around a limit can violate their terms. The product offers an ordered list the user writes and nothing more: no rotation, no load spreading, no key pooling, fallback off by default, and the Settings text says to check each provider's terms. Whether to rely on it is the user's decision.
- **Tool quality varies by model.** A weak tool model in `execute` or `plan` can loop or do damage. Mitigations: the capability flag (unknown means no tools), tool-heavy modes refuse a model without tools, the same permission gate for every provider, a step cap, and a per-model override the user owns. A bench scenario set for the adapter is part of the second half.
- **SSRF.** Covered by §4: one classifier for every IP spelling, a connect-time pin on every request, an operator gate for private targets, and abort on refusal. Residual: a hostname that is private by construction (`*.local`) is only trusted under the opt-in, and the OS resolver is trusted to answer for names.
- **Prompt injection.** Tool results are framed as data and the two egress tools ask first (§7); the permission gate is unchanged.
- **Keys.** Accepted once, vault only; the library's default error logging is off; error text is redacted with the key; the adapter's fetch cannot leave the connection's host or follow a redirect.

## §9b Chat integration and completion (T6.6)

- **Model picker.** The Mac composer lists every enabled catalog connection with its models and a `tools` / `no tools` badge. With the session router off (Settings, Providers) the models are shown disabled with a note and a one-click "Turn on the session router" (a preference, applied at the next backend start). With tools off (`settings.toolsEnabled`) they stay pickable for ask and document modes, with a visible note and the "Allow tools on provider models" switch; nothing is enabled silently. A pick pins the chat's route (`PUT /agent/v2/session/route`, provider `custom:cat-*`) and the turn goes to `/agent/v2/stream`, where the router hands it to the adapter. Any other pick releases a catalog pin.
- **Tool modes** (`TOOL_MODES`: execute, plan, assist_plan, review) refuse a model without tools with `MODEL_LACKS_TOOLS` and a message naming the fix; ask and document run without tools.
- **Completion.** `runClaude` dispatches a catalog provider to `providers/adapter-complete.mjs` (one completion, no tools, metered, transient errors retried, `PROVIDER_UNAVAILABLE` for config problems). `POST /kb/complete`, the tier-routed background roles (a Strong or Cheap tier may name a connection; Settings, Tiers and Roles) and the `internal` role of `/generate-notes` (JSON path), `/generate-questions` and `/extract-entities` use it. Not migrated: the streaming `/generate-notes` (CLI streaming), `/generate-doc` and `/kb/export` (their own prompt paths), `analyze-risks` (rule based, no model), the Loop's agent step (Claude Agent SDK by design).
- **Network.** Every request to a model-provider host goes through the pinned fetch; `tests/provider-fetch-pinned-guard.test.mjs` fails on a bare `fetch(` outside the fixed-host allowlist (api.anthropic.com, the web-fetch tool, Jev).

## §9c Upgrade path for users with old keys

The classic engine that ran the built-in OpenAI, Google and DeepSeek keys and the Custom Providers is gone (API 92), so the server carries those keys into the catalog once (`providers/legacy-key-migration.mjs`), on the first `GET /kb/providers/catalog` after the upgrade:

- **What is created.** For each of the openai, google and deepseek vault keys, a catalog connection of the same provider with the key copied into `custom.<id>.apiKey`; for each enabled OpenAI-compatible custom provider (and the shared custom endpoint with a key and base URL), an `openai-compatible` connection with the same base URL after the base-URL guard passes. A connection that already exists for that catalog entry (or base URL) is left alone.
- **Non-destructive.** The old keys and settings are never changed or deleted. A user who later disconnects a migrated connection is not reconnected: the outcome is recorded once in `user_flags` `provider.migration.v1` and the sweep never repeats.
- **Tools stay off.** The migration never switches `toolsEnabled` on. When a connection is created it reports `toolsSuggested: true`, and the card and the composer's note show a visible "Allow tools on provider models" switch with the one-line reason: tool turns can read files and run commands, subject to approvals. Without it the migrated models still answer in ask and document modes (no tools); a mode that needs tools is refused with 409 `PROVIDER_TOOLS_DISABLED`.
- **Failures.** Per provider, logged with the key redacted, never blocking the others. A base URL the guard refuses (private address, plain http) is recorded as `needsReview` with its reason (200 characters, redacted) and shown in the Provider catalog card as "needs review"; nothing is connected for it.
- **What the user sees.** The response of `GET /kb/providers/catalog` carries `migration: { created, needsReview, toolsSuggested }`. The card says which keys were added and that the old keys are kept, lists the ones that need review, and offers "Turn on the session router". The composer shows the catalog models disabled while the router is off, with the same one-click action in its note. Both set the `chat.router` preference only (never silently); it applies the next time the backend starts, and the note says so while it is pending.
- **Not carried over.** Keyless CLI modes (codex, gemini) and custom providers without an OpenAI-compatible endpoint. A Claude login or key is unaffected.

## §10 Tests

`extension/tests/ip-classifier.test.mjs`, `pinned-fetch.test.mjs` (a real local server, a fake resolver, a rebinding sequence), `eslint-ai-sdk-fence.test.mjs` and `provider-*.test.mjs` (catalog, connections, models, adapter incl. recorded wire, fallback, turn, wire conformance, routes) and `mac/Tests/LlmIdeMacTests/ProviderCatalogModelTests.swift`. No test reaches a real provider.

## Regeneration checklist

- [ ] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [ ] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [ ] Spot-check: one representative piece rebuilt from this page alone matches source.
- [ ] Structured facts link to their extractor-generated reference page (no hand-copied drift).
