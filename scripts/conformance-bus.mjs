#!/usr/bin/env node
// Conformance gate for the command bus contract (schema/bus, docs/spec/command-bus.md).
//
//   node scripts/conformance-bus.mjs           check everything
//   node scripts/conformance-bus.mjs --sync    copy schema/bus/registry.json to extension/routes/bus/registry.json
//
// Checks: the runtime registry copy is byte-identical; the registry is well formed (tiers, write kinds are T1/T2,
// unavailable kinds say why, error codes equal the event schema's); every command fixture validates (or fails at the
// named path); the tier matrix matches the pure gate (decideReceipt) and covers every kind x client class; every event
// fixture validates against event.schema.json and every variant and error code has one; every sequence is judged as
// its fixture says; no fixture carries anything the secret redactor would change.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../extension/routes/bus/schema-validate.mjs';
import { REGISTRY, decideReceipt, mayApprove, classInfo } from '../extension/routes/bus/registry.mjs';
import { checkSequence } from '../extension/routes/bus/sequence.mjs';
import { ERROR_CODES } from '../extension/kb/bus-store.mjs';
import { redactSecrets } from '../extension/core/redact-secrets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUS = join(ROOT, 'schema/bus');
const RUNTIME_COPY = join(ROOT, 'extension/routes/bus/registry.json');
const RUNTIME_COMMAND_SCHEMA = join(ROOT, 'extension/routes/bus/command.schema.json');
const read = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));

if (process.argv.includes('--sync')) {
  writeFileSync(RUNTIME_COPY, read(join(BUS, 'registry.json')));
  writeFileSync(RUNTIME_COMMAND_SCHEMA, read(join(BUS, 'command.schema.json')));
  console.log('conformance-bus: runtime registry copy synced');
  process.exit(0);
}

const problems = [];
const bad = (m) => problems.push(m);
const counts = { commands: 0, tiers: 0, events: 0, sequences: 0 };

// 1. runtime copy
if (read(join(BUS, 'registry.json')) !== read(RUNTIME_COPY)) bad('extension/routes/bus/registry.json differs from schema/bus/registry.json (run: node scripts/conformance-bus.mjs --sync)');

if (read(join(BUS, 'command.schema.json')) !== read(RUNTIME_COMMAND_SCHEMA)) bad('extension/routes/bus/command.schema.json differs from schema/bus/command.schema.json (run: node scripts/conformance-bus.mjs --sync)');

// 2. registry shape
const reg = json(join(BUS, 'registry.json'));
const eventSchema = json(join(BUS, 'event.schema.json'));
const commandSchema = json(join(BUS, 'command.schema.json'));
for (const [name, k] of Object.entries(reg.kinds)) {
  const at = `registry.kinds.${name}`;
  if (!reg.tiers[k.tier]) bad(`${at}: unknown tier ${k.tier}`);
  if (typeof k.write !== 'boolean') bad(`${at}: write must be boolean`);
  if (k.write && !['T1', 'T2'].includes(k.tier)) bad(`${at}: a write kind must be T1 or T2`);
  if (k.tier === 'T0' && k.write) bad(`${at}: T0 is read-only`);
  if (typeof k.available !== 'boolean') bad(`${at}: available must be boolean`);
  if (!k.available && !k.unavailableReason) bad(`${at}: an unavailable kind must say why (unavailableReason)`);
  if (k.available && !(k.engines || []).length) bad(`${at}: an available kind needs engines`);
  if (k.available && k.write) bad(`${at}: no write kind may be available until write mode on every engine is decided (spec, section 3)`);
  if (!k.args || k.args.type !== 'object' || k.args.additionalProperties !== false) bad(`${at}: args must be an object schema with additionalProperties:false`);
  if (!['read', 'write'].includes(k.lane)) bad(`${at}: lane must be read or write`);
}
for (const [c, cls] of Object.entries(reg.clientClasses)) {
  for (const t of cls.mayStart) if (!reg.tiers[t]) bad(`clientClasses.${c}: unknown tier ${t}`);
}
const evCodes = eventSchema.oneOf.find((v) => v.title === 'error').properties.payload.properties.code.enum;
if (JSON.stringify([...evCodes].sort()) !== JSON.stringify([...reg.errorCodes].sort())) bad('registry.errorCodes differs from the error enum in event.schema.json');

if (JSON.stringify([...ERROR_CODES].sort()) !== JSON.stringify([...reg.errorCodes].sort())) bad('kb/bus-store.mjs ERROR_CODES differs from registry.errorCodes');

// 3. command fixtures
const dir = (d) => readdirSync(join(BUS, 'fixtures', d)).filter((f) => f.endsWith('.json')).sort();
const framePlusArgs = (frame) => {
  const out = validate(commandSchema, frame);
  if (frame && typeof frame.kind === 'string' && Object.hasOwn(reg.kinds, frame.kind) && frame.args && typeof frame.args === 'object') {
    out.push(...validate(reg.kinds[frame.kind].args, frame.args, {}, '.args'));
  } else if (frame && typeof frame.kind === 'string' && !Object.hasOwn(reg.kinds, frame.kind)) out.push({ path: '.kind', message: 'unknown kind' });
  return out;
};
const seenValidKinds = new Set();
for (const f of dir('command')) {
  const fx = json(join(BUS, 'fixtures/command', f));
  counts.commands += 1;
  const got = framePlusArgs(fx.frame);
  if (fx.expect.valid) {
    if (got.length) bad(`command/${f}: expected valid, got ${got.map((g) => `${g.path} ${g.message}`).join('; ')}`);
    seenValidKinds.add(fx.frame.kind);
  } else if (!got.some((g) => g.path === fx.expect.atPath)) {
    bad(`command/${f}: expected a problem at ${fx.expect.atPath}, got ${got.map((g) => g.path).join(', ') || 'none'}`);
  }
}
for (const k of Object.keys(reg.kinds)) if (!seenValidKinds.has(k)) bad(`no valid command fixture for kind ${k}`);

// 4. tier matrix
const matrix = json(join(BUS, 'fixtures/tiers/matrix.json'));
const covered = new Set();
for (const r of matrix.rows) {
  counts.tiers += 1;
  const got = decideReceipt({ client: r.client, kind: r.kind, flagEnabled: r.flagEnabled }).outcome;
  if (got !== r.expect) bad(`tiers/matrix: ${r.client} ${r.kind} flag=${r.flagEnabled}: gate says ${got}, fixture says ${r.expect}`);
  if (!r.flagEnabled) covered.add(`${r.client}|${r.kind}`);
}
for (const c of Object.keys(reg.clientClasses)) for (const k of Object.keys(reg.kinds)) if (!covered.has(`${c}|${k}`)) bad(`tiers/matrix: no row for ${c} x ${k}`);
for (const r of json(join(BUS, 'fixtures/tiers/approval.json')).rows) {
  counts.tiers += 1;
  if (mayApprove(r.client) !== r.mayApprove) bad(`tiers/approval: ${r.client} mayApprove is ${mayApprove(r.client)}, fixture says ${r.mayApprove}`);
}
if (classInfo('phone-pwa')?.mayStart.some((t) => ['T0', 'T1', 'T2', 'D'].includes(t))) bad('phone-pwa must never start T0/T1/T2/D (spec D1)');

// 5. events
const variants = new Set();
const codesSeen = new Set();
for (const f of dir('event')) {
  const fx = json(join(BUS, 'fixtures/event', f));
  counts.events += 1;
  const got = validate(eventSchema, fx);
  if (got.length) bad(`event/${f}: ${got.map((g) => `${g.path} ${g.message}`).join('; ')}`);
  variants.add(fx.type);
  if (fx.type === 'error') codesSeen.add(fx.payload.code);
}
for (const v of eventSchema.oneOf) if (!variants.has(v.properties.type.const)) bad(`no event fixture for type ${v.properties.type.const}`);
for (const c of reg.errorCodes) if (!codesSeen.has(c)) bad(`no error event fixture for code ${c}`);

// 6. sequences
for (const f of dir('sequence')) {
  const fx = json(join(BUS, 'fixtures/sequence', f));
  counts.sequences += 1;
  for (const e of fx.events) {
    const got = validate(eventSchema, e);
    if (got.length) bad(`sequence/${f}: an event does not validate: ${got[0].path} ${got[0].message}`);
  }
  const partial = fx.expect.partialFrom;
  const problem = checkSequence(fx.events, { complete: !partial, from: partial || 1 });
  if (fx.expect.problem === null && problem) bad(`sequence/${f}: expected a clean sequence, got ${problem}`);
  if (fx.expect.problemContains && !(problem || '').includes(fx.expect.problemContains)) bad(`sequence/${f}: expected a problem containing "${fx.expect.problemContains}", got ${problem}`);
}

// 7. no secret-shaped content in any fixture or registry
const all = [['registry.json'], ...['command', 'tiers', 'event', 'sequence'].flatMap((d) => dir(d).map((f) => [`fixtures/${d}/${f}`]))];
for (const [rel] of all) {
  const text = read(join(BUS, rel));
  if (redactSecrets(text) !== text) bad(`${rel}: contains something the secret redactor would change`);
}

if (problems.length) {
  console.error(`conformance-bus: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`conformance-bus: OK (${Object.keys(reg.kinds).length} kinds, ${counts.commands} command fixtures, ${counts.tiers} tier rows, ${counts.events} event fixtures, ${counts.sequences} sequences)`);
