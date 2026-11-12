#!/usr/bin/env node
// Conformance gate for the Host API v1 contract (schema/host-api/v1).
//
//   node scripts/conformance-host-api.mjs
//
// Valid frames must satisfy the envelope's oneOf. Invalid fixtures are judged
// against the specific $defs variant they are built to violate and must fail
// at the expected path: validating them through the root oneOf collapses to a
// single aggregate "must match exactly one variant" error and hides what broke.
// Every invalid fixture is also checked against the root oneOf, so a fixture
// that stops being invalid is caught even when its targeted check still passes.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../extension/routes/bus/schema-validate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "schema/host-api/v1");
const EXPECTED_COMMANDS = 33;
const EXPECTED_EVENT_COMMANDS = [
  "chat.delta",
  "chat.done",
  "chat.error",
  "approval.request",
  "approval.cleared",
  "toolApproval.request",
  "host.capabilities",
];

// The expectation maps live beside the fixtures so the Swift validator tests read the same table.
const { envelope: INVALID_CASES, commands: INVALID_COMMAND_CASES } = JSON.parse(
  readFileSync(join(DIR, "fixtures/invalid-cases.json"), "utf8"),
);

// The subset validator understands exactly these keywords. A typo (`minLenght`) otherwise
// changes nothing at validate time — it is silently ignored — so the schema text is scanned.
const ALLOWED_SCHEMA_KEYS = new Set([
  "$schema", "$id", "$defs", "title", "description", "type", "additionalProperties", "required",
  "properties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum",
  "maximum", "enum", "const", "oneOf", "$ref", "default",
]);

const problems = [];
const bad = (m) => problems.push(m);
const json = (p) => JSON.parse(readFileSync(join(DIR, p), "utf8"));
const fixtureNames = (dir) => readdirSync(join(DIR, dir)).filter((f) => f.endsWith(".json")).sort();

const envelope = json("envelope.schema.json");
const defs = envelope.$defs;
const commandsSchema = json("commands.schema.json");
const commands = json("commands.json");
const events = json("events.schema.json");

function scanSchema(schema, where) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) bad(`${where}: unsupported schema keyword ${JSON.stringify(key)}`);
  }
  for (const [name, child] of Object.entries(schema.properties || {})) scanSchema(child, `${where}.properties.${name}`);
  for (const [name, child] of Object.entries(schema.$defs || {})) scanSchema(child, `${where}.$defs.${name}`);
  if (schema.items) scanSchema(schema.items, `${where}.items`);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    scanSchema(schema.additionalProperties, `${where}.additionalProperties`);
  }
  (schema.oneOf || []).forEach((child, i) => scanSchema(child, `${where}.oneOf[${i}]`));
}

// The four frame variants must agree on the command grammar: the registry name check below
// derives from Request, so a divergent Response/Event/ErrorFrame would accept or reject a
// different set of names than the one the registry is validated against.
const frameVariants = ["Request", "Response", "Event", "ErrorFrame"];
const commandPatterns = frameVariants.map((v) => defs[v]?.properties?.command?.pattern);
if (commandPatterns.some((p) => typeof p !== "string")) {
  bad(`envelope: ${frameVariants.join(", ")} must all declare command.pattern`);
} else if (new Set(commandPatterns).size !== 1) {
  bad(`envelope: command.pattern differs across frame variants: ${JSON.stringify(commandPatterns)}`);
}

// rev is envelope ordering, not payload data: Response and Event must carry it, ErrorFrame
// may carry it (async ordering), and no command result repeats it.
if (!defs.Event.required.includes("rev")) bad("envelope: Event must require rev");
if (!defs.Response.required.includes("rev")) bad("envelope: Response must require rev");
if (!Object.hasOwn(defs.ErrorFrame.properties, "rev")) bad("envelope: ErrorFrame must allow an optional rev");

for (const f of fixtureNames("fixtures/valid")) {
  const errs = validate(envelope, json(`fixtures/valid/${f}`), { defs });
  if (errs.length) bad(`valid/${f}: ${JSON.stringify(errs)}`);
}

const invalidNames = fixtureNames("fixtures/invalid");
for (const f of invalidNames) {
  const c = INVALID_CASES[f];
  if (!c) {
    bad(`invalid/${f}: no {def, at} case in the conformance map`);
    continue;
  }
  if (!Object.hasOwn(defs, c.def)) {
    bad(`invalid/${f}: unknown $defs variant ${c.def}`);
    continue;
  }
  const value = json(`fixtures/invalid/${f}`);
  const errs = validate(defs[c.def], value, { defs });
  if (!errs.some((e) => e.path === c.at)) bad(`invalid/${f}: expected a failure at ${c.at}, got ${JSON.stringify(errs)}`);
  if (validate(envelope, value, { defs }).length === 0) bad(`invalid/${f}: root envelope oneOf accepted it`);
}
for (const f of Object.keys(INVALID_CASES)) {
  if (!invalidNames.includes(f)) bad(`invalid/${f}: mapped fixture does not exist`);
}

if (validate(commandsSchema, commands, { defs: commandsSchema.$defs }).length) bad("commands.json does not match commands.schema.json");

const caps = new Set(commands.capabilities);
const names = Object.keys(commands.commands);
if (names.length !== EXPECTED_COMMANDS) bad(`expected ${EXPECTED_COMMANDS} commands, found ${names.length}`);

const invalidCommandNames = fixtureNames("fixtures/invalid/commands");
for (const f of invalidCommandNames) {
  const c = INVALID_COMMAND_CASES[f];
  if (!c) {
    bad(`invalid/commands/${f}: no {command, kind, at} case in the conformance map`);
    continue;
  }
  const command = commands.commands[c.command];
  if (!command) {
    bad(`invalid/commands/${f}: unknown command ${c.command}`);
    continue;
  }
  const value = json(`fixtures/invalid/commands/${f}`);
  const errs = validate(command[c.kind], value, { defs });
  if (!errs.some((e) => e.path === c.at)) {
    bad(`invalid/commands/${f}: expected a failure at ${c.at}, got ${JSON.stringify(errs)}`);
  }
  if (validate(envelope, value, { defs }).length === 0) bad(`invalid/commands/${f}: root envelope oneOf accepted it`);
}
for (const f of Object.keys(INVALID_COMMAND_CASES)) {
  if (!invalidCommandNames.includes(f)) bad(`invalid/commands/${f}: mapped fixture does not exist`);
}

const commandFixtures = new Set(fixtureNames("fixtures/commands"));
// The registry and the envelope must agree on what a command name looks like; the surface has two-
// (chat.send) and three-segment (host.auth.pair, chat.history.clear) names.
const commandPattern = new RegExp(defs.Request.properties.command.pattern);
for (const name of names) {
  if (!commandPattern.test(name)) bad(`bad command name: ${name}`);
  const c = commands.commands[name];
  if (!caps.has(c.capability)) bad(`${name}: capability ${c.capability} is not listed`);
  const fixtures = {};
  for (const kind of ["request", "result"]) {
    const file = `${name}.${kind}.json`;
    if (!commandFixtures.has(file)) {
      bad(`${name}: missing fixture fixtures/commands/${file}`);
      continue;
    }
    const value = json(`fixtures/commands/${file}`);
    fixtures[kind] = value;
    const errs = validate(c[kind], value, { defs });
    if (errs.length) bad(`${name} ${kind}: ${JSON.stringify(errs)}`);
  }
  if (fixtures.request && Buffer.byteLength(JSON.stringify(fixtures.request)) > commands.limits.maxFrameBytes) {
    bad(`${name}: request fixture too large`);
  }
  // Frame composition: the command layer and the frame layer are validated separately and
  // together, so a command fixture that only makes sense outside a frame fails here.
  for (const [kind, type, id, replyTo, payloadKey, ts, rev] of [
    ["request", "request", "c-test", undefined, "payload", 1, undefined],
    ["result", "response", "s-test", "c-test", "result", 2, 0],
  ]) {
    const value = fixtures[kind];
    if (!value) continue;
    const frame = { apiVersion: 1, id, type, command: name, [payloadKey]: value, ts };
    if (replyTo) frame.replyTo = replyTo;
    if (rev !== undefined) frame.rev = rev;
    const frameErrs = validate(envelope, frame, { defs });
    if (frameErrs.length) bad(`${name} ${type} frame: ${JSON.stringify(frameErrs)}`);
    const payloadErrs = validate(c[kind], frame[payloadKey], { defs });
    if (payloadErrs.length) bad(`${name} ${type} payload in frame: ${JSON.stringify(payloadErrs)}`);
  }
}
for (const f of commandFixtures) {
  const m = /^(.+)\.(request|result)\.json$/.exec(f);
  if (!m) bad(`fixtures/commands/${f}: expected <command>.<request|result>.json`);
  else if (!Object.hasOwn(commands.commands, m[1])) bad(`fixtures/commands/${f}: no such command ${m[1]}`);
}

// Event drift: every variant must keep the envelope Event's frame fields byte-identical,
// otherwise a variant can quietly redefine apiVersion/type/rev or drop replyTo.
if (!Array.isArray(events.oneOf) || events.oneOf.length !== EXPECTED_EVENT_COMMANDS.length) {
  bad(`events: expected ${EXPECTED_EVENT_COMMANDS.length} flat variants, found ${events.oneOf?.length ?? 0}`);
}
const eventCommands = new Set();
for (const [i, variant] of (events.oneOf || []).entries()) {
  const props = variant.properties || {};
  if (variant.additionalProperties !== false) bad(`events[${i}] ${props.command?.const ?? "?"}: must set additionalProperties false`);
  if (JSON.stringify(variant.required) !== JSON.stringify(defs.Event.required)) {
    bad(`events[${i}] ${props.command?.const ?? "?"}: required fields drift from envelope Event`);
  }
  for (const key of ["apiVersion", "id", "type", "ts", "rev"]) {
    if (JSON.stringify(props[key]) !== JSON.stringify(defs.Event.properties[key])) {
      bad(`events[${i}] ${props.command?.const ?? "?"}: ${key} drifts from envelope Event`);
    }
  }
  const hasReplyTo = Object.hasOwn(props, "replyTo");
  if (hasReplyTo !== Object.hasOwn(defs.Event.properties, "replyTo")) {
    bad(`events[${i}] ${props.command?.const ?? "?"}: replyTo presence drifts from envelope Event`);
  } else if (hasReplyTo && JSON.stringify(props.replyTo) !== JSON.stringify(defs.Event.properties.replyTo)) {
    bad(`events[${i}] ${props.command?.const ?? "?"}: replyTo definition drifts from envelope Event`);
  }
  const command = props.command?.const;
  if (typeof command !== "string") bad(`events[${i}]: missing command const`);
  else if (eventCommands.has(command)) bad(`events[${i}]: duplicate event variant ${command}`);
  else eventCommands.add(command);
}
if (JSON.stringify([...eventCommands].sort()) !== JSON.stringify([...EXPECTED_EVENT_COMMANDS].sort())) {
  bad(`events: expected variants ${EXPECTED_EVENT_COMMANDS.join(", ")}, found ${[...eventCommands].join(", ")}`);
}

// Capability drift: the registry's capability list is the single source. Every enum a client
// reads (handshake, pairing, token refresh and the capabilities-changed event) must offer
// exactly that set, or a client hides a command the host can serve (or the reverse).
const capabilityEnums = [
  ["host.hello result", commands.commands["host.hello"]?.result?.properties?.capabilities?.items?.enum],
  ["host.auth.pair result", commands.commands["host.auth.pair"]?.result?.properties?.capabilities?.items?.enum],
  ["host.auth.token result", commands.commands["host.auth.token"]?.result?.properties?.capabilities?.items?.enum],
];
const capabilitiesEvent = (events.oneOf || []).find((v) => v.properties?.command?.const === "host.capabilities");
capabilityEnums.push(["host.capabilities payload", capabilitiesEvent?.properties?.payload?.properties?.capabilities?.items?.enum]);
for (const [where, list] of capabilityEnums) {
  if (!Array.isArray(list)) bad(`${where}: missing capabilities.items.enum`);
  else if (list.length !== caps.size || list.some((c) => !caps.has(c))) {
    bad(`${where}: capabilities enum ${JSON.stringify(list)} does not match the registry ${JSON.stringify([...caps])}`);
  }
}
for (const f of fixtureNames("fixtures/events")) {
  const errs = validate(events, json(`fixtures/events/${f}`), { defs });
  if (errs.length) bad(`events/${f}: ${JSON.stringify(errs)}`);
}

scanSchema(envelope, "envelope.schema.json");
scanSchema(commandsSchema, "commands.schema.json");
scanSchema(events, "events.schema.json");
for (const [name, c] of Object.entries(commands.commands)) {
  scanSchema(c.request, `commands.json ${name}.request`);
  scanSchema(c.result, `commands.json ${name}.result`);
}

const gen = spawnSync(process.execPath, [join(ROOT, "scripts/generate-host-api.mjs"), "--check"], { encoding: "utf8" });
if (gen.status !== 0) bad((gen.stderr || "").trim() || "generated Host API constants are stale");

if (problems.length) {
  for (const p of problems) console.error(`conformance-host-api: ${p}`);
  process.exit(1);
}
console.log(`conformance-host-api: ok (${names.length} commands, ${eventCommands.size} events)`);
