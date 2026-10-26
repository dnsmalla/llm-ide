#!/usr/bin/env node
// Generates extension/src/lib/api-types.ts from the HTTP contract in
// schema/http/*.schema.json (and the agent-v2 event schema those endpoints
// reference through x-events).
//
//   node scripts/gen-api-types.mjs           write the file
//   node scripts/gen-api-types.mjs --check   fail when the file is stale, or when a
//                                            hand-written type in extension/src
//                                            re-declares a generated name
//
// Output is deterministic (sorted documents, schema order inside a document), so
// --check is a plain byte comparison. Hand-written duplicates are listed in
// HAND_TYPE_ALLOWLIST below, each with the reason it must stay.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'schema/http');
const EVENT_SCHEMAS = ['schema/agent-v2/agent-v2.schema.json'];
const OUT_FILE = join(ROOT, 'extension/src/lib/api-types.ts');
const SRC_DIR = join(ROOT, 'extension/src');
const CHECK = process.argv.includes('--check');

// Hand-written types in extension/src that deliberately keep a generated name.
// Key: "<relative path>:<TypeName>", value: why it stays hand-written.
const HAND_TYPE_ALLOWLIST = {};

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const REQUEST_PARTS = ['query', 'params', 'body'];

// ---------- naming ----------

const pascal = (s) =>
  String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

const docPascal = (id) => (id === '_common' ? 'Common' : pascal(id));

const endpointBase = (key) => {
  const [method, path] = key.split(' ');
  return pascal(method.toLowerCase()) + pascal(path);
};

const jsDoc = (text, ind) => {
  if (!text) return '';
  const body = String(text).replace(/\s+/g, ' ').trim().replace(/\*\//g, '*\\/');
  return `${ind}/** ${body} */\n`;
};

const propKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

// ---------- load documents ----------

function loadDocs() {
  const docs = new Map(); // id -> { id, file, json, rel }
  const groupFiles = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
  for (const f of groupFiles) {
    const id = f.replace(/\.schema\.json$/, '');
    const rel = `schema/http/${f}`;
    docs.set(id, { id, rel, json: JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')) });
  }
  for (const rel of EVENT_SCHEMAS) {
    const id = basename(rel).replace(/\.schema\.json$/, '');
    docs.set(id, { id, rel, json: JSON.parse(readFileSync(join(ROOT, rel), 'utf8')), event: true });
  }
  return docs;
}

const docs = loadDocs();
const pathToDoc = new Map([...docs.values()].map((d) => [d.rel, d.id]));
const httpDocIds = [...docs.values()].filter((d) => !d.event).map((d) => d.id);

// ---------- named $defs ----------

// A def name is kept bare unless two documents declare it; then each takes its
// document's prefix so the names stay unambiguous.
const defCount = new Map();
for (const d of docs.values()) {
  for (const name of Object.keys(d.json.$defs || {})) {
    defCount.set(name, (defCount.get(name) || 0) + 1);
  }
}
const defNames = new Map(); // "docId\0defName" -> TS name
for (const d of docs.values()) {
  for (const name of Object.keys(d.json.$defs || {})) {
    // _common defs always carry the prefix, so \`Error\` never shadows the global.
    const prefixed = d.id === '_common' || defCount.get(name) > 1;
    const tsName = prefixed ? docPascal(d.id) + name : name;
    defNames.set(`${d.id}\0${name}`, tsName);
  }
}

function refName(ref, fromDoc) {
  const m = /^(?:([^#]*)|)#\/\$defs\/(.+)$/.exec(ref);
  if (!m) throw new Error(`unsupported $ref "${ref}" in ${fromDoc.rel}`);
  let target = fromDoc.id;
  if (m[1]) {
    if (m[1] === '_common') target = '_common';
    else throw new Error(`unsupported $ref document "${m[1]}" in ${fromDoc.rel}`);
  }
  const name = defNames.get(`${target}\0${m[2]}`);
  if (!name) throw new Error(`unresolved $ref "${ref}" in ${fromDoc.rel}`);
  return name;
}

// ---------- schema -> TypeScript ----------

const union = (parts) => [...new Set(parts)].join(' | ');
const wrapArray = (s) => (/[|&]/.test(s) ? `(${s})` : s);

function objectType(node, doc, ind) {
  const props = node.properties || {};
  const keys = Object.keys(props);
  const required = new Set(node.required || []);
  const ap = node.additionalProperties;
  const inner = ind + '  ';

  const lines = keys.map((k) => {
    const p = props[k];
    const optional = !required.has(k) || p['x-optional'] === true;
    return `${jsDoc(p.description, inner)}${inner}${propKey(k)}${optional ? '?' : ''}: ${ts(p, doc, inner)};`;
  });

  let index = null;
  if (ap && typeof ap === 'object') index = ts(ap, doc, inner);
  else if (ap === true || (ap === undefined && keys.length === 0)) index = 'unknown';

  if (keys.length === 0) {
    if (index === null) return 'Record<string, never>';
    return `Record<string, ${index}>`;
  }
  const literal = `{\n${lines.join('\n')}\n${ind}}`;
  if (index === null || index === 'unknown') {
    if (index === null) return literal;
    return `{\n${lines.join('\n')}\n${inner}[key: string]: unknown;\n${ind}}`;
  }
  // A typed map beside named properties: intersect rather than index, so the
  // named keys do not have to fit the index signature.
  return `${literal} & Record<string, ${index}>`;
}

function ts(node, doc, ind = '') {
  if (node === undefined || node === null || typeof node !== 'object') return 'unknown';
  if (node.$ref) return refName(node.$ref, doc);
  if (node['x-unspecified'] !== undefined) return 'unknown';
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (Array.isArray(node.enum)) return union(node.enum.map((v) => JSON.stringify(v)));
  if (Array.isArray(node.oneOf)) return union(node.oneOf.map((v) => ts(v, doc, ind)));
  const t = node.type;
  if (Array.isArray(t)) return union(t.map((x) => ts({ ...node, type: x }, doc, ind)));
  switch (t) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `${wrapArray(node.items ? ts(node.items, doc, ind) : 'unknown')}[]`;
    case 'object':
      return objectType(node, doc, ind);
    default:
      if (node.properties || node.additionalProperties !== undefined) return objectType(node, doc, ind);
      if (node.items) return `${wrapArray(ts(node.items, doc, ind))}[]`;
      return 'unknown';
  }
}

// ---------- endpoints ----------

function endpointTypes(doc, key, spec, names) {
  const out = [];
  const base = names.get(key);
  const requestName = `${base}Request`;
  const parts = spec.request || {};
  const partKeys = REQUEST_PARTS.filter((p) => parts[p] !== undefined);
  const unknownParts = Object.keys(parts).filter((p) => !REQUEST_PARTS.includes(p));
  if (unknownParts.length) throw new Error(`${doc.rel} ${key}: unknown request part ${unknownParts.join(', ')}`);

  const requestBody =
    partKeys.length === 0
      ? 'Record<string, never>'
      : `{\n${partKeys
          .map((p) => `  ${p}: ${ts(parts[p], doc, '  ')};`)
          .join('\n')}\n}`;
  out.push(`${jsDoc(`Request parts for \`${key}\` (${doc.rel}).`, '')}export type ${requestName} = ${requestBody};\n`);

  const statuses = Object.keys(spec.responses || {}).sort((a, b) => Number(a) - Number(b));
  const responseNames = {};
  for (const status of statuses) {
    const name = `${base}Response${status}`;
    responseNames[status] = name;
    const node = spec.responses[status];
    let body;
    if (node['x-content'] === 'none') body = 'void';
    else if (node['x-content'] === 'binary') body = 'Blob';
    else if (node['x-content'] === 'text') body = 'string';
    else if (node['x-content'] === 'sse') {
      const eventDocId = pathToDoc.get(node['x-events']);
      if (!eventDocId) throw new Error(`${doc.rel} ${key} ${status}: x-events ${node['x-events']} not loaded`);
      body = `ReadonlyArray<${defEventName(eventDocId)}>`;
    } else body = ts(node, doc, '');
    out.push(`${jsDoc(node.description, '')}export type ${name} = ${body};\n`);
  }

  return { out, requestName, responseNames };
}

// The root of an event schema is the event union; it is named after its document.
const defEventName = (docId) => `${docPascal(docId)}Event`;

// ---------- generate ----------

function generate() {
  // Endpoint names: check uniqueness across the whole contract.
  const names = new Map();
  const seen = new Map();
  const endpointList = [];
  for (const id of httpDocIds) {
    const d = docs.get(id);
    for (const key of Object.keys(d.json.endpoints || {})) {
      const [method, path] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
      if (!METHODS.has(method) || !path.startsWith('/')) throw new Error(`${d.rel}: bad endpoint key "${key}"`);
      const base = endpointBase(key);
      if (seen.has(base)) throw new Error(`endpoint name clash: "${key}" and "${seen.get(base)}" both map to ${base}`);
      seen.set(base, key);
      names.set(key, base);
      endpointList.push({ doc: d, key, spec: d.json.endpoints[key] });
    }
  }

  const body = [];
  for (const id of [...docs.keys()].sort()) {
    const d = docs.get(id);
    const defs = d.json.$defs || {};
    for (const name of Object.keys(defs)) {
      body.push(`${jsDoc(defs[name].description, '')}export type ${defNames.get(`${id}\0${name}`)} = ${ts(defs[name], d, '')};\n`);
    }
    if (d.event) {
      const root = { ...d.json };
      delete root.$defs;
      body.push(`${jsDoc(d.json.description, '')}export type ${defEventName(id)} = ${ts(root, d, '')};\n`);
    }
  }

  const mapEntries = [];
  let endpointCount = 0;
  let responseCount = 0;
  for (const { doc, key, spec } of endpointList) {
    const { out, requestName, responseNames } = endpointTypes(doc, key, spec, names);
    body.push(...out);
    endpointCount += 1;
    responseCount += Object.keys(responseNames).length;
    const responseLines = Object.entries(responseNames).map(([s, n]) => `      ${s}: ${n};`);
    mapEntries.push(
      `  ${JSON.stringify(key)}: {\n    request: ${requestName};\n    responses: {\n${responseLines.join('\n')}\n    };\n  };`,
    );
  }

  const header = [
    '// GENERATED - do not edit.',
    '// Source: schema/http/*.schema.json (+ schema/agent-v2 event schema).',
    '// Regenerate with `node scripts/gen-api-types.mjs` (or `make api-types`).',
    '// Check with `node scripts/gen-api-types.mjs --check` (part of `make contract-gates`).',
    '',
  ].join('\n');

  const map = [
    '/** Typed map of every endpoint: request parts and each declared response, by status. */',
    'export interface ApiEndpoints {',
    ...mapEntries,
    '}',
    '',
    'export type ApiEndpointKey = keyof ApiEndpoints;',
    '',
    'export type ApiResponse<K extends ApiEndpointKey, S extends keyof ApiEndpoints[K][\'responses\']> =',
    '  ApiEndpoints[K][\'responses\'][S];',
    '',
  ].join('\n');

  const text = `${header}\n${body.join('\n')}\n${map}`;
  return { text, endpointCount, responseCount, typeCount: countExports(text) };
}

function countExports(text) {
  return (text.match(/^export (type|interface) \w+/gm) || []).length;
}

// ---------- hand-written duplicate gate ----------

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && p !== OUT_FILE) out.push(p);
  }
  return out;
}

function handDuplicates(generatedNames) {
  // A declaration, not an import-list entry: the name is followed by generics,
  // `=`, `extends` or `{`, never by the `,` of an import list.
  const decl = /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_]\w*)(?=\s*(?:<|=|extends\b|\{))/gm;
  const found = [];
  for (const file of walk(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(decl)) {
      const name = m[1];
      if (!generatedNames.has(name)) continue;
      const key = `${relative(ROOT, file)}:${name}`;
      if (HAND_TYPE_ALLOWLIST[key]) continue;
      found.push(key);
    }
  }
  return found;
}

// ---------- main ----------

const { text, endpointCount, responseCount, typeCount } = generate();
const generatedNames = new Set([...text.matchAll(/^export (?:type|interface) (\w+)/gm)].map((m) => m[1]));

if (CHECK) {
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
  const problems = [];
  if (current !== text) {
    problems.push(`${relative(ROOT, OUT_FILE)} is stale; run node scripts/gen-api-types.mjs`);
  }
  for (const key of handDuplicates(generatedNames)) {
    problems.push(`${key} re-declares a generated API type; import it from lib/api-types.ts instead`);
  }
  if (problems.length) {
    console.error(`api-types: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`api-types: ok (${typeCount} types, ${endpointCount} endpoints, ${responseCount} responses)`);
} else {
  writeFileSync(OUT_FILE, text);
  console.log(`wrote ${relative(ROOT, OUT_FILE)} (${typeCount} types, ${endpointCount} endpoints, ${responseCount} responses)`);
}
