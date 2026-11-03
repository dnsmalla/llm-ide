# Host API v1 contract implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Host API v1 contract executable: machine-checked frame schemas, a command registry, event schemas, conformance fixtures and generated command constants.

**Architecture:** JSON Schema files under `schema/host-api/v1` describe the envelope, commands and events. A dependency-free Node conformance script validates the registry and every fixture, then verifies generated Node/Swift constants are current. This plan deliberately has no host adapter and no client: it is the contract foundation for the adapter plans that follow.

**Tech Stack:** Node 20, existing dependency-free JSON Schema validator at `extension/routes/bus/schema-validate.mjs`, `node:test`, JSON Schema subset already used by `schema/bus`.

**Spec:** `docs/superpowers/specs/2026-11-03-host-api-design.md`

## Global Constraints

- `apiVersion` is always the integer `1` in v1 frames.
- Envelope frames are UTF-8 JSON and max **1,048,576 bytes**.
- Lists default to **100** items and never exceed **500**.
- Error messages are at most **500 characters**.
- Stable error codes are exactly: `auth_failed`, `capability_unavailable`, `unknown_command`, `invalid_payload`, `not_found`, `busy`, `denied`, `desktop_only`, `rate_limited`, `host_unreachable`, `internal`.
- A command has exactly one capability; every capability is listed in `capabilities`.
- Existing MobileProtocol v2 is untouched. This plan only adds `schema/host-api/v1`.
- No new npm dependency.
- Every command fixture must have both a request and a result.
- Generated files are checked in and drift-checked; never hand-edit them.

## Scope of this plan

The spec has six independently deliverable subsystems: contract, Mac adapter, desktop adapter, iOS transport, web client, TLS hardening. This is **Plan 1 (contract foundation)**. It covers `host.*`, `chat.*`, `approvals.*` and `toolApprovals.*` only; later plans add the remaining domains using the same machinery. Each later plan is self-contained and independently testable.

---

## File Structure

- `schema/host-api/v1/envelope.schema.json` — frame envelope and error shape.
- `schema/host-api/v1/commands.schema.json` — registry shape.
- `schema/host-api/v1/commands.json` — command table: capability, idempotency, request/result schemas, optional v2 tag.
- `schema/host-api/v1/events.schema.json` — event union for the initial slice.
- `schema/host-api/v1/fixtures/valid/` — valid envelope frames.
- `schema/host-api/v1/fixtures/invalid/` — invalid frames with expected failing path.
- `schema/host-api/v1/fixtures/commands/` — one request and one result per command.
- `schema/host-api/v1/fixtures/events/` — one event per event variant.
- `extension/tests/host-api-contract.test.mjs` — unit tests for the contract.
- `scripts/conformance-host-api.mjs` — the gate.
- `scripts/generate-host-api.mjs` — generates command constants.
- `extension/routes/host-api/commands.generated.mjs` — generated Node constants.
- `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift` — generated Swift constants.
- `Makefile` — add `host-api-check` and wire it into `contract-gates`.

---

### Task 1: Envelope schema and valid/invalid fixtures

**Files:**
- Create: `schema/host-api/v1/envelope.schema.json`
- Create: `schema/host-api/v1/fixtures/valid/request.json`
- Create: `schema/host-api/v1/fixtures/valid/response.json`
- Create: `schema/host-api/v1/fixtures/valid/event.json`
- Create: `schema/host-api/v1/fixtures/valid/error.json`
- Create: `schema/host-api/v1/fixtures/invalid/missing-api-version.json`
- Create: `schema/host-api/v1/fixtures/invalid/bad-request-id.json`
- Create: `schema/host-api/v1/fixtures/invalid/unknown-field.json`
- Create: `extension/tests/host-api-contract.test.mjs`

**Interfaces:**
- Produces: `validate(schema, value, { defs }, path)` usage for the envelope; fixtures consumed by Task 4's conformance script.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/host-api-contract.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../routes/bus/schema-validate.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "schema", "host-api", "v1");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const envelope = json("envelope.schema.json");
const check = (value) => validate(envelope, value, { defs: envelope.$defs });

test("host-api envelope: valid request/response/event/error frames pass", () => {
  for (const f of ["request", "response", "event", "error"]) {
    assert.deepEqual(check(json(`fixtures/valid/${f}.json`)), [], f);
  }
});

test("host-api envelope: missing version, bad id and unknown fields fail", () => {
  assert.ok(check(json("fixtures/invalid/missing-api-version.json")).length > 0);
  assert.ok(check(json("fixtures/invalid/bad-request-id.json")).length > 0);
  assert.ok(check(json("fixtures/invalid/unknown-field.json")).length > 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: FAIL with `ENOENT` for `schema/host-api/v1/envelope.schema.json`.

- [ ] **Step 3: Write the schema and fixtures**

`envelope.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llm-ide.local/schema/host-api/v1/envelope.schema.json",
  "title": "HostApiFrame",
  "$defs": {
    "ErrorCode": {
      "type": "string",
      "enum": ["auth_failed", "capability_unavailable", "unknown_command", "invalid_payload", "not_found", "busy", "denied", "desktop_only", "rate_limited", "host_unreachable", "internal"]
    },
    "Error": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "retryable"],
      "properties": {
        "code": { "$ref": "#/$defs/ErrorCode" },
        "message": { "type": "string", "minLength": 1, "maxLength": 500 },
        "retryable": { "type": "boolean" },
        "details": { "type": "object" }
      }
    },
    "Request": {
      "type": "object",
      "additionalProperties": false,
      "required": ["apiVersion", "id", "type", "command", "payload", "ts"],
      "properties": {
        "apiVersion": { "type": "integer", "const": 1 },
        "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "replyTo": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "type": { "type": "string", "const": "request" },
        "command": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*\\.[a-z][A-Za-z0-9]*$" },
        "payload": { "type": "object" },
        "ts": { "type": "integer", "minimum": 0 },
        "rev": { "type": "integer", "minimum": 0 }
      }
    },
    "Response": {
      "type": "object",
      "additionalProperties": false,
      "required": ["apiVersion", "id", "replyTo", "type", "command", "result", "ts"],
      "properties": {
        "apiVersion": { "type": "integer", "const": 1 },
        "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "replyTo": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "type": { "type": "string", "const": "response" },
        "command": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*\\.[a-z][A-Za-z0-9]*$" },
        "result": { "type": "object" },
        "ts": { "type": "integer", "minimum": 0 },
        "rev": { "type": "integer", "minimum": 0 }
      }
    },
    "Event": {
      "type": "object",
      "additionalProperties": false,
      "required": ["apiVersion", "id", "type", "command", "payload", "ts", "rev"],
      "properties": {
        "apiVersion": { "type": "integer", "const": 1 },
        "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "replyTo": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "type": { "type": "string", "const": "event" },
        "command": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*\\.[a-z][A-Za-z0-9]*$" },
        "payload": { "type": "object" },
        "ts": { "type": "integer", "minimum": 0 },
        "rev": { "type": "integer", "minimum": 0 }
      }
    },
    "ErrorFrame": {
      "type": "object",
      "additionalProperties": false,
      "required": ["apiVersion", "id", "type", "error", "ts"],
      "properties": {
        "apiVersion": { "type": "integer", "const": 1 },
        "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "replyTo": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "type": { "type": "string", "const": "error" },
        "command": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*\\.[a-z][A-Za-z0-9]*$" },
        "error": { "$ref": "#/$defs/Error" },
        "ts": { "type": "integer", "minimum": 0 }
      }
    }
  },
  "oneOf": [
    { "$ref": "#/$defs/Request" },
    { "$ref": "#/$defs/Response" },
    { "$ref": "#/$defs/Event" },
    { "$ref": "#/$defs/ErrorFrame" }
  ]
}
```

Fixtures (exact values):

`fixtures/valid/request.json`:

```json
{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1760000000000}
```

`fixtures/valid/response.json`:

```json
{"apiVersion":1,"id":"s-1","replyTo":"c-1","type":"response","command":"host.ping","result":{},"ts":1760000000001,"rev":1}
```

`fixtures/valid/event.json`:

```json
{"apiVersion":1,"id":"e-1","type":"event","command":"chat.delta","payload":{"text":"hi"},"ts":1760000000002,"rev":2}
```

`fixtures/valid/error.json`:

```json
{"apiVersion":1,"id":"e-2","replyTo":"c-1","type":"error","error":{"code":"denied","message":"not allowed","retryable":false},"ts":1760000000003}
```

`fixtures/invalid/missing-api-version.json`:

```json
{"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1760000000000}
```

`fixtures/invalid/bad-request-id.json`:

```json
{"apiVersion":1,"id":"bad id!","type":"request","command":"host.ping","payload":{},"ts":1760000000000}
```

`fixtures/invalid/unknown-field.json`:

```json
{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1760000000000,"surprise":true}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add schema/host-api/v1 extension/tests/host-api-contract.test.mjs
git commit -m "feat(host-api): add the v1 frame envelope and fixtures"
```

---

### Task 2: Command registry schema and host/auth commands

**Files:**
- Create: `schema/host-api/v1/commands.schema.json`
- Create: `schema/host-api/v1/commands.json`
- Create: `schema/host-api/v1/fixtures/commands/host.hello.request.json`
- Create: `schema/host-api/v1/fixtures/commands/host.hello.result.json`
- Create: `schema/host-api/v1/fixtures/commands/host.auth.pair.request.json`
- Create: `schema/host-api/v1/fixtures/commands/host.auth.pair.result.json`
- Create: `schema/host-api/v1/fixtures/commands/host.auth.token.request.json`
- Create: `schema/host-api/v1/fixtures/commands/host.auth.token.result.json`
- Create: `schema/host-api/v1/fixtures/commands/host.auth.revoke.request.json`
- Create: `schema/host-api/v1/fixtures/commands/host.auth.revoke.result.json`
- Create: `schema/host-api/v1/fixtures/commands/host.ping.request.json`
- Create: `schema/host-api/v1/fixtures/commands/host.ping.result.json`
- Create: `schema/host-api/v1/fixtures/commands/host.snapshot.request.json`
- Create: `schema/host-api/v1/fixtures/commands/host.snapshot.result.json`
- Modify: `extension/tests/host-api-contract.test.mjs`

**Interfaces:**
- Produces: `commands.json` entries `{ capability, direction, idempotent, v2Tag, request, result }`; Task 4 and Task 5 read this shape.

- [ ] **Step 1: Write the failing test**

Append to `extension/tests/host-api-contract.test.mjs`:

```js
const commandsSchema = json("commands.schema.json");
const commands = json("commands.json");
const commandEntry = (name) => commands.commands[name];

test("host-api command registry: host commands have a capability and exact schemas", () => {
  assert.deepEqual(validate(commandsSchema, commands, { defs: commandsSchema.$defs }), []);
  for (const name of ["host.hello", "host.auth.pair", "host.auth.token", "host.auth.revoke", "host.ping", "host.snapshot"]) {
    const c = commandEntry(name);
    assert.ok(c, `${name} exists`);
    assert.equal(c.capability, "host", name);
    assert.equal(c.request.type, "object", `${name} request`);
    assert.equal(c.result.type, "object", `${name} result`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: FAIL with `ENOENT` for `commands.schema.json`.

- [ ] **Step 3: Write the registry and fixtures**

`commands.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llm-ide.local/schema/host-api/v1/commands.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "limits", "capabilities", "commands"],
  "properties": {
    "version": { "type": "integer", "const": 1 },
    "limits": {
      "type": "object",
      "additionalProperties": false,
      "required": ["maxFrameBytes", "defaultListItems", "maxListItems"],
      "properties": {
        "maxFrameBytes": { "type": "integer", "const": 1048576 },
        "defaultListItems": { "type": "integer", "const": 100 },
        "maxListItems": { "type": "integer", "const": 500 }
      }
    },
    "capabilities": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
      "minItems": 1
    },
    "commands": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["capability", "direction", "idempotent", "v2Tag", "request", "result"],
        "properties": {
          "capability": { "type": "string" },
          "direction": { "type": "string", "enum": ["client_to_host"] },
          "idempotent": { "type": "boolean" },
          "v2Tag": { "type": ["string", "null"] },
          "request": { "type": "object" },
          "result": { "type": "object" }
        }
      }
    }
  }
}
```

`commands.json` (host/auth slice):

```json
{
  "version": 1,
  "limits": { "maxFrameBytes": 1048576, "defaultListItems": 100, "maxListItems": 500 },
  "capabilities": ["host", "chat", "approvals", "tool_approvals"],
  "commands": {
    "host.hello": {
      "capability": "host", "direction": "client_to_host", "idempotent": true, "v2Tag": null,
      "request": {"type":"object","additionalProperties":false,"required":["clientName","clientVersion","platform","apiVersions"],"properties":{"clientName":{"type":"string","minLength":1,"maxLength":120},"clientVersion":{"type":"string","minLength":1,"maxLength":64},"platform":{"type":"string","enum":["ios","web","desktop","mac"]},"apiVersions":{"type":"array","items":{"type":"integer","minimum":1},"minItems":1}}},
      "result": {"type":"object","additionalProperties":false,"required":["hostName","hostKind","apiVersion","capabilities","protocolVersion","requiresAuth"],"properties":{"hostName":{"type":"string","minLength":1,"maxLength":120},"hostKind":{"type":"string","enum":["mac","desktop"]},"apiVersion":{"type":"integer","const":1},"capabilities":{"type":"array","items":{"type":"string"},"minItems":1},"protocolVersion":{"type":"integer","minimum":1},"requiresAuth":{"type":"boolean"},"certificateFingerprint":{"type":"string","maxLength":200}}}
    },
    "host.auth.pair": {
      "capability": "host", "direction": "client_to_host", "idempotent": false, "v2Tag": "pairing",
      "request": {"type":"object","additionalProperties":false,"required":["pin"],"properties":{"pin":{"type":"string","pattern":"^[0-9]{6}$"}}},
      "result": {"type":"object","additionalProperties":false,"required":["token","capabilities"],"properties":{"token":{"type":"string","minLength":16,"maxLength":512},"capabilities":{"type":"array","items":{"type":"string"},"minItems":1}}}
    },
    "host.auth.token": {
      "capability": "host", "direction": "client_to_host", "idempotent": true, "v2Tag": null,
      "request": {"type":"object","additionalProperties":false,"required":["token"],"properties":{"token":{"type":"string","minLength":16,"maxLength":512}}},
      "result": {"type":"object","additionalProperties":false,"required":["capabilities"],"properties":{"capabilities":{"type":"array","items":{"type":"string"},"minItems":1}}}
    },
    "host.auth.revoke": {
      "capability": "host", "direction": "client_to_host", "idempotent": true, "v2Tag": null,
      "request": {"type":"object","additionalProperties":false,"required":["token"],"properties":{"token":{"type":"string","minLength":16,"maxLength":512}}},
      "result": {"type":"object","additionalProperties":false,"required":["revoked"],"properties":{"revoked":{"type":"boolean"}}}
    },
    "host.ping": {
      "capability": "host", "direction": "client_to_host", "idempotent": true, "v2Tag": "heartbeat",
      "request": {"type":"object","additionalProperties":false,"properties":{}},
      "result": {"type":"object","additionalProperties":false,"required":["rev"],"properties":{"rev":{"type":"integer","minimum":0}}}
    },
    "host.snapshot": {
      "capability": "host", "direction": "client_to_host", "idempotent": true, "v2Tag": null,
      "request": {"type":"object","additionalProperties":false,"required":["topics"],"properties":{"topics":{"type":"array","items":{"type":"string","enum":["chat","status","autotasks","loop"]},"minItems":1,"maxItems":4}}},
      "result": {"type":"object","additionalProperties":false,"required":["rev","snapshots"],"properties":{"rev":{"type":"integer","minimum":0},"snapshots":{"type":"object"}}}
    }
  }
}
```

Fixtures (exact values):

`host.hello.request.json`:

```json
{"clientName":"iPhone","clientVersion":"2.0","platform":"ios","apiVersions":[1]}
```

`host.hello.result.json`:

```json
{"hostName":"Dinsh's MacBook","hostKind":"mac","apiVersion":1,"capabilities":["host","chat","approvals"],"protocolVersion":3,"requiresAuth":true,"certificateFingerprint":"sha256:00"}
```

`host.auth.pair.request.json`:

```json
{"pin":"123456"}
```

`host.auth.pair.result.json`:

```json
{"token":"0123456789abcdef0123456789abcdef","capabilities":["host","chat"]}
```

`host.auth.token.request.json`:

```json
{"token":"0123456789abcdef0123456789abcdef"}
```

`host.auth.token.result.json`:

```json
{"capabilities":["host","chat"]}
```

`host.auth.revoke.request.json`:

```json
{"token":"0123456789abcdef0123456789abcdef"}
```

`host.auth.revoke.result.json`:

```json
{"revoked":true}
```

`host.ping.request.json`:

```json
{}
```

`host.ping.result.json`:

```json
{"rev":7}
```

`host.snapshot.request.json`:

```json
{"topics":["chat"]}
```

`host.snapshot.result.json`:

```json
{"rev":7,"snapshots":{"chat":{"messages":[]}}}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add schema/host-api/v1 extension/tests/host-api-contract.test.mjs
git commit -m "feat(host-api): add the host command registry"
```

---

### Task 3: Chat/approval commands, events and fixtures

**Files:**
- Modify: `schema/host-api/v1/commands.json`
- Create: `schema/host-api/v1/events.schema.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.send.request.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.send.result.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.snapshot.request.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.snapshot.result.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.cancel.request.json`
- Create: `schema/host-api/v1/fixtures/commands/chat.cancel.result.json`
- Create: `schema/host-api/v1/fixtures/commands/approvals.answer.request.json`
- Create: `schema/host-api/v1/fixtures/commands/approvals.answer.result.json`
- Create: `schema/host-api/v1/fixtures/commands/toolApprovals.answer.request.json`
- Create: `schema/host-api/v1/fixtures/commands/toolApprovals.answer.result.json`
- Create: `schema/host-api/v1/fixtures/events/chat.delta.json`
- Create: `schema/host-api/v1/fixtures/events/approval.request.json`
- Modify: `extension/tests/host-api-contract.test.mjs`

**Interfaces:**
- Produces: `events.schema.json` with one variant per event; command registry adds `chat.*`, `approvals.answer` and `toolApprovals.answer`.

- [ ] **Step 1: Write the failing test**

Append:

```js
const events = json("events.schema.json");

test("host-api chat commands and events decode", () => {
  for (const name of ["chat.send", "chat.snapshot", "chat.cancel", "approvals.answer", "toolApprovals.answer"]) {
    assert.ok(commands.commands[name], name);
  }
  assert.deepEqual(validate(events, json("fixtures/events/chat.delta.json"), { defs: events.$defs }), []);
  assert.deepEqual(validate(events, json("fixtures/events/approval.request.json"), { defs: events.$defs }), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: FAIL with `ENOENT` for `events.schema.json`.

- [ ] **Step 3: Write the commands and events**

Add to `commands.json` (inside `commands`):

```json
"chat.snapshot": {
  "capability": "chat", "direction": "client_to_host", "idempotent": true, "v2Tag": "llmide_chat_history_list",
  "request": {"type":"object","additionalProperties":false,"properties":{"limit":{"type":"integer","minimum":1,"maximum":500}}},
  "result": {"type":"object","additionalProperties":false,"required":["messages"],"properties":{"messages":{"type":"array","items":{"type":"object"},"maxItems":500},"rev":{"type":"integer","minimum":0}}}
},
"chat.send": {
  "capability": "chat", "direction": "client_to_host", "idempotent": false, "v2Tag": "llmide_chat",
  "request": {"type":"object","additionalProperties":false,"required":["text"],"properties":{"text":{"type":"string","minLength":1,"maxLength":100000},"attachments":{"type":"array","items":{"type":"object"},"maxItems":10}}},
  "result": {"type":"object","additionalProperties":false,"required":["accepted"],"properties":{"accepted":{"type":"boolean"},"requestId":{"type":"string","maxLength":64}}}
},
"chat.cancel": {
  "capability": "chat", "direction": "client_to_host", "idempotent": true, "v2Tag": "llmide_cancel",
  "request": {"type":"object","additionalProperties":false,"properties":{}},
  "result": {"type":"object","additionalProperties":false,"required":["cancelled"],"properties":{"cancelled":{"type":"boolean"}}}
},
"approvals.answer": {
  "capability": "approvals", "direction": "client_to_host", "idempotent": false, "v2Tag": "approval_answer",
  "request": {"type":"object","additionalProperties":false,"required":["requestId","answer"],"properties":{"requestId":{"type":"string","minLength":1,"maxLength":64},"answer":{"type":"object"}}},
  "result": {"type":"object","additionalProperties":false,"required":["accepted"],"properties":{"accepted":{"type":"boolean"}}}
},
"toolApprovals.answer": {
  "capability": "tool_approvals", "direction": "client_to_host", "idempotent": false, "v2Tag": "tool_approval_answer",
  "request": {"type":"object","additionalProperties":false,"required":["requestId","decision"],"properties":{"requestId":{"type":"string","minLength":1,"maxLength":64},"decision":{"type":"string","enum":["allow_once","deny"]}}},
  "result": {"type":"object","additionalProperties":false,"required":["accepted"],"properties":{"accepted":{"type":"boolean"}}}
}
```

`events.schema.json` (flat variants; the dependency-free validator has no `allOf`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llm-ide.local/schema/host-api/v1/events.schema.json",
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["apiVersion", "id", "type", "command", "payload", "ts", "rev"],
      "properties": {
        "apiVersion": { "type": "integer", "const": 1 },
        "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "type": { "type": "string", "const": "event" },
        "command": { "type": "string", "const": "chat.delta" },
        "payload": { "type": "object", "additionalProperties": false, "required": ["text"], "properties": { "text": { "type": "string", "maxLength": 100000 } } },
        "ts": { "type": "integer", "minimum": 0 },
        "rev": { "type": "integer", "minimum": 0 }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["apiVersion", "id", "type", "command", "payload", "ts", "rev"],
      "properties": {
        "apiVersion": { "type": "integer", "const": 1 },
        "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" },
        "type": { "type": "string", "const": "event" },
        "command": { "type": "string", "const": "approval.request" },
        "payload": { "type": "object", "additionalProperties": false, "required": ["requestId", "question"], "properties": { "requestId": { "type": "string" }, "question": { "type": "string", "maxLength": 2000 } } },
        "ts": { "type": "integer", "minimum": 0 },
        "rev": { "type": "integer", "minimum": 0 }
      }
    }
  ]
}
```

The variants are deliberately duplicated: the existing validator supports `oneOf` but not `allOf`, and this plan does not change that shared validator.

Fixtures:

`fixtures/events/chat.delta.json`:

```json
{"apiVersion":1,"id":"e-1","type":"event","command":"chat.delta","payload":{"text":"hi"},"ts":1760000000002,"rev":2}
```

`fixtures/events/approval.request.json`:

```json
{"apiVersion":1,"id":"e-2","type":"event","command":"approval.request","payload":{"requestId":"a-1","question":"Run it?"},"ts":1760000000003,"rev":3}
```

Command fixtures:

`chat.send.request.json`:

```json
{"text":"hello"}
```

`chat.send.result.json`:

```json
{"accepted":true,"requestId":"r-1"}
```

`chat.snapshot.request.json`:

```json
{"limit":100}
```

`chat.snapshot.result.json`:

```json
{"messages":[],"rev":4}
```

`chat.cancel.request.json`:

```json
{}
```

`chat.cancel.result.json`:

```json
{"cancelled":true}
```

`approvals.answer.request.json`:

```json
{"requestId":"a-1","answer":{"choice":"yes"}}
```

`approvals.answer.result.json`:

```json
{"accepted":true}
```

`toolApprovals.answer.request.json`:

```json
{"requestId":"t-1","decision":"allow_once"}
```

`toolApprovals.answer.result.json`:

```json
{"accepted":true}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add schema/host-api/v1 extension/tests/host-api-contract.test.mjs
git commit -m "feat(host-api): add chat and approval commands plus events"
```

---

### Task 4: Conformance gate

**Files:**
- Create: `scripts/conformance-host-api.mjs`
- Create: `schema/host-api/v1/fixtures/invalid/bad-command-shape.json`
- Modify: `Makefile`
- Modify: `extension/tests/host-api-contract.test.mjs`

**Interfaces:**
- Produces: `node scripts/conformance-host-api.mjs` exits `0` on a valid contract and prints one line per check; `make host-api-check`.

- [ ] **Step 1: Write the failing test**

Append:

```js
import { spawnSync } from "node:child_process";

test("host-api conformance script passes", () => {
  const r = spawnSync(process.execPath, ["scripts/conformance-host-api.mjs"], { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: FAIL because `scripts/conformance-host-api.mjs` does not exist.

- [ ] **Step 3: Write the script and Make target**

`scripts/conformance-host-api.mjs` must:

```js
#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../extension/routes/bus/schema-validate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "schema/host-api/v1");
const read = (p) => JSON.parse(readFileSync(join(DIR, p), "utf8"));
const problems = [];
const bad = (m) => problems.push(m);

const envelope = read("envelope.schema.json");
const commandsSchema = read("commands.schema.json");
const commands = read("commands.json");
const events = read("events.schema.json");
const defs = envelope.$defs;

for (const f of readdirSync(join(DIR, "fixtures/valid"))) {
  if (!f.endsWith(".json")) continue;
  const errs = validate(envelope, read(`fixtures/valid/${f}`), { defs });
  if (errs.length) bad(`valid/${f}: ${JSON.stringify(errs)}`);
}
for (const f of readdirSync(join(DIR, "fixtures/invalid"))) {
  if (!f.endsWith(".json")) continue;
  const errs = validate(envelope, read(`fixtures/invalid/${f}`), { defs });
  if (errs.length === 0) bad(`invalid/${f}: expected a validation failure`);
}
if (validate(commandsSchema, commands, { defs: commandsSchema.$defs }).length) bad("commands.json does not match commands.schema.json");

const caps = new Set(commands.capabilities);
const names = Object.keys(commands.commands);
if (new Set(names).size !== names.length) bad("duplicate command names");
for (const name of names) {
  if (!/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(name)) bad(`bad command name: ${name}`);
  const c = commands.commands[name];
  if (!caps.has(c.capability)) bad(`${name}: capability ${c.capability} is not listed`);
  const req = read(`fixtures/commands/${name}.request.json`);
  const res = read(`fixtures/commands/${name}.result.json`);
  for (const [kind, schema, value] of [["request", c.request, req], ["result", c.result, res]]) {
    const errs = validate(schema, value, { defs });
    if (errs.length) bad(`${name} ${kind}: ${JSON.stringify(errs)}`);
  }
  if (Buffer.byteLength(JSON.stringify(req)) > commands.limits.maxFrameBytes) bad(`${name}: request fixture too large`);
}
for (const f of readdirSync(join(DIR, "fixtures/events"))) {
  if (!f.endsWith(".json")) continue;
  const errs = validate(events, read(`fixtures/events/${f}`), { defs: events.$defs });
  if (errs.length) bad(`events/${f}: ${JSON.stringify(errs)}`);
}
if (problems.length) {
  for (const p of problems) console.error(`conformance-host-api: ${p}`);
  process.exit(1);
}
console.log(`conformance-host-api: ok (${names.length} commands)`);
```

Add to `Makefile`:

```make
.PHONY: host-api-check
host-api-check:
	node scripts/conformance-host-api.mjs
```

Add `$(MAKE) host-api-check` inside `contract-gates`.

Create `fixtures/invalid/bad-command-shape.json` with a request missing `command`:

```json
{"apiVersion":1,"id":"c-1","type":"request","payload":{},"ts":1}
```

- [ ] **Step 4: Run the test and the gate**

Run:

```bash
cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs
cd .. && node scripts/conformance-host-api.mjs
make host-api-check
```

Expected: PASS; `conformance-host-api: ok (11 commands)`.

- [ ] **Step 5: Commit**

```bash
git add scripts/conformance-host-api.mjs schema/host-api/v1/fixtures/invalid/bad-command-shape.json Makefile extension/tests/host-api-contract.test.mjs
git commit -m "test(host-api): add the contract conformance gate"
```

---

### Task 5: Generated command constants

**Files:**
- Create: `scripts/generate-host-api.mjs`
- Create: `extension/routes/host-api/commands.generated.mjs`
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift`
- Modify: `scripts/conformance-host-api.mjs`
- Modify: `extension/tests/host-api-contract.test.mjs`

**Interfaces:**
- Produces: `HOST_API_VERSION`, `HOST_API_COMMANDS` and Swift `HostApi.version` / `HostApi.commands`.
- Consumes: `commands.json`.

- [ ] **Step 1: Write the failing test**

Append:

```js
test("generated Host API constants match the registry", () => {
  const r = spawnSync(process.execPath, ["scripts/generate-host-api.mjs", "--check"], { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: FAIL because `scripts/generate-host-api.mjs` does not exist.

- [ ] **Step 3: Write the generator**

`scripts/generate-host-api.mjs`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(ROOT, "schema/host-api/v1/commands.json"), "utf8"));
const names = Object.keys(registry.commands).sort();
const check = process.argv.includes("--check");

const js = `// GENERATED by scripts/generate-host-api.mjs from schema/host-api/v1/commands.json. Do not edit.\nexport const HOST_API_VERSION = ${registry.version};\nexport const HOST_API_LIMITS = Object.freeze(${JSON.stringify(registry.limits)});\nexport const HOST_API_COMMANDS = Object.freeze({\n${names.map((n) => `  ${JSON.stringify(n)}: Object.freeze({ capability: ${JSON.stringify(registry.commands[n].capability)}, idempotent: ${registry.commands[n].idempotent} })`).join(",\n")}\n});\n`;

const swift = `// GENERATED by scripts/generate-host-api.mjs from schema/host-api/v1/commands.json. Do not edit.\nimport Foundation\n\npublic enum HostApi {\n    public static let version = ${registry.version}\n    public static let commands: [String: String] = [\n${names.map((n) => `        ${JSON.stringify(n)}: ${JSON.stringify(registry.commands[n].capability)}`).join(",\n")}\n    ]\n}\n`;

const outputs = [
  ["extension/routes/host-api/commands.generated.mjs", js],
  ["ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift", swift],
];

let stale = false;
for (const [rel, content] of outputs) {
  const path = join(ROOT, rel);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      console.error(`host-api: ${rel} is stale (run node scripts/generate-host-api.mjs)`);
      stale = true;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
if (stale) process.exit(1);
if (!check) console.log(`host-api: wrote ${outputs.length} generated files`);
```

Run:

```bash
node scripts/generate-host-api.mjs
```

- [ ] **Step 4: Wire the drift check and verify**

Add to `scripts/conformance-host-api.mjs` before the final error block:

```js
import { spawnSync } from "node:child_process";
const gen = spawnSync(process.execPath, [join(ROOT, "scripts/generate-host-api.mjs"), "--check"], { encoding: "utf8" });
if (gen.status !== 0) bad(gen.stderr.trim() || "generated Host API constants are stale");
```

Run:

```bash
node scripts/generate-host-api.mjs --check
cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-host-api.mjs extension/routes/host-api/commands.generated.mjs ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift scripts/conformance-host-api.mjs extension/tests/host-api-contract.test.mjs
git commit -m "feat(host-api): generate Node and Swift command constants"
```

---

### Task 6: Contract README, coverage map, and full gate

**Files:**
- Create: `schema/host-api/v1/README.md`
- Modify: `extension/tests/host-api-contract.test.mjs`

**Interfaces:**
- Produces: a human-readable coverage map; `make host-api-check` was added in Task 4.

- [ ] **Step 1: Write the failing test**

Append:

```js
test("host-api README lists every command", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const name of Object.keys(commands.commands)) assert.match(readme, new RegExp(`\\b${name.replaceAll(".", "\\.")}\\b`));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs`

Expected: FAIL with `ENOENT` for `README.md`.

- [ ] **Step 3: Write the README**

Create `schema/host-api/v1/README.md` with exactly this content:

```markdown
# Host API v1 contract

The machine-checked contract for Mac, desktop, iOS and web clients. Design:
[`docs/superpowers/specs/2026-11-03-host-api-design.md`](../../../superpowers/specs/2026-11-03-host-api-design.md).

This directory contains the frame envelope, command registry, event schemas and
fixtures. It does not contain a host adapter or a client; those are later plans.

## Limits

- `apiVersion` is always `1`.
- A frame is at most 1,048,576 bytes.
- Lists default to 100 items, maximum 500.
- Error messages are at most 500 characters.

## Workflow

1. Add or change the command in `commands.json`.
2. Add both fixtures under `fixtures/commands/<command>.request.json` and
   `.result.json`.
3. Add or change the event in `events.schema.json` and add its fixture.
4. Run `node scripts/generate-host-api.mjs`.
5. Run `node scripts/conformance-host-api.mjs`.
6. Run `make host-api-check`.

## Commands

| Command | Capability | Idempotent | v2 tag |
|---|---|---|---|
| `host.hello` | host | yes | — |
| `host.auth.pair` | host | no | `pairing` |
| `host.auth.token` | host | yes | — |
| `host.auth.revoke` | host | yes | — |
| `host.ping` | host | yes | `heartbeat` |
| `host.snapshot` | host | yes | — |
| `chat.snapshot` | chat | yes | `llmide_chat_history_list` |
| `chat.send` | chat | no | `llmide_chat` |
| `chat.cancel` | chat | yes | `llmide_cancel` |
| `approvals.answer` | approvals | no | `approval_answer` |
| `toolApprovals.answer` | tool_approvals | no | `tool_approval_answer` |

The remaining spec domains (Explorer, Auto Tasks, Loop, projects, files, SCM,
issues, Self-Heal, generation, usage, activity) are added by later plans using
the same envelope and registry machinery.
```

- [ ] **Step 4: Run the full gate**

Run:

```bash
node scripts/generate-host-api.mjs
cd extension && node --test --experimental-strip-types tests/host-api-contract.test.mjs
cd .. && make host-api-check
make contract-gates
```

Expected: PASS. `make contract-gates` now includes `host-api-check`.

- [ ] **Step 5: Commit**

```bash
git add schema/host-api/v1/README.md scripts/generate-host-api.mjs Makefile extension/tests/host-api-contract.test.mjs
git commit -m "docs(host-api): document the v1 contract and wire the gate"
```

---

## Self-review

- **Spec coverage:** This plan covers the envelope, error codes, host/auth/chat/approval commands, events, fixtures, limits, generated constants and the conformance gate. It intentionally defers Mac adapter, desktop adapter, iOS transport, web client and TLS to later plans.
- **Placeholder scan:** No TBD/TODO; every task has files, code, commands and expected results.
- **Type consistency:** `commands.json` is the single source; generator and conformance both read the same `commands` map and the same `maxFrameBytes/defaultListItems/maxListItems` names used in the spec.
- **Known deliberate gap:** `events.schema.json` variants are written flat because the existing validator has no `allOf`; the plan states this explicitly.
