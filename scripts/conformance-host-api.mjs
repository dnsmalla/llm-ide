#!/usr/bin/env node
// Conformance gate for the Host API v1 contract (schema/host-api/v1).
//
//   node scripts/conformance-host-api.mjs
//
// Valid frames must satisfy the envelope's oneOf. Invalid fixtures are judged
// against the specific $defs variant they are built to violate and must fail
// at the expected path: validating them through the root oneOf collapses to a
// single aggregate "must match exactly one variant" error and hides what broke.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../extension/routes/bus/schema-validate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "schema/host-api/v1");
const EXPECTED_COMMANDS = 12;

// filename -> the envelope $defs variant it violates and the path the failure must name.
const INVALID_CASES = {
  "bad-command-shape.json": { def: "Request", at: ".command" },
  "bad-command-pattern.json": { def: "Request", at: ".command" },
  "bad-request-id.json": { def: "Request", at: ".id" },
  "missing-api-version.json": { def: "Request", at: ".apiVersion" },
  "unknown-field.json": { def: "Request", at: ".surprise" },
  "unknown-error-code.json": { def: "ErrorFrame", at: ".error.code" },
  "error-message-too-long.json": { def: "ErrorFrame", at: ".error.message" },
  "error-missing-error.json": { def: "ErrorFrame", at: ".error" },
  "response-missing-reply-to.json": { def: "Response", at: ".replyTo" },
  "event-missing-rev.json": { def: "Event", at: ".rev" },
};

const problems = [];
const bad = (m) => problems.push(m);
const json = (p) => JSON.parse(readFileSync(join(DIR, p), "utf8"));
const fixtureNames = (dir) => readdirSync(join(DIR, dir)).filter((f) => f.endsWith(".json")).sort();

const envelope = json("envelope.schema.json");
const defs = envelope.$defs;

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
  const errs = validate(defs[c.def], json(`fixtures/invalid/${f}`), { defs });
  if (!errs.some((e) => e.path === c.at)) bad(`invalid/${f}: expected a failure at ${c.at}, got ${JSON.stringify(errs)}`);
}
for (const f of Object.keys(INVALID_CASES)) {
  if (!invalidNames.includes(f)) bad(`invalid/${f}: mapped fixture does not exist`);
}

const commandsSchema = json("commands.schema.json");
const commands = json("commands.json");
if (validate(commandsSchema, commands, { defs: commandsSchema.$defs }).length) bad("commands.json does not match commands.schema.json");

const caps = new Set(commands.capabilities);
const names = Object.keys(commands.commands);
if (new Set(names).size !== names.length) bad("duplicate command names");
if (names.length !== EXPECTED_COMMANDS) bad(`expected ${EXPECTED_COMMANDS} commands, found ${names.length}`);

const commandFixtures = new Set(fixtureNames("fixtures/commands"));
// The registry and the envelope must agree on what a command name looks like; the surface has two-
// (chat.send) and three-segment (host.auth.pair, chat.history.clear) names.
const commandPattern = new RegExp(defs.Request.properties.command.pattern);
for (const name of names) {
  if (!commandPattern.test(name)) bad(`bad command name: ${name}`);
  const c = commands.commands[name];
  if (!caps.has(c.capability)) bad(`${name}: capability ${c.capability} is not listed`);
  for (const kind of ["request", "result"]) {
    const file = `${name}.${kind}.json`;
    if (!commandFixtures.has(file)) {
      bad(`${name}: missing fixture fixtures/commands/${file}`);
      continue;
    }
    const errs = validate(c[kind], json(`fixtures/commands/${file}`), { defs });
    if (errs.length) bad(`${name} ${kind}: ${JSON.stringify(errs)}`);
  }
  const req = json(`fixtures/commands/${name}.request.json`);
  if (Buffer.byteLength(JSON.stringify(req)) > commands.limits.maxFrameBytes) bad(`${name}: request fixture too large`);
}
for (const f of commandFixtures) {
  const m = /^(.+)\.(request|result)\.json$/.exec(f);
  if (!m) bad(`fixtures/commands/${f}: expected <command>.<request|result>.json`);
  else if (!Object.hasOwn(commands.commands, m[1])) bad(`fixtures/commands/${f}: no such command ${m[1]}`);
}

const events = json("events.schema.json");
for (const f of fixtureNames("fixtures/events")) {
  const errs = validate(events, json(`fixtures/events/${f}`), { defs: events.$defs });
  if (errs.length) bad(`events/${f}: ${JSON.stringify(errs)}`);
}

const gen = spawnSync(process.execPath, [join(ROOT, "scripts/generate-host-api.mjs"), "--check"], { encoding: "utf8" });
if (gen.status !== 0) bad((gen.stderr || "").trim() || "generated Host API constants are stale");

if (problems.length) {
  for (const p of problems) console.error(`conformance-host-api: ${p}`);
  process.exit(1);
}
console.log(`conformance-host-api: ok (${names.length} commands)`);
