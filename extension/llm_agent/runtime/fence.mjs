// Fence parser + args validator. The wire shape of a tool call is the
// only thing this module knows; everything else in the runtime treats
// parser output as opaque.

const OPEN = '<<<TOOL_CALL>>>';
const CLOSE = '<<<END_TOOL_CALL>>>';

export function parseFence(raw) {
  if (typeof raw !== 'string') {
    return { text: '', fence: null };
  }
  const openIdx = raw.indexOf(OPEN);
  if (openIdx < 0) {
    return { text: raw, fence: null };
  }
  const closeIdx = raw.indexOf(CLOSE, openIdx + OPEN.length);
  if (closeIdx < 0) {
    return {
      text: raw.slice(0, openIdx),
      fence: null,
      parseError: 'unterminated fence: missing <<<END_TOOL_CALL>>>',
    };
  }
  const text = raw.slice(0, openIdx);
  const jsonBlob = raw.slice(openIdx + OPEN.length, closeIdx).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonBlob);
  } catch (err) {
    return { text, fence: null, parseError: `JSON parse error: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text, fence: null, parseError: 'fence body must be a JSON object' };
  }
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    return { text, fence: null, parseError: "fence missing 'name'" };
  }
  if (!parsed.arguments || typeof parsed.arguments !== 'object' || Array.isArray(parsed.arguments)) {
    return { text, fence: null, parseError: "fence missing 'arguments' object" };
  }
  return { text, fence: { name: parsed.name, arguments: parsed.arguments } };
}

export function validateArgs(schema, args) {
  const value = {};
  if (!args || typeof args !== 'object') {
    return { error: 'arguments must be an object' };
  }
  for (const [name, def] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(args, name);
    if (!present) {
      if (def.required) return { error: `missing required argument '${name}'` };
      continue;
    }
    const v = args[name];
    if (def.type === 'string') {
      if (typeof v !== 'string') return { error: `argument '${name}' must be a string` };
      if (def.maxLength != null && v.length > def.maxLength) {
        return { error: `argument '${name}' exceeds maxLength ${def.maxLength}` };
      }
    } else if (def.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { error: `argument '${name}' must be a finite number` };
      }
    } else if (def.type === 'boolean') {
      if (typeof v !== 'boolean') return { error: `argument '${name}' must be a boolean` };
    } else if (def.type === 'string[]') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        return { error: `argument '${name}' must be an array of strings` };
      }
      // Apply maxLength to each element, not just the array as a whole.
      if (def.maxLength != null) {
        for (let idx = 0; idx < v.length; idx++) {
          if (v[idx].length > def.maxLength) {
            return { error: `argument '${name}[${idx}]' exceeds maxLength ${def.maxLength}` };
          }
        }
      }
    } else {
      return { error: `argument '${name}' has unsupported type` };
    }
    value[name] = v;
  }
  return { value };
}
