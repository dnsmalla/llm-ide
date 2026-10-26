#!/usr/bin/env node
// Generates docs/reference/api/openapi.yaml (OpenAPI 3.1) from the HTTP contract
// in schema/http/*.schema.json, merged with docs/reference/api/openapi.overlay.json
// (the human summaries, descriptions and response descriptions the schemas do not carry).
//
//   node scripts/gen-openapi.mjs           write the file
//   node scripts/gen-openapi.mjs --check   fail when the file on disk is stale
//
// The overlay is keyed by "METHOD /path" in OpenAPI form ({param}); its parameter
// keys are "in.name" and its response keys are status codes. Every overlay entry
// must name something the contract generates, so an entry for a removed endpoint
// fails the run instead of going stale. `outsideRoster` carries operations served
// outside ALL_ENDPOINTS (no schema exists for them) and is copied through verbatim.
//
// Output is deterministic (sorted paths, fixed method order, schema key order), so
// --check is a plain byte comparison.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractDocs } from './lib/http-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'docs/reference/api/openapi.yaml');
const OVERLAY_FILE = join(ROOT, 'docs/reference/api/openapi.overlay.json');
const SERVER_FILE = join(ROOT, 'extension/server.mjs');
const CHECK = process.argv.includes('--check');

const METHOD_ORDER = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];
const METHODS = new Set(METHOD_ORDER.map((m) => m.toUpperCase()));
const REQUEST_PARTS = ['query', 'params', 'body'];

// Schema keywords copied into OpenAPI. Metadata keywords are dropped; anything else
// fails the run, so a keyword the converter does not map cannot vanish silently.
const SCHEMA_KEYWORDS = new Set([
  'type', 'title', 'description', 'enum', 'const', 'required', 'properties', 'items',
  'additionalProperties', 'oneOf',
]);
const DROPPED_KEYWORDS = new Set(['$schema', '$id', '$comment', '$defs']);

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large',
  415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

const pascal = (s) =>
  String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

// ---------- component names ----------

// A named $def keeps its bare name unless two documents declare it; then each takes
// its document's prefix. An event document's root is named after the document.
function componentNames(docs) {
  const count = new Map();
  for (const d of docs.values()) {
    for (const name of Object.keys(d.json.$defs || {})) count.set(name, (count.get(name) || 0) + 1);
  }
  const names = new Map(); // "docId\0defName" -> component name
  const taken = new Map(); // component name -> where it came from
  const claim = (name, from) => {
    if (taken.has(name)) throw new Error(`component name clash: "${name}" from ${from} and ${taken.get(name)}`);
    taken.set(name, from);
  };
  for (const d of docs.values()) {
    for (const name of Object.keys(d.json.$defs || {})) {
      const out = count.get(name) > 1 ? pascal(d.id) + name : name;
      names.set(`${d.id}\0${name}`, out);
      claim(out, d.rel);
    }
    if (d.event) {
      const root = `${pascal(d.id)}Event`;
      names.set(`${d.id}\0<root>`, root);
      claim(root, d.rel);
    }
  }
  return names;
}

// ---------- schema conversion ----------

function makeConverter(names, docs) {
  const refTarget = (ref, doc) => {
    const m = /^([^#]*)#\/\$defs\/(.+)$/.exec(ref);
    if (!m) throw new Error(`${doc.rel}: unsupported $ref "${ref}"`);
    if (m[1] && m[1] !== '_common') throw new Error(`${doc.rel}: unsupported $ref document "${m[1]}"`);
    const target = m[1] ? '_common' : doc.id;
    const name = names.get(`${target}\0${m[2]}`);
    if (!name) throw new Error(`${doc.rel}: unresolved $ref "${ref}"`);
    return `#/components/schemas/${name}`;
  };

  // JSON Schema 2020-12 is what OpenAPI 3.1 embeds, so most keywords pass through.
  // $ref becomes a component reference; x-unspecified becomes an unconstrained schema
  // that carries the reason; other x-* keys (x-optional, x-content) are contract-only.
  const convert = (node, doc) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`${doc.rel}: schema node is not an object`);
    }
    if (node.$ref !== undefined) return { $ref: refTarget(node.$ref, doc) };
    if (node['x-unspecified'] !== undefined) return { description: `Not yet specified: ${node['x-unspecified']}` };
    const out = {};
    for (const key of Object.keys(node)) {
      if (key.startsWith('x-') || DROPPED_KEYWORDS.has(key)) continue;
      if (!SCHEMA_KEYWORDS.has(key)) {
        throw new Error(`${doc.rel}: unhandled schema keyword "${key}"; the converter maps ${[...SCHEMA_KEYWORDS].join(', ')}`);
      }
      const v = node[key];
      if (key === 'properties') {
        out.properties = Object.fromEntries(Object.entries(v).map(([k, p]) => [k, convert(p, doc)]));
      } else if (key === 'items') {
        out.items = convert(v, doc);
      } else if (key === 'additionalProperties') {
        out.additionalProperties = typeof v === 'object' ? convert(v, doc) : v;
      } else if (key === 'oneOf') {
        out.oneOf = v.map((x) => convert(x, doc));
      } else {
        out[key] = v;
      }
    }
    return out;
  };
  // The node a schema (or $ref) denotes, following references to their $defs target.
  const resolve = (node, doc) => {
    let current = node;
    let docId = doc.id;
    for (let hops = 0; current && current.$ref !== undefined; hops += 1) {
      if (hops > 16) throw new Error(`${doc.rel}: $ref chain too deep`);
      const m = /^([^#]*)#\/\$defs\/(.+)$/.exec(current.$ref);
      if (!m) throw new Error(`${doc.rel}: unsupported $ref "${current.$ref}"`);
      const target = m[1] ? '_common' : docId;
      const found = docs.get(target)?.json?.$defs?.[m[2]];
      if (!found) throw new Error(`${doc.rel}: unresolved $ref "${current.$ref}"`);
      current = found;
      docId = target;
    }
    return current;
  };
  return { convert, refTarget, resolve };
}

// ---------- YAML output ----------

// The file is emitted by a small block-style writer: keys are plain where safe and
// scalars are JSON-quoted (valid YAML). Enough for a spec document, and it keeps the
// generator free of a YAML dependency.
const PLAIN_KEY = /^[A-Za-z_/][A-Za-z0-9_/.{}-]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
const yamlKey = (k) => (PLAIN_KEY.test(k) && !RESERVED.has(k.toLowerCase()) ? k : JSON.stringify(k));
const isScalar = (v) => v === null || typeof v !== 'object';
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
const yamlScalar = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
};
const emptyFlow = (v) => (Array.isArray(v) ? '[]' : '{}');

function yamlBlock(v, ind) {
  const pad = ' '.repeat(ind);
  if (Array.isArray(v)) {
    return v.flatMap((item) => {
      if (isScalar(item)) return [`${pad}- ${yamlScalar(item)}`];
      if (isEmpty(item)) return [`${pad}- ${emptyFlow(item)}`];
      const sub = yamlBlock(item, ind + 2);
      return [`${pad}- ${sub[0].trimStart()}`, ...sub.slice(1)];
    });
  }
  return Object.entries(v).flatMap(([k, child]) => {
    const key = yamlKey(k);
    if (isScalar(child)) return [`${pad}${key}: ${yamlScalar(child)}`];
    if (isEmpty(child)) return [`${pad}${key}: ${emptyFlow(child)}`];
    return [`${pad}${key}:`, ...yamlBlock(child, ind + 2)];
  });
}

const toYaml = (doc) => `${yamlBlock(doc, 0).join('\n')}\n`;

// ---------- operations ----------

// OpenAPI path form: Express-style :name becomes {name}.
const oasPath = (path) => path.replace(/:([A-Za-z_]\w*)/g, '{$1}');

// Overlay overrides for one parameter's OpenAPI schema. The contract types query values
// as strings (the wire form; fixtures carry "5", not 5), so a numeric parameter is typed
// here as an integer with its handler default. Only keywords the handler actually
// enforces or relies on belong here, and each override must name a real parameter.
const PARAM_OVERRIDE_KEYS = new Set(['type', 'default', 'pattern', 'enum', 'format', 'items', 'required']);
const PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array']);

function applyParamOverride(opKey, location, name, schema, override, seenOverlay) {
  const where = `openapi.overlay.json: ${opKey} parameterSchemas.${location}.${name}`;
  for (const k of Object.keys(override)) {
    if (!PARAM_OVERRIDE_KEYS.has(k)) throw new Error(`${where}: keyword "${k}" is not an allowed override`);
  }
  if (override.type !== undefined && !PARAM_TYPES.has(override.type)) {
    throw new Error(`${where}: type "${override.type}" is not allowed`);
  }
  seenOverlay.add(`${opKey}|param override ${location}.${name}`);
  const { required, ...rest } = override;
  Object.assign(schema, rest);
  return required;
}

// Response media types the overlay adds or removes. A status with no contract body that
// the handlers answer with the shared JSON error envelope gets that envelope by default.
const ERROR_CONTENT = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

// overlay operations[opKey].responseContent[status] = { removeContent?: [mediaType],
// content?: { mediaType: { schema } } }. Media types are added or replaced; removeContent
// drops the contract's own. Used for the wire types the contract cannot name (a DOCX
// download, NDJSON, text/html, an SSE stream of unspecified events).
function applyContentOverride(opKey, status, response, ov, seenOverlay) {
  const o = ov.responseContent?.[status];
  if (o === undefined) return;
  const where = `openapi.overlay.json: ${opKey} responseContent.${status}`;
  for (const k of Object.keys(o)) {
    if (k !== 'removeContent' && k !== 'content') throw new Error(`${where}: keyword "${k}" is not allowed`);
  }
  const content = { ...(response.content || {}) };
  for (const mt of o.removeContent || []) delete content[mt];
  for (const [mt, entry] of Object.entries(o.content || {})) {
    if (!mt.includes('/')) throw new Error(`${where}: "${mt}" is not a media type`);
    if (!entry || typeof entry !== 'object' || !('schema' in entry)) throw new Error(`${where}: ${mt} needs a schema`);
    content[mt] = entry;
  }
  if (Object.keys(content).length) response.content = content;
  else delete response.content;
  seenOverlay.add(`${opKey}|content ${status}`);
}

function buildOperation({ doc, key, spec, convert, resolve, ov, eventName, seenOverlay }) {
  const [method, path] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
  const opKey = `${method} ${oasPath(path)}`;
  const parts = spec.request || {};
  const unknown = Object.keys(parts).filter((p) => !REQUEST_PARTS.includes(p));
  if (unknown.length) throw new Error(`${doc.rel} ${key}: unknown request part ${unknown.join(', ')}`);

  const params = [];
  const placeholders = [...oasPath(path).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const pathParams = parts.params ? Object.keys(parts.params.properties || {}) : [];
  const missing = placeholders.filter((n) => !pathParams.includes(n));
  const extra = pathParams.filter((n) => !placeholders.includes(n));
  if (missing.length || extra.length) {
    throw new Error(`${doc.rel} ${key}: path parameters do not match the path (undeclared ${missing.join(', ') || '-'}, not in path ${extra.join(', ') || '-'})`);
  }

  const described = (location, name, schema) => {
    const overlayDesc = ov.parameters?.[`${location}.${name}`];
    if (overlayDesc !== undefined) seenOverlay.add(`${opKey}|param ${location}.${name}`);
    const desc = overlayDesc ?? schema.description;
    if (schema.description !== undefined) delete schema.description;
    return desc === undefined ? {} : { description: desc };
  };

  const overrideFor = (location, name, schema) => {
    const override = ov.parameterSchemas?.[`${location}.${name}`];
    return override === undefined ? undefined : applyParamOverride(opKey, location, name, schema, override, seenOverlay);
  };

  for (const name of pathParams) {
    const schema = convert(parts.params.properties[name], doc);
    overrideFor('path', name, schema);
    params.push({ name, in: 'path', required: true, ...described('path', name, schema), schema });
  }
  if (parts.query) {
    const required = new Set(parts.query.required || []);
    for (const name of Object.keys(parts.query.properties || {})) {
      const schema = convert(parts.query.properties[name], doc);
      const overrideRequired = overrideFor('query', name, schema);
      const isRequired = overrideRequired ?? required.has(name);
      params.push({ name, in: 'query', required: isRequired, ...described('query', name, schema), schema });
    }
  }
  for (const k of Object.keys(ov.parameterSchemas || {})) {
    if (!seenOverlay.has(`${opKey}|param override ${k}`)) {
      throw new Error(`openapi.overlay.json: ${opKey} parameterSchemas.${k} names no parameter in the contract`);
    }
  }
  // Query parameters the handler reads but the contract does not declare yet. They carry
  // no fixture coverage, so they live here, marked, until the contract declares them.
  for (const extra of ov.extraParameters || []) {
    if (extra.in !== 'query' || typeof extra.name !== 'string') {
      throw new Error(`openapi.overlay.json: ${opKey} extraParameters entries must be query parameters with a name`);
    }
    if (params.some((p) => p.name === extra.name && p.in === extra.in)) {
      throw new Error(`openapi.overlay.json: ${opKey} extraParameters.${extra.name} is already in the contract`);
    }
    params.push({ name: extra.name, in: 'query', required: false, 'x-undeclared': true, ...extra, schema: { type: 'string', ...(extra.schema || {}) } });
  }

  const op = {};
  if (ov.summary !== undefined) op.summary = ov.summary;
  if (ov.description !== undefined) op.description = ov.description;
  op.tags = [doc.id];
  if (ov.security !== undefined) op.security = ov.security;
  if (params.length) op.parameters = params;
  if (parts.body !== undefined) {
    // A body is required only when its schema requires some property: a handler that
    // accepts an empty POST has no required properties in its contract.
    const bodyNode = resolve(parts.body, doc);
    // An overlay bodyRequired (boolean) wins where a fixture deliberately sends a body
    // without the field the handler rejects, so the contract keeps its fixtures valid.
    const ruleRequired = Array.isArray(bodyNode.required) && bodyNode.required.length > 0;
    const bodyRequired = ov.bodyRequired ?? ruleRequired;
    if (typeof bodyRequired !== 'boolean') throw new Error(`openapi.overlay.json: ${opKey} bodyRequired must be a boolean`);
    op.requestBody = { required: bodyRequired, content: { 'application/json': { schema: convert(parts.body, doc) } } };
  } else if (ov.bodyRequired !== undefined) {
    throw new Error(`openapi.overlay.json: ${opKey} has bodyRequired but no request body`);
  }

  const declared = Object.keys(spec.responses || {});
  if (!declared.length) throw new Error(`${doc.rel} ${key}: no responses declared`);
  // A status the overlay documents but the contract does not declare yet is kept as a
  // description-only response, marked x-undeclared, so the gap stays visible.
  const statuses = [...new Set([...declared, ...Object.keys(ov.responses || {})])]
    .sort((a, b) => Number(a) - Number(b));
  const responses = {};
  for (const status of statuses) {
    const node = spec.responses[status];
    const overlayDesc = ov.responses?.[status];
    if (overlayDesc !== undefined) seenOverlay.add(`${opKey}|response ${status}`);
    if (node === undefined) {
      responses[status] = { description: overlayDesc, 'x-undeclared': true };
      if (Number(status) >= 400) responses[status].content = structuredClone(ERROR_CONTENT);
      applyContentOverride(opKey, status, responses[status], ov, seenOverlay);
      continue;
    }
    const xContent = node['x-content'];
    let r;
    if (node['x-unspecified'] !== undefined) {
      r = { description: overlayDesc ?? `Not yet specified: ${node['x-unspecified']}` };
    } else if (xContent === 'none') {
      r = { description: overlayDesc ?? STATUS_TEXT[status] ?? `HTTP ${status}` };
    } else if (xContent === 'binary') {
      r = {
        description: overlayDesc ?? 'File download',
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      };
    } else if (xContent === 'text') {
      r = {
        description: overlayDesc ?? STATUS_TEXT[status] ?? `HTTP ${status}`,
        content: { 'text/plain': { schema: { type: 'string' } } },
      };
    } else if (xContent === 'sse') {
      const events = { type: 'array', items: { $ref: `#/components/schemas/${eventName(node['x-events'])}` } };
      r = {
        description: overlayDesc ?? 'Server-sent event stream',
        content: { 'text/event-stream': { schema: events } },
      };
    } else {
      const schema = convert(node, doc);
      const desc = overlayDesc ?? schema.description ?? STATUS_TEXT[status] ?? `HTTP ${status}`;
      if (schema.description !== undefined) delete schema.description;
      r = { description: desc, content: { 'application/json': { schema } } };
    }
    // Error statuses the handlers answer with the shared JSON envelope (sendError).
    if (r.content === undefined && Number(status) >= 400) r.content = structuredClone(ERROR_CONTENT);
    applyContentOverride(opKey, status, r, ov, seenOverlay);
    responses[status] = r;
  }
  for (const s of Object.keys(ov.responseContent || {})) {
    if (!statuses.includes(s)) throw new Error(`openapi.overlay.json: ${opKey} responseContent.${s} names no response`);
  }
  op.responses = responses;
  return { opKey, path: oasPath(path), method: method.toLowerCase(), op };
}

// ---------- assemble ----------

function build() {
  const docs = loadContractDocs(ROOT);
  const names = componentNames(docs);
  const { convert, resolve } = makeConverter(names, docs);
  const overlay = JSON.parse(readFileSync(OVERLAY_FILE, 'utf8'));
  const serverSrc = readFileSync(SERVER_FILE, 'utf8');
  const apiVersion = Number(serverSrc.match(/const SERVER_API_VERSION = (\d+);/)?.[1]);
  if (!Number.isInteger(apiVersion)) throw new Error('SERVER_API_VERSION not found in extension/server.mjs');

  const eventDocs = new Map([...docs.values()].filter((d) => d.event).map((d) => [d.rel, d]));
  const eventName = (rel) => {
    const d = eventDocs.get(rel);
    if (!d) throw new Error(`x-events ${rel} is not a loaded event schema`);
    return names.get(`${d.id}\0<root>`);
  };

  const ops = new Map(); // "METHOD /path" -> { path, method, op }
  const seenOverlay = new Set();
  const tags = new Set();
  for (const d of docs.values()) {
    if (d.event) continue;
    tags.add(d.id);
    for (const key of Object.keys(d.json.endpoints || {})) {
      if (!METHODS.has(key.split(' ')[0]) || !key.split(' ').slice(1).join(' ').startsWith('/')) {
        throw new Error(`${d.rel}: bad endpoint key "${key}"`);
      }
      const spec = d.json.endpoints[key];
      const probe = buildOperation({
        doc: d, key, spec, convert, resolve, ov: {}, eventName, seenOverlay: new Set(),
      });
      const ov = overlay.operations?.[probe.opKey] ?? {};
      const built = buildOperation({ doc: d, key, spec, convert, resolve, ov, eventName, seenOverlay });
      if (ops.has(built.opKey)) throw new Error(`${d.rel} ${key}: duplicate operation ${built.opKey}`);
      ops.set(built.opKey, built);
    }
  }

  // Overlay entries must name generated operations, parameters and responses.
  for (const key of Object.keys(overlay.operations || {})) {
    if (!ops.has(key)) throw new Error(`openapi.overlay.json: "${key}" names no endpoint in schema/http`);
  }
  const overlayParamsAndResponses = [];
  for (const [key, ov] of Object.entries(overlay.operations || {})) {
    for (const p of Object.keys(ov.parameters || {})) overlayParamsAndResponses.push(`${key}|param ${p}`);
    for (const s of Object.keys(ov.responses || {})) overlayParamsAndResponses.push(`${key}|response ${s}`);
  }
  const stale = overlayParamsAndResponses.filter((k) => !seenOverlay.has(k));
  if (stale.length) throw new Error(`openapi.overlay.json: no generated match for ${stale.join('; ')}`);

  const paths = {};
  for (const { path, method, op } of ops.values()) {
    paths[path] ??= {};
    paths[path][method] = op;
  }
  for (const [path, item] of Object.entries(overlay.outsideRoster || {})) {
    if (paths[path]) throw new Error(`openapi.overlay.json: outsideRoster ${path} is already generated from the contract`);
    paths[path] = item;
  }
  const sortedPaths = {};
  for (const path of Object.keys(paths).sort()) {
    const item = {};
    for (const m of METHOD_ORDER) if (paths[path][m]) item[m] = paths[path][m];
    sortedPaths[path] = item;
  }

  const schemas = {};
  for (const d of [...docs.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const name of Object.keys(d.json.$defs || {})) {
      schemas[names.get(`${d.id}\0${name}`)] = convert(d.json.$defs[name], d);
    }
    if (d.event) {
      const root = { ...d.json };
      delete root.$defs;
      schemas[names.get(`${d.id}\0<root>`)] = convert(root, d);
    }
  }
  for (const [name, description] of Object.entries(overlay.components || {})) {
    if (!schemas[name]) throw new Error(`openapi.overlay.json: component "${name}" is not generated`);
    schemas[name] = { ...schemas[name], description };
  }

  const info = { ...overlay.info, 'x-api-version': apiVersion };
  const sortedSchemas = Object.fromEntries(Object.keys(schemas).sort().map((k) => [k, schemas[k]]));
  const doc = {
    openapi: '3.1.0',
    info,
    servers: overlay.servers,
    security: overlay.security,
    tags: [...tags].sort().map((name) => ({ name })),
    paths: sortedPaths,
    components: {
      securitySchemes: overlay.securitySchemes,
      schemas: sortedSchemas,
    },
  };
  return { text: `# GENERATED - do not edit.\n# Source: schema/http/*.schema.json, merged with docs/reference/api/openapi.overlay.json.\n# Regenerate with \`node scripts/gen-openapi.mjs\` (or \`make openapi\`).\n# Check with \`node scripts/gen-openapi.mjs --check\` (part of \`make contract-gates\`).\n${toYaml(doc)}`, operationCount: ops.size, schemaCount: Object.keys(sortedSchemas).length };
}

// ---------- main ----------

const { text, operationCount, schemaCount } = build();

if (CHECK) {
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
  if (current !== text) {
    console.error(`openapi: ${relative(ROOT, OUT_FILE)} is stale; run node scripts/gen-openapi.mjs`);
    process.exit(1);
  }
  console.log(`openapi: ok (${operationCount} operations, ${schemaCount} schemas)`);
} else {
  writeFileSync(OUT_FILE, text);
  console.log(`wrote ${relative(ROOT, OUT_FILE)} (${operationCount} operations, ${schemaCount} schemas)`);
}
