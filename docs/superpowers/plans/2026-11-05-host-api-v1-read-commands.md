# Host API v1 Read Commands (first slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Host API v1 clients more than chat and approvals: a read-only list of the user's chats, a read-only view of any of those chats' history, and the usage and limits summary, served by the desktop host and shown in the web client.

**Architecture:** Three new v1 commands (`chat.sessions`, `chat.history`, `usage.get`) under one new capability `read`, added to the machine-checked contract in `schema/host-api/v1/` and regenerated for Node, Swift and TypeScript. The desktop gateway (`extension/routes/host-api/gateway.mjs`) answers them in process from the existing stores (`kb/chat-sessions.mjs`, `kb/usage.mjs`) through pure mappers in a new `routes/host-api/reads.mjs` that clamp, re-redact and shape every value to the closed v1 schema. `read` is served only when `LLMIDE_HOST_API_READ=1` (default off), and a device gets it only if it was paired while it was served (served ∩ granted, as `tool_approvals` works today). The Mac host compiles the new cases but does not serve `read`. iOS and the Mac host serving `read` are follow-up plans.

**Tech Stack:** Node 20+ ESM (`node:test`), better-sqlite3 (existing stores only), the repo's JSON-Schema subset validator (`extension/routes/bus/schema-validate.mjs`), `scripts/generate-host-api.mjs` (Node/Swift/TS codegen), React 19 + TypeScript in `web/` (tests: `node --test --experimental-strip-types`), Swift only for a compile-only case in the Mac gateway.

**Spec:** `docs/superpowers/specs/2026-11-03-host-api-design.md` (Host API design), `schema/host-api/v1/README.md` (the contract and "Host differences"), `docs/superpowers/plans/2026-10-31-command-bus-spec.md` §1.4, §2.1, §2.3 (kind names and the R tier), `docs/superpowers/MASTER-PLAN.md` S4 lines 239-240.

## Global Constraints

- `apiVersion` stays `1`. The new commands are additive inside v1 (README: "The remaining spec domains … are added by later plans using the same envelope and registry machinery"). No HTTP route changes, so **no `SERVER_API_VERSION` bump and no `ALL_ENDPOINTS` change**.
- A frame is at most 1,048,576 bytes; a list result at most `maxListBytes` = 786,432 bytes (UTF-8 JSON of its items); lists default 100 items, maximum 500 (`HOST_API_LIMITS`).
- Payload objects are closed (`additionalProperties: false`). Schema `pattern`s end in `$` and avoid `\d`, `\w`, `\s`, `.` (Swift ICU). Only the keywords in `ALLOWED_SCHEMA_KEYS` (`scripts/conformance-host-api.mjs:38-42`). No `number` and no `null` types: use `integer` and optional fields (the Swift generator and validator are only exercised on `integer`, `string`, `boolean`, `array`, `object` today).
- Every read is user-scoped by the **authenticated session's** `userId`; a payload never names a user. A chat id that is not the caller's answers `not_found`, exactly like an unknown id.
- No secrets in frames: titles, message text and model labels pass `redactSecretsForStorage` (`extension/core/redact-secrets.mjs`) again on read (rows can predate redaction). Never send `meta`, tool output, system lines, limit configuration (`priority`, `threshold_pct`, `enabled`, `custom`), token breakdowns, keys or paths.
- The gateway never calls HTTP and never reads UI state (`extension/CLAUDE.md` "No HTTP inside"). Store modules load lazily (off the boot path).
- Never log frame content, tokens or PINs: type and size only.
- Command names follow the command bus spec (`chat.sessions`, `chat.history`, `usage.get`, all tier **R**).
- Swift feature freeze: Mac changes are limited to what the shared generated code forces (one unreachable `case` so the exhaustive switch compiles).
- Conventional Commits, one concern per commit, commit on `main` (user rule: no branches). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Scope

In this plan: contract + generated code (Task 1), desktop mappers (Task 2), desktop gateway + switch + rate bucket (Task 3), real-DB tenancy test (Task 4), web read controller (Task 5), web screens + docs + master plan (Task 6).

**Not in this plan (follow-ups, stated on purpose):**
- **iOS** (`ios_app/MyApp`): mapping `usage.get` into `UsageStore` and `chat.sessions`/`chat.history` into a read-only chat list when `hostApiVersion == 1` (today `RootTabView.swift:88-110` guards every store with `hostApiVersion == 2`). Task 1 regenerates `ios_app/SharedProtocol`, so the follow-up only touches screens. Follow-up plan: "Host API v1 reads on iOS".
- **Mac host serving `read`**: the Mac's chats live in its own `ChatSessionStore`, not `chat_sessions` (`kb/chat-sessions.mjs:1-4`), and its usage view is Swift-side; parity needs new Swift deps. Deferred under the feature freeze; README "Host differences" says so.
- **Auto Tasks status**: the desktop core has no Auto Task runner or state (Auto Tasks audit F8, `docs/superpowers/plans/2026-10-31-auto-tasks-audit.md:18`); its state lives in the Mac's `AutoCodeUpdateService`. Becomes `task.list`/`task.status` once the command bus job store is the source (bus spec §2.2).
- **Explorer read**: bus spec §2.3 decides it is native-only and off by default, id-based, never PWA. Needs its own design (secret/`.git`/symlink rules).
- **Library read**: bus spec `library.search`/`library.read` (id-based, 256 KiB cap, paged, redacted). The data exists (`kb/meetings.mjs listMeetings`, note index) but needs its own shapes; next slice.
- **Switching** the device's chat to another session (see Decision 2) and a desktop Settings toggle for `LLMIDE_HOST_API_READ` (today `tool_approvals` is env-only too).

## Decisions for the user (secure defaults, already applied in this plan)

1. **One new `read` capability, off by default.** Served only with `LLMIDE_HOST_API_READ=1`; a device paired before that must re-pair to get it (the existing served ∩ granted rule). Recommended: yes. Alternative: put the reads under `chat`, which would silently grant chat history to every already-paired device.
2. **Open, never switch.** A client can read another chat's history; `chat.send` still goes only to the per-user "Phone chat" (run `auto_read_only`). Recommended: keep switching out of v1 for now. Letting a remote device send into a desktop chat would let it continue a project-bound chat whose mode may allow edits.
3. **Browser clients get `read` like native clients.** This follows the bus spec, which lists `chat.sessions`, `chat.history` and `usage.get` for `D X N P`. A browser still has to be paired with a desktop PIN and come from an allowlisted Origin. Recommended: yes. Alternative: withhold `read` from Origin-bearing sessions, which needs the listener to tell the gateway about the Origin.
4. **Keep the capability enum strict.** iOS validates `host.hello`/pair/token results against the closed enum (`HostApiFrame.parseInbound`, `HostApiFrame.swift:171-177`). An iOS build older than Task 1 therefore fails `host.hello` against a desktop that serves `read`. Recommended: keep it strict, because the switch is off by default and iOS is rebuilt from this repo. Alternative: relax the four enums to a pattern so future capabilities never break old clients, at the cost of a contract rule.
5. **No audit row per successful read.** Refusals are already audited (`scope_denied`, `rate_closed`), and reads change no state (the bus audits only state changes, `docs/spec/command-bus.md` "Audit"). Recommended: no per-read row.
6. **Auto Tasks, Explorer and Library reads are deferred** to follow-up plans (reasons in Scope). Recommended: accept the deferral.

## File Structure

| File | Responsibility |
|---|---|
| `schema/host-api/v1/commands.json` (modify) | `read` capability, three commands, four capability enums |
| `schema/host-api/v1/events.schema.json` (modify) | `host.capabilities` enum gains `read` |
| `schema/host-api/v1/fixtures/commands/{chat.sessions,chat.history,usage.get}.{request,result}.json` (create) | valid fixtures |
| `schema/host-api/v1/fixtures/invalid/commands/*.json` + `invalid-cases.json` (create/modify) | invalid fixtures |
| `schema/host-api/v1/fixtures/events/host.capabilities.json` (modify) | lists `read` |
| `schema/host-api/v1/README.md` (modify) | command table, Limits, Host differences |
| `scripts/conformance-host-api.mjs` (modify) | `EXPECTED_COMMANDS = 15` |
| generated: `extension/routes/host-api/commands.generated.mjs`, `web/src/host-api/types.generated.ts`, `ios_app/SharedProtocol/Sources/SharedProtocol/HostApi{Commands,Payloads,Schemas}.swift` | regenerated, never hand-edited |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift` (modify) | one unreachable case |
| `extension/routes/host-api/reads.mjs` (create) | pure mappers `sessionsOf`, `historyOf`, `usageOf`, `READ_LIMITS` |
| `extension/routes/host-api/rate.mjs` (modify) | per-device read bucket |
| `extension/routes/host-api/gateway.mjs` (modify) | `read` capability switch, default read deps, three cases |
| `extension/tests/host-api-reads.test.mjs` (create) | mapper unit tests |
| `extension/tests/host-api-gateway.test.mjs` (modify) | gateway read scenarios with fakes |
| `extension/tests/host-api-reads-db.test.mjs` (create) | real-DB tenancy and wiring |
| `web/src/read/controller.ts` (create) | read state + commands, no React |
| `web/src/screens/ReadPanel.tsx` (create) | usage strip, chat list, read-only history |
| `web/src/app-model.ts`, `web/src/App.tsx`, `web/src/web.css`, `web/tests/ui-entry.ts` (modify) | wiring |
| `web/tests/read-controller.test.mjs` (create), `web/tests/screens.test.mjs` (modify) | web tests |
| `extension/CLAUDE.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | docs |

---

### Task 1: Contract: `read` capability and three commands

**Files:**
- Modify: `schema/host-api/v1/commands.json` (the `capabilities` array at line 4; the four `capabilities.items.enum` lists in `host.hello`, `host.auth.pair`, `host.auth.token` results; append three commands at the end of `commands`)
- Modify: `schema/host-api/v1/events.schema.json` (`host.capabilities` payload enum)
- Modify: `schema/host-api/v1/fixtures/events/host.capabilities.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.sessions.request.json`, `chat.sessions.result.json`, `chat.history.request.json`, `chat.history.result.json`, `usage.get.request.json`, `usage.get.result.json`
- Create: `schema/host-api/v1/fixtures/invalid/commands/chat.history.missing-session-id.json`, `chat.history.bad-session-id.json`, `chat.sessions.limit-too-large.json`, `usage.get.model-unknown-field.json`
- Modify: `schema/host-api/v1/fixtures/invalid-cases.json`
- Modify: `scripts/conformance-host-api.mjs:20`
- Modify: `schema/host-api/v1/README.md`
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift` (end of the `switch request.command`, after `case .toolApprovalsAnswer:` near line 289)
- Test: `extension/tests/host-api-contract.test.mjs`, `extension/tests/host-api-ts-types.test.mjs`

**Interfaces:**
- Produces (wire, used by every later task):
  - `chat.sessions` request `{ limit?: 1..100, offset?: 0..10000 }` → result `{ sessions: [{ id, title, updatedAt, phoneChat? }], nextOffset? }`
  - `chat.history` request `{ sessionId, beforeSeq?: >=1, limit?: 1..500 }` → result `{ messages: [{ seq, role: "user"|"assistant", content }], nextBeforeSeq? }`
  - `usage.get` request `{}` → result `{ providers: [{ provider, status, activeModel?, models: [{ model, label?, state, unit, window, used, limit, pct?, resetAt }] }] }`
  - Generated: `HOST_API_COMMANDS["chat.sessions"|"chat.history"|"usage.get"] = { capability: "read", idempotent: true }`; Swift `HostApiCommand.chatSessions`, `.chatHistory`, `.usageGet`; TS `HostApiResult<"chat.sessions">` and so on.

- [ ] **Step 1: Write the failing contract tests**

In `extension/tests/host-api-contract.test.mjs` change the count test and add a read test:

```js
test("host-api command registry: 15 commands and every fixture validates", () => {
  assert.equal(Object.keys(commands.commands).length, 15);
  for (const [name, c] of Object.entries(commands.commands)) {
    for (const [kind, schema] of [["request", c.request], ["result", c.result]]) {
      const value = json(`fixtures/commands/${name}.${kind}.json`);
      assert.deepEqual(validate(schema, value, { defs: envelope.$defs }), [], `${name} ${kind}`);
    }
  }
});

test("host-api read commands: capability read, idempotent, closed shapes, bounded lists", () => {
  assert.ok(commands.capabilities.includes("read"));
  for (const name of ["chat.sessions", "chat.history", "usage.get"]) {
    const c = commandEntry(name);
    assert.equal(c.capability, "read", name);
    assert.equal(c.idempotent, true, name);
    assert.equal(c.request.additionalProperties, false, name);
    assert.equal(c.result.additionalProperties, false, name);
  }
  assert.equal(commandEntry("chat.sessions").result.properties.sessions.maxItems, 100);
  assert.equal(commandEntry("chat.history").result.properties.messages.maxItems, 500);
  // A foreign or system role never validates, so a mapper bug cannot leak a system line.
  const bad = { messages: [{ seq: 1, role: "system", content: "x" }] };
  assert.ok(validate(commandEntry("chat.history").result, bad, { defs: envelope.$defs }).length > 0);
});
```

In `extension/tests/host-api-ts-types.test.mjs` line 20 change the expectation to:

```js
    v: 1, c: 15, e: 7, caps: ['host', 'chat', 'approvals', 'tool_approvals', 'read'], codes: 11, send: { capability: 'chat', idempotent: false },
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-contract.test.mjs tests/host-api-ts-types.test.mjs`
Expected: FAIL (`12 !== 15`, `read` missing, missing fixture `chat.sessions.request.json`).

- [ ] **Step 3: Add the capability and the three commands to `commands.json`**

Line 4 becomes:

```json
  "capabilities": ["host", "chat", "approvals", "tool_approvals", "read"],
```

In the three results `host.hello`, `host.auth.pair` and `host.auth.token`, change each `"enum": ["host", "chat", "approvals", "tool_approvals"]` to `"enum": ["host", "chat", "approvals", "tool_approvals", "read"]`. Then append after `toolApprovals.answer` (add a comma after its closing brace):

```json
    "chat.sessions": {
      "capability": "read",
      "direction": "client_to_host",
      "idempotent": true,
      "v2Tag": null,
      "request": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
          "offset": { "type": "integer", "minimum": 0, "maximum": 10000 }
        }
      },
      "result": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessions"],
        "properties": {
          "sessions": {
            "type": "array",
            "maxItems": 100,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "title", "updatedAt"],
              "properties": {
                "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
                "title": { "type": "string", "minLength": 1, "maxLength": 120 },
                "updatedAt": { "type": "integer", "minimum": 0 },
                "phoneChat": { "type": "boolean" }
              }
            }
          },
          "nextOffset": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "chat.history": {
      "capability": "read",
      "direction": "client_to_host",
      "idempotent": true,
      "v2Tag": null,
      "request": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sessionId"],
        "properties": {
          "sessionId": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
          "beforeSeq": { "type": "integer", "minimum": 1 },
          "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
        }
      },
      "result": {
        "type": "object",
        "additionalProperties": false,
        "required": ["messages"],
        "properties": {
          "messages": {
            "type": "array",
            "maxItems": 500,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["seq", "role", "content"],
              "properties": {
                "seq": { "type": "integer", "minimum": 1 },
                "role": { "type": "string", "enum": ["user", "assistant"] },
                "content": { "type": "string", "maxLength": 100000 }
              }
            }
          },
          "nextBeforeSeq": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "usage.get": {
      "capability": "read",
      "direction": "client_to_host",
      "idempotent": true,
      "v2Tag": "usage_get",
      "request": { "type": "object", "additionalProperties": false, "properties": {} },
      "result": {
        "type": "object",
        "additionalProperties": false,
        "required": ["providers"],
        "properties": {
          "providers": {
            "type": "array",
            "maxItems": 10,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["provider", "status", "models"],
              "properties": {
                "provider": { "type": "string", "minLength": 1, "maxLength": 64 },
                "status": { "type": "string", "enum": ["ok", "degraded", "paused", "unconfigured"] },
                "activeModel": { "type": "string", "minLength": 1, "maxLength": 200 },
                "models": {
                  "type": "array",
                  "maxItems": 50,
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["model", "state", "unit", "window", "used", "limit", "resetAt"],
                    "properties": {
                      "model": { "type": "string", "minLength": 1, "maxLength": 200 },
                      "label": { "type": "string", "minLength": 1, "maxLength": 200 },
                      "state": { "type": "string", "enum": ["ok", "warning", "exhausted"] },
                      "unit": { "type": "string", "enum": ["runs", "tokens"] },
                      "window": { "type": "string", "enum": ["daily", "monthly"] },
                      "used": { "type": "integer", "minimum": 0 },
                      "limit": { "type": "integer", "minimum": 0 },
                      "pct": { "type": "integer", "minimum": 0, "maximum": 999 },
                      "resetAt": { "type": "integer", "minimum": 0 }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
```

In `events.schema.json`, the `host.capabilities` variant's `payload.properties.capabilities.items.enum` becomes `["host","chat","approvals","tool_approvals","read"]`. In `fixtures/events/host.capabilities.json` the payload becomes `{"capabilities":["host","chat","approvals","tool_approvals","read"]}`.

- [ ] **Step 4: Add the fixtures**

`fixtures/commands/chat.sessions.request.json`:
```json
{"limit":50}
```
`fixtures/commands/chat.sessions.result.json`:
```json
{"sessions":[{"id":"7f1c2a4e-0b7d-4c55-9a51-2f0e7c1d9b10","title":"Phone chat","updatedAt":1762300000000,"phoneChat":true},{"id":"0c9e1b52-6a3d-4f7e-8b21-5d4c3b2a1f00","title":"Refactor the router","updatedAt":1762290000000}],"nextOffset":50}
```
`fixtures/commands/chat.history.request.json`:
```json
{"sessionId":"0c9e1b52-6a3d-4f7e-8b21-5d4c3b2a1f00","limit":100}
```
`fixtures/commands/chat.history.result.json`:
```json
{"messages":[{"seq":7,"role":"user","content":"Why is the router slow?"},{"seq":8,"role":"assistant","content":"It re-parses the URL per route."}],"nextBeforeSeq":7}
```
`fixtures/commands/usage.get.request.json`:
```json
{}
```
`fixtures/commands/usage.get.result.json`:
```json
{"providers":[{"provider":"anthropic","status":"ok","activeModel":"claude-sonnet-4-5","models":[{"model":"claude-sonnet-4-5","label":"Sonnet","state":"ok","unit":"runs","window":"daily","used":42,"limit":100,"pct":42,"resetAt":1762387200000},{"model":"claude-haiku-4-5","state":"ok","unit":"tokens","window":"monthly","used":0,"limit":0,"resetAt":1764547200000}]}]}
```
`fixtures/invalid/commands/chat.history.missing-session-id.json`:
```json
{"limit":10}
```
`fixtures/invalid/commands/chat.history.bad-session-id.json`:
```json
{"sessionId":"../etc/passwd"}
```
`fixtures/invalid/commands/chat.sessions.limit-too-large.json`:
```json
{"limit":101}
```
`fixtures/invalid/commands/usage.get.model-unknown-field.json`:
```json
{"providers":[{"provider":"anthropic","status":"ok","models":[{"model":"m","state":"ok","unit":"runs","window":"daily","used":0,"limit":0,"resetAt":0,"apiKey":"x"}]}]}
```
In `fixtures/invalid-cases.json`, add to the `commands` map (after `toolApprovals.answer.bad-decision.json`, with a comma):
```json
    "chat.history.missing-session-id.json": { "command": "chat.history", "kind": "request", "at": ".sessionId" },
    "chat.history.bad-session-id.json": { "command": "chat.history", "kind": "request", "at": ".sessionId" },
    "chat.sessions.limit-too-large.json": { "command": "chat.sessions", "kind": "request", "at": ".limit" },
    "usage.get.model-unknown-field.json": { "command": "usage.get", "kind": "result", "at": ".providers[0].models[0].apiKey" }
```
Before you commit, check each `at` path against the validator's actual error output. If the validator reports a missing required field at the parent (`""`) and not at `.sessionId`, use the path that `node scripts/conformance-host-api.mjs` prints.

In `scripts/conformance-host-api.mjs` line 20: `const EXPECTED_COMMANDS = 15;`

- [ ] **Step 5: README**

In `schema/host-api/v1/README.md`: change "All 12 commands are listed below." to "All 15 commands are listed below." and append these rows to the table (the contract test parses them):

```markdown
| `chat.sessions` | read | yes | — |
| `chat.history` | read | yes | — |
| `usage.get` | read | yes | `usage_get` |
```

Replace the paragraph "The remaining spec domains (Explorer, Auto Tasks, Loop, …)" with:

```markdown
`read` (tier R in the command bus spec) is the read-only slice: the user's chat list, one chat's history, and the usage and limits summary. It is served only when the host enables it (desktop: `LLMIDE_HOST_API_READ=1`, default off) and only to a device paired while it was served. The remaining spec domains (Explorer, Auto Tasks, Loop, projects, files, SCM, issues, Self-Heal, generation, Library, activity) are added by later plans using the same envelope and registry machinery.
```

Under "Limits" add:

```markdown
- `chat.sessions` pages by `offset` (at most 100 per page; `nextOffset` is present while more exist). `chat.history` pages backwards by `beforeSeq` (`nextBeforeSeq` is present while older messages exist) and is trimmed to `maxListBytes` like `chat.snapshot`: oldest dropped first, the newest always kept, with `nextBeforeSeq` pointing at the oldest kept message.
```

Under "Host differences" add:

```markdown
- **Reads.** Only the desktop serves `read` (`chat.sessions`, `chat.history`, `usage.get`). Its chats are the server `chat_sessions` rows, and the per-user "Phone chat" is flagged `phoneChat`. The Mac does not serve `read` yet, so its gate answers `capability_unavailable`. The desktop also rate-limits reads per device (20-read bucket at 2/s); the Mac has no read bucket.
```

- [ ] **Step 6: Regenerate and fix the Mac's exhaustive switch**

Run: `cd /Users/dinsmallade/llm-ide && node scripts/generate-host-api.mjs`
Expected: it rewrites `extension/routes/host-api/commands.generated.mjs`, `web/src/host-api/types.generated.ts` and the generated `ios_app/SharedProtocol/Sources/SharedProtocol/HostApi*.swift`.

In `HostApiV1Gateway.swift`, add after the `case .toolApprovalsAnswer:` block and before the switch's closing `}`:

```swift
        case .chatSessions, .chatHistory, .usageGet:
            // Unreachable: the Mac never serves `read`, so the gate refused above. The desktop host serves it.
            fail(session, id, "capability_unavailable", "This Mac does not serve read right now.")
```

If the generated case names differ, use what `grep -n "case chat\|case usage" ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift` prints.

- [ ] **Step 7: Run every contract gate**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-contract.test.mjs tests/host-api-ts-types.test.mjs tests/host-api-frame.test.mjs tests/host-api-session.test.mjs`
Expected: PASS.

Run: `cd /Users/dinsmallade/llm-ide && make host-api-check`
Expected: `conformance-host-api: ok (15 commands, 7 events)`.

Run: `cd /Users/dinsmallade/llm-ide && make test-shared-protocol`
Expected: build (and tests, with Xcode) PASS.

Run: `cd /Users/dinsmallade/llm-ide/mac && swift build && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1`
Expected: PASS. (If SwiftPM fails with "Invalid manifest" or "Operation not permitted", that is the sandbox: run it again unsandboxed.)

Run: `cd /Users/dinsmallade/llm-ide/web && npx tsc --noEmit -p . && npm test`
Expected: PASS. The web's `#known` filter already accepts any registry capability.

- [ ] **Step 8: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add schema/host-api/v1 scripts/conformance-host-api.mjs extension/routes/host-api/commands.generated.mjs \
  web/src/host-api/types.generated.ts ios_app/SharedProtocol/Sources/SharedProtocol \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift \
  extension/tests/host-api-contract.test.mjs extension/tests/host-api-ts-types.test.mjs
git commit -m "feat(host-api): add the read capability with chat.sessions, chat.history and usage.get

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Desktop read mappers (`reads.mjs`)

**Files:**
- Create: `extension/routes/host-api/reads.mjs`
- Test: `extension/tests/host-api-reads.test.mjs`

**Interfaces:**
- Consumes: `clamp` from `./frame.mjs`; `response(replyTo, command, result, rev)` from `./frame.mjs` (only in tests, to prove the shapes validate); `HOST_API_LIMITS` from `./commands.generated.mjs`; `redactSecretsForStorage` from `../../core/redact-secrets.mjs`.
- Consumes store shapes: `listChatSessions` rows `{ id, title, surface, mode, projectId, createdAt (s), updatedAt (s) }`; `getChatSession` → `{ …session, messages: [{ seq, role, content, meta, createdAt }] (ascending), hasMore }` or `null`; `usageSummary` → `{ providers: { [prov]: { active: { status, model, … }, models: [{ model, label, state, unit, window_kind, used, limit, pct, resetAt (ISO) , … }] } } }`.
- Produces:
  - `READ_LIMITS = { sessionsDefault: 50, historyDefault: 100, providersMax: 10, modelsMax: 50 }`
  - `sessionsOf(rows, limit, offset, phoneChatId) -> HostApiResult<"chat.sessions">`. `rows` was fetched with `limit + 1`.
  - `historyOf(session, limit) -> HostApiResult<"chat.history">`
  - `usageOf(summary) -> HostApiResult<"usage.get">`

- [ ] **Step 1: Write the failing tests**

```js
// Host API v1 read mappers: closed shapes, redaction on read, size caps, paging hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionsOf, historyOf, usageOf, READ_LIMITS } from '../routes/host-api/reads.mjs';
import { response } from '../routes/host-api/frame.mjs';
import { HOST_API_LIMITS } from '../routes/host-api/commands.generated.mjs';

const KEY = `sk-ant-api03-${'A'.repeat(48)}`;
const valid = (command, result) => assert.doesNotThrow(() => response('c-1', command, result, 0));

test('sessionsOf: ms timestamps, redacted titles, phone chat flagged, nextOffset only when more exist', () => {
  const rows = [
    { id: 'chat-1', title: 'Phone chat', updatedAt: 1762300000.5 },
    { id: 'chat-2', title: `paste ${KEY}`, updatedAt: 1762290000 },
    { id: 'chat-3', title: '', updatedAt: 1 },
  ];
  const r = sessionsOf(rows, 2, 0, 'chat-1');
  assert.deepEqual(r.sessions[0], { id: 'chat-1', title: 'Phone chat', updatedAt: 1762300000500, phoneChat: true });
  assert.doesNotMatch(r.sessions[1].title, /sk-ant/);
  assert.equal(r.sessions.length, 2);
  assert.equal(r.nextOffset, 2);
  assert.equal(sessionsOf(rows, 5, 10, null).nextOffset, undefined);
  assert.equal(sessionsOf(rows, 5, 10, null).sessions[2].title, 'New chat');
  valid('chat.sessions', r);
});

test('sessionsOf: an id the wire cannot carry is skipped, never sent', () => {
  const r = sessionsOf([{ id: 'bad/id', title: 't', updatedAt: 1 }, { id: 'ok', title: 't', updatedAt: 1 }], 50, 0, null);
  assert.deepEqual(r.sessions.map((s) => s.id), ['ok']);
});

test('historyOf: only user and assistant lines, no meta, redacted, paging hint from the store', () => {
  const session = { hasMore: true, messages: [
    { seq: 3, role: 'system', content: 'sys', meta: { x: 1 } },
    { seq: 4, role: 'user', content: `my key ${KEY}`, meta: { tool: 'Bash' } },
    { seq: 5, role: 'assistant', content: 'ok' },
  ] };
  const r = historyOf(session, 100);
  assert.deepEqual(r.messages.map((m) => [m.seq, m.role]), [[4, 'user'], [5, 'assistant']]);
  assert.doesNotMatch(r.messages[0].content, /sk-ant/);
  assert.equal(Object.keys(r.messages[0]).sort().join(), 'content,role,seq');
  assert.equal(r.nextBeforeSeq, 3, 'the oldest fetched row, even a filtered one, so the next page does not repeat');
  assert.equal(historyOf({ hasMore: false, messages: session.messages }, 100).nextBeforeSeq, undefined);
  valid('chat.history', r);
});

test('historyOf: trimmed to maxListBytes oldest first, newest kept, nextBeforeSeq at the oldest kept', () => {
  const big = 'x'.repeat(100_000);
  const messages = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: big }));
  const r = historyOf({ hasMore: false, messages }, 500);
  assert.ok(r.messages.length < 12 && r.messages.length >= 1);
  assert.equal(r.messages.at(-1).seq, 12);
  assert.equal(r.nextBeforeSeq, r.messages[0].seq);
  assert.ok(Buffer.byteLength(JSON.stringify(r.messages)) <= HOST_API_LIMITS.maxListBytes + r.messages.length);
  valid('chat.history', r);
});

test('usageOf: numbers and labels only, no limit configuration, bounded', () => {
  const summary = { providers: {
    anthropic: { active: { status: 'ok', model: 'claude-sonnet-4-5', reason: 'x' }, models: [
      { model: 'claude-sonnet-4-5', label: 'Sonnet', enabled: 1, custom: false, priority: 0, unit: 'runs', window_kind: 'daily',
        limit: 100, threshold_pct: 90, used: 42, pct: 42.4, state: 'ok', quota: false, tokens: { input: 1 }, resetAt: '2026-11-06T00:00:00.000Z' },
      { model: 'claude-haiku-4-5', label: '', unit: 'tokens', window_kind: 'monthly', limit: 0, used: 0, pct: null, state: 'ok', resetAt: '2026-12-01T00:00:00.000Z' },
    ] },
    weird: { active: { status: 'nope' }, models: Array.from({ length: 80 }, (_, i) => ({ model: `m${i}`, state: 'boom', unit: 'x', window_kind: 'y', used: -1, limit: NaN, resetAt: 'bad' })) },
  } };
  const r = usageOf(summary);
  const m0 = r.providers[0].models[0];
  assert.deepEqual(m0, { model: 'claude-sonnet-4-5', label: 'Sonnet', state: 'ok', unit: 'runs', window: 'daily', used: 42, limit: 100, pct: 42, resetAt: Date.parse('2026-11-06T00:00:00.000Z') });
  assert.equal(r.providers[0].models[1].pct, undefined);
  assert.equal(r.providers[0].models[1].label, undefined);
  assert.equal(r.providers[1].status, 'unconfigured');
  assert.equal(r.providers[1].models.length, READ_LIMITS.modelsMax);
  assert.deepEqual(r.providers[1].models[0], { model: 'm0', state: 'ok', unit: 'runs', window: 'daily', used: 0, limit: 0, resetAt: 0 });
  valid('usage.get', r);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-reads.test.mjs`
Expected: FAIL with `Cannot find module '../routes/host-api/reads.mjs'`.

- [ ] **Step 3: Implement `reads.mjs`**

```js
// Host API v1 read commands on the desktop host (chat.sessions, chat.history, usage.get): pure mappers from the kb
// stores to the closed v1 shapes. Every string is re-redacted (rows can predate redaction) and clamped; never meta,
// tool output, system lines, limit configuration or a key. The gateway's respond() validates the result again.
import { clamp } from './frame.mjs';
import { HOST_API_LIMITS } from './commands.generated.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';

export const READ_LIMITS = Object.freeze({ sessionsDefault: 50, historyDefault: 100, providersMax: 10, modelsMax: 50 });
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(['ok', 'warning', 'exhausted']);
const STATUSES = new Set(['ok', 'degraded', 'paused', 'unconfigured']);
const text = (s, max) => clamp(redactSecretsForStorage(typeof s === 'string' ? s : ''), max);
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** `rows` was fetched with limit + 1, so one extra row means another page exists. */
export function sessionsOf(rows, limit, offset, phoneChatId) {
  const page = rows.slice(0, limit).filter((r) => typeof r?.id === 'string' && ID_RE.test(r.id));
  return {
    sessions: page.map((r) => ({
      id: r.id,
      title: text(r.title, 120) || 'New chat',
      updatedAt: count(Number(r.updatedAt) * 1000), // the store keeps seconds
      ...(r.id === phoneChatId ? { phoneChat: true } : {}),
    })),
    ...(rows.length > limit ? { nextOffset: offset + limit } : {}),
  };
}

export function historyOf(session, limit) {
  const fetched = session?.messages ?? [];
  const lines = fetched
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && Number.isInteger(m.seq) && m.seq >= 1)
    .slice(-limit)
    .map((m) => ({ seq: m.seq, role: m.role, content: text(m.content, 100_000) }));
  // Newest first within maxListBytes, as messagesOf in gateway.mjs: the newest line always fits alone.
  let bytes = 0;
  let start = lines.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(lines[start - 1])) + 1;
    if (start < lines.length && bytes + size > HOST_API_LIMITS.maxListBytes) break;
    bytes += size;
    start -= 1;
  }
  const messages = lines.slice(start);
  const next = start > 0 ? messages[0].seq : session?.hasMore && fetched.length ? fetched[0].seq : null;
  return { messages, ...(Number.isInteger(next) && next >= 1 ? { nextBeforeSeq: next } : {}) };
}

export function usageOf(summary) {
  const providers = Object.entries(summary?.providers ?? {}).slice(0, READ_LIMITS.providersMax).map(([provider, p]) => {
    const active = p?.active ?? {};
    const activeModel = text(active.model, 200);
    return {
      provider: clamp(provider, 64),
      status: STATUSES.has(active.status) ? active.status : 'unconfigured',
      ...(activeModel ? { activeModel } : {}),
      models: (Array.isArray(p?.models) ? p.models : []).slice(0, READ_LIMITS.modelsMax).map((m) => {
        const label = text(m?.label, 200);
        return {
          model: text(m?.model, 200) || 'model',
          ...(label ? { label } : {}),
          state: STATES.has(m?.state) ? m.state : 'ok',
          unit: m?.unit === 'tokens' ? 'tokens' : 'runs',
          window: m?.window_kind === 'monthly' ? 'monthly' : 'daily',
          used: count(m?.used),
          limit: count(m?.limit),
          ...(Number.isFinite(m?.pct) ? { pct: Math.min(999, Math.max(0, Math.round(m.pct))) } : {}),
          resetAt: count(Date.parse(m?.resetAt)),
        };
      }),
    };
  });
  return { providers };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-reads.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/host-api/reads.mjs extension/tests/host-api-reads.test.mjs
git commit -m "feat(host-api): map chat sessions, history and usage to the v1 read shapes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Desktop gateway serves `read` behind a switch, with a read bucket

**Files:**
- Modify: `extension/routes/host-api/rate.mjs` (`RATE_LIMITS`, `createRateLimiter`)
- Modify: `extension/routes/host-api/gateway.mjs` (header comment line 1, `hostApiCapabilities` line 21, `defaultDeps` line 29, the `switch (command)` in `handle`)
- Modify: `extension/CLAUDE.md` ("Host API v1 (desktop)" section)
- Test: `extension/tests/host-api-gateway.test.mjs`, `extension/tests/host-api-audit-rate.test.mjs:64`

**Interfaces:**
- Consumes: `sessionsOf`, `historyOf`, `usageOf`, `READ_LIMITS` (Task 2); `HOST_API_LIMITS`.
- Produces:
  - `hostApiCapabilities(env)` returns `[...'host','chat','approvals', tool_approvals?, 'read'?]`, with `read` iff `env.LLMIDE_HOST_API_READ === '1'`.
  - A new dep `deps.read = { sessions(userId, { limit, offset }) -> rows[], history(userId, sessionId, { limit, beforeSeq }) -> session|null, usage(userId) -> summary }`.
  - `RATE_LIMITS.readCapacity = 20`, `RATE_LIMITS.readPerSecond = 2`; `rate.read(deviceId, now) -> null | waitMs`.

- [ ] **Step 1: Write the failing tests**

In `extension/tests/host-api-audit-rate.test.mjs` line 64, change the expectation to:

```js
  assert.deepEqual({ ...RATE_LIMITS }, { frameCapacity: 40, framePerSecond: 10, turnCapacity: 6, turnPerSecond: 0.1, readCapacity: 20, readPerSecond: 2, closeAfterRefusals: 100 });
```

and add:

```js
test('the read bucket is per device: 20 reads, then a wait', () => {
  const r = createRateLimiter();
  for (let i = 0; i < 20; i += 1) assert.equal(r.read('d1', 0), null);
  assert.ok(r.read('d1', 0) > 0);
  assert.equal(r.read('d2', 0), null);
});
```

In `extension/tests/host-api-gateway.test.mjs`, extend `harness()`. Add `read = false` and `reads = null` to its options, change the `capabilities` line, and add a `read` dep:

```js
function harness({ toolApprovals = false, chatClear = false, hold = false, skipInit = () => false, history = null, fingerprint = null, read = false, reads = null } = {}) {
  // ...unchanged lines...
    capabilities: () => ['host', 'chat', 'approvals', ...(t.toolApprovals ? ['tool_approvals'] : []), ...(t.read ? ['read'] : [])],
  // ...and next to `append:`:
    read: reads ?? {
      sessions: (userId, opts) => { t.readCalls.push(['sessions', userId, opts]); return [{ id: 'chat-1', title: 'Phone chat', updatedAt: 1 }, { id: 'chat-2', title: 'Other', updatedAt: 2 }]; },
      history: (userId, id, opts) => { t.readCalls.push(['history', userId, id, opts]); return id === 'chat-2' ? { hasMore: false, messages: [{ seq: 1, role: 'user', content: 'q' }, { seq: 2, role: 'assistant', content: 'a' }] } : null; },
      usage: (userId) => { t.readCalls.push(['usage', userId]); return { providers: {} }; },
    },
```

Initialise `readCalls: []` and `read` in `t` (`const t = { …, toolApprovals, read, readCalls: [] }`). Then add these tests:

```js
test('reads: not served by default — capability_unavailable, the store is never touched', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.sessions', {}));
  assert.equal(t.lastError(), 'capability_unavailable');
  assert.equal(t.readCalls.length, 0);
});

test('reads: served and granted at pairing — sessions, history and usage answer for the session user only', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals', 'read']);
  await t.g.receive(s, req('c-1', 'chat.sessions', { limit: 1 }));
  assert.deepEqual(t.last().result, { sessions: [{ id: 'chat-1', title: 'Phone chat', updatedAt: 1000 }], nextOffset: 1 });
  assert.deepEqual(t.readCalls.at(-1), ['sessions', 'u1', { limit: 2, offset: 0 }]);
  await t.g.receive(s, req('c-2', 'chat.history', { sessionId: 'chat-2' }));
  assert.deepEqual(t.last().result.messages.map((m) => m.seq), [1, 2]);
  assert.deepEqual(t.readCalls.at(-1), ['history', 'u1', 'chat-2', { limit: 100, beforeSeq: undefined }]);
  await t.g.receive(s, req('c-3', 'usage.get', {}));
  assert.deepEqual(t.last().result, { providers: [] });
  assert.deepEqual(t.readCalls.at(-1), ['usage', 'u1']);
});

test('reads: an unknown or foreign chat id is not_found', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.history', { sessionId: 'someone-elses' }));
  assert.equal(t.lastError(), 'not_found');
});

test('reads: the phone chat is flagged', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'hi' })); // creates the phone chat 'chat-1'
  await t.g.receive(s, req('c-1', 'chat.sessions', {}));
  assert.equal(t.last().result.sessions[0].phoneChat, true);
  assert.equal(t.last().result.sessions[1].phoneChat, undefined);
});

test('reads: a token paired before read was served is denied with a re-pair hint', async () => {
  const t = harness();
  await t.paired({ n: 1 });
  const token = t.last().result.token;
  // A host now serving read, holding the same device row: the old token's scopes lack read.
  const t2 = harness({ read: true });
  t2.tokens.set(token, t.tokens.get(token));
  const s2 = { n: 2 };
  t2.g.opened(s2, '127.0.0.1');
  await t2.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t2.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  assert.deepEqual(t2.last().result.capabilities, ['host', 'chat', 'approvals']);
  await t2.g.receive(s2, req('c-1', 'usage.get', {}));
  assert.equal(t2.lastError(), 'denied');
  assert.match(t2.last().error.message, /pair again/);
  assert.equal(t2.readCalls.length, 0);
});

test('reads: the per-device read bucket refuses with rate_limited and retryAfterMs', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  for (let i = 0; i < 20; i += 1) await t.g.receive(s, req(`c-${i}`, 'usage.get', {}));
  await t.g.receive(s, req('c-x', 'usage.get', {}));
  assert.equal(t.lastError(), 'rate_limited');
  assert.ok(t.last().error.details.retryAfterMs > 0);
});

test('hostApiCapabilities: read only with LLMIDE_HOST_API_READ=1', async () => {
  const { hostApiCapabilities } = await import('../routes/host-api/gateway.mjs');
  assert.deepEqual(hostApiCapabilities({}), ['host', 'chat', 'approvals']);
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_READ: '1' }), ['host', 'chat', 'approvals', 'read']);
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_READ: '1', LLMIDE_HOST_API_TOOL_APPROVALS: '1' }), ['host', 'chat', 'approvals', 'tool_approvals', 'read']);
});
```

Note on the rate test: `c-h`, `c-p` and 21 reads make 23 frames, under the 40-frame bucket, so only the read bucket refuses. The harness uses the real `Date.now()`, and 20 reads complete in far less than the half second one read token takes to refill.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-gateway.test.mjs tests/host-api-audit-rate.test.mjs`
Expected: FAIL (the `RATE_LIMITS` deepEqual, `r.read is not a function`, the read commands answer `unknown_command` from the `default:` branch).

- [ ] **Step 3: Read bucket in `rate.mjs`**

```js
export const RATE_LIMITS = Object.freeze({
  frameCapacity: 40, framePerSecond: 10, // per session
  turnCapacity: 6, turnPerSecond: 0.1,   // chat.send, per device
  readCapacity: 20, readPerSecond: 2,    // read commands, per device: each can read up to ~768 KiB from SQLite
  closeAfterRefusals: 100,               // rate refusals before the session is closed
});
```

In `createRateLimiter`, add `const reads = new Map(); // deviceId -> TokenBucket (bounded by the paired devices)` and the method:

```js
    read: (deviceId, now) => take(reads, deviceId, limits.readCapacity, limits.readPerSecond, now),
```

- [ ] **Step 4: Gateway**

Line 1 comment: change "and the 12 commands" to "and the 15 commands (chat, approvals, and the `read` slice)".

Add the import: `import { sessionsOf, historyOf, usageOf, READ_LIMITS } from './reads.mjs';`

`hostApiCapabilities`:

```js
export function hostApiCapabilities(env = process.env) {
  return ['host', 'chat', 'approvals',
    ...(env.LLMIDE_HOST_API_TOOL_APPROVALS === '1' ? ['tool_approvals'] : []),
    ...(env.LLMIDE_HOST_API_READ === '1' ? ['read'] : [])]; // default off: a device gets read only if paired while served
}
```

In `defaultDeps()`, after `append`:

```js
    // In-process, user-scoped stores (never HTTP). The session's userId is the only user a read ever names.
    read: {
      sessions: async (userId, { limit, offset }) => (await chatSessions()).listChatSessions(userId, { limit, offset }),
      history: async (userId, sessionId, { limit, beforeSeq }) => (await chatSessions()).getChatSession(userId, sessionId, { messageLimit: limit, beforeSeq }),
      usage: async (userId) => {
        const [{ usageSummary }, { getDb }] = await Promise.all([import('../../kb/usage.mjs'), import('../../kb/db.mjs')]);
        return usageSummary(getDb(), userId);
      },
    },
```

Inside `createGateway`, next to `rateRefused`:

```js
  function readRefused(s, entry, id) {
    const wait = rate.read(entry.state.deviceId, deps.now());
    if (wait == null) return false;
    rateRefused(s, entry, id, wait);
    return true;
  }
```

In `handle`'s `switch (command)`, before `default:`:

```js
      case 'chat.sessions': {
        if (readRefused(s, entry, id)) return;
        const limit = p.limit ?? READ_LIMITS.sessionsDefault;
        const offset = p.offset ?? 0;
        const rows = await deps.read.sessions(userId, { limit: limit + 1, offset });
        return respond(s, id, command, sessionsOf(rows, limit, offset, deps.quickChat.get(userId)));
      }
      case 'chat.history': {
        if (readRefused(s, entry, id)) return;
        const limit = p.limit ?? READ_LIMITS.historyDefault;
        const session = await deps.read.history(userId, p.sessionId, { limit, beforeSeq: p.beforeSeq });
        // Another user's id reads as unknown: the store query is WHERE user_id = ? AND id = ?.
        if (!session) return fail(s, id, 'not_found', 'That chat is not on this computer.');
        return respond(s, id, command, historyOf(session, limit));
      }
      case 'usage.get': {
        if (readRefused(s, entry, id)) return;
        return respond(s, id, command, usageOf(await deps.read.usage(userId)));
      }
```

The scope check above the switch already refuses a served-but-not-granted `read` with `denied` and audits `scope_denied`. The session gate already answers `capability_unavailable` when `read` is not served. Neither path needs new code.

- [ ] **Step 5: Run the tests**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-gateway.test.mjs tests/host-api-audit-rate.test.mjs tests/host-api-scopes.test.mjs tests/host-api-e2e.test.mjs tests/host-api-reads.test.mjs`
Expected: PASS.

- [ ] **Step 6: Document the switch in `extension/CLAUDE.md`**

In "Host API v1 (desktop)", in the **Env** bullet, append:

```markdown
`LLMIDE_HOST_API_READ=1` serves the `read` capability (`chat.sessions`, `chat.history`, `usage.get`; default off, `routes/host-api/reads.mjs`): every read is the session user's own (`listChatSessions` / `getChatSession` / `usageSummary`), re-redacted and clamped on the way out, with no meta, system lines or limit configuration. A device paired before the switch was on must re-pair to get it.
```

In the **Audit and limits** bullet, change "6-turn bucket at 0.1/s" to "6-turn bucket at 0.1/s, 20-read bucket at 2/s (per device)".

- [ ] **Step 7: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/routes/host-api/rate.mjs extension/routes/host-api/gateway.mjs extension/CLAUDE.md \
  extension/tests/host-api-gateway.test.mjs extension/tests/host-api-audit-rate.test.mjs
git commit -m "feat(host-api): serve the read commands on the desktop behind LLMIDE_HOST_API_READ

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Real-DB tenancy and default-deps wiring test

**Files:**
- Create: `extension/tests/host-api-reads-db.test.mjs`

**Interfaces:**
- Consumes: `createGateway` with its **default** `read` deps (not overridden); `createChatSession`, `appendChatMessage` from `kb/chat-sessions.mjs`; `users.registerUser`.

This proves the in-process wiring (lazy imports, argument names `messageLimit`/`beforeSeq`, seconds-to-ms) against the real stores. It also proves that another user's chat id is `not_found`.

- [ ] **Step 1: Write the test**

```js
// Host API v1 reads against the real stores: default read deps, per-user scoping, paging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-reads-db-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const chats = await import('../kb/chat-sessions.mjs');
const { createGateway } = await import('../routes/host-api/gateway.mjs');

const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });
const user = (tag) => users.registerUser(kb.getDb(), { email: `reads-${tag}-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: tag }).id;

function gatewayFor(userId) {
  const sent = [];
  const g = createGateway({
    send: (_s, text) => sent.push(JSON.parse(text)),
    close: () => {},
    hostName: () => 'Test Computer',
    capabilities: () => ['host', 'chat', 'approvals', 'read'],
    pins: { consumePin: (pin) => (pin === '123456' ? userId : null) },
    devices: {
      issueDeviceToken: (_u, _n, _now, scopes) => ({ deviceId: `h1-${userId}`, token: `tok-${userId}-0123456789`, scopes }),
      authenticateDeviceToken: () => null,
      revokeDevice: () => true,
    },
    quickChat: { get: () => null, set: () => {}, create: () => 'unused' },
  });
  const s = {};
  return {
    sent, last: () => sent.at(-1),
    async open() {
      g.opened(s, '127.0.0.1');
      await g.receive(s, req('c-h', 'host.hello', HELLO));
      await g.receive(s, req('c-p', 'host.auth.pair', { pin: '123456' }));
    },
    ask: (id, command, payload) => g.receive(s, req(id, command, payload)),
  };
}

test('a user reads only their own chats; another user\'s id is not_found', async () => {
  const a = user('a');
  const b = user('b');
  const chat = chats.createChatSession(a, { title: 'Router work', surface: 'any', mode: 'ask' });
  for (let i = 0; i < 5; i += 1) chats.appendChatMessage(a, chat.id, { role: i % 2 ? 'assistant' : 'user', content: `line ${i}` });

  const ga = gatewayFor(a);
  await ga.open();
  await ga.ask('c-1', 'chat.sessions', {});
  assert.equal(ga.last().type, 'response');
  assert.deepEqual(ga.last().result.sessions.map((x) => x.title), ['Router work']);
  assert.ok(ga.last().result.sessions[0].updatedAt > 1_000_000_000_000, 'milliseconds');

  await ga.ask('c-2', 'chat.history', { sessionId: chat.id, limit: 2 });
  const page = ga.last().result;
  assert.deepEqual(page.messages.map((m) => m.content), ['line 3', 'line 4']);
  assert.equal(typeof page.nextBeforeSeq, 'number');
  await ga.ask('c-3', 'chat.history', { sessionId: chat.id, limit: 2, beforeSeq: page.nextBeforeSeq });
  assert.deepEqual(ga.last().result.messages.map((m) => m.content), ['line 1', 'line 2']);

  const gb = gatewayFor(b);
  await gb.open();
  await gb.ask('c-1', 'chat.history', { sessionId: chat.id });
  assert.equal(gb.last().error.code, 'not_found');
  await gb.ask('c-2', 'chat.sessions', {});
  assert.deepEqual(gb.last().result.sessions, []);
});

test('usage.get answers a valid shape for a fresh user from the real usage store', async () => {
  const g = gatewayFor(user('u'));
  await g.open();
  await g.ask('c-1', 'usage.get', {});
  assert.equal(g.last().type, 'response', JSON.stringify(g.last()));
  assert.ok(Array.isArray(g.last().result.providers));
});
```

- [ ] **Step 2: Run it**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/host-api-reads-db.test.mjs`
Expected: PASS. If it fails, the cause is a wiring mismatch in Task 3's default deps, such as a wrong argument name. Fix the deps, not the test.

- [ ] **Step 3: Run the extension suite**

Run: `cd /Users/dinsmallade/llm-ide && make test`
Expected: PASS. Then delete the stray `_host-api-reads-db-test.db*` files if any are left; the other `_*.db` test files are not committed.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/tests/host-api-reads-db.test.mjs
git commit -m "test(host-api): prove v1 reads are per user against the real stores

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web read controller

**Files:**
- Create: `web/src/read/controller.ts`
- Test: `web/tests/read-controller.test.mjs`

**Interfaces:**
- Consumes: `HostLink` (`web/src/host-api/connection.ts:59-65`), `HostApiResult` from `web/src/host-api/types.generated.ts` (Task 1).
- Produces:
  - `ReadState = { sessions, nextOffset: number | null, open: { id, title, messages, nextBeforeSeq: number | null } | null, usage: providers | null, loading: boolean, error: string | null }`
  - `initialReadState`
  - `createReadController(link) -> { getState, subscribe, refresh(): Promise<void>, moreSessions(): Promise<void>, open(id, title): Promise<void>, older(): Promise<void>, close(): void, dispose(): void }`
  - `MAX_SESSIONS = 500`, `MAX_OPEN_MESSAGES = 2000` (client memory caps)

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadController, initialReadState } from "../src/read/controller.ts";

function fakeLink(results = {}, caps = ["host", "chat", "read"]) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() };
  const calls = [];
  let n = 0;
  return {
    capabilities: new Set(caps), calls,
    send(command, payload) {
      const id = `c-${++n}`;
      calls.push({ command, payload });
      const r = results[command];
      return { id, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(typeof r === "function" ? r(payload) : r ?? {}) };
    },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)),
    onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)),
    resync: () => ls.resync.forEach((fn) => fn()),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("without the read capability nothing is sent", async () => {
  const link = fakeLink({}, ["host", "chat"]);
  const r = createReadController(link);
  await r.refresh();
  assert.equal(link.calls.length, 0);
  assert.deepEqual(r.getState(), initialReadState);
});

test("refresh loads chats and usage; more appends the next page", async () => {
  const link = fakeLink({
    "chat.sessions": (p) => (p.offset ? { sessions: [{ id: "b", title: "B", updatedAt: 1 }] } : { sessions: [{ id: "a", title: "A", updatedAt: 2 }], nextOffset: 50 }),
    "usage.get": { providers: [{ provider: "anthropic", status: "ok", models: [] }] },
  });
  const r = createReadController(link);
  await r.refresh();
  assert.deepEqual(r.getState().sessions.map((s) => s.id), ["a"]);
  assert.equal(r.getState().nextOffset, 50);
  assert.equal(r.getState().usage[0].provider, "anthropic");
  await r.moreSessions();
  assert.deepEqual(link.calls.at(-1), { command: "chat.sessions", payload: { limit: 50, offset: 50 } });
  assert.deepEqual(r.getState().sessions.map((s) => s.id), ["a", "b"]);
  assert.equal(r.getState().nextOffset, null);
});

test("open shows one chat read-only; older prepends; a stale reply for another chat is dropped", async () => {
  let release;
  const slow = new Promise((res) => { release = res; });
  const link = fakeLink({
    "chat.history": (p) => p.sessionId === "slow" ? slow
      : p.beforeSeq ? { messages: [{ seq: 1, role: "user", content: "old" }] }
      : { messages: [{ seq: 2, role: "assistant", content: "new" }], nextBeforeSeq: 2 },
  });
  const r = createReadController(link);
  const first = r.open("slow", "Slow");
  await r.open("x", "X");
  release({ messages: [{ seq: 9, role: "user", content: "stale" }] });
  await first;
  assert.equal(r.getState().open.id, "x");
  assert.deepEqual(r.getState().open.messages.map((m) => m.content), ["new"]);
  await r.older();
  assert.deepEqual(link.calls.at(-1).payload, { sessionId: "x", beforeSeq: 2, limit: 100 });
  assert.deepEqual(r.getState().open.messages.map((m) => m.content), ["old", "new"]);
  assert.equal(r.getState().open.nextBeforeSeq, null);
  r.close();
  assert.equal(r.getState().open, null);
});

test("an error is shown, not thrown; a resync refreshes", async () => {
  const link = fakeLink({ "chat.sessions": new Error("This chat is not on this computer."), "usage.get": { providers: [] } });
  const r = createReadController(link);
  await r.refresh();
  assert.match(r.getState().error, /not on this computer/);
  link.resync();
  await tick();
  assert.ok(link.calls.filter((c) => c.command === "usage.get").length >= 2);
  r.dispose();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/read-controller.test.mjs`
Expected: FAIL with a module-not-found error for `../src/read/controller.ts`.

- [ ] **Step 3: Implement the controller**

```ts
// Read-only views over Host API v1 `read`: the chat list, one chat's history and the usage summary. No React here.
import type { HostLink } from "../host-api/connection.ts";
import type { HostApiResult } from "../host-api/types.generated.ts";

export const MAX_SESSIONS = 500;
export const MAX_OPEN_MESSAGES = 2000;
const PAGE = 50;
const HISTORY_PAGE = 100;

type Sessions = HostApiResult<"chat.sessions">["sessions"];
type Lines = HostApiResult<"chat.history">["messages"];
type Providers = HostApiResult<"usage.get">["providers"];
export interface OpenChat { id: string; title: string; messages: Lines; nextBeforeSeq: number | null }
export interface ReadState {
  sessions: Sessions; nextOffset: number | null; open: OpenChat | null; usage: Providers | null; loading: boolean; error: string | null;
}
export const initialReadState: ReadState = { sessions: [], nextOffset: null, open: null, usage: null, loading: false, error: null };
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createReadController(link: HostLink) {
  let state = initialReadState;
  let ticket = 0; // the open chat's request generation: a reply for an older open() is dropped
  const subs = new Set<() => void>();
  const set = (p: Partial<ReadState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };

  async function run<T>(go: () => Promise<T>, apply: (r: T) => Partial<ReadState> | null) {
    if (!link.capabilities.has("read")) return;
    set({ loading: true, error: null });
    try { const p = apply(await go()); set({ ...(p ?? {}), loading: false }); }
    catch (e) { set({ loading: false, error: messageOf(e) }); }
  }

  const refresh = async () => {
    await Promise.all([
      run(() => link.send("chat.sessions", { limit: PAGE }).done, (r) => ({ sessions: r.sessions, nextOffset: r.nextOffset ?? null })),
      run(() => link.send("usage.get", {}).done, (r) => ({ usage: r.providers })),
    ]);
  };
  const offs = [link.onResync(() => { void refresh(); })];

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    refresh,
    moreSessions: () => {
      const offset = state.nextOffset;
      if (offset == null) return Promise.resolve();
      return run(() => link.send("chat.sessions", { limit: PAGE, offset }).done,
        (r) => ({ sessions: [...state.sessions, ...r.sessions].slice(0, MAX_SESSIONS), nextOffset: r.nextOffset ?? null }));
    },
    open: (id: string, title: string) => {
      const mine = ++ticket;
      return run(() => link.send("chat.history", { sessionId: id, limit: HISTORY_PAGE }).done,
        (r) => (mine === ticket ? { open: { id, title, messages: r.messages, nextBeforeSeq: r.nextBeforeSeq ?? null } } : null));
    },
    older: () => {
      const o = state.open;
      if (!o || o.nextBeforeSeq == null) return Promise.resolve();
      const mine = ticket;
      return run(() => link.send("chat.history", { sessionId: o.id, beforeSeq: o.nextBeforeSeq!, limit: HISTORY_PAGE }).done,
        (r) => (mine === ticket && state.open?.id === o.id
          ? { open: { ...o, messages: [...r.messages, ...o.messages].slice(-MAX_OPEN_MESSAGES), nextBeforeSeq: r.nextBeforeSeq ?? null } }
          : null));
    },
    close: () => { ticket += 1; set({ open: null }); },
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}

export type ReadController = ReturnType<typeof createReadController>;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/read-controller.test.mjs && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add web/src/read/controller.ts web/tests/read-controller.test.mjs
git commit -m "feat(web): add a read controller for chats, history and usage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web read panel, wiring, docs and master plan

**Files:**
- Create: `web/src/screens/ReadPanel.tsx`
- Modify: `web/src/app-model.ts` (`Session`, `open`, `shut`), `web/src/App.tsx` (`Chat`), `web/src/web.css`, `web/tests/ui-entry.ts`
- Modify: `web/tests/screens.test.mjs`, `web/MANUAL-CHECK.md`
- Modify: `docs/superpowers/MASTER-PLAN.md:239-240`

**Interfaces:**
- Consumes: `ReadState`, `ReadController`, `createReadController` (Task 5); `Markdown` from `@llmide/screens/chat/MarkdownView.tsx` (as `WebChat.tsx` uses it).
- Produces: `ReadPanel(props: { capabilities: ReadonlySet<HostApiCapability>; state: ReadState; onOpen(id: string, title: string): void; onOlder(): void; onClose(): void; onMore(): void }) -> JSX | null`; `Session.read: ReadController`.

- [ ] **Step 1: Write the failing screen tests**

Add to `web/tests/ui-entry.ts`:

```ts
export { ReadPanel } from "../src/screens/ReadPanel.tsx";
export { initialReadState } from "../src/read/controller.ts";
```

Add to `web/tests/screens.test.mjs`:

```js
const readProps = (state, extra = {}) => ({ capabilities: caps("chat", "read"), state, onOpen: noop, onOlder: noop, onClose: noop, onMore: noop, ...extra });

test("read panel: hidden without the read capability", () => {
  assert.equal(html(h(UI.ReadPanel, { ...readProps(UI.initialReadState), capabilities: caps("chat") })), "");
});

test("read panel: usage numbers, chat list with the phone chat marked, host text as text", () => {
  const state = { ...UI.initialReadState,
    usage: [{ provider: "anthropic", status: "ok", models: [
      { model: "m1", label: "Sonnet", state: "warning", unit: "runs", window: "daily", used: 42, limit: 100, pct: 42, resetAt: 0 },
      { model: "m2", state: "ok", unit: "tokens", window: "monthly", used: 5, limit: 0, resetAt: 0 }] }],
    sessions: [{ id: "p", title: "Phone chat", updatedAt: 1, phoneChat: true }, { id: "x", title: "<img src=x onerror=alert(1)>", updatedAt: 2 }],
    nextOffset: 50 };
  const out = html(h(UI.ReadPanel, readProps(state)));
  assert.match(out, /Sonnet: 42 of 100 runs · daily/);
  assert.match(out, /m2: 5 tokens · monthly, no cap/);
  assert.match(out, /Phone chat \(this device\)/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /More chats/);
});

test("read panel: an open chat is read-only with Show older and Back", () => {
  const state = { ...UI.initialReadState, open: { id: "x", title: "Router", nextBeforeSeq: 3,
    messages: [{ seq: 3, role: "user", content: "<b>q</b>" }, { seq: 4, role: "assistant", content: "a" }] } };
  const out = html(h(UI.ReadPanel, readProps(state)));
  assert.match(out, /Router/);
  assert.match(out, /Read-only/);
  assert.match(out, /Show older/);
  assert.match(out, /Back to the phone chat/);
  assert.doesNotMatch(out, /<b>q/);
  assert.doesNotMatch(out, /<textarea/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/screens.test.mjs`
Expected: FAIL (`ReadPanel` is undefined in the bundle).

- [ ] **Step 3: Implement `ReadPanel.tsx`**

```tsx
// Read-only Host API v1 views: usage numbers, the user's chats, and one chat's history. Host text renders as text.
import { StatusBanner } from "@llmide/ui-kit";
import { Markdown } from "@llmide/screens/chat/MarkdownView.tsx";
import type { HostApiCapability } from "../host-api/types.generated.ts";
import type { ReadState } from "../read/controller.ts";

export interface ReadPanelProps {
  capabilities: ReadonlySet<HostApiCapability>;
  state: ReadState;
  onOpen: (id: string, title: string) => void;
  onOlder: () => void;
  onClose: () => void;
  onMore: () => void;
}

const openLink = (href: string) => { if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); };
type Model = NonNullable<ReadState["usage"]>[number]["models"][number];
const meter = (m: Model) =>
  `${m.label ?? m.model}: ${m.limit > 0 ? `${m.used} of ${m.limit}` : m.used} ${m.unit} · ${m.window}${m.limit > 0 ? "" : ", no cap"}`;

export function ReadPanel(p: ReadPanelProps) {
  if (!p.capabilities.has("read")) return null;
  const { state } = p;
  if (state.open) {
    const o = state.open;
    return (
      <section className="web-read" aria-label={`Chat: ${o.title}`}>
        <header className="web-read-head">
          <h2>{o.title}</h2>
          <span className="chat-muted">Read-only</span>
          <button type="button" onClick={p.onClose}>Back to the phone chat</button>
        </header>
        {state.error && <StatusBanner severity="error" message={state.error} />}
        {o.nextBeforeSeq != null && <button type="button" onClick={p.onOlder} disabled={state.loading}>Show older</button>}
        <ul className="web-list">
          {o.messages.map((m) => m.role === "user"
            ? <li key={m.seq} className="web-msg web-user">{m.content}</li>
            : <li key={m.seq} className="web-msg web-assistant"><Markdown text={m.content} onOpenLink={openLink} /></li>)}
        </ul>
      </section>
    );
  }
  return (
    <aside className="web-read" aria-label="Chats and usage">
      {state.error && <StatusBanner severity="error" message={state.error} />}
      {state.usage && (
        <section aria-label="Usage">
          <h2>Usage</h2>
          {state.usage.map((prov) => (
            <ul key={prov.provider} className="web-read-usage">
              {prov.models.map((m) => <li key={m.model} data-state={m.state}>{meter(m)}</li>)}
            </ul>
          ))}
        </section>
      )}
      <section aria-label="Chats">
        <h2>Chats</h2>
        <ul className="web-read-chats">
          {state.sessions.map((c) => (
            <li key={c.id}>
              {c.phoneChat
                ? <span>{c.title} (this device)</span>
                : <button type="button" onClick={() => p.onOpen(c.id, c.title)}>{c.title}</button>}
            </li>
          ))}
        </ul>
        {state.nextOffset != null && <button type="button" onClick={p.onMore} disabled={state.loading}>More chats</button>}
      </section>
    </aside>
  );
}
```

The test expects `m2: 5 tokens · monthly, no cap`, and `meter` produces exactly that: when `limit` is 0 it prints `used`, then the unit and window, then `, no cap`. The phone chat is shown but not opened here: it is the live chat in `WebChat` already.

- [ ] **Step 4: Wire it into the session and App**

`web/src/app-model.ts`:

```ts
import { createReadController, type ReadController } from "./read/controller.ts";

export interface Session { url: string; tokens: TokenStore; connection: HostConnection; controller: ChatController; read: ReadController }
```

In `open`: `return { url, tokens, connection, controller: createChatController(connection), read: createReadController(connection) };`
In `shut`: `const shut = (s: Session) => { s.controller.dispose(); s.read.dispose(); s.connection.close(); };`

`web/src/App.tsx`, in `Chat`:

```tsx
import { ReadPanel } from "./screens/ReadPanel.tsx";

function Chat({ session, onForget }: { session: Session; onForget: () => void }) {
  const { connection: c, controller, read } = session;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const readState = useSyncExternalStore(read.subscribe, read.getState, read.getState);
  const [conn, setConn] = useState<ConnectionState>(c.state);
  useEffect(() => c.onState(setConn), [c]);
  const capabilities = state.capabilities ?? c.capabilities;
  useEffect(() => { if (conn.kind === "ready") void read.refresh(); }, [read, conn.kind]);
  return (
    <div className="web-shell">
      <ReadPanel capabilities={capabilities} state={readState} onOpen={(id, t) => void read.open(id, t)}
        onOlder={() => void read.older()} onClose={read.close} onMore={() => void read.moreSessions()} />
      {!readState.open && (
        <WebChat hostName={c.hello?.hostName ?? "Host"} connection={conn} capabilities={capabilities} state={state}
          onSend={(t) => void controller.send(t)} onStop={() => void controller.cancel()} onClear={() => void controller.clearHistory()}
          onForget={onForget} onAnswer={(r, a) => void controller.answerQuestion(r, a)} onDecline={(r) => void controller.declineQuestion(r)}
          onTool={(r, d) => void controller.answerTool(r, d)} />
      )}
    </div>
  );
}
```

While a past chat is open, `WebChat` is unmounted. A live turn keeps running on the host, and its events still reach the chat controller, which stays subscribed. Coming back shows the reply because the controller state survives. The one exception is approval cards, which only appear once the user returns. That limit is acceptable for a read-only view, and Step 6 records it in `MANUAL-CHECK.md`.

Append to `web/src/web.css`:

```css
.web-shell { display: flex; flex-wrap: wrap; gap: 16px; }
.web-read { flex: 1 1 260px; max-width: 100%; min-width: 0; }
.web-read-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.web-read-usage, .web-read-chats { list-style: none; margin: 0; padding: 0; }
.web-read-usage li[data-state="warning"], .web-read-usage li[data-state="exhausted"] { font-weight: 600; }
.web-read-chats button { all: unset; cursor: pointer; text-decoration: underline; overflow-wrap: anywhere; }
.web-read-chats button:focus-visible { outline: 2px solid currentColor; }
```

- [ ] **Step 5: Run the web suite**

Run: `cd /Users/dinsmallade/llm-ide/web && npm test && npx tsc --noEmit -p .`
Expected: PASS. `tests/app.test.mjs` builds sessions through `createAppModel`, so it picks up `read` automatically. If a test constructs a `Session` literal, add `read: createReadController(link)` there.

- [ ] **Step 6: Docs and master plan**

In `web/MANUAL-CHECK.md` add a section:

```markdown
## Read views (desktop core started with LLMIDE_HOST_API_READ=1, browser paired AFTER the switch)
- The panel shows Usage (one line per model) and Chats; the phone chat reads "(this device)".
- Opening a chat shows "Read-only", no composer; Show older pages back; Back returns to the phone chat.
- A browser paired before the switch shows no panel (it must re-pair).
- While a past chat is open, a running reply's approval cards appear only after Back.
```

In `docs/superpowers/MASTER-PLAN.md`, change line 240 so it records the slice and keeps the rest open:

```markdown
- [ ] Host API v1 commands beyond chat: read-only sessions, usage, Auto Tasks status, Explorer read, Library read, so the web client and a phone paired to a Host API v1 host (desktop) get more than chat and approvals (the phone skips every v2-only screen on v1, `ios_app/MyApp/Views/RootTabView.swift`); plan it through the command bus spec (`plans/2026-10-31-command-bus-spec.md`) (me). Slice 1 (`read`: `chat.sessions`, `chat.history`, `usage.get`, desktop host + web, switch `LLMIDE_HOST_API_READ`, default off): `plans/2026-11-05-host-api-v1-read-commands.md`; next: iOS v1 screens, Mac host parity, Library read, then Auto Tasks status over the bus job store; Explorer stays native-only
```

On line 239, append ` (sessions list + read-only history + usage strip land with the read slice above)`.

- [ ] **Step 7: Full gates**

Run: `cd /Users/dinsmallade/llm-ide && make host-api-check && make test && (cd web && npm test && npx tsc --noEmit -p .)`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add web/src/screens/ReadPanel.tsx web/src/app-model.ts web/src/App.tsx web/src/web.css web/tests/ui-entry.ts \
  web/tests/screens.test.mjs web/MANUAL-CHECK.md docs/superpowers/MASTER-PLAN.md
git commit -m "feat(web): show chats, read-only history and usage on Host API v1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage.** Chat session list: Tasks 1-3 and 5-6. Open an existing chat: `chat.history`, read-only; switching is Decision 2, deferred. Usage/limits: `usage.get`. Auto Tasks status: deferred, because the desktop core has no data source (audit F8). Explorer/Library: deferred with reasons (Scope, Decision 6). No writes and no execution: all three commands are idempotent reads, and `chat.send` is unchanged. Scope/grant decision: Decision 1 plus the gateway's existing served ∩ granted check, tested in Task 3. Pagination/size caps: `limit` maxima, `nextOffset`/`nextBeforeSeq`, `maxListBytes` trim, provider/model caps, a per-device read bucket, client memory caps. Per-user scoping: Task 4. No secrets: re-redaction plus closed schemas validated again by `respond()`. Audit: Decision 5. Versioning: no `SERVER_API_VERSION` bump, since only v1 frames change. Mac: compile-only. iOS: follow-up. Bus alignment: same names, tier R.
- **Placeholder scan.** Every step has code or an exact command. Two spots defer to tool output: the `at` paths in `invalid-cases.json` (Task 1 Step 4), and the generated Swift case names (Task 1 Step 6). Each says which command output is authoritative.
- **Type consistency.** `sessionsOf(rows, limit, offset, phoneChatId)`, `historyOf(session, limit)` and `usageOf(summary)` match between Tasks 2 and 3. `deps.read.{sessions,history,usage}` match between Tasks 3 and 4. `nextOffset`/`nextBeforeSeq` match across schema, mappers, controller and panel. `READ_LIMITS.historyDefault = 100` equals `HISTORY_PAGE = 100` on the web.
