# Web Chat Parity with the Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between the web client's chat and the desktop chat: a mode picker and a model picker bounded to what the desktop allows a remote client, text-file attachments that actually reach the model, a "New chat" switcher, and a usage strip that refreshes after every reply.

**Architecture:** One new Host API v1 capability `compose` (desktop switch `LLMIDE_HOST_API_COMPOSE=1`, default off) carries two new commands, `chat.options` (the allowed modes and the account's Claude models) and `chat.new` (start a fresh phone chat), plus two new optional `chat.send` fields, `mode` and `model`, which the gateway honours only for a session granted `compose`. The desktop gateway re-checks every value against the same allowed set in process (`startHostTurn` gains `mode` and `model` and still clamps to read-only), never over HTTP. The web client adds a compose controller and a `ComposeBar` beside the existing shared `Composer`. The existing `chat.send.attachments` contract is fixed on the desktop host, where it was silently dropped (see "What exists today").

**Tech Stack:** Node 20+ ESM (`node:test`), the repo's JSON-Schema subset validator (`extension/routes/bus/schema-validate.mjs`), `scripts/generate-host-api.mjs` (Node/Swift/TS codegen), React 19.3.1 + TypeScript 5.9.3 in `web/` (tests: `node --test --experimental-strip-types`, UI via esbuild 0.28.2 in `web/tests/helpers.mjs`), Swift only for one compile-only case in the Mac gateway.

**Spec:** `docs/superpowers/specs/2026-11-03-host-api-design.md` (Host API design), `schema/host-api/v1/README.md` (contract, "Host differences"), `docs/superpowers/MASTER-PLAN.md` line 431 (this item), prior slice `docs/superpowers/plans/2026-11-05-host-api-v1-read-commands.md` (house style, Decisions 1-6).

## Global Constraints

- Security first (user decision): every new Host API command is behind a capability granted at pairing (served ∩ granted), rate-limited per session, audited without content, contract-first (`schema/host-api/v1` + fixtures + the shared vectors used by both the Node gateway and the iOS/web clients), and `apiVersion` handling per the spec. A browser paired before a new capability existed must re-pair to get it (as the read slice did).
- `apiVersion` stays `1`. Additive inside v1. No HTTP route changes, so **no `SERVER_API_VERSION` bump and no `ALL_ENDPOINTS` change**.
- Writes from the web are bounded: mode and model changes only to the allowed set the desktop exposes; attachments size/type capped (reuse the core's existing attachment limits; never paths on the desktop's disk); "always allow" rules only as project-scoped prefix rules the desktop already supports, created only after an explicit user action and listed/revocable on the desktop; never a "bypass" mode from the web.
- The allowed modes are exactly `auto`, `ask`, `plan`, `assist_plan`, `review`, `document` (`auto` on the wire runs `auto_read_only`). `execute` and every permission mode (`ask` / `accept-edits` / `bypass` of `permissionMode`) are refused by the schema and again by `startHostTurn`.
- Core attachment limits (`extension/core/prompt-framing.mjs` `selectAttachments`; mirrored in `ui/screens/chat/attach/limits.ts`): 80,000 characters per text file, 200,000 in total. v1 schema: at most 10 attachments, name ≤ 300 characters, text ≤ 100,000 characters. Frame ≤ 1,048,576 bytes.
- The Host API runs turns in process (`startHostTurn`), never over HTTP; the phone chat is one server-side chat per user (`host_api_quick_chat`) in `auto_read_only` in the extension chat workspace.
- The relay web tier keeps `host, chat, read` only (`extension/core/host-api-relay.mjs` unchanged), so a relay-bridged session never holds `compose`.
- Payload objects are closed (`additionalProperties: false`). Schema `pattern`s end in `$` and avoid `\d`, `\w`, `\s` and an unescaped `.` outside a character class (Swift ICU). Only keywords in `ALLOWED_SCHEMA_KEYS` (`scripts/conformance-host-api.mjs:38`). No `number`/`null` types.
- Never log frame content, tokens, PINs, file names or attachment text: type and size only. Audit rows carry mode, model id and a file count, never text.
- Web: React app in `web/`, strict decoding, `AbortController`-equivalent cancellation stays the connection's (requests are WebSocket frames; nothing here adds `fetch`), CSP unchanged (a file input and `Blob.text()` need nothing new), phone-width layout (wraps at 320 px, 16 px gutter already in `web.css`), keyboard + VoiceOver usable (native `<select>` and `<input type="file">` with visible labels, `role="alert"` errors), tests with `node:test` like `web/tests`.
- Pinned versions only; no new dependencies.
- Swift feature freeze: Mac changes are limited to what the shared generated code forces (one unreachable `case`).
- Conventional Commits, one concern per commit, commit on `main` (user rule: no branches). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Another agent works in `web/src/sync/`, `web/src/sources/`, `extension/routes/sync/` and the iOS sync files this weekend. Do not edit those files. The shared files this plan touches are listed under "File overlaps"; keep those hunks small and re-read each one right before editing it (the other agent may have changed it since).

## What exists today (facts checked 2026-11-06)

- **Sessions list, read-only history, usage strip:** built by the read slice (`chat.sessions`, `chat.history`, `usage.get`, capability `read`, `LLMIDE_HOST_API_READ=1`): `web/src/read/controller.ts`, `web/src/screens/ReadPanel.tsx`. Gap: usage refreshes only on resync, never after a reply.
- **Session switching:** none. `chat.send` always targets the per-user phone chat (prior plan Decision 2, "Open, never switch").
- **Mode / model:** none. `startHostTurn` (`extension/routes/agent-v2.mjs:1044`) hard-codes `mode: AUTO_READ_ONLY` and the default provider/model.
- **Attachments:** the v1 contract has `chat.send.attachments: [{ name, text }]` (≤ 10) and iOS sends them (`ios_app/SharedProtocol/Sources/SharedProtocol/HostApiClientLogic.swift:133`). **Bug:** the desktop gateway passes them unchanged as `files` (`gateway.mjs` `startTurn`, `files: p.attachments ?? []`), but the engine only reads `{ path, content }` (`core/prompt-framing.mjs` `splitImageAttachments` / `selectAttachments` skip any entry without both), so every Host API attachment is silently dropped on the desktop. The web client never sends attachments.
- **Tool approvals:** `toolApprovals.answer` allows `allow_once | deny` only; the gateway comment says "Never always-allow from a client". Desktop saved rules live in `kb/tool-permissions.mjs` (`addRule` / `listRules` / `removeRule`, table `tool_permission_rules`, per user + project root + tool + prefix), revocable in desktop Settings, Tool permissions.
- **Bypass:** the desktop's Bypass needs a single-use token from a host-native Cancel-first dialog (`ui/screens/chat/bypass.ts`, core `403 HOST_APPROVAL_REQUIRED`); `startHostTurn` passes no `permissionMode` and ends any Bypass grant (`bypassGrants.revoke`). No remote client can get Bypass today, and this plan keeps it so.

## Decisions for the user (secure default first, already applied in this plan)

| # | Question | Secure default (applied) | Alternative |
|---|---|---|---|
| 1 | How is the new surface granted? | One new capability `compose`, served only with `LLMIDE_HOST_API_COMPOSE=1` (default off); a browser paired before must re-pair; never via the relay web tier. | Put it under `chat`, which would silently grant it to every paired device. |
| 2 | Can the web switch to another session and send there? | **No.** Every desktop chat stays read-only from the web. `chat.new` only starts a fresh phone chat; the previous phone chat then shows in the list as a normal read-only chat. | Send into any desktop chat (read-only mode): continues project-bound chats from a remote device, in the open project's workspace instead of the extension chat workspace. |
| 3 | What mode may a web-sent turn run in? | Only read-only modes: Auto (= `auto_read_only`), Ask, Plan, Assist Plan, Code Review, Document. `execute` is refused by the schema and clamped again by `startHostTurn`. | Execute with tool approvals: lets a browser drive file edits and commands. |
| 4 | Bypass from the web? | **Never.** The desktop does not allow it for remote clients today (host-native dialog token, `HOST_APPROVAL_REQUIRED`), and nothing here adds a path. | None offered. |
| 5 | "Always allow" rules from the web? | **Not built.** In the read-only modes of row 3 the tool roster has no Bash (`allowedToolNames`, `mode-personas.mjs`), and the only rules the desktop saves are project-scoped Bash prefix rules (`describeRule` / `SAFE_RULE_PREFIXES`), so a web turn can never be offered one; the gateway keeps "never always-allow from a client". The web card says rules are made and revoked on the desktop. | A `tool_rules` capability with an `always_allow` decision; only meaningful if row 3 ever allows Execute. |
| 6 | Which models may the web pick? | Only the Claude models the desktop's Agent SDK lists for this user (`listSdkModels`), re-checked on every send; plus "Desktop default". No custom providers, no "Add model", no effort picker. | Include catalog/custom providers (needs their tool support and key checks on a remote path). |
| 7 | Attachments? | Text files only: ≤ 10 per message, 80,000 characters each, 200,000 in total, file name only (never a path); images refused (the core allows a 6M-character image, a 1 MiB frame cannot carry it). Attachments stay under `chat` (existing contract); the desktop fix also makes iOS attachments reach the model. | Small images under `compose` with a ~700 KB cap. |
| 8 | Audit? | One row per `chat.new`; `chat.options` and a `chat.send` that picks a mode/model are de-duplicated per device and choice per minute; mode, model id and file count only. | No audit row for `chat.options` (it is a read, like Decision 5 of the read slice). |
| 9 | iOS? | No screen work. Task 1 regenerates `ios_app/SharedProtocol`; an older iOS build fails `host.hello` against a host serving `compose` (strict capability enum, read-slice Decision 4), which is acceptable because the switch is off by default. | Relax the capability enums to a pattern. |

## File overlaps with the sync agent

| File | Why this plan touches it | Owner of the other change | Rule |
|---|---|---|---|
| `web/src/App.tsx` | wire compose controller and `ComposeBar` into `Chat` | sync/sources wiring in `App` | edit only the `Chat` function; leave `App` untouched |
| `web/src/app-model.ts` | `Session.compose` | none known | small hunk |
| `web/tests/ui-entry.ts` | export `ComposeBar` | exports `SyncTier`, `SourcesScreen` | append one line at the end |
| `web/src/web.css` | `.web-compose` rules | sync/sources rules | append at the end |
| `web/src/read/controller.ts` | refresh usage after a reply | `web/src/read/snapshot.ts` (sync) imports `initialReadState` / `ReadState` | `ReadState` shape unchanged |
| `extension/routes/agent-v2.mjs` | `startHostTurn` gains optional `mode`, `model` | `extension/routes/sync/consumer.mjs` calls `startHostTurn` without them | additive; defaults unchanged |
| `extension/CLAUDE.md` | "Host API v1 (desktop)" section | "Sync (desktop producer)" section | edit only the Host API section |
| `docs/superpowers/MASTER-PLAN.md` | line 431 | sync lines (SP5-SP7) | edit only line 431 |

Not touched: `web/src/sync/*`, `web/src/sources/*`, `web/src/screens/SyncTier.tsx`, `web/src/screens/SourcesScreen.tsx`, `web/src/screens/ReadPanel.tsx`, `web/src/read/snapshot.ts`, `web/MANUAL-CHECK.md`, `extension/routes/sync/*`, any `ios_app` sync file.

## File Structure

| File | Responsibility |
|---|---|
| `schema/host-api/v1/commands.json` (modify) | `compose` capability; `chat.options`, `chat.new`; `chat.send.mode` / `.model`; capability enums |
| `schema/host-api/v1/events.schema.json` (modify) | `host.capabilities` enum gains `compose` |
| `schema/host-api/v1/fixtures/commands/{chat.options,chat.new}.{request,result}.json` (create) | valid fixtures |
| `schema/host-api/v1/fixtures/invalid/commands/{chat.send.mode-execute,chat.send.model-bad,chat.new.unknown-field}.json` + `invalid-cases.json` | invalid fixtures |
| `schema/host-api/v1/fixtures/security/compose.json` (create) + `security/README.md` | shared vector: allowed/refused modes, model ids, attachment limits |
| `schema/host-api/v1/fixtures/events/host.capabilities.json` (modify) | lists `compose` |
| `schema/host-api/v1/README.md` (modify) | 17 commands, `compose`, Host differences |
| `scripts/conformance-host-api.mjs` (modify) | `EXPECTED_COMMANDS = 17` |
| generated: `extension/routes/host-api/commands.generated.mjs`, `web/src/host-api/types.generated.ts`, `ios_app/SharedProtocol/Sources/SharedProtocol/HostApi{Commands,Payloads,Schemas}.swift` | regenerated, never hand-edited |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift` (modify) | one unreachable case |
| `extension/routes/host-api/compose.mjs` (create) | `COMPOSE_MODES`, `optionsOf`, `offersModel`, `attachmentsToFiles` |
| `extension/routes/host-api/gateway.mjs` (modify) | attachments mapping, `compose` switch, `chat.options`, `chat.new`, `chat.send` options |
| `extension/routes/host-api/audit.mjs` (modify) | success outcome for `chat_options`, `chat_new`, `compose_send` |
| `extension/routes/agent-v2.mjs` (modify) | `startHostTurn({ mode, model })` |
| `extension/tests/host-api-compose.test.mjs` (create) | mapper + shared-vector tests |
| `extension/tests/host-api-gateway.test.mjs`, `extension/tests/agent-v2-host-turn.test.mjs`, `extension/tests/host-api-contract.test.mjs`, `extension/tests/host-api-ts-types.test.mjs` (modify) | tests |
| `web/src/chat/attachments.ts` (create) | read one browser file as a bounded text attachment |
| `web/src/chat/compose.ts` (create) | compose state + `chat.options`, no React |
| `web/src/chat/controller.ts` (modify) | `send(text, extra)` returns accepted; `newChat()` |
| `web/src/read/controller.ts` (modify) | usage refresh on `chat.done` |
| `web/src/screens/ComposeBar.tsx` (create) | mode select, model select, attach input, chips |
| `web/src/screens/WebChat.tsx`, `web/src/screens/ToolApprovalCard.tsx` (modify) | `compose` slot, "New chat", rules note |
| `web/src/app-model.ts`, `web/src/App.tsx`, `web/src/web.css`, `web/tests/ui-entry.ts` (modify) | wiring |
| `web/tests/attachments.test.mjs`, `web/tests/compose-controller.test.mjs` (create); `web/tests/chat-controller.test.mjs`, `web/tests/read-controller.test.mjs`, `web/tests/screens.test.mjs` (modify) | web tests |
| `extension/CLAUDE.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | docs |

---

### Task 1: Contract: `compose` capability, `chat.options`, `chat.new`, `chat.send` options, shared vector (~35 min)

**Files:**
- Modify: `schema/host-api/v1/commands.json` (line 4 `capabilities`; the three `capabilities.items.enum` lists in the `host.hello`, `host.auth.pair`, `host.auth.token` results; `chat.send.request.properties`; append two commands at the end of `commands`)
- Modify: `schema/host-api/v1/events.schema.json` (`host.capabilities` payload enum), `schema/host-api/v1/fixtures/events/host.capabilities.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.options.request.json`, `chat.options.result.json`, `chat.new.request.json`, `chat.new.result.json`
- Create: `schema/host-api/v1/fixtures/invalid/commands/chat.send.mode-execute.json`, `chat.send.model-bad.json`, `chat.new.unknown-field.json`; modify `fixtures/invalid-cases.json`
- Create: `schema/host-api/v1/fixtures/security/compose.json`; modify `fixtures/security/README.md`
- Modify: `scripts/conformance-host-api.mjs:20`, `schema/host-api/v1/README.md`
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift` (after `case .chatSessions, .chatHistory, .usageGet:` near line 290)
- Test: `extension/tests/host-api-contract.test.mjs`, `extension/tests/host-api-ts-types.test.mjs`

**Interfaces:**
- Produces (wire):
  - `chat.options` (capability `compose`, idempotent) request `{}` → result `{ modes: ("auto"|"ask"|"plan"|"assist_plan"|"review"|"document")[] (1..6), models: [{ model, label? }] (0..50) }`
  - `chat.new` (capability `compose`, not idempotent) request `{}` → result `{ sessionId }` (`^[A-Za-z0-9_-]{1,64}$`)
  - `chat.send` request gains `mode?` (same six-value enum) and `model?` (`^[A-Za-z0-9_.:\[\]-]{1,200}$`)
  - Generated: `HOST_API_COMMANDS["chat.options"|"chat.new"].capability === "compose"`; TS `HostApiResult<"chat.options">`, `HostApiRequest<"chat.send">["mode"]`; Swift `HostApiCommand.chatOptions`, `.chatNew` (exact names: read them from the generated `HostApiCommands.swift`).
  - Shared vector `schema/host-api/v1/fixtures/security/compose.json` (read by Task 3's and Task 5's tests).

- [ ] **Step 1: Write the failing contract tests**

In `extension/tests/host-api-contract.test.mjs` change the count test title and assertion from 15 to 17 (`"host-api command registry: 17 commands and every fixture validates"`, `assert.equal(Object.keys(commands.commands).length, 17);`), change `assert.match(readme, /15 commands/);` to `/17 commands/`, and append:

```js
test("host-api compose: capability compose, closed shapes, the shared vector matches the schema", () => {
  assert.ok(commands.capabilities.includes("compose"));
  assert.equal(commandEntry("chat.options").capability, "compose");
  assert.equal(commandEntry("chat.options").idempotent, true);
  assert.equal(commandEntry("chat.new").capability, "compose");
  assert.equal(commandEntry("chat.new").idempotent, false);
  const vector = json("fixtures/security/compose.json");
  const send = commandEntry("chat.send").request;
  assert.deepEqual(send.properties.mode.enum, vector.modes.allowed);
  assert.deepEqual(commandEntry("chat.options").result.properties.modes.items.enum, vector.modes.allowed);
  for (const mode of vector.modes.refused) {
    assert.ok(validate(send, { text: "hi", mode }, { defs: envelope.$defs }).length > 0, `mode ${JSON.stringify(mode)} refused`);
  }
  for (const model of vector.models.allowed) assert.deepEqual(validate(send, { text: "hi", model }, { defs: envelope.$defs }), [], model);
  for (const model of vector.models.refused) assert.ok(validate(send, { text: "hi", model }, { defs: envelope.$defs }).length > 0, `model ${JSON.stringify(model)} refused`);
  assert.equal(send.properties.attachments.maxItems, vector.attachments.maxFiles);
  assert.equal(send.properties.attachments.items.properties.name.maxLength, vector.attachments.maxNameChars);
});
```

In `extension/tests/host-api-ts-types.test.mjs` line 20 change the expectation to:

```js
    v: 1, c: 17, e: 7, caps: ['host', 'chat', 'approvals', 'tool_approvals', 'read', 'compose'], codes: 11, send: { capability: 'chat', idempotent: false },
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-contract.test.mjs tests/host-api-ts-types.test.mjs`
Expected: FAIL (`15 !== 17`, `compose` missing, `fixtures/security/compose.json` not found).

- [ ] **Step 3: Edit `commands.json`**

Line 4 becomes:

```json
  "capabilities": ["host", "chat", "approvals", "tool_approvals", "read", "compose"],
```

In the `capabilities.items.enum` of the `host.hello`, `host.auth.pair` and `host.auth.token` results, replace `["host", "chat", "approvals", "tool_approvals", "read"]` with `["host", "chat", "approvals", "tool_approvals", "read", "compose"]`.

In `chat.send.request.properties`, after `"text": {…},` add:

```json
          "mode": { "type": "string", "enum": ["auto", "ask", "plan", "assist_plan", "review", "document"] },
          "model": { "type": "string", "pattern": "^[A-Za-z0-9_.:\\[\\]-]{1,200}$" },
```

Append after the `usage.get` entry (add a comma after its closing brace):

```json
    "chat.options": {
      "capability": "compose",
      "direction": "client_to_host",
      "idempotent": true,
      "v2Tag": null,
      "request": { "type": "object", "additionalProperties": false, "properties": {} },
      "result": {
        "type": "object",
        "additionalProperties": false,
        "required": ["modes", "models"],
        "properties": {
          "modes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 6,
            "items": { "type": "string", "enum": ["auto", "ask", "plan", "assist_plan", "review", "document"] }
          },
          "models": {
            "type": "array",
            "maxItems": 50,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["model"],
              "properties": {
                "model": { "type": "string", "pattern": "^[A-Za-z0-9_.:\\[\\]-]{1,200}$" },
                "label": { "type": "string", "minLength": 1, "maxLength": 200 }
              }
            }
          }
        }
      }
    },
    "chat.new": {
      "capability": "compose",
      "direction": "client_to_host",
      "idempotent": false,
      "v2Tag": null,
      "request": { "type": "object", "additionalProperties": false, "properties": {} },
      "result": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessionId"],
        "properties": {
          "sessionId": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" }
        }
      }
    }
```

- [ ] **Step 4: Events schema and fixtures**

In `events.schema.json`, the `host.capabilities` variant's `payload.properties.capabilities.items.enum` becomes `["host", "chat", "approvals", "tool_approvals", "read", "compose"]`.

`fixtures/events/host.capabilities.json`:

```json
{"apiVersion":1,"id":"e-7","type":"event","command":"host.capabilities","payload":{"capabilities":["host","chat","approvals","tool_approvals","read","compose"]},"ts":1760000000008,"rev":8}
```

`fixtures/commands/chat.options.request.json`: `{}`

`fixtures/commands/chat.options.result.json`:

```json
{"modes":["auto","ask","plan","assist_plan","review","document"],"models":[{"model":"claude-sonnet-5-5","label":"Sonnet 5.5"},{"model":"claude-opus-4-9[1m]"}]}
```

`fixtures/commands/chat.new.request.json`: `{}`

`fixtures/commands/chat.new.result.json`: `{"sessionId":"chat-2"}`

`fixtures/invalid/commands/chat.send.mode-execute.json`: `{"text":"hi","mode":"execute"}`

`fixtures/invalid/commands/chat.send.model-bad.json`: `{"text":"hi","model":"a b"}`

`fixtures/invalid/commands/chat.new.unknown-field.json`: `{"sessionId":"x"}`

In `fixtures/invalid-cases.json` add to `"commands"`:

```json
    "chat.send.mode-execute.json": { "command": "chat.send", "kind": "request", "at": ".mode" },
    "chat.send.model-bad.json": { "command": "chat.send", "kind": "request", "at": ".model" },
    "chat.new.unknown-field.json": { "command": "chat.new", "kind": "request", "at": ".sessionId" }
```

If `node scripts/conformance-host-api.mjs` reports a different `at` path for one of them, use the path it prints (the validator's path format is authoritative).

- [ ] **Step 5: The shared vector**

Create `schema/host-api/v1/fixtures/security/compose.json`:

```json
{
  "modes": {
    "allowed": ["auto", "ask", "plan", "assist_plan", "review", "document"],
    "refused": ["execute", "bypass", "accept-edits", "auto_read_only", "manual", ""]
  },
  "models": {
    "allowed": ["claude-sonnet-5-5", "claude-opus-4-9[1m]", "claude-haiku-4-5-20251001", "claude-sonnet-5.5"],
    "refused": ["", "a b", "../etc/passwd", "claude\nopus", "x;rm -rf /"]
  },
  "attachments": {
    "maxFiles": 10,
    "maxNameChars": 300,
    "maxCharsPerFile": 80000,
    "maxCharsTotal": 200000,
    "imagesAllowed": false
  }
}
```

Append to `fixtures/security/README.md`:

```markdown
`compose.json` pins the `compose` capability's bounds: the only modes a client may ask for (never `execute` or a permission mode), which model ids pass the wire pattern, and the attachment limits (the core's 80,000 / 200,000 characters, the schema's 10 files and 300-character names, text only). The Node gateway tests (`extension/tests/host-api-compose.test.mjs`) and the web client tests (`web/tests/attachments.test.mjs`) read it.
```

- [ ] **Step 6: Conformance count, README, regenerate**

`scripts/conformance-host-api.mjs:20`: `const EXPECTED_COMMANDS = 17;`

In `schema/host-api/v1/README.md`: change "All 15 commands are listed below." to "All 17 commands are listed below."; append two table rows after `usage.get`:

```markdown
| `chat.options` | compose | yes | — |
| `chat.new` | compose | no | — |
```

and after the `read` paragraph add:

```markdown
`compose` is the web chat's turn options: `chat.options` lists the modes a client may pick (read-only ones only: `auto`, which runs `auto_read_only`, `ask`, `plan`, `assist_plan`, `review`, `document`) and the account's Claude models; `chat.send` may then carry `mode` and `model`, which a host honours only for a session granted `compose` (`denied` with a re-pair hint otherwise) and re-checks against the same lists; `chat.new` starts a fresh phone chat (the previous one stays readable through `chat.history`). Served only when the host enables it (desktop: `LLMIDE_HOST_API_COMPOSE=1`, default off), never to a relay-bridged session, and only to a device paired while it was served. Bounds are pinned by `fixtures/security/compose.json`. Attachments stay under `chat`: text only, the host frames them as `{ path: name, content: text }` for the model.
```

Then run: `cd /Users/dinsmallade/llm-ide && node scripts/generate-host-api.mjs`
Expected: it rewrites `extension/routes/host-api/commands.generated.mjs`, `web/src/host-api/types.generated.ts` and the three `ios_app/SharedProtocol/Sources/SharedProtocol/HostApi*.swift` files.

- [ ] **Step 7: Mac compile-only case**

In `HostApiV1Gateway.swift`, after the `case .chatSessions, .chatHistory, .usageGet:` block, add (use the case names from the regenerated `HostApiCommands.swift` if they differ):

```swift
        case .chatOptions, .chatNew:
            // Unreachable: the Mac never serves `compose`, so the gate refused above. The desktop host serves it.
            fail(session, id, "capability_unavailable", "This Mac does not serve compose right now.")
```

- [ ] **Step 8: Run the gates**

Run: `cd /Users/dinsmallade/llm-ide && make host-api-check && (cd extension && node --test tests/host-api-contract.test.mjs tests/host-api-ts-types.test.mjs) && make test-shared-protocol && (cd mac && swift build)`
Expected: PASS. `swift build` may fail inside the sandbox with "Invalid manifest" / "Operation not permitted"; retry it unsandboxed (a sandbox artifact, not a code error).

- [ ] **Step 9: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add schema/host-api/v1 scripts/conformance-host-api.mjs extension/routes/host-api/commands.generated.mjs \
  web/src/host-api/types.generated.ts ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift \
  ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPayloads.swift ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemas.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift \
  extension/tests/host-api-contract.test.mjs extension/tests/host-api-ts-types.test.mjs
git commit -m "feat(host-api): compose capability with chat.options, chat.new and send options

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Desktop: Host API attachments reach the model (~15 min)

The engine reads `{ path, content }`; the v1 wire carries `{ name, text }`. Today every Host API attachment is dropped (see "What exists today"). This fix needs no new capability: it makes the existing `chat` contract do what it says.

**Files:**
- Create: `extension/routes/host-api/compose.mjs` (only `attachmentsToFiles` in this task)
- Modify: `extension/routes/host-api/gateway.mjs` (import; the `deps.turn({...})` call in `startTurn`)
- Test: `extension/tests/host-api-compose.test.mjs` (create), `extension/tests/host-api-gateway.test.mjs` (the `chat.send runs a turn…` test, line ~107)

**Interfaces:**
- Produces: `attachmentsToFiles(list: Array<{ name: string, text: string }> | undefined): Array<{ path: string, content: string }>` from `extension/routes/host-api/compose.mjs`.

- [ ] **Step 1: Write the failing tests**

Create `extension/tests/host-api-compose.test.mjs`:

```js
// Host API v1 compose helpers on the desktop host: attachment framing, the allowed modes and the model list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentsToFiles } from '../routes/host-api/compose.mjs';
import { selectAttachments } from '../core/prompt-framing.mjs';

test('attachmentsToFiles: the wire {name, text} becomes the engine {path, content}, and the engine keeps it', () => {
  const files = attachmentsToFiles([{ name: 'notes.md', text: 'hello' }]);
  assert.deepEqual(files, [{ path: 'notes.md', content: 'hello' }]);
  assert.deepEqual(selectAttachments(files).files, [{ path: 'notes.md', content: 'hello' }]);
});

test('attachmentsToFiles: absent or malformed entries yield nothing', () => {
  assert.deepEqual(attachmentsToFiles(undefined), []);
  assert.deepEqual(attachmentsToFiles([{ name: 'a' }, null, { text: 'x' }]), []);
});
```

In `extension/tests/host-api-gateway.test.mjs`, in the test `'chat.send runs a turn on the quick chat and routes delta + done'`, replace

```js
  assert.deepEqual(t.turns[0].files, [{ name: 'a.md', text: 'x' }]);
```

with

```js
  assert.deepEqual(t.turns[0].files, [{ path: 'a.md', content: 'x' }]);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-compose.test.mjs tests/host-api-gateway.test.mjs`
Expected: FAIL (`Cannot find module '../routes/host-api/compose.mjs'`; the gateway test still sees `{ name, text }`).

- [ ] **Step 3: Implement**

Create `extension/routes/host-api/compose.mjs`:

```js
// Host API v1 chat composition on the desktop host: attachment framing (capability chat) and, from Task 3 of the web
// chat parity plan, the `compose` options. Pure. The v1 wire names an attachment by its file name only; the engine
// (core/prompt-framing.mjs) reads { path, content } and treats `path` as a display label, never a file to open.

/** The wire's attachments as the engine's files; entries without both strings are dropped (the schema already refused them). */
export function attachmentsToFiles(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => typeof a?.name === 'string' && typeof a?.text === 'string')
    .map((a) => ({ path: a.name, content: a.text }));
}
```

In `gateway.mjs` add the import next to the `reads.mjs` one:

```js
import { attachmentsToFiles } from './compose.mjs';
```

and in `startTurn` change

```js
      .then(() => deps.turn({ userId: o.userId, chatSessionId, message: p.text, files: p.attachments ?? [], onEvent }))
```

to

```js
      .then(() => deps.turn({ userId: o.userId, chatSessionId, message: p.text, files: attachmentsToFiles(p.attachments), onEvent }))
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-compose.test.mjs tests/host-api-gateway.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/host-api/compose.mjs extension/routes/host-api/gateway.mjs extension/tests/host-api-compose.test.mjs extension/tests/host-api-gateway.test.mjs
git commit -m "fix(host-api): frame v1 chat attachments as engine files on the desktop

Host API attachments arrived as {name, text} and the engine reads only
{path, content}, so every attachment from iOS was silently dropped.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Desktop: `startHostTurn` takes a read-only mode and a model (~20 min)

**Files:**
- Modify: `extension/routes/agent-v2.mjs` (the `startHostTurn` doc comment and function, lines ~1037-1066)
- Test: `extension/tests/agent-v2-host-turn.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `startHostTurn({ userId, chatSessionId, message, files = [], mode = 'auto', model = null, onEvent, deps = {} })` and `HOST_TURN_MODES` (frozen array `['auto','ask','plan','assist_plan','review','document']`) exported from `extension/routes/agent-v2.mjs`. `mode` other than these runs `auto_read_only`; a non-`auto` mode is passed through `clampToReadOnly`; `model` (a non-empty string) becomes `body.model`. `routes/sync/consumer.mjs` keeps calling it without either, unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/agent-v2-host-turn.test.mjs`:

```js
test('startHostTurn: an allowed mode runs as asked and a model is passed through', async () => {
  const userId = await makeUser();
  const seen = {};
  await v2.startHostTurn({
    userId, chatSessionId: 'c-host-mode', message: 'plan the change', mode: 'plan', model: 'claude-sonnet-5-5', onEvent: () => {},
    deps: { classifyMode: async () => { throw new Error('an explicit mode must not classify'); }, runTurn: fakeRun([], seen) },
  });
  assert.equal(seen.mode, 'plan');
  assert.equal(seen.model, 'claude-sonnet-5-5');
  assert.equal(seen.permissionMode, null, 'never Bypass');
});

test('startHostTurn: execute, a permission mode or junk never runs as asked; auto stays auto_read_only', async () => {
  const userId = await makeUser();
  for (const mode of ['execute', 'bypass', 'accept-edits', 'auto_read_only', 'nonsense', 'auto', undefined]) {
    const seen = {};
    await v2.startHostTurn({
      userId, chatSessionId: `c-host-${String(mode)}`, message: 'edit the file', mode, onEvent: () => {},
      deps: { classifyMode: async () => ({ mode: 'execute' }), runTurn: fakeRun([], seen) },
    });
    assert.equal(seen.mode, 'ask', `${String(mode)} is clamped to read-only`);
  }
});

test('HOST_TURN_MODES matches the shared compose vector', async () => {
  const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema/host-api/v1/fixtures/security/compose.json'), 'utf8'));
  assert.deepEqual([...v2.HOST_TURN_MODES], vector.modes.allowed);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/agent-v2-host-turn.test.mjs`
Expected: FAIL (`seen.mode` is `ask` for `plan` because the classifier path throws and falls back; `HOST_TURN_MODES` undefined).

- [ ] **Step 3: Implement**

In `extension/routes/agent-v2.mjs` replace the `startHostTurn` doc comment's first sentence and the function head and body line that builds `body`:

```js
/** The modes a Host API client may ask for: `auto` (run as auto_read_only) and the tool-restricted modes. Never execute. */
export const HOST_TURN_MODES = Object.freeze(['auto', 'ask', 'plan', 'assist_plan', 'review', 'document']);

/**
 * Runs one Agent v2 turn in process, exactly as POST /agent/v2/stream would for a read-only client (the Host
 * API gateway): mode auto_read_only unless the client picked one of HOST_TURN_MODES (clamped to read-only again
 * here), the default provider with an optional model id the gateway already checked, the extension chat
 * workspace, no Bypass. Every event the SSE stream would carry goes to `onEvent`. Resolves when the turn ends; a
 * refusal the route answers with 409/503/402 (TURN_IN_PROGRESS, SDK_UPDATING, PLUGIN_UPDATING, SESSION_TOKEN_LIMIT,
 * ROUTE_UNAVAILABLE) rejects with an Error carrying that `code`.
 */
export async function startHostTurn({ userId, chatSessionId, message, files = [], mode = 'auto', model = null, onEvent, deps = {} }) {
  const agentContext = { chatSessionId, workspaceRoot: extensionChatWorkspace(), surface: 'host-api' };
  const hostMode = mode !== 'auto' && HOST_TURN_MODES.includes(mode) ? clampToReadOnly(mode) : AUTO_READ_ONLY;
  const body = { message, mode: hostMode, agentContext, attachments: files, ...(typeof model === 'string' && model ? { model } : {}) };
```

Leave the rest of the function unchanged.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/agent-v2-host-turn.test.mjs`
Expected: PASS (all old tests too: `'ask'` from `classifyMode` for the default path).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/agent-v2.mjs extension/tests/agent-v2-host-turn.test.mjs
git commit -m "feat(server): host turns accept a read-only mode and a model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Desktop: `compose` switch and `chat.options` (~25 min)

**Files:**
- Modify: `extension/routes/host-api/compose.mjs` (add `COMPOSE_MODES`, `optionsOf`, `offersModel`)
- Modify: `extension/routes/host-api/gateway.mjs` (`hostApiCapabilities`; `defaultDeps` gains `models`; `chat.options` case)
- Modify: `extension/routes/host-api/audit.mjs` (`SUCCESS` set)
- Test: `extension/tests/host-api-compose.test.mjs`, `extension/tests/host-api-gateway.test.mjs` (harness options + new tests)

**Interfaces:**
- Consumes: `attachmentsToFiles` (Task 2); the schema from Task 1.
- Produces:
  - `COMPOSE_MODES` (frozen, equal to `HOST_TURN_MODES`), `optionsOf(entries): { modes: string[], models: Array<{ model: string, label?: string }> }`, `offersModel(entries, id): boolean` in `compose.mjs`. `entries` is `listSdkModels`' result: `Array<{ id, displayName, description, effortLevels }>`.
  - Gateway dep `models(userId): Promise<entries>`; private helper `modelsFor(userId)` (never throws; `[]` when the SDK cannot answer).
  - `hostApiCapabilities(env)` adds `compose` when `LLMIDE_HOST_API_COMPOSE === '1'`, after `read`.
  - Audit events `chat_options`, `chat_new`, `compose_send` have outcome `success`.
  - Test harness options `compose`, `models`, and `t.audits` (used by Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/host-api-compose.test.mjs`:

```js
import fs from 'node:fs';
import { COMPOSE_MODES, optionsOf, offersModel } from '../routes/host-api/compose.mjs';
import { auditOutcome } from '../routes/host-api/audit.mjs';

const vector = JSON.parse(fs.readFileSync(new URL('../../schema/host-api/v1/fixtures/security/compose.json', import.meta.url), 'utf8'));

test('COMPOSE_MODES is the shared vector: read-only modes only', () => {
  assert.deepEqual([...COMPOSE_MODES], vector.modes.allowed);
  for (const m of vector.modes.refused) assert.equal(COMPOSE_MODES.includes(m), false, m);
});

test('optionsOf: the SDK list as {model, label}, ids checked, de-duplicated, at most 50', () => {
  const entries = [
    { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', effortLevels: [] },
    { id: 'claude-sonnet-5-5', displayName: 'dup' },
    { id: 'claude-opus-4-9[1m]', displayName: '' },
    ...vector.models.refused.map((id) => ({ id, displayName: 'bad' })),
    ...Array.from({ length: 60 }, (_, i) => ({ id: `claude-x-${i}` })),
  ];
  const r = optionsOf(entries);
  assert.deepEqual(r.modes, vector.modes.allowed);
  assert.deepEqual(r.models.slice(0, 2), [{ model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { model: 'claude-opus-4-9[1m]' }]);
  assert.equal(r.models.length, 50);
  assert.ok(r.models.every((m) => !vector.models.refused.includes(m.model)));
  assert.deepEqual(optionsOf(undefined), { modes: vector.modes.allowed, models: [] });
});

test('offersModel: only an id the list offers', () => {
  const entries = [{ id: 'claude-sonnet-5-5' }];
  assert.equal(offersModel(entries, 'claude-sonnet-5-5'), true);
  assert.equal(offersModel(entries, 'claude-opus-4-9'), false);
  assert.equal(offersModel([], 'claude-sonnet-5-5'), false);
});

test('compose audit events are successes', () => {
  for (const e of ['chat_options', 'chat_new', 'compose_send']) assert.equal(auditOutcome(e), 'success', e);
});
```

In `extension/tests/host-api-gateway.test.mjs` change the harness signature and three lines inside it:

```js
function harness({ toolApprovals = false, chatClear = false, hold = false, skipInit = () => false, history = null, fingerprint = null, read = false, reads = null, compose = false, models = null } = {}) {
  const t = { sent: [], closed: [], turns: [], cancelled: [], decided: [], cleared: [], saved: [], toolApprovals, read, compose, readCalls: [], pending: [], audits: [], modelCalls: 0 };
```

```js
    capabilities: () => ['host', 'chat', 'approvals', ...(t.toolApprovals ? ['tool_approvals'] : []), ...(t.read ? ['read'] : []), ...(t.compose ? ['compose'] : [])],
```

```js
    quickChat: { get: () => quick, set: (_u, id) => { quick = id; }, create: () => `chat-${++made}` },
    models: async () => { t.modelCalls += 1; if (models instanceof Error) throw models; return models ?? [{ id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }]; },
    audit: (event, fields) => t.audits.push([event, fields]),
```

and declare `let made = 0;` next to `let quick = null;` (the first `create()` still returns `'chat-1'`, so existing tests are unchanged).

Append:

```js
test('compose: not served by default — chat.options is capability_unavailable, no model list is asked', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.options', {}));
  assert.equal(t.lastError(), 'capability_unavailable');
  assert.equal(t.modelCalls, 0);
});

test('compose: served and granted — chat.options lists the read-only modes and the SDK models, audited once a minute', async () => {
  const t = harness({ compose: true });
  const s = {};
  await t.paired(s);
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals', 'compose']);
  await t.g.receive(s, req('c-1', 'chat.options', {}));
  assert.deepEqual(t.last().result, { modes: ['auto', 'ask', 'plan', 'assist_plan', 'review', 'document'], models: [{ model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] });
  await t.g.receive(s, req('c-2', 'chat.options', {}));
  const rows = t.audits.filter(([e]) => e === 'chat_options');
  assert.equal(rows.length, 2, 'the sink de-duplicates; the gateway passes a dedupeKey');
  assert.equal(rows[0][1].dedupeKey, rows[0][1].deviceId);
  assert.equal(JSON.stringify(rows).includes('Sonnet'), false, 'no list content in audit');
});

test('compose: an SDK that cannot list models still answers, with no models', async () => {
  const t = harness({ compose: true, models: new Error('not logged in') });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.options', {}));
  assert.deepEqual(t.last().result.models, []);
});

test('compose: chat.options uses the per-device read bucket', async () => {
  const t = harness({ compose: true });
  const s = {};
  await t.paired(s);
  for (let i = 0; i < 20; i += 1) await t.g.receive(s, req(`c-${i}`, 'chat.options', {}));
  await t.g.receive(s, req('c-x', 'chat.options', {}));
  assert.equal(t.lastError(), 'rate_limited');
});

test('hostApiCapabilities: compose only with LLMIDE_HOST_API_COMPOSE=1', async () => {
  const { hostApiCapabilities } = await import('../routes/host-api/gateway.mjs');
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_COMPOSE: '1' }), ['host', 'chat', 'approvals', 'compose']);
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_COMPOSE: '1', LLMIDE_HOST_API_READ: '1' }), ['host', 'chat', 'approvals', 'read', 'compose']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-compose.test.mjs tests/host-api-gateway.test.mjs`
Expected: FAIL (`COMPOSE_MODES` not exported; `chat.options` answers `unknown_command`; `compose` not in capabilities).

- [ ] **Step 3: Implement `compose.mjs` additions**

Append to `extension/routes/host-api/compose.mjs`:

```js
import { clamp } from './frame.mjs';

/** The modes a `compose` client may pick; the same list as HOST_TURN_MODES in routes/agent-v2.mjs (tested equal). */
export const COMPOSE_MODES = Object.freeze(['auto', 'ask', 'plan', 'assist_plan', 'review', 'document']);
const MAX_MODELS = 50;
const MODEL_RE = /^[A-Za-z0-9_.:[\]-]{1,200}$/; // the wire pattern of chat.send.model / chat.options models

/** chat.options from listSdkModels' entries: the account's Claude models, first = the SDK default. */
export function optionsOf(entries) {
  const seen = new Set();
  const models = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const id = e?.id;
    if (typeof id !== 'string' || !MODEL_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = clamp(typeof e.displayName === 'string' ? e.displayName.trim() : '', 200);
    models.push({ model: id, ...(label ? { label } : {}) });
    if (models.length === MAX_MODELS) break;
  }
  return { modes: [...COMPOSE_MODES], models };
}

/** Whether chat.send may run on `id`: only a model chat.options would list right now. */
export const offersModel = (entries, id) => optionsOf(entries).models.some((m) => m.model === id);
```

Move the new `import { clamp } …` line to the top of the file, above `attachmentsToFiles`.

- [ ] **Step 4: Implement the gateway and audit changes**

`audit.mjs`:

```js
const SUCCESS = new Set(['pair_ok', 'revoke_self', 'revoke_host', 'identity_created', 'identity_reset', 'chat_options', 'chat_new', 'compose_send']);
```

`gateway.mjs`, the import becomes:

```js
import { attachmentsToFiles, optionsOf } from './compose.mjs';
```

`hostApiCapabilities`:

```js
export function hostApiCapabilities(env = process.env) {
  return ['host', 'chat', 'approvals',
    ...(env.LLMIDE_HOST_API_TOOL_APPROVALS === '1' ? ['tool_approvals'] : []),
    ...(env.LLMIDE_HOST_API_READ === '1' ? ['read'] : []), // default off: a device gets read only if paired while served
    ...(env.LLMIDE_HOST_API_COMPOSE === '1' ? ['compose'] : [])]; // default off, as read
}
```

In `defaultDeps()`, after the `read: {…},` block:

```js
    // The account's Claude models, in process and cached by the SDK module (never HTTP). Lazy: off the boot path.
    models: async (userId) => (await import('../../llm_agent/sdk/models.mjs')).listSdkModels(userId),
```

Inside `createGateway`, after `async function lines(…) {…}`:

```js
  // The SDK may be logged out or slow to answer: compose then offers the desktop default only, never an error.
  async function modelsFor(userId) {
    try { return await deps.models(userId); } catch (e) { deps.log(`Host API v1 model list unavailable (${e?.code ?? 'error'})`); return []; }
  }
```

Add a case before `default:` in `handle`:

```js
      case 'chat.options': {
        if (readRefused(s, entry, id)) return;
        audit('chat_options', { peer: entry.peer, userId, deviceId: entry.state.deviceId, dedupeKey: entry.state.deviceId });
        return respond(s, id, command, optionsOf(await modelsFor(userId)));
      }
```

- [ ] **Step 5: Run them to verify they pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-compose.test.mjs tests/host-api-gateway.test.mjs tests/host-api-audit-rate.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/host-api/compose.mjs extension/routes/host-api/gateway.mjs extension/routes/host-api/audit.mjs \
  extension/tests/host-api-compose.test.mjs extension/tests/host-api-gateway.test.mjs
git commit -m "feat(host-api): serve chat.options behind the compose switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Desktop: `chat.send` options and `chat.new` (~35 min)

**Files:**
- Modify: `extension/routes/host-api/gateway.mjs` (import `offersModel`; `chat.send` case; `startTurn` passes `mode`/`model`; new `chat.new` case)
- Test: `extension/tests/host-api-gateway.test.mjs`

**Interfaces:**
- Consumes: `offersModel`, `modelsFor`, harness `compose` / `models` / `t.audits` (Task 4); `startHostTurn({ mode, model })` (Task 3) via `deps.turn`.
- Produces: `deps.turn` is called with `{ userId, chatSessionId, message, files, mode, model, onEvent }` where `mode` is the client's (or `'auto'`) and `model` is the client's (or `null`). `chat.new` answers `{ sessionId }` and sets the user's phone chat to it.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/host-api-gateway.test.mjs`:

```js
test('compose send: without compose, a mode or model is refused before any turn (old sends unchanged)', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', mode: 'plan' }));
  assert.equal(t.lastError(), 'capability_unavailable');
  assert.equal(t.turns.length, 0);
  await t.g.receive(s, req('c-2', 'chat.send', { text: 'hi' }));
  await flush();
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].mode, 'auto');
  assert.equal(t.turns[0].model, null);
});

test('compose send: a device paired before compose was served is denied with a re-pair hint and audited', async () => {
  const t = harness();
  await t.paired({ n: 1 });
  const token = t.last().result.token;
  const t2 = harness({ compose: true });
  t2.tokens.set(token, t.tokens.get(token));
  const s2 = { n: 2 };
  t2.g.opened(s2, '127.0.0.1');
  await t2.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t2.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  await t2.g.receive(s2, req('c-1', 'chat.send', { text: 'hi', model: 'claude-sonnet-5-5' }));
  assert.equal(t2.lastError(), 'denied');
  assert.match(t2.last().error.message, /pair again/);
  assert.equal(t2.turns.length, 0);
  assert.equal(t2.audits.at(-1)[0], 'scope_denied');
  assert.equal(t2.audits.at(-1)[1].detail, 'compose');
});

test('compose send: granted — the mode and a listed model reach the turn; the audit has no text', async () => {
  const t = harness({ compose: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'secret plan text', mode: 'plan', model: 'claude-sonnet-5-5', attachments: [{ name: 'a.md', text: 'body' }] }));
  await flush();
  assert.equal(t.turns[0].mode, 'plan');
  assert.equal(t.turns[0].model, 'claude-sonnet-5-5');
  const row = t.audits.find(([e]) => e === 'compose_send');
  assert.equal(row[1].detail, 'mode=plan model=claude-sonnet-5-5 files=1');
  assert.equal(JSON.stringify(t.audits).includes('secret'), false);
  assert.equal(JSON.stringify(t.audits).includes('a.md'), false);
});

test('compose send: a model the desktop does not list is denied, no turn starts', async () => {
  const t = harness({ compose: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', model: 'claude-opus-9' }));
  assert.equal(t.lastError(), 'denied');
  assert.equal(t.turns.length, 0);
});

test('compose send: execute never passes the schema', async () => {
  const t = harness({ compose: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', mode: 'execute' }));
  assert.equal(t.lastError(), 'invalid_payload');
  assert.equal(t.turns.length, 0);
});

test('chat.new: starts a fresh phone chat; the next send goes there; audited', async () => {
  const t = harness({ compose: true, read: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'first' }));
  await flush();
  assert.equal(t.turns[0].chatSessionId, 'chat-1');
  await t.g.receive(s, req('c-1', 'chat.new', {}));
  assert.deepEqual(t.last().result, { sessionId: 'chat-2' });
  assert.equal(t.audits.at(-1)[0], 'chat_new');
  await t.g.receive(s, req('c-2', 'chat.send', { text: 'second' }));
  await flush();
  assert.equal(t.turns[1].chatSessionId, 'chat-2');
});

test('chat.new: refused busy while a turn of this user runs', async () => {
  const t = harness({ compose: true, hold: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'long' }));
  await flush();
  await t.g.receive(s, req('c-1', 'chat.new', {}));
  assert.equal(t.lastError(), 'busy');
  assert.equal(t.last().error.retryable, true);
});

test('chat.new: not served without compose', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.new', {}));
  assert.equal(t.lastError(), 'capability_unavailable');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-gateway.test.mjs`
Expected: FAIL (a `mode` on a non-compose session starts a turn; `t.turns[0].mode` is `undefined`; `chat.new` is `unknown_command`).

- [ ] **Step 3: Implement**

Import:

```js
import { attachmentsToFiles, optionsOf, offersModel } from './compose.mjs';
```

In `startTurn`, the turn call becomes:

```js
      .then(() => deps.turn({ userId: o.userId, chatSessionId, message: p.text, files: attachmentsToFiles(p.attachments), mode: p.mode ?? 'auto', model: p.model ?? null, onEvent }))
```

Add a helper inside `createGateway`, after `modelsFor`:

```js
  // A chat.send that picks a mode or model needs `compose` (served ∩ granted), like a command of that capability.
  // Returns true when it refused (the frame is answered).
  function composeRefused(s, entry, id) {
    if (entry.grants?.has('compose') && deps.capabilities().includes('compose')) return false;
    if (!deps.capabilities().includes('compose')) {
      fail(s, id, 'capability_unavailable', 'This computer does not serve compose right now.');
      return true;
    }
    const { userId: u, deviceId: d } = entry.state;
    audit('scope_denied', { peer: entry.peer, userId: u, deviceId: d, detail: 'compose', dedupeKey: `${d}:compose` });
    fail(s, id, 'denied', 'This device was not granted compose — pair again to grant it.');
    return true;
  }
```

The `chat.send` case becomes:

```js
      case 'chat.send': {
        const picks = p.mode !== undefined || p.model !== undefined;
        if (picks && composeRefused(s, entry, id)) return;
        const wait = rate.turn(entry.state.deviceId, deps.now());
        if (wait != null) return rateRefused(s, entry, id, wait);
        if (owned.has(internalId(entry.num, id))) return fail(s, id, 'busy', 'That request id is still running.');
        if ([...owned.values()].some((o) => o.session === s)) return fail(s, id, 'busy', 'A chat turn is already running on this connection.');
        if (p.model !== undefined && !offersModel(await modelsFor(userId), p.model)) {
          return fail(s, id, 'denied', 'That model is not offered on this computer — pick another.');
        }
        if (picks) {
          const deviceId = entry.state.deviceId;
          audit('compose_send', { peer: entry.peer, userId, deviceId, detail: `mode=${p.mode ?? 'auto'} model=${p.model ?? 'default'} files=${p.attachments?.length ?? 0}`,
            dedupeKey: `${deviceId}:${p.mode ?? 'auto'}:${p.model ?? ''}` });
        }
        const chatSessionId = await quickChatFor(userId);
        if (sessions.get(s) !== entry) return;
        return startTurn(s, entry, id, p, chatSessionId);
      }
```

Add a case before `default:`:

```js
      case 'chat.new': {
        const wait = rate.turn(entry.state.deviceId, deps.now()); // a write: the turn bucket, not the read one
        if (wait != null) return rateRefused(s, entry, id, wait);
        if ([...owned.values()].some((o) => o.userId === userId)) return fail(s, id, 'busy', 'A chat turn is running — try again when it ends.', { retryable: true });
        await creatingQuickChat.get(userId); // a first phone chat being created right now is replaced, not raced
        const sessionId = await deps.quickChat.create(userId);
        deps.quickChat.set(userId, sessionId);
        audit('chat_new', { peer: entry.peer, userId, deviceId: entry.state.deviceId });
        return respond(s, id, command, { sessionId });
      }
```

Update the file's first comment line: replace "the 15 commands (chat, approvals, and the `read` slice)" with "the 17 commands (chat, approvals, the `read` slice and `compose`)".

- [ ] **Step 4: Run the Host API suites**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-*.test.mjs tests/agent-v2-host-turn.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/host-api/gateway.mjs extension/tests/host-api-gateway.test.mjs
git commit -m "feat(host-api): bounded mode and model on chat.send, and chat.new

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web: read a browser file as a bounded text attachment (~20 min)

**Files:**
- Create: `web/src/chat/attachments.ts`
- Test: `web/tests/attachments.test.mjs`

**Interfaces:**
- Produces (from `web/src/chat/attachments.ts`):
  - `ATTACH_LIMITS = { maxFiles: 10, maxNameChars: 300, maxCharsPerFile: 80_000, maxCharsTotal: 200_000, maxFileBytes: 26_214_400 }`
  - `interface FileLike { name: string; type: string; size: number; slice(start?: number, end?: number): { text(): Promise<string> } }`
  - `interface WebAttachment { name: string; text: string; truncated: boolean }`
  - `type AttachResult = { ok: true; attachment: WebAttachment } | { ok: false; reason: string }`
  - `cleanName(name: string): string`
  - `readTextAttachment(file: FileLike, usedChars: number): Promise<AttachResult>`
  - `ACCEPT: string` (the file input's `accept`)

- [ ] **Step 1: Write the failing tests**

Create `web/tests/attachments.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ATTACH_LIMITS, cleanName, readTextAttachment } from "../src/chat/attachments.ts";
import * as core from "../../ui/screens/chat/attach/limits.ts";

const vector = JSON.parse(readFileSync(new URL("../../schema/host-api/v1/fixtures/security/compose.json", import.meta.url), "utf8"));
const file = (text, name = "notes.md", type = "text/markdown") => new File([text], name, { type });

test("limits are the shared vector's and the core's", () => {
  assert.equal(ATTACH_LIMITS.maxFiles, vector.attachments.maxFiles);
  assert.equal(ATTACH_LIMITS.maxNameChars, vector.attachments.maxNameChars);
  assert.equal(ATTACH_LIMITS.maxCharsPerFile, vector.attachments.maxCharsPerFile);
  assert.equal(ATTACH_LIMITS.maxCharsTotal, vector.attachments.maxCharsTotal);
  assert.equal(ATTACH_LIMITS.maxCharsPerFile, core.MAX_TEXT_CHARS_PER_FILE);
  assert.equal(ATTACH_LIMITS.maxCharsTotal, core.MAX_TEXT_CHARS_TOTAL);
  assert.equal(ATTACH_LIMITS.maxFileBytes, core.HOST_FILE_MAX_BYTES);
});

test("a text file becomes {name, text}; the name is a bare file name", async () => {
  const r = await readTextAttachment(file("hello"), 0);
  assert.deepEqual(r, { ok: true, attachment: { name: "notes.md", text: "hello", truncated: false } });
  assert.equal(cleanName("C:\\Users\\me\\secret\\plan.txt"), "plan.txt");
  assert.equal(cleanName("/home/me/.ssh/id_rsa"), "id_rsa");
  assert.equal(cleanName("a\u0000b\nc.md"), "abc.md");
  assert.equal(cleanName(""), "file.txt");
  assert.equal(cleanName("x".repeat(400)).length, 300);
});

test("a long file is cut to the per-file cap and to what is left of the total", async () => {
  const big = await readTextAttachment(file("a".repeat(90_000)), 0);
  assert.equal(big.attachment.text.length, 80_000);
  assert.equal(big.attachment.truncated, true);
  const rest = await readTextAttachment(file("b".repeat(50_000)), 180_000);
  assert.equal(rest.attachment.text.length, 20_000);
  assert.equal(rest.attachment.truncated, true);
  const full = await readTextAttachment(file("c"), 200_000);
  assert.equal(full.ok, false);
  assert.match(full.reason, /200,000/);
});

test("images, binaries and non-text types are refused with a reason", async () => {
  assert.equal(vector.attachments.imagesAllowed, false);
  const img = await readTextAttachment(file("x", "a.png", "image/png"), 0);
  assert.equal(img.ok, false);
  assert.match(img.reason, /images/i);
  const pdf = await readTextAttachment(file("x", "a.pdf", "application/pdf"), 0);
  assert.equal(pdf.ok, false);
  const bin = await readTextAttachment(file("ab\u0000cd", "a.dat", ""), 0);
  assert.equal(bin.ok, false);
  assert.match(bin.reason, /binary/);
  const json = await readTextAttachment(file("{}", "a.json", "application/json"), 0);
  assert.equal(json.ok, true);
});

test("a file over 25 MB is refused without reading it", async () => {
  let read = false;
  const huge = { name: "big.log", type: "text/plain", size: ATTACH_LIMITS.maxFileBytes + 1, slice: () => ({ text: async () => { read = true; return ""; } }) };
  const r = await readTextAttachment(huge, 0);
  assert.equal(r.ok, false);
  assert.equal(read, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/attachments.test.mjs`
Expected: FAIL (`Cannot find module '../src/chat/attachments.ts'`).

- [ ] **Step 3: Implement**

Create `web/src/chat/attachments.ts`:

```ts
// Text-file attachments for chat.send, read in the browser. Only the file's own name (never a path) and its text go
// on the wire. Limits are the core's (extension/core/prompt-framing.mjs selectAttachments, mirrored in
// ui/screens/chat/attach/limits.ts) and the v1 schema's; schema/host-api/v1/fixtures/security/compose.json pins them.
export const ATTACH_LIMITS = Object.freeze({
  maxFiles: 10, maxNameChars: 300, maxCharsPerFile: 80_000, maxCharsTotal: 200_000, maxFileBytes: 25 * 1024 * 1024,
});
/** Bytes read from a file: enough for maxCharsPerFile characters even at 4 bytes each; the rest is never read. */
const READ_BYTES = ATTACH_LIMITS.maxCharsPerFile * 4;
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml",
  "application/javascript", "application/typescript", "application/x-sh", "application/sql",
]);
export const ACCEPT = "text/*,.md,.txt,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.js,.ts,.tsx,.py,.swift,.rs,.go,.java,.sh,.sql";

export interface FileLike { name: string; type: string; size: number; slice(start?: number, end?: number): { text(): Promise<string> } }
export interface WebAttachment { name: string; text: string; truncated: boolean }
export type AttachResult = { ok: true; attachment: WebAttachment } | { ok: false; reason: string };

/** The last path segment without control characters, clamped; browsers give a bare name already, this makes sure. */
export function cleanName(name: string): string {
  const base = (String(name).split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(0, ATTACH_LIMITS.maxNameChars) || "file.txt";
}

export async function readTextAttachment(f: FileLike, usedChars: number): Promise<AttachResult> {
  const name = cleanName(f.name);
  const type = typeof f.type === "string" ? f.type.toLowerCase() : "";
  if (type.startsWith("image/")) return { ok: false, reason: `${name}: images can't be sent from the web yet. Attach text files.` };
  if (type && !type.startsWith("text/") && !TEXT_TYPES.has(type)) return { ok: false, reason: `${name}: only text files can be attached.` };
  if (f.size > ATTACH_LIMITS.maxFileBytes) return { ok: false, reason: `${name}: larger than 25 MB.` };
  const room = ATTACH_LIMITS.maxCharsTotal - usedChars;
  if (room <= 0) return { ok: false, reason: "This message is at the 200,000-character limit for attachments." };
  const raw = await f.slice(0, READ_BYTES).text();
  if (raw.includes("\u0000")) return { ok: false, reason: `${name}: looks like a binary file, not text.` };
  const text = raw.slice(0, Math.min(ATTACH_LIMITS.maxCharsPerFile, room));
  return { ok: true, attachment: { name, text, truncated: text.length < raw.length || f.size > READ_BYTES } };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/attachments.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add web/src/chat/attachments.ts web/tests/attachments.test.mjs
git commit -m "feat(web): bounded text-file attachments for chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web: compose controller, send options, New chat, usage refresh (~30 min)

**Files:**
- Create: `web/src/chat/compose.ts`
- Modify: `web/src/chat/controller.ts` (`send`, add `newChat`)
- Modify: `web/src/read/controller.ts` (usage after `chat.done`)
- Test: `web/tests/compose-controller.test.mjs` (create), `web/tests/chat-controller.test.mjs`, `web/tests/read-controller.test.mjs`

**Interfaces:**
- Consumes: `readTextAttachment`, `ATTACH_LIMITS`, `FileLike`, `WebAttachment` (Task 6); generated `HostApiRequest<"chat.send">`, `HostApiResult<"chat.options">` (Task 1).
- Produces:
  - `createComposeController(link: HostLink)` → `{ getState(): ComposeState; subscribe(fn): () => void; load(): Promise<void>; setMode(m: string): void; setModel(id: string): void; addFiles(files: Iterable<FileLike>): Promise<void>; remove(index: number): void; extras(): SendExtras; clearAttachments(): void; dispose(): void }`, type `ComposeController`.
  - `interface ComposeState { modes: readonly ComposeMode[]; models: ComposeModels; mode: ComposeMode; model: string | null; attachments: readonly WebAttachment[]; error: string | null }`, `initialComposeState`, `type SendExtras = Omit<HostApiRequest<"chat.send">, "text">`.
  - `ChatController.send(text: string, extra?: SendExtras): Promise<boolean>` (true = accepted); `ChatController.newChat(): Promise<boolean>`.
  - The read controller sends `usage.get` after each `chat.done` when `read` is held.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/compose-controller.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposeController, initialComposeState } from "../src/chat/compose.ts";

function fakeLink(results = {}, caps = ["host", "chat", "compose"]) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() };
  const calls = [];
  return {
    capabilities: new Set(caps), calls,
    send(command, payload) {
      calls.push({ command, payload });
      const r = results[command];
      return { id: `c-${calls.length}`, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? {}) };
    },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)),
    onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)),
    resync: () => ls.resync.forEach((fn) => fn()),
  };
}
const OPTIONS = { modes: ["auto", "ask", "plan"], models: [{ model: "claude-sonnet-5-5", label: "Sonnet 5.5" }] };
const file = (text, name = "a.md") => new File([text], name, { type: "text/markdown" });

test("without compose: no chat.options, no mode or model in extras, attachments still allowed", async () => {
  const link = fakeLink({}, ["host", "chat"]);
  const c = createComposeController(link);
  await c.load();
  assert.equal(link.calls.length, 0);
  c.setMode("plan");
  c.setModel("claude-sonnet-5-5");
  await c.addFiles([file("x")]);
  assert.deepEqual(c.extras(), { attachments: [{ name: "a.md", text: "x" }] });
});

test("with compose: options load on resync; only offered modes and models can be picked", async () => {
  const link = fakeLink({ "chat.options": OPTIONS });
  const c = createComposeController(link);
  link.resync();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(c.getState().modes, ["auto", "ask", "plan"]);
  c.setMode("execute");
  assert.equal(c.getState().mode, "auto");
  c.setMode("plan");
  c.setModel("claude-opus-9");
  assert.equal(c.getState().model, null);
  c.setModel("claude-sonnet-5-5");
  assert.deepEqual(c.extras(), { mode: "plan", model: "claude-sonnet-5-5" });
  c.setMode("auto");
  c.setModel("");
  assert.deepEqual(c.extras(), {});
});

test("attachments: capped at 10, refused files show a reason, remove and clear work", async () => {
  const c = createComposeController(fakeLink({ "chat.options": OPTIONS }));
  await c.addFiles(Array.from({ length: 12 }, (_, i) => file(`t${i}`, `f${i}.md`)));
  assert.equal(c.getState().attachments.length, 10);
  assert.match(c.getState().error, /10 files/);
  await c.addFiles([new File(["x"], "a.png", { type: "image/png" })]);
  assert.match(c.getState().error, /images/);
  c.remove(0);
  assert.equal(c.getState().attachments[0].name, "f1.md");
  c.clearAttachments();
  assert.deepEqual(c.getState().attachments, []);
  assert.equal(c.getState().error, null);
});

test("an options error is shown and the picks fall back to the defaults", async () => {
  const c = createComposeController(fakeLink({ "chat.options": new Error("This device was not granted compose — pair again to grant it.") }));
  await c.load();
  assert.match(c.getState().error, /pair again/);
  assert.equal(c.getState().mode, initialComposeState.mode);
});
```

Append to `web/tests/chat-controller.test.mjs`:

```js
test("send carries compose extras and reports whether the host accepted it", async () => {
  const link = fakeLink({ "chat.send": { accepted: true } });
  const chat = createChatController(link);
  const ok = await chat.send("hi", { mode: "plan", attachments: [{ name: "a.md", text: "x" }] });
  assert.equal(ok, true);
  assert.deepEqual(link.calls[0].payload, { text: "hi", mode: "plan", attachments: [{ name: "a.md", text: "x" }] });
  const refused = createChatController(fakeLink({ "chat.send": new Error("That model is not offered on this computer — pick another.") }));
  assert.equal(await refused.send("hi", { model: "x" }), false);
});

test("newChat starts a fresh phone chat and empties the view; refused during a turn", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "chat.new": { sessionId: "chat-2" }, "chat.snapshot": { messages: [] } });
  const chat = createChatController(link);
  await chat.send("hi");
  assert.equal(await chat.newChat(), false, "a turn is running");
  link.emit({ command: "chat.done", payload: { requestId: "c-1" }, rev: 1, replyTo: "c-1" });
  assert.equal(await chat.newChat(), true);
  assert.equal(link.calls.at(-1).command, "chat.new");
  assert.deepEqual(chat.getState().messages, []);
});
```

In `web/tests/read-controller.test.mjs`, in `fakeLink` add `emit: (e) => ls.event.forEach((fn) => fn(e)),` after the `resync` line, and append:

```js
test("a finished reply refreshes the usage strip", async () => {
  const link = fakeLink({ "usage.get": { providers: [{ provider: "anthropic", status: "ok", models: [] }] } });
  const r = createReadController(link);
  link.emit({ command: "chat.done", payload: { requestId: "c-1" }, rev: 1, replyTo: "c-1" });
  await tick();
  assert.deepEqual(link.calls, [{ command: "usage.get", payload: {} }]);
  assert.equal(r.getState().usage[0].provider, "anthropic");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/compose-controller.test.mjs tests/chat-controller.test.mjs tests/read-controller.test.mjs`
Expected: FAIL (`compose.ts` missing; `send` resolves `undefined`; `newChat` is not a function; no `usage.get` after `chat.done`).

- [ ] **Step 3: Implement `compose.ts`**

Create `web/src/chat/compose.ts`:

```ts
// The web chat's turn options over Host API v1 `compose`: the mode and model the desktop offers, plus text
// attachments (capability chat). No React here. The host re-checks every pick; this only keeps the UI honest.
import type { HostLink } from "../host-api/connection.ts";
import type { HostApiRequest, HostApiResult } from "../host-api/types.generated.ts";
import { ATTACH_LIMITS, readTextAttachment, type FileLike, type WebAttachment } from "./attachments.ts";

type Options = HostApiResult<"chat.options">;
export type ComposeMode = Options["modes"][number];
export type ComposeModels = Options["models"];
export type SendExtras = Omit<HostApiRequest<"chat.send">, "text">;
export interface ComposeState {
  modes: readonly ComposeMode[]; models: ComposeModels; mode: ComposeMode; model: string | null;
  attachments: readonly WebAttachment[]; error: string | null;
}
export const initialComposeState: ComposeState = { modes: [], models: [], mode: "auto", model: null, attachments: [], error: null };
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createComposeController(link: HostLink) {
  let state = initialComposeState;
  const subs = new Set<() => void>();
  const set = (p: Partial<ComposeState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };
  const can = () => link.capabilities.has("compose");

  const load = async () => {
    if (!can()) return set({ modes: [], models: [], mode: "auto", model: null });
    try {
      const r = await link.send("chat.options", {}).done;
      set({
        modes: r.modes, models: r.models, error: null,
        mode: r.modes.includes(state.mode) ? state.mode : "auto",
        model: state.model && r.models.some((m) => m.model === state.model) ? state.model : null,
      });
    } catch (e) { set({ modes: [], models: [], mode: "auto", model: null, error: messageOf(e) }); }
  };
  const offs = [
    link.onResync(() => { void load(); }),
    link.onEvent((e) => { if (e.command === "host.capabilities") void load(); }),
  ];

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    load,
    setMode(m: string) { const hit = state.modes.find((x) => x === m); if (hit) set({ mode: hit }); },
    setModel(id: string) { set({ model: id && state.models.some((m) => m.model === id) ? id : null }); },
    async addFiles(files: Iterable<FileLike>) {
      let list = [...state.attachments];
      let error: string | null = null;
      for (const f of files) {
        if (list.length >= ATTACH_LIMITS.maxFiles) { error = "At most 10 files per message."; break; }
        const used = list.reduce((n, a) => n + a.text.length, 0);
        const r = await readTextAttachment(f, used);
        if (r.ok) list = [...list, r.attachment]; else error = r.reason;
      }
      set({ attachments: list, error });
    },
    remove(index: number) { set({ attachments: state.attachments.filter((_, i) => i !== index), error: null }); },
    /** What chat.send carries beside the text. Mode and model only with compose, and only when not the default. */
    extras(): SendExtras {
      return {
        ...(can() && state.mode !== "auto" ? { mode: state.mode } : {}),
        ...(can() && state.model ? { model: state.model } : {}),
        ...(state.attachments.length ? { attachments: state.attachments.map(({ name, text }) => ({ name, text })) } : {}),
      };
    },
    clearAttachments() { set({ attachments: [], error: null }); },
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}

export type ComposeController = ReturnType<typeof createComposeController>;
```

- [ ] **Step 4: Implement the chat and read controller changes**

In `web/src/chat/controller.ts` add the import

```ts
import type { SendExtras } from "./compose.ts";
```

and replace `send` with:

```ts
    async send(text: string, extra: SendExtras = {}): Promise<boolean> {
      const t = text.trim();
      if (!t || state.turn) return false;
      if (t.length > MAX_SEND_CHARS) { dispatch({ type: "notice", text: "Keep a message under 100,000 characters." }); return false; }
      const { id, done } = link.send("chat.send", { text: t, ...extra });
      dispatch({ type: "sent", commandId: id, text: t });
      try {
        const r = await done;
        if (r.accepted) return true;
        dispatch({ type: "sendFailed", commandId: id, message: "The host did not accept the message." });
      } catch (e) {
        dispatch({ type: "sendFailed", commandId: id, message: messageOf(e) });
      }
      return false;
    },
    /** A fresh phone chat (capability compose); the old one stays readable in the chat list. */
    async newChat(): Promise<boolean> {
      if (state.turn) return false;
      try { await link.send("chat.new", {}).done; dispatch({ type: "cleared" }); return true; }
      catch (e) { dispatch({ type: "notice", text: messageOf(e) }); return false; }
    },
```

In `web/src/read/controller.ts` replace

```ts
  const offs = [link.onResync(() => { void refresh(); })];
```

with

```ts
  const offs = [
    link.onResync(() => { void refresh(); }),
    // A finished reply changed the counters: refresh the usage strip only (one read from the 20-read bucket).
    link.onEvent((e) => { if (e.command === "chat.done") void run(() => link.send("usage.get", {}).done, (r) => ({ usage: r.providers })); }),
  ];
```

- [ ] **Step 5: Run them to verify they pass**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/compose-controller.test.mjs tests/chat-controller.test.mjs tests/read-controller.test.mjs && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add web/src/chat/compose.ts web/src/chat/controller.ts web/src/read/controller.ts \
  web/tests/compose-controller.test.mjs web/tests/chat-controller.test.mjs web/tests/read-controller.test.mjs
git commit -m "feat(web): compose controller, send options, new chat and usage refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web: ComposeBar, New chat and wiring (~35 min)

**Files:**
- Create: `web/src/screens/ComposeBar.tsx`
- Modify: `web/src/screens/WebChat.tsx` (props `compose?`, `onNewChat?`; header button; slot before `Composer`)
- Modify: `web/src/screens/ToolApprovalCard.tsx` (one note line)
- Modify: `web/src/app-model.ts` (`Session.compose`), `web/src/App.tsx` (`Chat` only), `web/src/web.css` (append), `web/tests/ui-entry.ts` (append)
- Test: `web/tests/screens.test.mjs`

**Interfaces:**
- Consumes: `ComposeController`, `ComposeState`, `initialComposeState` (Task 7); `ACCEPT`, `ATTACH_LIMITS` (Task 6); `ChatController.send(text, extra)`, `.newChat()` (Task 7); `MODES` from `@llmide/screens/chat/route.ts` (labels only).
- Produces: `ComposeBar(props: ComposeBarProps)` with `ComposeBarProps { state: ComposeState; canChoose: boolean; disabled: boolean; onMode(m: string): void; onModel(id: string): void; onFiles(files: FileList | null): void; onRemove(i: number): void }`; `WebChatProps.compose?: ReactNode`, `WebChatProps.onNewChat?: () => void`; `Session.compose: ComposeController`.

- [ ] **Step 1: Write the failing screen tests**

Append to `web/tests/screens.test.mjs`:

```js
const composeProps = (state, extra = {}) => ({ state: { ...UI.initialComposeState, ...state }, canChoose: true, disabled: false,
  onMode: noop, onModel: noop, onFiles: noop, onRemove: noop, ...extra });

test("compose bar: labelled mode and model selects with only offered options; never Execute or Bypass", () => {
  const out = html(h(UI.ComposeBar, composeProps({ modes: ["auto", "ask", "plan"], models: [{ model: "claude-sonnet-5-5", label: "Sonnet 5.5" }] })));
  assert.match(out, /aria-label="Mode"/);
  assert.match(out, /aria-label="Model"/);
  assert.match(out, />Plan</);
  assert.match(out, />Sonnet 5.5</);
  assert.match(out, />Desktop default</);
  assert.doesNotMatch(out, /Execute|Bypass/);
  assert.match(out, /read-only on the desktop/);
});

test("compose bar: without compose only the attach input shows; chips have labelled remove buttons", () => {
  const out = html(h(UI.ComposeBar, composeProps({ attachments: [{ name: "<b>a.md</b>", text: "xyz", truncated: true }] }, { canChoose: false })));
  assert.doesNotMatch(out, /aria-label="Mode"/);
  assert.match(out, /type="file"/);
  assert.match(out, /Attach text files/);
  assert.match(out, /aria-label="Remove &lt;b&gt;a.md&lt;\/b&gt;"/);
  assert.match(out, /cut to the limit/);
});

test("web chat: New chat only when offered, disabled during a turn; the compose slot renders", () => {
  const idle = UI.initialChatState;
  assert.doesNotMatch(html(h(UI.WebChat, chatProps(idle))), /New chat/);
  const out = html(h(UI.WebChat, chatProps(idle, { onNewChat: noop, compose: h("p", null, "COMPOSE-SLOT") })));
  assert.match(out, /New chat/);
  assert.match(out, /COMPOSE-SLOT/);
  const busy = [{ type: "sent", commandId: "c-1", text: "hi" }].reduce(UI.reduce, UI.initialChatState);
  assert.match(html(h(UI.WebChat, chatProps(busy, { onNewChat: noop }))), /<button[^>]*disabled=""[^>]*>New chat/);
});

test("tool approval card says where saved rules live, still offers no saved rule", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "hi" },
    ev("toolApproval.request", { requestId: "r-1", commandId: "c-1", toolName: "Edit", summary: "edit a.txt", truncated: false })].reduce(UI.reduce, UI.initialChatState);
  const out = html(h(UI.WebChat, chatProps(s, { capabilities: caps("chat", "approvals", "tool_approvals") })));
  assert.match(out, /made and revoked on the desktop/);
  assert.doesNotMatch(out, /[Aa]lways/);
});
```

Append to `web/tests/ui-entry.ts`:

```ts
export { ComposeBar } from "../src/screens/ComposeBar.tsx";
export { initialComposeState } from "../src/chat/compose.ts";
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/screens.test.mjs`
Expected: FAIL (the build cannot resolve `ComposeBar.tsx`).

- [ ] **Step 3: Implement `ComposeBar.tsx`**

Create `web/src/screens/ComposeBar.tsx`:

```tsx
// Turn options beside the composer: mode and model (Host API v1 `compose`) and text attachments (capability chat).
// Native controls with visible labels, so keyboard and VoiceOver work as they do on the desktop pickers.
import { MODES } from "@llmide/screens/chat/route.ts";
import type { ComposeState } from "../chat/compose.ts";
import { ACCEPT, ATTACH_LIMITS } from "../chat/attachments.ts";

export interface ComposeBarProps {
  state: ComposeState;
  /** The session holds `compose`: show the mode and model pickers. */
  canChoose: boolean;
  disabled: boolean;
  onMode: (m: string) => void;
  onModel: (id: string) => void;
  onFiles: (files: FileList | null) => void;
  onRemove: (i: number) => void;
}

const modeLabel = (id: string) => MODES.find((m) => m.id === id)?.label ?? id;

export function ComposeBar(p: ComposeBarProps) {
  const s = p.state;
  const full = s.attachments.length >= ATTACH_LIMITS.maxFiles;
  return (
    <div className="web-compose" role="group" aria-label="Message options">
      {p.canChoose && s.modes.length > 0 && (
        <label className="chat-pick">
          <span className="chat-pick-label">Mode</span>
          <select aria-label="Mode" value={s.mode} disabled={p.disabled} onChange={(e) => p.onMode(e.target.value)}>
            {s.modes.map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}
          </select>
        </label>
      )}
      {p.canChoose && (
        <label className="chat-pick">
          <span className="chat-pick-label">Model</span>
          <select aria-label="Model" value={s.model ?? ""} disabled={p.disabled} onChange={(e) => p.onModel(e.target.value)}>
            <option value="">Desktop default</option>
            {s.models.map((m) => <option key={m.model} value={m.model}>{m.label ?? m.model}</option>)}
          </select>
        </label>
      )}
      <label className="web-attach">
        Attach text files
        <input type="file" multiple accept={ACCEPT} disabled={p.disabled || full}
          onChange={(e) => { p.onFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
      </label>
      {s.attachments.length > 0 && (
        <ul className="chat-chip-row" aria-label="Attachments">
          {s.attachments.map((a, i) => (
            <li key={`${i}-${a.name}`} className="chat-chip">
              <span className="chat-chip-name">{a.name}</span>
              <span className="chat-muted">{a.text.length.toLocaleString("en-US")} chars{a.truncated ? ", cut to the limit" : ""}</span>
              <button type="button" className="chat-chip-x" aria-label={`Remove ${a.name}`} onClick={() => p.onRemove(i)}>{"×"}</button>
            </li>
          ))}
        </ul>
      )}
      {s.error && <p role="alert" className="web-error">{s.error}</p>}
      {p.canChoose && <p className="chat-muted">Runs read-only on the desktop: no file edits or commands from the web.</p>}
    </div>
  );
}
```

- [ ] **Step 4: WebChat, ToolApprovalCard, App wiring, CSS**

`WebChat.tsx`: change the React import to `import { useRef, useState, type ReactNode } from "react";`, add to `WebChatProps`:

```ts
  /** Turn options rendered above the composer (ComposeBar); absent = none. */
  compose?: ReactNode;
  /** Start a fresh phone chat (capability compose); absent = no button. */
  onNewChat?: () => void;
```

In the header, before the `Clear history` button:

```tsx
        {p.onNewChat && (
          <button type="button" onClick={p.onNewChat} disabled={disabledReason !== null || state.turn !== null}
            title={disabledReason ?? (state.turn ? "Wait for the reply to finish" : "Start a new phone chat; this one stays in the chat list")}>New chat</button>
        )}
```

and right before `<Composer …/>`:

```tsx
      {p.compose}
```

`ToolApprovalCard.tsx`, after the `web-actions` div:

```tsx
      <p className="chat-muted">Rules that skip this question are made and revoked on the desktop (Settings, Tool permissions).</p>
```

`app-model.ts`: add `import { createComposeController, type ComposeController } from "./chat/compose.ts";`, extend the interface to `export interface Session { url: string; tokens: TokenStore; connection: HostConnection; controller: ChatController; read: ReadController; compose: ComposeController }`, in `open` return `{ url, tokens, connection, controller: createChatController(connection), read: createReadController(connection), compose: createComposeController(connection) }`, and in `shut` add `s.compose.dispose();` before `s.connection.close();`.

`App.tsx`: add `import { ComposeBar } from "./screens/ComposeBar.tsx";` and replace the `Chat` function (only this function) with:

```tsx
function Chat({ session, conn, onForget }: { session: Session; conn: ConnectionState; onForget: () => void }) {
  const { connection: c, controller, read, compose } = session;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const readState = useSyncExternalStore(read.subscribe, read.getState, read.getState);
  const cs = useSyncExternalStore(compose.subscribe, compose.getState, compose.getState);
  const capabilities = state.capabilities ?? c.capabilities;
  const canCompose = capabilities.has("compose");
  const send = (t: string) => void controller.send(t, compose.extras()).then((ok) => { if (ok) compose.clearAttachments(); });
  const newChat = () => void controller.newChat().then((ok) => { if (ok) void read.refresh(); });
  return (
    <div className="web-shell">
      <ReadPanel capabilities={capabilities} state={readState} onOpen={(id, t) => void read.open(id, t)}
        onOlder={() => void read.older()} onClose={read.close} onMore={() => void read.moreSessions()} />
      {!readState.open && (
        <WebChat hostName={c.hello?.hostName ?? "Host"} connection={conn} capabilities={capabilities} state={state}
          onSend={send} onStop={() => void controller.cancel()} onClear={() => void controller.clearHistory()}
          onForget={onForget} onAnswer={(r, a) => void controller.answerQuestion(r, a)} onDecline={(r) => void controller.declineQuestion(r)}
          onTool={(r, d) => void controller.answerTool(r, d)} onNewChat={canCompose ? newChat : undefined}
          compose={capabilities.has("chat") ? (
            <ComposeBar state={cs} canChoose={canCompose} disabled={conn.kind !== "ready" || state.turn !== null}
              onMode={compose.setMode} onModel={compose.setModel} onRemove={compose.remove}
              onFiles={(f) => { if (f) void compose.addFiles(Array.from(f)); }} />
          ) : null} />
      )}
    </div>
  );
}
```

Append to `web/src/web.css`:

```css
.web-compose { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; min-width: 0; }
.web-compose .chat-chip-row { flex-basis: 100%; }
.web-attach { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; }
.web-attach input[type="file"] { max-width: 100%; }
.web-attach input[type="file"]:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
```

- [ ] **Step 5: Run the web suite and the type check**

Run: `cd /Users/dinsmallade/llm-ide/web && npm test && npx tsc --noEmit -p .`
Expected: PASS. If a test builds a `Session` literal by hand, add `compose: createComposeController(link)` there (`tests/app.test.mjs` builds sessions through `createAppModel`, so it picks `compose` up automatically).

- [ ] **Step 6: Phone-width and screen-reader check (manual, 5 min)**

Run `cd /Users/dinsmallade/llm-ide/extension && LLMIDE_HOST_API_DEV=1 LLMIDE_HOST_API_READ=1 LLMIDE_HOST_API_COMPOSE=1 LLMIDE_HOST_API_WEB_ORIGINS=http://127.0.0.1:5173 npm run server` and `cd web && npm run dev`, pair a fresh browser, then at 320 px width: Mode, Model and Attach wrap without horizontal scroll; Tab reaches Mode → Model → Attach → each chip's Remove → the message box; VoiceOver reads "Mode, Auto, pop-up button" and "Attach text files". Send a Plan turn with a `.md` attached and confirm the reply mentions the file; press New chat and confirm the old chat appears in Chats as openable read-only.

- [ ] **Step 7: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add web/src/screens/ComposeBar.tsx web/src/screens/WebChat.tsx web/src/screens/ToolApprovalCard.tsx web/src/app-model.ts \
  web/src/App.tsx web/src/web.css web/tests/ui-entry.ts web/tests/screens.test.mjs
git commit -m "feat(web): mode and model pickers, attachments and new chat in the web chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, master plan and full gates (~15 min)

**Files:**
- Modify: `schema/host-api/v1/README.md` ("Host differences")
- Modify: `extension/CLAUDE.md` ("Host API v1 (desktop)" section only)
- Modify: `docs/superpowers/MASTER-PLAN.md` (line 431 only)

**Interfaces:**
- Consumes: everything above. Produces: docs only.

- [ ] **Step 1: README "Host differences"**

Add a bullet after "**Reads.**":

```markdown
- **Compose.** Only the desktop serves `compose` (`chat.options`, `chat.new`, and `mode` / `model` on `chat.send`), with `LLMIDE_HOST_API_COMPOSE=1`; models come from the account's Agent SDK list and are re-checked on every send; `chat.new` and `chat.options` use the turn and read buckets. The Mac gateway answers both commands `capability_unavailable` and ignores `mode` / `model` on `chat.send` (it never grants `compose`, so a client never sends them there). Both hosts accept `chat.send.attachments`; the desktop frames them for the engine as `{ path: name, content: text }`.
```

- [ ] **Step 2: `extension/CLAUDE.md`**

In the **Env** bullet, after the `LLMIDE_HOST_API_READ=1 …` sentence group, add:

```markdown
`LLMIDE_HOST_API_COMPOSE=1` serves `compose` (default off, `routes/host-api/compose.mjs`): `chat.options` lists the read-only modes (`auto` = `auto_read_only`, `ask`, `plan`, `assist_plan`, `review`, `document`; never `execute` or a permission mode) and the account's Claude models (`listSdkModels`, in process); `chat.send` may carry `mode` / `model` only on a session granted `compose`, the model re-checked against that list; `chat.new` points the user's phone chat at a fresh session. Never granted to a relay-bridged session. Same re-pair and Tauri `core_env.rs` rules as `read`.
```

In the **Audit and limits** bullet, add `chat_options`, `chat_new`, `compose_send` to the event list (after `plaintext_refused`).

Replace the **Phone chat** bullet with:

```markdown
- **Phone chat**: one server-side chat per user (`host_api_quick_chat`), run in mode `auto_read_only` (or a read-only mode a `compose` client picked; `startHostTurn` clamps again) in the extension chat workspace, not the open project. `chat.new` replaces it with a fresh one; other chats are read-only from a client. Attachments arrive as `{ name, text }` and run as engine files `{ path, content }` (text only, the core's 80,000 / 200,000-character caps).
```

- [ ] **Step 3: Master plan line 431**

Replace line 431 with:

```markdown
- [~] Web client chat parity with the desktop (plan `plans/2026-11-07-web-chat-parity.md`): new capability `compose` (`LLMIDE_HOST_API_COMPOSE=1`, default off; re-pair to get it) with `chat.options` and `chat.new`, read-only mode picker (never Execute or Bypass), Claude model picker from the account's SDK list, text attachments (also fixes the desktop dropping every Host API attachment), New chat (other desktop chats stay read-only), usage strip refreshed after each reply; "always allow" from the web not built (web turns have no Bash, so no desktop rule applies; decision 5 in the plan); open: your browser check against a real desktop (me, you)
```

(Set it to `[x]` only after the manual check in Task 8 Step 6 passed.)

- [ ] **Step 4: Full gates**

Run: `cd /Users/dinsmallade/llm-ide && make host-api-check && make test && (cd web && npm test && npx tsc --noEmit -p .) && make test-shared-protocol`
Expected: PASS. Then `make regression` before any later push (push is not part of this plan).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add schema/host-api/v1/README.md extension/CLAUDE.md docs/superpowers/MASTER-PLAN.md
git commit -m "docs(host-api): compose capability and web chat parity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Not in this plan (stated on purpose)

- **iOS screens** for mode/model/new chat: the regenerated `SharedProtocol` (Task 1) keeps the current app building and compatible; screens are a follow-up if wanted.
- **Mac host serving `compose`**: Swift feature freeze; README "Host differences" says so.
- **Sending into another desktop chat**, **Execute from the web**, **"always allow" from the web**, **images**, **effort picker**, **custom/catalog providers**: Decisions 2, 3, 5, 6, 7.
- **Remembering the mode/model pick across reloads**: a new or switched chat starts on Auto, as on the desktop (`pickerModeAfterSessionChange`).
- **A desktop Settings toggle for `LLMIDE_HOST_API_COMPOSE`**: env only, like `read` and `tool_approvals`.

## Self-review

- **Spec coverage.** Session switcher: `chat.new` (Tasks 1, 5, 7, 8) plus the existing read list; sending elsewhere is Decision 2. Mode picker: allowed set in schema + vector (Task 1), clamp in `startHostTurn` (Task 3), gateway grant check (Task 5), UI (Tasks 7-8). Model picker: `chat.options` from `listSdkModels` (Task 4), re-check on send (Task 5), UI. Attachments: desktop framing bug (Task 2), web reader with the core's limits and no paths (Task 6), UI. Usage strip: exists; refresh after reply (Task 7). Always allow: Decision 5 with evidence; the card points to desktop Settings (Task 8). Bypass: Decision 4; nothing adds it. Capability at pairing, served ∩ granted, re-pair: Task 4/5 tests (`denied` with "pair again"). Rate limits: `chat.options` read bucket, `chat.new` and `chat.send` turn bucket (Tasks 4-5). Audit without content: `chat_options`, `chat_new`, `compose_send`, `scope_denied` (Tasks 4-5, tested for no text). Contract-first with shared vector: Task 1, read by Node (Tasks 1, 3, 4) and web (Task 6) tests. `apiVersion`: stays 1, additive. In-process turns: `deps.turn` → `startHostTurn`, `deps.models` → `listSdkModels`, no HTTP. Web constraints: strict decoding unchanged (generated types, host validates), CSP unchanged, phone width + keyboard/VoiceOver (Task 8 Steps 4 and 6), `node:test`.
- **Placeholder scan.** Every code step has the code. Two spots defer to tool output on purpose: the `at` paths of the new invalid fixtures (Task 1 Step 4) and the generated Swift case names (Task 1 Step 7); each says which output is authoritative.
- **Type consistency.** `attachmentsToFiles` (Task 2) is used unchanged in Task 5. `COMPOSE_MODES` (Task 4) = `HOST_TURN_MODES` (Task 3) = vector `modes.allowed` (Task 1), each tested. `optionsOf` / `offersModel` / `modelsFor` (Task 4) are what Task 5 calls. `deps.turn` args `{ mode, model }` (Task 5) match `startHostTurn({ mode, model })` (Task 3). `SendExtras`, `ComposeState`, `initialComposeState`, `createComposeController` (Task 7) are what Task 8 imports; `ChatController.send` returns `Promise<boolean>` in Task 7 and is used that way in Task 8's `App.tsx`. Harness options `compose`, `models`, `t.audits`, `t.modelCalls` are added in Task 4 and used in Task 5.
