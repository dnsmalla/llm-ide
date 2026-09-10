#!/usr/bin/env node
// agent/v2 wire conformance gate.
//
// Schema + fixtures alone only prove that a payload DECODES. They never prove
// the two sides AGREE — which is how `error.retryable` came to be emitted by
// the server and silently dropped by the Mac for as long as nobody looked.
// (graph-kit learned the same lesson the same way; see the Makefile's note on
// conformance-memory.mjs.)
//
// So this runner does field-set diffing:
//
//   1. VALIDITY  — every fixture matches exactly one schema variant, carries
//                  its required keys, and no key the schema does not declare.
//   2. COVERAGE  — every field path the schema declares is exercised by at
//                  least one fixture, so nothing is checked only in theory.
//   3. DECODE GAP— for each fixture, the paths it actually carries minus the
//                  paths `chat-contract-lab --decode` says Swift kept. A
//                  non-empty difference must be listed in ALLOWED_UNDECODED
//                  with a reason, or this exits 1.
//   4. ROSTER    — every `type:` literal emitted under llm_agent/ or routes/
//                  exists in the schema, so a new emitter cannot appear
//                  outside the linker unnoticed. server/ai-routes.mjs is out
//                  of scope: it serves the LEGACY /code-assist wire.
//
// No JSON-Schema library: `ajv` is only present transitively (via eslint) and
// would vanish on an eslint upgrade. The schema uses a small, fixed subset, so
// the ~60 lines below are the whole validator.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(ROOT, 'schema/agent-v2/agent-v2.schema.json');
const FIXTURE_DIR = join(ROOT, 'schema/agent-v2/fixtures');

// Field paths the server sends and the Mac deliberately (or knowingly) does not
// decode. Every entry needs a reason — and the matching row in SCHEMA.md.
// REMOVE an entry the moment the Swift side starts decoding the field; a stale
// entry here is how a fixed drift silently reopens.
const ALLOWED_UNDECODED = {
  'sdk.json': {
    subtype: 'Observation channel only — the Mac keeps sdkType. AgentV2Event.swift SdkWire.',
    raw: 'Same: the raw SDK message is not modelled on the Mac.',
  },
  'error.json': {
    retryable: 'REAL DRIFT, not a choice: ErrorWire has no such field, so the Mac infers retryability from code == "SESSION_UNRESUMABLE" alone. Remove this entry when ErrorWire gains it.',
  },
  'approval_request_question.json': {
    'questions.options.preview': 'REAL DRIFT: the SDK sends option previews, AgentV2ApprovalOption has no field for them, so they cannot render.',
  },
};

const fail = [];
const note = (msg) => fail.push(msg);

// ---------------------------------------------------------------- schema

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

/** Dotted field paths a schema variant declares, minus the `type` discriminator. */
function schemaPaths(node, prefix = '') {
  const out = new Set();
  const props = node?.properties;
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (!prefix && key === 'type') continue; // the case itself carries it
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    const nested = value?.type === 'array' ? resolveRef(value.items) : value;
    if (nested && nested.type === 'object') {
      for (const child of schemaPaths(nested, path)) out.add(child);
    }
  }
  return out;
}

function resolveRef(node) {
  if (node?.$ref?.startsWith('#/$defs/')) return schema.$defs[node.$ref.slice('#/$defs/'.length)];
  return node;
}

function variantFor(doc) {
  return schema.oneOf.find((v) => {
    const p = v.properties || {};
    if (p.type?.const !== doc.type) return false;
    if (p.kind?.const && p.kind.const !== doc.kind) return false;
    return true;
  });
}

/**
 * Paths the schema declares as OPAQUE — a property with no `type` and no
 * `properties`, i.e. `{}`. `sdk.raw` is the only one today: it is a whole SDK
 * message passed through verbatim, so its interior is not part of this
 * contract and must not be walked.
 */
function opaquePaths(node, prefix = '') {
  const out = new Set();
  for (const [key, value] of Object.entries(node?.properties || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !value.type && !value.properties && !value.$ref && !value.const) {
      out.add(path);
      continue;
    }
    const nested = value?.type === 'array' ? resolveRef(value.items) : value;
    if (nested?.type === 'object') for (const p of opaquePaths(nested, path)) out.add(p);
  }
  return out;
}

/** Dotted paths a concrete document actually carries, not descending into opaque values. */
function docPaths(value, prefix = '', opaque = new Set()) {
  const out = new Set();
  if (Array.isArray(value)) {
    for (const item of value) for (const p of docPaths(item, prefix, opaque)) out.add(p);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (!prefix && key === 'type') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    if (opaque.has(path)) continue;
    for (const p of docPaths(child, path, opaque)) out.add(p);
  }
  return out;
}

// ---------------------------------------------------------------- fixtures

const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
if (fixtures.length === 0) { console.error('no fixtures found'); process.exit(1); }

const docs = new Map();
const exercised = new Set();

for (const name of fixtures) {
  const doc = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
  const variant = variantFor(doc);
  if (!variant) { note(`${name}: no schema variant matches type=${doc.type} kind=${doc.kind}`); continue; }

  const declared = schemaPaths(variant);
  const present = docPaths(doc, '', opaquePaths(variant));

  for (const key of variant.required || []) {
    if (key !== 'type' && !(key in doc)) note(`${name}: missing required "${key}"`);
  }
  for (const path of present) {
    if (!declared.has(path)) note(`${name}: "${path}" is not declared by the schema variant "${variant.title}"`);
  }
  for (const path of present) exercised.add(`${variant.title}::${path}`);
  docs.set(name, { doc, variant, present });
}

// 2. COVERAGE — a declared path no fixture exercises is checked only in theory.
for (const variant of schema.oneOf) {
  for (const path of schemaPaths(variant)) {
    if (!exercised.has(`${variant.title}::${path}`)) {
      note(`schema declares "${path}" on "${variant.title}" but no fixture exercises it`);
    }
  }
}

// ---------------------------------------------------------------- swift side

let decoded;
try {
  const raw = execFileSync(
    'swift', ['run', 'chat-contract-lab', '--decode', FIXTURE_DIR],
    { cwd: join(ROOT, 'mac'), encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, maxBuffer: 32 * 1024 * 1024 },
  );
  decoded = new Map(
    raw.split('\n').filter((l) => l.startsWith('{')).map((l) => {
      const row = JSON.parse(l);
      return [row.file, row];
    }),
  );
} catch (err) {
  console.error('conformance-agent-v2: could not run `swift run chat-contract-lab --decode`');
  console.error(err.stderr || err.message);
  process.exit(1);
}

// 3. DECODE GAP
for (const [name, { present }] of docs) {
  const row = decoded.get(name);
  if (!row) { note(`${name}: chat-contract-lab reported nothing for this fixture`); continue; }
  if (!row.decoded) { note(`${name}: Swift failed to decode — ${row.error}`); continue; }

  const captured = new Set(row.captured);
  const allowed = ALLOWED_UNDECODED[name] || {};
  for (const path of present) {
    if (captured.has(path)) continue;
    if (path in allowed) continue;
    note(`${name}: server sends "${path}" but Swift does not keep it (add the field, or explain it in ALLOWED_UNDECODED)`);
  }
  for (const path of Object.keys(allowed)) {
    if (captured.has(path)) {
      note(`${name}: ALLOWED_UNDECODED lists "${path}" but Swift now decodes it — delete the stale entry`);
    } else if (!present.has(path)) {
      note(`${name}: ALLOWED_UNDECODED lists "${path}" but no fixture carries it — stale entry`);
    }
  }
}

// 4. ROSTER — every emitted `type:` literal must be in the schema.
const known = new Set(schema.oneOf.map((v) => v.properties?.type?.const).filter(Boolean));
// Scoped to the agent/v2 wire only. `server/ai-routes.mjs` serves the LEGACY
// /code-assist stream, whose vocabulary (chunk, done, progress, spike_*) is a
// different contract with a different client path — SCHEMA.md's "Not covered"
// section says so. Including it here would demand this schema model both wires
// and make `error`/`tasks` ambiguous.
const EMITTER_GLOBS = ['extension/llm_agent', 'extension/routes'];
const emitted = new Map();
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.mjs')) continue;
    const text = readFileSync(full, 'utf8');
    for (const m of text.matchAll(/(?:send|onEvent\?\.|writeEvent)\(\{\s*type:\s*'([a-z_]+)'/g)) {
      if (!emitted.has(m[1])) emitted.set(m[1], full.slice(ROOT.length + 1));
    }
  }
}
for (const g of EMITTER_GLOBS) walk(join(ROOT, g));

const ROSTER_EXEMPT = new Set();
for (const [type, where] of emitted) {
  if (known.has(type) || ROSTER_EXEMPT.has(type)) continue;
  note(`"${type}" is emitted at ${where} but is not in the schema`);
}

// ------------------------------------------------------------ model ids
//
// The fourth drift class: Claude model ids. Node now reads
// schema/models/anthropic-models.json directly; Swift keeps a literal list
// (a build-time resource would complicate the feature-reduced builds), so the
// two are reconciled HERE rather than by convention. Before this, three lists
// disagreed and the server's own DEFAULT_MODEL was an id the Mac retired.

const MODELS_PATH = join(ROOT, 'schema/models/anthropic-models.json');
const CLAUDE_CLI_PATH = join(ROOT, 'mac/Sources/LlmIdeMac/ClaudeLink/ClaudeCLI.swift');
const models = JSON.parse(readFileSync(MODELS_PATH, 'utf8'));
const swiftSource = readFileSync(CLAUDE_CLI_PATH, 'utf8');

const swiftPicker = [...swiftSource.matchAll(/AIModel\(id:\s*"([^"]+)"/g)].map((m) => m[1]);
const jsonPicker = models.models.map((m) => m.id);
if (swiftPicker.join(',') !== jsonPicker.join(',')) {
  note(`ClaudeCLI.fallbackModels [${swiftPicker}] does not match anthropic-models.json models [${jsonPicker}]`);
}

const retiredBlock = swiftSource.slice(swiftSource.indexOf('retiredModelIds'));
const swiftRetired = Object.fromEntries(
  [...retiredBlock.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
);
for (const [from, to] of Object.entries(models.retired)) {
  if (swiftRetired[from] !== to) note(`retired "${from}" → "${to}" in JSON but "${swiftRetired[from] ?? 'absent'}" in ClaudeCLI.swift`);
}
for (const from of Object.keys(swiftRetired)) {
  if (!(from in models.retired)) note(`ClaudeCLI.retiredModelIds has "${from}" which anthropic-models.json does not`);
}

// The server's chain and the Mac's picker are different lists (see the JSON's
// _comment). What must hold is that the DEFAULT is a chain entry — anything
// else means the server's fallback ladder cannot reach its own default.
const chainIds = models.chain.map((c) => c.id);
if (!chainIds.includes(models.default)) {
  note(`default "${models.default}" is not in the chain [${chainIds}]`);
}
if (models.chain.filter((c) => c.fast).length > 1) note('more than one chain entry is flagged fast');

// KNOWN, REPORTED, NOT YET DECIDED — printed every run so it cannot rot
// quietly. These are ids the server calls that the Mac coerces away; making
// them agree changes which model actually answers, so it is the user's call,
// not this gate's. See the JSON's OPEN DECISION note.
const retiredInChain = chainIds.filter((id) => id in models.retired);
if (retiredInChain.length) {
  console.log(`  note: chain still uses ${retiredInChain.length} id(s) the Mac retires — ${retiredInChain.join(', ')}`);
  if (models.default in models.retired) {
    console.log(`  note: the server default "${models.default}" is one of them (→ ${models.retired[models.default]})`);
  }
}

// ---------------------------------------------------------------- report

if (fail.length) {
  console.error('\n=== agent/v2 conformance FAILED ===');
  for (const f of fail) console.error('  ✗ ' + f);
  console.error(`\n${fail.length} problem(s). See schema/agent-v2/SCHEMA.md.`);
  process.exit(1);
}
console.log(`agent/v2 conformance: ${fixtures.length} fixtures, ${known.size} variants — Swift and the wire agree`);
