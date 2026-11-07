import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.ok(check(json("fixtures/invalid/response-missing-rev.json")).length > 0);
});

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

test("host-api command registry: 20 commands and every fixture validates", () => {
  assert.equal(Object.keys(commands.commands).length, 20);
  for (const [name, c] of Object.entries(commands.commands)) {
    for (const [kind, schema] of [["request", c.request], ["result", c.result]]) {
      const value = json(`fixtures/commands/${name}.${kind}.json`);
      assert.deepEqual(validate(schema, value, { defs: envelope.$defs }), [], `${name} ${kind}`);
    }
  }
});

const events = json("events.schema.json");

test("host-api chat commands and events decode", () => {
  for (const name of ["chat.send", "chat.snapshot", "chat.cancel", "chat.history.clear", "approvals.answer", "toolApprovals.answer"]) {
    assert.ok(commands.commands[name], name);
  }
  for (const command of ["chat.delta", "chat.done", "chat.error", "approval.request", "approval.cleared", "toolApproval.request", "host.capabilities"]) {
    const fixture = json(`fixtures/events/${command}.json`);
    assert.deepEqual(validate(events, fixture, { defs: envelope.$defs }), [], command);
  }
});

test("host-api composes a chat.send request and response frame", () => {
  const c = commandEntry("chat.send");
  const request = json("fixtures/commands/chat.send.request.json");
  const result = json("fixtures/commands/chat.send.result.json");
  const requestFrame = { apiVersion: 1, id: "c-test", type: "request", command: "chat.send", payload: request, ts: 1 };
  const responseFrame = {
    apiVersion: 1,
    id: "s-test",
    replyTo: "c-test",
    type: "response",
    command: "chat.send",
    result,
    ts: 2,
    rev: 0,
  };
  assert.deepEqual(check(requestFrame), []);
  assert.deepEqual(validate(c.request, requestFrame.payload, { defs: envelope.$defs }), []);
  assert.deepEqual(check(responseFrame), []);
  assert.deepEqual(validate(c.result, responseFrame.result, { defs: envelope.$defs }), []);
});

test("host-api conformance script passes", () => {
  const r = spawnSync(process.execPath, ["scripts/conformance-host-api.mjs"], { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("host-api README lists every command with its metadata", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const rows = new Map();
  for (const line of readme.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([a-z_]+)\s*\|\s*(yes|no)\s*\|\s*(?:`([^`]+)`|—)\s*\|$/.exec(line.trim());
    if (m) rows.set(m[1], { capability: m[2], idempotent: m[3] === "yes", v2Tag: m[4] ?? null });
  }
  const names = Object.keys(commands.commands);
  assert.equal(rows.size, names.length);
  for (const name of names) {
    const c = commands.commands[name];
    assert.deepEqual(rows.get(name), { capability: c.capability, idempotent: c.idempotent, v2Tag: c.v2Tag }, name);
  }
  assert.match(readme, /20 commands/);
  assert.match(readme, /seven flat variants/);
  assert.match(readme, /host\.capabilities/);
  assert.match(readme, /envelope `rev`/);
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

test("generated Host API constants match the registry", () => {
  const r = spawnSync(process.execPath, ["scripts/generate-host-api.mjs", "--check"], { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("generated Host API schemas mirror every request and result verbatim", async () => {
  const { HOST_API_SCHEMAS } = await import("../routes/host-api/commands.generated.mjs");
  assert.ok(Object.isFrozen(HOST_API_SCHEMAS));
  assert.deepEqual(Object.keys(HOST_API_SCHEMAS), Object.keys(commands.commands).sort());
  for (const [name, c] of Object.entries(commands.commands)) {
    assert.ok(Object.isFrozen(HOST_API_SCHEMAS[name]), name);
    assert.deepEqual(HOST_API_SCHEMAS[name], { request: c.request, result: c.result }, name);
  }
});

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
