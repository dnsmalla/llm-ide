// Every schema sent as output_config.format must satisfy the structured-outputs rules: each object lists all its
// keys as required with additionalProperties false, and uses no unsupported constraint.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const UNSUPPORTED = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'];
function check(schema, at) {
  for (const k of UNSUPPORTED) assert.ok(!(k in schema), `${at}: ${k} is not supported`);
  const types = [].concat(schema.type ?? []);
  if (types.includes('object')) {
    assert.equal(schema.additionalProperties, false, `${at}: additionalProperties must be false`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${at}: every key is required`);
    for (const [k, v] of Object.entries(schema.properties)) check(v, `${at}.${k}`);
  }
  if (types.includes('array')) check(schema.items, `${at}[]`);
}

export const SCHEMAS = {
  entities: (await import('../server/ai-routes.mjs')).ENTITIES_SCHEMA,
  summary: (await import('../agents/summarize.mjs')).SUMMARY_SCHEMA,
  emailClassify: (await import('../agents/email-classify.mjs')).CLASSIFY_SCHEMA,
  connectorClassify: (await import('../agents/connector-classify.mjs')).CLASSIFY_SCHEMA,
  plan: (await import('../agents/planner.mjs')).PLAN_SCHEMA,
  memoryExtract: (await import('../llm_agent/memory/memory-extract.mjs')).EXTRACT_SCHEMA,
};

for (const [name, schema] of Object.entries(SCHEMAS)) {
  test(`structured-output schema: ${name}`, () => {
    assert.equal(schema.type, 'object');
    check(schema, name);
  });
}
