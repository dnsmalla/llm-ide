// Convert the in-memory skill schema (from loader.mjs) into OpenAI-compatible
// `tools` entries, so providers that speak the OpenAI function-calling API
// (deepseek / openai / custom) can select a tool and emit a structured
// `tool_calls` response. callOpenAI translates those tool_calls back into the
// <<<TOOL_CALL>>> fence the rest of the agent loop already dispatches on, so
// this is the only place that needs to know the OpenAI tool-definition shape.
//
// Skill schema shape: { [arg]: { type, required, maxLength, description, enum } }
// type ∈ 'string' | 'number' | 'boolean' | 'string[]'

const SCHEMA_TYPE_TO_OPENAI = {
  string: () => ({ type: 'string' }),
  number: () => ({ type: 'number' }),
  boolean: () => ({ type: 'boolean' }),
  'string[]': () => ({ type: 'array', items: { type: 'string' } }),
};

function toProperty(def) {
  const prop = (SCHEMA_TYPE_TO_OPENAI[def.type] || (() => ({ type: 'string' })))();
  if (typeof def.description === 'string' && def.description) prop.description = def.description;
  if (typeof def.maxLength === 'number') prop.maxLength = def.maxLength;
  if (Array.isArray(def.enum) && def.enum.length) prop.enum = def.enum;
  return prop;
}

export function skillToOpenAITool(skill) {
  const schema = skill && skill.schema ? skill.schema : {};
  const properties = {};
  const required = [];
  for (const [arg, def] of Object.entries(schema)) {
    properties[arg] = toProperty(def);
    if (def.required) required.push(arg);
  }
  const description = (typeof skill.description === 'string' && skill.description.trim())
    ? skill.description.trim()
    : skill.name;
  return {
    type: 'function',
    function: {
      name: skill.name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

// Build the full `tools` array for a skills Map. Read+write skills are both
// exposed: write tools surface as a pendingTool for the client either way, and
// the model needs to see them to choose e.g. `bash` vs `run-bash`.
//
// `readOnly` — drop write skills. Write tools need a client confirmation
// round-trip (pendingTool); on native-tool providers that loop cycles
// (confirm sheet re-shown, auto-continue) and trips the rate limiter. Read
// tools execute server-side and return output in one turn, which is what the
// chat agent should use for "run X / list / read / search" requests.
export function skillsToOpenAITools(skillsMap, { readOnly = false } = {}) {
  const out = [];
  if (!skillsMap || typeof skillsMap[Symbol.iterator] !== 'function') return out;
  for (const skill of skillsMap.values()) {
    if (readOnly && skill.kind !== 'read') continue;
    out.push(skillToOpenAITool(skill));
  }
  return out;
}
