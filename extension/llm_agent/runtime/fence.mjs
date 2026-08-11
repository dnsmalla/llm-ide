// Fence parser + args validator. The wire shape of a tool call is the
// only thing this module knows; everything else in the runtime treats
// parser output as opaque.

const OPEN = '<<<TOOL_CALL>>>';
const CLOSE = '<<<END_TOOL_CALL>>>';

// ── Output hygiene ───────────────────────────────────────────────────
// `parseFence` removes a WELL-FORMED fence, so anything it fails to recognise
// is handed to the user as prose. Two shapes reach the chat that way:
//
//   • A near-miss the model typed slightly wrong (`<<< TOOL_CALL >>>`,
//     `<<<TOOLCALL>>>`), which indexOf(OPEN) never finds.
//   • A ZWJ-REDACTED fence. redactFence (redaction.mjs) neutralises sentinels
//     in replayed history by inserting a zero-width joiner, so a fence that
//     once leaked into a stored turn comes back to the model as
//     `<<‍<TOOL_CALL>‍>>`. The model imitates what it sees, emits the redacted
//     spelling, and parseFence can't match it — a self-sustaining loop that
//     shows the user machine syntax indefinitely.
//
// Zero-width characters the redactor (or a copy-paste round-trip) can leave
// between the brackets.
const ZW = '[\\u200B-\\u200D\\uFEFF]*';
const ANGLES_OPEN = `<${ZW}<${ZW}<`;
const ANGLES_CLOSE = `>${ZW}>${ZW}>`;
// The alternation MUST be grouped: without `(?:…)` the `|` splits the whole
// pattern, so the regex degenerates into "opening angles + END_TOOL_CALL" OR
// "TOOL_CALL + closing angles" — the second of which matches from the word
// rather than the brackets and leaves a stray `<<<` behind in the reply.
const looseMarker = (word) =>
  new RegExp(`${ANGLES_OPEN}${ZW}\\s*(?:${word})${ZW}\\s*${ANGLES_CLOSE}`, 'i');
const LOOSE_OPEN = looseMarker('END_?TOOL_?CALL|TOOL_?CALL');
const LOOSE_CLOSE = looseMarker('END_?TOOL_?CALL');

/**
 * Remove leftover tool-call directives from text that is about to be shown to
 * a user. Deliberately conservative: a fence-shaped marker is only stripped
 * when a JSON object follows it, so prose that merely MENTIONS the protocol
 * ("what does <<<TOOL_CALL>>> do?") is preserved — this repo documents the
 * fence, and the agent must still be able to talk about it.
 *
 * Pure + exported for unit tests.
 */
export function stripFenceRemnants(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  // Bounded: each pass removes one directive, so a handful covers any realistic
  // reply and a pathological one can't spin.
  for (let pass = 0; pass < 8; pass++) {
    const open = LOOSE_OPEN.exec(out);
    if (!open) break;
    const afterOpen = open.index + open[0].length;
    const rest = out.slice(afterOpen);
    // Only treat it as a directive if a JSON payload follows close behind.
    if (!/^\s{0,40}\{/.test(rest)) break;
    const close = LOOSE_CLOSE.exec(rest);
    const end = close ? afterOpen + close.index + close[0].length : out.length;
    out = (out.slice(0, open.index) + out.slice(end)).trim();
  }
  return out;
}

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
      if (Array.isArray(def.enum) && def.enum.length && !def.enum.includes(v)) {
        return { error: `argument '${name}' must be one of: ${def.enum.join(', ')}` };
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
      // Cap element count (default 512) so a forged fence can't pass a
      // pathologically long array — per-element maxLength alone doesn't
      // bound the total.
      const maxItems = def.maxItems != null ? def.maxItems : 512;
      if (v.length > maxItems) {
        return { error: `argument '${name}' exceeds maxItems ${maxItems}` };
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
  // Reject any key present in args that is not declared in the schema.
  // Silently dropping undeclared keys would allow a future handler that
  // reads raw args (rather than the validated value) to see unsanitised
  // input.  Failing fast makes the contract explicit.
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      return { error: `unexpected argument '${key}'` };
    }
  }
  return { value };
}
