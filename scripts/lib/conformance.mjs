// Generic schema-vs-fixture conformance helpers, shared by
// scripts/conformance-agent-v2.mjs and scripts/conformance-http.mjs.
//
// Nothing here knows about agent/v2 or HTTP. A runner supplies its schema
// documents, fixtures and any domain-specific checks, and uses these pieces for:
//
//   - loading JSON, reporting parse errors as problems   loadJson, listJson
//   - schema walking and `$ref` resolution               makeSchemaWalker, RefError
//   - a flat validator (agent/v2, a discriminated union)  variantFor, checkDoc
//   - a schema-aware validator (HTTP: maps, oneOf, any)   validateNode, coverablePaths
//   - keyword whitelisting for a schema file             keywordProblems
//   - coverage: every declared path exercised            createCoverage
//   - a uniform report and exit code                     createReport
//
// No JSON-Schema library: the schemas use a small fixed subset, and an external
// validator would vanish on an unrelated dependency upgrade.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- files

/** Parse a JSON file. Throws on error; callers that must continue use loadJson. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Parse a JSON file. On failure (missing, unreadable, invalid) reports
 * `<label>: invalid JSON — <message>` through `onError` and returns undefined,
 * so the run continues and every bad file is listed.
 */
export function loadJson(path, label, onError) {
  try {
    return readJson(path);
  } catch (e) {
    onError(`${label}: invalid JSON — ${e.message}`);
    return undefined;
  }
}

/** Sorted names of the `.json` files directly inside `dir` ([] if it is missing). */
export function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

// ---------------------------------------------------------------- $ref

/** A `$ref` that does not resolve. Runners catch it and report it with the file name. */
export class RefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefError';
  }
}

// ---------------------------------------------------------------- schema walking

/**
 * Bind the path helpers to one schema document.
 *
 * `$ref` forms: `#/$defs/<name>` (this document) and `<file>#/$defs/<name>`
 * (a document passed in `externals`, keyed by `<file>`). A `$ref` node is
 * replaced wholesale by its target; siblings of `$ref` are not used.
 *
 * @param {object} root      the parsed schema document
 * @param {object} [opts]
 * @param {string[]} [opts.rootSkip=[]]  top-level keys ignored by path enumeration.
 *   agent/v2 passes ['type'] because `type` is the variant discriminator, not a field.
 * @param {Record<string, object>} [opts.externals={}]  other documents `$ref` may name.
 */
export function makeSchemaWalker(root, { rootSkip = [], externals = {} } = {}) {
  const skipRoot = new Set(rootSkip);

  /** Follow `$ref`s to the schema they name. Throws RefError if one does not resolve. */
  function resolveRef(node) {
    let n = node;
    const seen = new Set();
    while (n && typeof n === 'object' && typeof n.$ref === 'string') {
      const ref = n.$ref;
      if (seen.has(ref)) throw new RefError(`cyclic $ref "${ref}"`);
      seen.add(ref);
      const m = /^([A-Za-z0-9_-]+)?#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
      if (!m) throw new RefError(`unresolved $ref "${ref}"`);
      const doc = m[1] ? externals[m[1]] : root;
      const defs = doc?.$defs;
      if (!defs || !Object.hasOwn(defs, m[2])) throw new RefError(`unresolved $ref "${ref}"`);
      n = defs[m[2]];
    }
    return n;
  }

  /**
   * Dotted paths an object (or array of objects) schema declares. A property
   * whose value is an object or an array of objects is descended into.
   */
  function schemaPaths(node, prefix = '') {
    const out = new Set();
    if (node?.type === 'array') {
      // A root array: its item fields sit at the same prefix a document's do.
      for (const p of schemaPaths(resolveRef(node.items), prefix)) out.add(p);
      return out;
    }
    const props = node?.properties;
    if (!props) return out;
    for (const [key, value] of Object.entries(props)) {
      if (!prefix && skipRoot.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      const nested = value?.type === 'array' ? resolveRef(value.items) : resolveRef(value);
      if (nested && nested.type === 'object') {
        for (const child of schemaPaths(nested, path)) out.add(child);
      }
    }
    return out;
  }

  /**
   * Paths declared OPAQUE: a property with no `type`, no `properties` and no
   * `$ref`/`const`, i.e. `{}`. Its interior is not part of the contract (agent/v2's
   * `sdk.raw` passes a whole SDK message through verbatim), so it is not walked.
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

  /**
   * Paths of objects that set `additionalProperties: true`. Keys under them are
   * accepted without being declared. Anything else (the default, or `false`) is
   * strict: an undeclared key is a problem.
   */
  function openPaths(node, prefix = '') {
    const out = new Set();
    if (node?.type === 'array') return openPaths(resolveRef(node.items), prefix);
    if (node?.additionalProperties === true) out.add(prefix);  // '' = the root is open
    for (const [key, value] of Object.entries(node?.properties || {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      const nested = value?.type === 'array' ? resolveRef(value.items) : resolveRef(value);
      if (nested?.type === 'object') for (const p of openPaths(nested, path)) out.add(p);
    }
    return out;
  }

  /** Dotted paths a concrete document carries, not descending into opaque or open values. */
  function docPaths(value, prefix = '', opaque = new Set()) {
    const out = new Set();
    if (Array.isArray(value)) {
      for (const item of value) for (const p of docPaths(item, prefix, opaque)) out.add(p);
      return out;
    }
    if (value === null || typeof value !== 'object') return out;
    for (const [key, child] of Object.entries(value)) {
      if (!prefix && skipRoot.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      if (opaque.has(path)) continue;
      for (const p of docPaths(child, path, opaque)) out.add(p);
    }
    return out;
  }

  return { resolveRef, schemaPaths, opaquePaths, openPaths, docPaths };
}

// ---------------------------------------------------------------- variants

/**
 * The variant (an entry of `variants`) a document matches.
 *
 * Each discriminator is a property name. A `strict` discriminator must equal the
 * document's value (`type` is strict: an absent const never matches). A
 * non-strict one only constrains a variant that declares a const for it (`kind`).
 * Variants that declare no const for a discriminator are not constrained by it.
 *
 * @returns {object | undefined}
 */
export function variantFor(variants, doc, discriminators = [{ key: 'type', strict: true }, { key: 'kind' }]) {
  return variants.find((v) => {
    const props = v.properties || {};
    for (const { key, strict } of discriminators) {
      const c = props[key]?.const;
      if (strict) {
        if (c !== doc[key]) return false;
      } else if (c && c !== doc[key]) {
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------- flat validity (agent/v2)

/**
 * Required keys of `node` that `value` lacks. `deep` also checks every nested
 * object and array item the value carries (an absent nested object is not
 * checked: its own parent's `required` decides that).
 */
function requiredProblems(walker, node, value, prefix, deep, out) {
  const target = walker.resolveRef(node);
  if (!target || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) requiredProblems(walker, target.items ?? target, item, prefix, deep, out);
    return out;
  }
  for (const key of target.required || []) {
    if (!(key in value)) out.push(prefix ? `${prefix}.${key}` : key);
  }
  if (!deep) return out;
  for (const [key, child] of Object.entries(target.properties || {})) {
    if (!(key in value)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const childNode = child?.type === 'array' ? walker.resolveRef(child.items) : walker.resolveRef(child);
    if (child?.type === 'array') {
      for (const item of Array.isArray(value[key]) ? value[key] : []) requiredProblems(walker, childNode, item, path, deep, out);
    } else {
      requiredProblems(walker, childNode, value[key], path, deep, out);
    }
  }
  return out;
}

/**
 * VALIDITY for one document against one flat schema node (no maps, no oneOf).
 * Used by agent/v2. Reports each required key the document lacks (`type` is never
 * required from the document: it is the discriminator), each path it carries that
 * the schema does not declare (unless under an `additionalProperties: true`
 * object), and, with `checkTypes`, each value whose type, const or enum disagrees.
 *
 * @param {object} p
 * @param {ReturnType<typeof makeSchemaWalker>} p.walker
 * @param {object} p.node       schema node the document must match
 * @param {unknown} p.doc       the document
 * @param {string} p.name       document name, prefixes every message
 * @param {string} p.label      how the message refers to the schema, e.g. `the schema variant "x"`
 * @param {boolean} [p.deepRequired=false]  also check required keys of nested objects
 * @param {boolean} [p.checkTypes=false]    also check value types, const and enum
 * @returns {{ present: Set<string>, problems: string[] }}
 */
export function checkDoc({ walker, node, doc, name, label, deepRequired = false, checkTypes = false }) {
  const problems = [];
  const opaque = walker.opaquePaths(node);
  const open = walker.openPaths(node);
  const present = walker.docPaths(doc, '', opaque);
  const declared = walker.schemaPaths(node);

  for (const path of requiredProblems(walker, node, doc, '', deepRequired, [])) {
    if (path !== 'type') problems.push(`${name}: missing required "${path}"`);
  }
  for (const path of present) {
    if (declared.has(path)) continue;
    if ([...open].some((o) => o === '' || path.startsWith(`${o}.`))) continue;
    problems.push(`${name}: "${path}" is not declared by ${label}`);
  }
  if (checkTypes) {
    for (const msg of typeProblems(walker, node, doc, '')) problems.push(`${name}: ${msg}`);
  }
  return { present, problems };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const got = typeOf(v);
  if (want === 'number') return got === 'number' || got === 'integer';
  return got === want;
}

/** Type, const and enum problems at and below `value` (flat walk). Messages carry no name prefix. */
function typeProblems(walker, node, value, path) {
  const out = [];
  const target = walker.resolveRef(node);
  if (!target || typeof target !== 'object') return out;
  const at = path || '(root)';
  if (target.const !== undefined && value !== target.const) out.push(`"${at}" must be ${JSON.stringify(target.const)}`);
  if (target.enum && !target.enum.includes(value)) out.push(`"${at}" must be one of ${JSON.stringify(target.enum)}`);
  if (target.type !== undefined && value !== undefined) {
    const wanted = Array.isArray(target.type) ? target.type : [target.type];
    if (!wanted.some((w) => typeMatches(w, value))) out.push(`"${at}" should be ${wanted.join(' or ')}, got ${typeOf(value)}`);
  }
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    if (target.items) value.forEach((item) => out.push(...typeProblems(walker, target.items, item, `${path}[]`)));
    return out;
  }
  for (const [key, child] of Object.entries(target.properties || {})) {
    if (!(key in value)) continue;
    out.push(...typeProblems(walker, child, value[key], path ? `${path}.${key}` : key));
  }
  return out;
}

// ---------------------------------------------------------------- schema-aware validity (HTTP)

const joinPath = (prefix, key) => (prefix ? `${prefix}.${key}` : key);

/**
 * Validate one value against one schema node, recursively. Supports objects with
 * `properties` / `required`, `additionalProperties` as `true` (keys free) or as a
 * schema (map values typed; the key position is written `*` in paths), arrays of
 * any depth, `type` (including arrays of types), `const`, `enum`. A `{}` node, or
 * one with only `description`/`title`/`x-*`, constrains nothing.
 *
 * Paths in `present` use `*` for map keys, so they line up with coverablePaths.
 *
 * @returns {{ present: Set<string>, problems: string[], matched?: number }}
 *   For a node with `oneOf`: `matched` is the index of the first variant with no
 *   problems. A value matching none reports the closest variant's problems.
 */
export function validateNode(walker, node, value, { name, label }) {
  const resolved = walker.resolveRef(node);
  if (resolved?.oneOf) {
    const results = resolved.oneOf.map((v) => validateNode(walker, v, value, { name, label }));
    const ok = results.findIndex((r) => r.problems.length === 0);
    if (ok >= 0) return { ...results[ok], matched: ok };
    let closest = 0;
    results.forEach((r, i) => { if (r.problems.length < results[closest].problems.length) closest = i; });
    return {
      present: new Set(),
      problems: [
        `${name}: matches none of the ${results.length} variants of ${label}`,
        ...results[closest].problems.map((p) => `  closest variant ${closest}: ${p}`),
      ],
      matched: -1,
    };
  }
  const present = new Set();
  const problems = [];
  visitValue(walker, node, value, '', present, problems, name, label);
  return { present, problems };
}

function visitValue(walker, node, value, path, present, problems, name, label) {
  const target = walker.resolveRef(node);
  if (!target || typeof target !== 'object') return;
  const specKeys = Object.keys(target).filter((k) => !k.startsWith('x-') && k !== 'description' && k !== 'title');
  if (specKeys.length === 0) return;
  const at = path || '(root)';
  if (Object.hasOwn(target, 'const') && value !== target.const) {
    problems.push(`${name}: "${at}" must be ${JSON.stringify(target.const)}`);
  }
  if (target.enum && !target.enum.includes(value)) {
    problems.push(`${name}: "${at}" must be one of ${JSON.stringify(target.enum)}`);
  }
  if (target.type !== undefined) {
    const wanted = Array.isArray(target.type) ? target.type : [target.type];
    if (!wanted.some((w) => typeMatches(w, value))) {
      problems.push(`${name}: "${at}" should be ${wanted.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(value)) {
    if (target.items) for (const item of value) visitValue(walker, target.items, item, path, present, problems, name, label);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const props = target.properties || {};
  for (const key of target.required || []) {
    if (!(key in value)) problems.push(`${name}: missing required "${joinPath(path, key)}"`);
  }
  const ap = target.additionalProperties;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(props, key)) {
      const childPath = joinPath(path, key);
      present.add(childPath);
      visitValue(walker, props[key], value[key], childPath, present, problems, name, label);
    } else if (ap && typeof ap === 'object') {
      const mapPath = joinPath(path, '*');
      present.add(mapPath);
      visitValue(walker, ap, value[key], mapPath, present, problems, name, label);
    } else if (ap === true) {
      present.add(joinPath(path, key));
    } else {
      problems.push(`${name}: "${joinPath(path, key)}" is not declared by ${label}`);
    }
  }
}

/**
 * Field paths a schema declares, for COVERAGE. Maps contribute `<prefix>.*` and
 * their value schema's paths beneath it. A property marked `"x-optional": true`
 * (on the property node itself) is not required to be exercised.
 */
export function coverablePaths(walker, node, prefix = '') {
  const out = new Set();
  const t = walker.resolveRef(node);
  if (!t || typeof t !== 'object' || t.oneOf) return out;
  if (t.type === 'array' || (t.items !== undefined && t.properties === undefined)) {
    if (t.items !== undefined) for (const p of coverablePaths(walker, t.items, prefix)) out.add(p);
    return out;
  }
  for (const [key, raw] of Object.entries(t.properties || {})) {
    const resolved = walker.resolveRef(raw);
    if (raw?.['x-optional'] === true || resolved?.['x-optional'] === true) continue;
    const path = joinPath(prefix, key);
    out.add(path);
    for (const p of coverablePaths(walker, raw, path)) out.add(p);
  }
  if (t.additionalProperties && typeof t.additionalProperties === 'object') {
    const mapPath = joinPath(prefix, '*');
    out.add(mapPath);
    for (const p of coverablePaths(walker, t.additionalProperties, mapPath)) out.add(p);
  }
  return out;
}

// ---------------------------------------------------------------- keywords

/** Keywords a schema file may use. `x-*` extension keys are always allowed. */
export const SCHEMA_KEYWORDS = Object.freeze(new Set([
  'type', 'properties', 'required', 'items', 'enum', 'const', '$ref', '$defs',
  'additionalProperties', 'description', 'title', 'oneOf',
]));

const escPtr = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Keywords outside SCHEMA_KEYWORDS (and not `x-*`) in a schema tree, each with its
 * file and JSON pointer. `oneOf` is allowed only when `top` is set (the root of a
 * response schema). A `$ref` may not carry sibling keywords, because they would be
 * silently ignored.
 *
 * @param {object} node  schema node to check
 * @param {string} file  file name for messages
 * @param {string} ptr   JSON pointer of `node` within `file`
 * @param {{ top?: boolean }} [opts]
 * @returns {string[]}
 */
export function keywordProblems(node, file, ptr, { top = false } = {}) {
  const out = [];
  const visit = (n, p, isTop) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      out.push(`${file}${p}: a schema must be an object`);
      return;
    }
    for (const k of Object.keys(n)) {
      if (SCHEMA_KEYWORDS.has(k) || k.startsWith('x-')) continue;
      out.push(`${file}${p}: unsupported keyword "${k}"`);
    }
    if (typeof n.$ref === 'string') {
      const siblings = Object.keys(n).filter((k) => k !== '$ref' && k !== 'description' && k !== 'title' && !k.startsWith('x-'));
      if (siblings.length) out.push(`${file}${p}: "$ref" cannot have sibling keywords (${siblings.join(', ')}); they would be ignored`);
    }
    if (n.oneOf !== undefined) {
      if (!isTop) out.push(`${file}${p}: "oneOf" is only supported at the top of a response schema`);
      else if (!Array.isArray(n.oneOf)) out.push(`${file}${p}: "oneOf" must be an array`);
      else n.oneOf.forEach((v, i) => visit(v, `${p}/oneOf/${i}`, false));
    }
    if (n.properties !== undefined) {
      if (typeof n.properties !== 'object') out.push(`${file}${p}: "properties" must be an object`);
      else for (const [k, v] of Object.entries(n.properties)) visit(v, `${p}/properties/${escPtr(k)}`, false);
    }
    if (n.items !== undefined) visit(n.items, `${p}/items`, false);
    if (n.additionalProperties && typeof n.additionalProperties === 'object') visit(n.additionalProperties, `${p}/additionalProperties`, false);
    if (n.$defs !== undefined && typeof n.$defs === 'object') {
      for (const [k, v] of Object.entries(n.$defs)) visit(v, `${p}/$defs/${escPtr(k)}`, false);
    }
  };
  visit(node, ptr, top);
  return out;
}

// ---------------------------------------------------------------- coverage

/**
 * COVERAGE bookkeeping. A runner calls `exercise` for every fixture, then
 * `check` for every declared unit. A declared path no fixture exercised is
 * a problem: it is checked only in theory.
 */
export function createCoverage() {
  const exercised = new Map();
  return {
    /** Record the paths one fixture carries under `unitKey`. */
    exercise(unitKey, paths) {
      if (!exercised.has(unitKey)) exercised.set(unitKey, new Set());
      for (const p of paths) exercised.get(unitKey).add(p);
    },
    /**
     * Problems for `declared` paths of `unitKey` that no fixture exercised.
     * `describe` completes the sentence: `on "Foo"`, `on request of "GET /x"`.
     */
    check(unitKey, declared, describe) {
      const seen = exercised.get(unitKey) || new Set();
      return [...declared]
        .filter((p) => !seen.has(p))
        .map((p) => `schema declares "${p}" ${describe} but no fixture exercises it`);
    },
  };
}

// ---------------------------------------------------------------- report

/**
 * Collects problems and ends the run uniformly.
 *
 *   const report = createReport();
 *   report.note('...');
 *   report.finish({ title: 'agent/v2 conformance', footer: 'See …', ok: 'agent/v2 conformance: …' });
 *
 * On problems: prints `=== <title> FAILED ===`, each as `  ✗ …`, then a count and
 * `footer` to stderr and exits 1. Otherwise prints `ok` to stdout and returns.
 */
export function createReport() {
  const problems = [];
  return {
    note(msg) { problems.push(msg); },
    problems,
    finish({ title, footer, ok }) {
      if (problems.length) {
        console.error(`\n=== ${title} FAILED ===`);
        for (const f of problems) console.error('  ✗ ' + f);
        console.error(`\n${problems.length} problem(s). ${footer}`);
        process.exit(1);
      }
      console.log(ok);
    },
  };
}
