// Minimal JSON Schema subset validator for the command bus (registry args, command envelope, event envelope).
// Shared by the executor and scripts/conformance-bus.mjs so both judge the same bytes. Dependency-free.
// Keywords: type, enum, const, required, properties, additionalProperties (bool | schema), items, minItems, maxItems,
// minLength, maxLength, pattern, minimum, maximum, oneOf, $ref ('#/$defs/Name' against opts.defs), and x-format
// (id | provider | model | date), which the validator enforces itself (ids are never paths or shell text).

const FORMATS = {
  id: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
  provider: /^(anthropic|openai|google|custom:[A-Za-z0-9][A-Za-z0-9_-]{0,99})$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/,
  date: /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/,
};

// Every key lookup below is an OWN-property lookup: a plain `obj[k]` / `k in obj` would find Object.prototype members
// (constructor, toString, __proto__ ...) and let them satisfy `required` or bypass `additionalProperties: false`.
const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

/**
 * @returns {{path: string, message: string}[]} empty when valid
 */
export function validate(schema, value, opts = {}, path = '') {
  const defs = opts.defs || {};
  const out = [];
  const bad = (message) => out.push({ path: path || '(root)', message });
  if (!schema || typeof schema !== 'object') return out;
  if (schema.$ref) {
    const name = String(schema.$ref).replace('#/$defs/', '');
    if (!own(defs, name)) { bad(`unresolved $ref ${schema.$ref}`); return out; }
    return validate(defs[name], value, opts, path);
  }
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => validate(s, value, opts, path).length === 0).length;
    if (hits !== 1) bad(`must match exactly one variant (matched ${hits})`);
    return out;
  }
  if (own(schema, 'const') && value !== schema.const) { bad(`must equal ${JSON.stringify(schema.const)}`); return out; }
  if (schema.enum && !schema.enum.includes(value)) { bad(`must be one of ${schema.enum.join(', ')}`); return out; }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) { bad(`must be ${types.join(' or ')}`); return out; }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) bad(`shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) bad(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) bad('does not match the required pattern');
    const fmt = schema['x-format'];
    if (fmt && own(FORMATS, fmt) && !FORMATS[fmt].test(value)) bad(`not a valid ${fmt}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) bad(`below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) bad(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) bad(`fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) bad(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...validate(schema.items, v, opts, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!own(value, k)) out.push({ path: `${path}.${k}`, message: 'is required' });
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [k, v] of Object.entries(value)) {
      if (own(props, k)) out.push(...validate(props[k], v, opts, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push({ path: `${path}.${k}`, message: 'is not allowed' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.push(...validate(schema.additionalProperties, v, opts, `${path}.${k}`));
    }
  }
  return out;
}
