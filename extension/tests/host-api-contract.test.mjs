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

test("host-api command registry: 12 commands and every fixture validates", () => {
  assert.equal(Object.keys(commands.commands).length, 12);
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
  assert.deepEqual(validate(events, json("fixtures/events/chat.delta.json"), { defs: events.$defs }), []);
  assert.deepEqual(validate(events, json("fixtures/events/approval.request.json"), { defs: events.$defs }), []);
});

test("host-api conformance script passes", () => {
  const r = spawnSync(process.execPath, ["scripts/conformance-host-api.mjs"], { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("host-api README lists every command", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const name of Object.keys(commands.commands)) {
    assert.match(readme, new RegExp(`\\b${name.replaceAll(".", "\\.")}\\b`));
  }
  assert.match(readme, /12 commands/);
});

test("generated Host API constants match the registry", () => {
  const r = spawnSync(process.execPath, ["scripts/generate-host-api.mjs", "--check"], { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
