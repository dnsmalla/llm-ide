#!/usr/bin/env node
// HTTP endpoint conformance gate. Layout and rules: schema/http/SCHEMA.md.
//
// Each route group has one schema file, schema/http/<group>.schema.json, whose
// `endpoints` object is keyed by "<METHOD> <path>". Each endpoint has `request`
// parts (query / params / body) and `responses` keyed by status code. Fixtures
// live in schema/http/fixtures/<group>/<name>.json: one example exchange each.
// `_common.schema.json` holds shared $defs (the error envelope), referenced as
// "_common#/$defs/Error".
//
// Checks (machinery in scripts/lib/conformance.mjs):
//
//   0. LOAD      — invalid JSON, unsupported keywords, unresolved $refs, bare {}
//                  responses, non-numeric status keys: all reported with file
//                  and JSON pointer, and the run continues.
//   1. VALIDITY  — each fixture's request and response match their schemas:
//                  required keys, undeclared keys, types, const, enum, oneOf
//                  variants, map values, arrays. SSE responses are checked
//                  event by event against an event schema.
//   2. COVERAGE  — every declared field path is exercised by a fixture: request
//                  paths by any fixture of the endpoint; response paths by a
//                  fixture of that status (and of that oneOf variant).
//   3. ROSTER    — every declared endpoint exists in ALL_ENDPOINTS
//                  (extension/server.mjs) or in the public + auth roster
//                  (extension/server/auth.mjs, auth-routes.mjs), both parsed by
//                  scripts/lib/roster.mjs.
//
// The summary line also reports the share of ALL_ENDPOINTS with a specified 2xx
// response, and the count of x-unspecified responses. `--require-all` fails when
// an endpoint has no specified 2xx response, or a roster path has no endpoint.
// It is off until the route-group specs (P3–P10) land.
//
// Usage:
//   node scripts/conformance-http.mjs                run the checks
//   node scripts/conformance-http.mjs --require-all  also fail on unspecified endpoints

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadJson, listJson, makeSchemaWalker, RefError, variantFor,
  validateNode, coverablePaths, keywordProblems, createCoverage, createReport,
} from './lib/conformance.mjs';
import { loadRosters } from './lib/roster.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'schema/http');
const FIXTURE_DIR = join(SCHEMA_DIR, 'fixtures');
const SCHEMA_SUFFIX = '.schema.json';
const COMMON_FILE = `_common${SCHEMA_SUFFIX}`;
const COMMON_NAME = '_common';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const REQUEST_PARTS = new Set(['query', 'params', 'body']);
const FIXTURE_KEYS = new Set(['endpoint', 'status', 'description', 'request', 'response']);
const CONTENT_KINDS = new Set(['sse', 'binary', 'text', 'none']);
const BINARY_KEYS = new Set(['contentType', 'description']);

const requireAll = process.argv.includes('--require-all');
const report = createReport();
const note = (msg) => report.note(msg);
const EMPTY = Object.freeze({ present: new Set(), problems: [] });

const escPtr = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
/** Keys that make a response schema say something beyond its description. */
const constraintKeys = (node) => Object.keys(node).filter((k) => !k.startsWith('x-') && k !== 'description' && k !== 'title');

/** Run `fn`; a RefError is reported at `where` and `fallback` returned. Anything else is a bug and propagates. */
function guard(where, fn, fallback) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RefError) { note(`${where}: ${e.message}`); return fallback; }
    throw e;
  }
}

// ---------------------------------------------------------------- roster

// Two rosters: ALL_ENDPOINTS (advertised by /health) and the public + auth roster
// (pre-routing public paths and the auth namespace, read from their definitions).
// A declared endpoint must be in either one.
const rosters = loadRosters((rel) => readFileSync(join(ROOT, rel), 'utf8'));
const allEndpoints = new Set(rosters.endpoints.map((r) => r.path));
const publicAuth = new Set(rosters.publicAuth.map((r) => r.path));
const roster = new Set([...allEndpoints, ...publicAuth]);

// ---------------------------------------------------------------- common + events

const externals = {};
if (existsSync(join(SCHEMA_DIR, COMMON_FILE))) {
  const common = loadJson(join(SCHEMA_DIR, COMMON_FILE), COMMON_FILE, note);
  if (common) {
    externals[COMMON_NAME] = common;
    if (JSON.stringify(common).includes('"$ref"')) {
      note(`${COMMON_FILE}: _common $defs must be self-contained; a "$ref" in it would resolve against the group file`);
    }
    for (const [name, def] of Object.entries(common.$defs ?? {})) {
      for (const msg of keywordProblems(def, COMMON_FILE, `/$defs/${escPtr(name)}`)) note(msg);
    }
  }
}

const eventSchemas = new Map(); // x-events path -> { doc, walker } | null
/** The event schema an `x-events` path names: its oneOf variants are the event types. */
function eventSchema(rel, where) {
  if (eventSchemas.has(rel)) return eventSchemas.get(rel);
  let out = null;
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    note(`${where}: x-events "${rel}" does not exist`);
  } else {
    const doc = loadJson(abs, rel, note);
    if (doc && Array.isArray(doc.oneOf)) {
      out = { doc, walker: makeSchemaWalker(doc, { rootSkip: ['type'] }) };
    } else if (doc) {
      note(`${where}: x-events "${rel}" must be a schema with oneOf variants`);
    }
  }
  eventSchemas.set(rel, out);
  return out;
}

// ---------------------------------------------------------------- response classification

/**
 * What one response declares. `units` are the coverage units the fixtures must
 * exercise (`{ unit, node, walker }`); an unspecified, bodyless or bad response
 * has none. Problems are reported here, at load time.
 */
function classifyResponse(where, key, status, rs, walker) {
  const unit = `${key}::${status}`;
  if (!rs || typeof rs !== 'object' || Array.isArray(rs)) {
    note(`${where}: a response must be a schema object`);
    return { kind: 'bad', units: [] };
  }
  if (rs['x-content'] !== undefined) {
    const c = rs['x-content'];
    if (!CONTENT_KINDS.has(c)) {
      note(`${where}: x-content must be one of sse, binary, text, none (got ${JSON.stringify(c)})`);
      return { kind: 'bad', units: [] };
    }
    if (c === 'none') return { kind: 'none', units: [] };
    if (c === 'binary') return { kind: 'binary', units: [] };
    if (c === 'text') {
      if (rs.type !== 'string') note(`${where}: x-content "text" needs "type": "string"`);
      return { kind: 'schema', node: rs, units: [{ unit, node: rs, walker }] };
    }
    // sse
    if (typeof rs['x-events'] !== 'string') {
      note(`${where}: x-content "sse" needs "x-events": "<path to an event schema>"`);
      return { kind: 'bad', units: [] };
    }
    const events = eventSchema(rs['x-events'], where);
    if (!events) return { kind: 'bad', units: [] };
    const units = events.doc.oneOf.map((v, i) => ({ unit: `${unit}::event::${v.title ?? i}`, node: v, walker: events.walker }));
    return { kind: 'sse', units, events };
  }
  if (rs['x-unspecified'] !== undefined) {
    if (typeof rs['x-unspecified'] !== 'string' || !rs['x-unspecified'].trim()) {
      note(`${where}: x-unspecified needs a non-empty reason string`);
    }
    return { kind: 'unspecified', reason: String(rs['x-unspecified']), units: [] };
  }
  if (constraintKeys(rs).length === 0) {
    note(`${where}: bare {} response; declare the body, or mark it "x-unspecified": "<reason>"`);
    return { kind: 'bad', units: [] };
  }
  if (Array.isArray(rs.oneOf)) {
    const units = rs.oneOf.map((v, i) => ({ unit: `${unit}::variant::${v?.title ?? i}`, node: v, walker }));
    return { kind: 'schema', oneOf: true, node: rs, units };
  }
  return { kind: 'schema', node: rs, units: [{ unit, node: rs, walker }] };
}

// ---------------------------------------------------------------- request shape

/**
 * The schema a request is validated against: an object whose properties are the
 * parts the endpoint declares. Each declared part is required, so a fixture has
 * to exemplify every part the schema describes. Undeclared parts are undeclared keys.
 */
function requestRoot(spec) {
  const req = spec.request ?? {};
  const properties = {};
  const required = [];
  for (const part of REQUEST_PARTS) {
    if (req[part] === undefined) continue;
    properties[part] = req[part];
    required.push(part);
  }
  return { type: 'object', properties, required };
}

// ---------------------------------------------------------------- group files

const endpoints = new Map(); // "<METHOD> <path>" -> { file, group, path, ptr, spec, walker, responses }
const groups = [];

for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(SCHEMA_SUFFIX) && f !== COMMON_FILE).sort()) {
  const group = file.slice(0, -SCHEMA_SUFFIX.length);
  const doc = loadJson(join(SCHEMA_DIR, file), file, note);
  if (doc === undefined) continue;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { note(`${file}: a group file must be an object`); continue; }
  groups.push(group);
  for (const [name, def] of Object.entries(doc.$defs ?? {})) {
    for (const msg of keywordProblems(def, file, `/$defs/${escPtr(name)}`)) note(msg);
  }
  const walker = makeSchemaWalker(doc, { rootSkip: [], externals });
  if (!doc.endpoints || typeof doc.endpoints !== 'object') { note(`${file}: no "endpoints" object`); continue; }

  for (const [key, spec] of Object.entries(doc.endpoints)) {
    const ptr = `/endpoints/${escPtr(key)}`;
    const m = /^([A-Z]+) (\/\S*)$/.exec(key);
    if (!m) { note(`${file}${ptr}: endpoint key "${key}" is not "<METHOD> <path>"`); continue; }
    if (!METHODS.has(m[1])) note(`${file}${ptr}: "${key}" uses an unsupported method ${m[1]}`);
    if (endpoints.has(key)) { note(`${file}${ptr}: "${key}" is declared in more than one group file`); continue; }
    if (!roster.has(m[2])) note(`${file}${ptr}: "${key}" is in neither ALL_ENDPOINTS (extension/server.mjs) nor the public + auth roster`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { note(`${file}${ptr}: endpoint must be an object`); continue; }

    if (spec.request !== undefined) {
      if (!spec.request || typeof spec.request !== 'object' || Array.isArray(spec.request)) {
        note(`${file}${ptr}/request: must be an object of parts (query, params, body)`);
      } else {
        for (const part of Object.keys(spec.request)) {
          if (!REQUEST_PARTS.has(part)) { note(`${file}${ptr}/request: unknown part "${part}" (use query, params or body)`); continue; }
          for (const msg of keywordProblems(spec.request[part], file, `${ptr}/request/${part}`)) note(msg);
        }
      }
    }

    const responses = new Map();
    if (!spec.responses || typeof spec.responses !== 'object' || Object.keys(spec.responses).length === 0) {
      note(`${file}${ptr}: declares no responses`);
    } else {
      for (const [status, rs] of Object.entries(spec.responses)) {
        const where = `${file}${ptr}/responses/${status}`;
        if (!/^[1-5]\d\d$/.test(status)) { note(`${where}: responses keys must be numeric status codes`); continue; }
        for (const msg of keywordProblems(rs, file, `${ptr}/responses/${status}`, { top: true })) note(msg);
        responses.set(status, guard(where, () => classifyResponse(where, key, status, rs, walker), { kind: 'bad', units: [] }));
      }
    }
    endpoints.set(key, { file, group, path: m[2], ptr, spec, walker, responses });
  }
}

// ---------------------------------------------------------------- fixtures

const coverage = createCoverage();
let fixtureCount = 0;

if (existsSync(FIXTURE_DIR)) {
  for (const entry of readdirSync(FIXTURE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name.endsWith('.json')) note(`fixtures/${entry.name}: fixtures belong in fixtures/<group>/`);
      continue;
    }
    const group = entry.name;
    if (!groups.includes(group)) note(`fixtures/${group}/: no group schema schema/http/${group}${SCHEMA_SUFFIX}`);

    for (const file of listJson(join(FIXTURE_DIR, group))) {
      const where = `fixtures/${group}/${file}`;
      fixtureCount++;
      const fx = loadJson(join(FIXTURE_DIR, group, file), where, note);
      if (fx === undefined) continue;
      if (!fx || typeof fx !== 'object' || Array.isArray(fx)) { note(`${where}: a fixture must be an object`); continue; }
      for (const key of Object.keys(fx)) {
        if (!FIXTURE_KEYS.has(key)) note(`${where}: unexpected top-level key "${key}"`);
      }

      const ep = typeof fx.endpoint === 'string' ? endpoints.get(fx.endpoint) : undefined;
      if (!ep) { note(`${where}: endpoint "${fx.endpoint}" is not declared in any group file`); continue; }
      if (ep.group !== group) note(`${where}: "${fx.endpoint}" is declared in ${ep.file}, not in fixtures/${group}/`);
      if (!Number.isInteger(fx.status)) { note(`${where}: "status" must be an integer status code`); continue; }

      const statusKey = String(fx.status);
      const res = ep.responses.get(statusKey);
      if (!res) { note(`${where}: "${fx.endpoint}" declares no response for status ${statusKey}`); continue; }

      // 1. VALIDITY — request.
      const req = guard(where, () => validateNode(ep.walker, requestRoot(ep.spec), fx.request ?? {}, {
        name: where, label: `the request schema of "${fx.endpoint}"`,
      }), EMPTY);
      for (const msg of req.problems) note(msg);
      coverage.exercise(`${fx.endpoint}::request`, req.present);

      // 1. VALIDITY — response.
      switch (res.kind) {
        case 'bad':
        case 'unspecified':
          break;  // reported at load time, or the body is declared unchecked
        case 'none':
          if (fx.response !== undefined) note(`${where}: "${fx.endpoint}" ${statusKey} is x-content "none" but the fixture has a response`);
          break;
        case 'binary': {
          const r = fx.response;
          if (!r || typeof r !== 'object' || Array.isArray(r)) {
            note(`${where}: a binary response is { contentType, description }`);
            break;
          }
          for (const k of Object.keys(r)) if (!BINARY_KEYS.has(k)) note(`${where}: binary response carries "${k}"; only contentType and description`);
          if (typeof r.contentType !== 'string') note(`${where}: binary "contentType" must be a string`);
          if (typeof r.description !== 'string') note(`${where}: binary "description" must be a string`);
          break;
        }
        case 'sse': {
          if (!Array.isArray(fx.response)) { note(`${where}: an sse response is an array of events`); break; }
          const variants = res.events.doc.oneOf;
          fx.response.forEach((ev, i) => {
            const variant = variantFor(variants, ev ?? {});
            if (!variant) { note(`${where}: event ${i} matches no event variant (type=${JSON.stringify(ev?.type)})`); return; }
            const r = guard(where, () => validateNode(res.events.walker, variant, ev, {
              name: `${where}: event ${i}`, label: `the event schema variant "${variant.title}"`,
            }), EMPTY);
            for (const msg of r.problems) note(msg);
            coverage.exercise(`${fx.endpoint}::${statusKey}::event::${variant.title ?? variants.indexOf(variant)}`, r.present);
          });
          break;
        }
        default: {  // schema, including oneOf and text
          if (fx.response === undefined) { note(`${where}: no "response" for status ${statusKey}`); break; }
          const r = guard(where, () => validateNode(ep.walker, res.node, fx.response, {
            name: where, label: `the ${statusKey} response schema of "${fx.endpoint}"`,
          }), EMPTY);
          for (const msg of r.problems) note(msg);
          if (res.oneOf) {
            if (r.matched >= 0) coverage.exercise(res.units[r.matched].unit, r.present);
          } else {
            coverage.exercise(res.units[0].unit, r.present);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- coverage

// 2. COVERAGE — a declared path no fixture exercises is checked only in theory.
for (const [key, ep] of endpoints) {
  if (ep.spec.request !== undefined) {
    const declared = guard(`${ep.file}${ep.ptr}`, () => coverablePaths(ep.walker, requestRoot(ep.spec)), new Set());
    for (const msg of coverage.check(`${key}::request`, declared, `on the request of "${key}"`)) note(msg);
  }
  for (const [status, res] of ep.responses) {
    for (const u of res.units) {
      const declared = guard(`${ep.file}${ep.ptr}/responses/${status}`, () => coverablePaths(u.walker, u.node), new Set());
      for (const msg of coverage.check(u.unit, declared, `on the ${status} response of "${key}"`)) note(msg);
    }
  }
}

// ---------------------------------------------------------------- roster and summary

const specified = new Set();
const unspecifiedList = [];
const no2xx = [];
for (const [key, ep] of endpoints) {
  let has2xx = false;
  for (const [status, res] of ep.responses) {
    if (res.kind === 'unspecified') unspecifiedList.push(`${key} ${status} — ${res.reason}`);
    if (status.startsWith('2') && res.kind !== 'unspecified' && res.kind !== 'bad') has2xx = true;
  }
  if (has2xx && roster.has(ep.path)) specified.add(ep.path);
  if (!has2xx) no2xx.push(key);
}
if (requireAll) {
  for (const key of no2xx) note(`"${key}" has no specified 2xx response (--require-all)`);
  for (const p of roster) if (!specified.has(p)) note(`roster path ${p} has no schema (--require-all)`);
}
for (const u of unspecifiedList) console.log(`unspecified: ${u}`);

const pct = roster.size ? ((100 * specified.size) / roster.size).toFixed(1) : '0.0';
const specifiedOf = (set) => [...set].filter((p) => specified.has(p)).length;
report.finish({
  title: 'http conformance',
  footer: 'See schema/http/SCHEMA.md.',
  ok: `http conformance: ${groups.length} groups, ${specified.size}/${roster.size} endpoints specified (${pct}%; `
    + `ALL_ENDPOINTS ${specifiedOf(allEndpoints)}/${allEndpoints.size}, public + auth ${specifiedOf(publicAuth)}/${publicAuth.size}), `
    + `${fixtureCount} fixtures, ${unspecifiedList.length} unspecified${requireAll ? ' (--require-all)' : ''}`,
});
