#!/usr/bin/env node
// agent/v2 wire conformance gate.
//
// Validity, coverage and roster checks over schema/agent-v2:
//
//   1. VALIDITY  — every fixture matches exactly one schema variant, carries
//                  its required keys, and no key the schema does not declare.
//   2. COVERAGE  — every field path the schema declares is exercised by at
//                  least one fixture, so nothing is checked only in theory.
//   3. ROSTER    — every `type:` literal emitted under llm_agent/ or routes/
//                  exists in the schema, so a new emitter cannot appear
//                  outside the linker unnoticed. server/ai-routes.mjs is out
//                  of scope: it serves the LEGACY /code-assist wire.
//   4. MODELS    — the default Claude model is an entry of the fallback chain.
//
// (The Swift decode-gap check ran against the Mac app's chat-contract-lab and
// was removed with the Mac app.)
//
// The generic parts (schema walking, variant matching, validity, coverage, the
// report) live in scripts/lib/conformance.mjs, shared with conformance-http.mjs.
// What stays here is agent/v2-specific: the emitter roster scan and the model check.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, listJson, makeSchemaWalker, variantFor, checkDoc, createCoverage, createReport } from './lib/conformance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(ROOT, 'schema/agent-v2/agent-v2.schema.json');
const FIXTURE_DIR = join(ROOT, 'schema/agent-v2/fixtures');

const report = createReport();
const note = (msg) => report.note(msg);

// ---------------------------------------------------------------- schema

const schema = readJson(SCHEMA_PATH);
// `type` is the variant discriminator, not a field: it is skipped at the root.
const walker = makeSchemaWalker(schema, { rootSkip: ['type'] });

// ---------------------------------------------------------------- fixtures

const fixtures = listJson(FIXTURE_DIR);
if (fixtures.length === 0) { console.error('no fixtures found'); process.exit(1); }

const coverage = createCoverage();

for (const name of fixtures) {
  const doc = readJson(join(FIXTURE_DIR, name));
  const variant = variantFor(schema.oneOf, doc);
  if (!variant) { note(`${name}: no schema variant matches type=${doc.type} kind=${doc.kind}`); continue; }

  // 1. VALIDITY — required keys and undeclared keys for this variant.
  const { present, problems } = checkDoc({ walker, node: variant, doc, name, label: `the schema variant "${variant.title}"` });
  for (const msg of problems) note(msg);
  coverage.exercise(variant.title, present);
}

// A duplicate variant title would merge two variants' coverage sets and let an
// unexercised field pass unnoticed — the key must be unique for the check below
// to mean anything.
const titles = schema.oneOf.map((v) => v.title);
for (const t of new Set(titles)) {
  if (titles.filter((x) => x === t).length > 1) note(`two schema variants share the title "${t}" — COVERAGE keys on it`);
}
for (const [i, v] of schema.oneOf.entries()) {
  if (!v.title) note(`schema.oneOf[${i}] has no title — COVERAGE cannot key on it`);
}

// 2. COVERAGE — a declared path no fixture exercises is checked only in theory.
for (const variant of schema.oneOf) {
  for (const msg of coverage.check(variant.title, walker.schemaPaths(variant), `on "${variant.title}"`)) note(msg);
}

// 3. ROSTER — every emitted `type:` literal must be in the schema.
const known = new Set(schema.oneOf.map((v) => v.properties?.type?.const).filter(Boolean));

// Object literals carrying a `type` key that are NOT wire events. Keep this
// SMALL and explicit: an unrecognised literal fails the gate, which is the
// point — a new emitter cannot appear unnoticed.
const NON_WIRE_TYPE_LITERALS = new Set([
  // SDK/provider input shapes — these are built to be sent TO a model, never
  // written to our SSE stream.
  // The re-attach stream (GET /agent/v2/turns/stream) only: its markers never ride POST /agent/v2/stream, and the
  // route is specified as text in schema/http/agent.schema.json.
  'replay_info',              // routes/agent-v2.mjs — first frame of a re-attach with a gap
  'replay_truncated',         // routes/turn-replay.mjs — stands in for an event over 256 KB
  'local',                    // sdk/engine.mjs — plugin mount descriptor
  'preset',                   // sdk/engine.mjs — systemPrompt: { type: 'preset' }
  'custom',                   // sdk/engine.mjs — systemPrompt: { type: 'custom' } (LLMIDE_V2_COMPACT_PROMPT)
  'function',                 // runtime/openai-tools.mjs — OpenAI tool definition
  'web_fetch_tool_result',    // tools/handlers/fetch-url.mjs — Anthropic content block
  'web_fetch_result',
  'web_search_tool_result',   // tools/handlers/web-search.mjs — Anthropic content block
  'web_search_result',
  'image',                    // sdk/engine.mjs buildPromptInput — Anthropic image block
  'user',                     // sdk/engine.mjs buildPromptInput — SDKUserMessage envelope
  'noul', 'choice', 'score',  // tools/decide.mjs — Jev answer shapes inside the `decide` tool result, never stream events
  'hello',                    // routes/os.mjs — first event of GET /kb/os/stream (the System view change feed), a separate wire
  'progress',                 // routes/bus/bus-routes.mjs — a command-bus job_events row appended by the desktop claim route; it rides GET /bus/commands/:id/events, never the agent stream
  'spki',                     // routes/sync/keys.mjs — createPublicKey(...).export({ type: 'spki' }), never an SSE event
  'skill', 'command', 'agent', 'mcp', 'hook', 'lsp', 'bin', // llm_agent/extensions/importer.mjs — extension catalog member kinds, not stream events
  // JSON-Schema fragments inside tool definitions.
  'text', 'object', 'string', 'boolean', 'number', 'integer', 'array',
]);
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
    // Match an object LITERAL whose first key is `type` — `{ type: 'init'`.
    // The previous pattern keyed on the CALL (`send({ type:`), which missed the
    // eight variants events.mjs produces by RETURNING array literals from
    // mapSdkMessage: the roster had never once inspected the core of the
    // vocabulary. A leading `{` also excludes comparisons (`msg.type ===
    // 'system'`), which are SDK INPUT types, not wire events.
    for (const m of text.matchAll(/\{\s*type:\s*'([a-z_]+)'/g)) {
      if (!emitted.has(m[1])) emitted.set(m[1], full.slice(ROOT.length + 1));
    }
  }
}
for (const g of EMITTER_GLOBS) walk(join(ROOT, g));

const ROSTER_EXEMPT = new Set();
for (const [type, where] of emitted) {
  if (known.has(type) || ROSTER_EXEMPT.has(type) || NON_WIRE_TYPE_LITERALS.has(type)) continue;
  note(`"${type}" is built as a { type: '...' } literal at ${where} but is not in the schema. `
    + `If it reaches the SSE stream, add it to the schema and a fixture; if it never does, add it to NON_WIRE_TYPE_LITERALS.`);
}

// The roster must actually SEE the core vocabulary. This guards the bug the
// check itself had: a pattern matching nothing still reported success.
for (const core of ['init', 'delta', 'tool_use_start', 'tool_args_delta', 'tool_result', 'usage', 'result']) {
  if (!emitted.has(core)) note(`ROSTER found no emitter for "${core}" — the scan pattern is broken, not the code`);
}

// ------------------------------------------------------------ model ids
//
// Claude model ids: Node reads schema/models/anthropic-models.json directly.
const MODELS_PATH = join(ROOT, 'schema/models/anthropic-models.json');
const models = JSON.parse(readFileSync(MODELS_PATH, 'utf8'));

// What must hold is that the DEFAULT is a chain entry — anything
// else means the server's fallback ladder cannot reach its own default.
const chainIds = models.chain.map((c) => c.id);
if (!chainIds.includes(models.default)) {
  note(`default "${models.default}" is not in the chain [${chainIds}]`);
}
if (models.chain.filter((c) => c.fast).length > 1) note('more than one chain entry is flagged fast');

// ---------------------------------------------------------------- report

report.finish({
  title: 'agent/v2 conformance',
  footer: 'See schema/agent-v2/SCHEMA.md.',
  ok: `agent/v2 conformance: ${fixtures.length} fixtures, ${known.size} variants — the fixtures, schema and emitters agree`,
});
