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
  codegen: (await import('../agents/codegen.mjs')).CODEGEN_SCHEMA,
  meetingQuestion: (await import('../agents/agent-prompt.mjs')).QUESTION_SCHEMA,
  decide: (await import('../llm_agent/tools/decide.mjs')).decideSchema({
    q1: { type: 'noul', instructions: 'x' },
    q2: { type: 'choice', instructions: 'x', criteria: { a: 'first', b: 'second' } },
    q3: { type: 'score', instructions: 'x', criteria: ['low', 'mid', 'high'] },
  }),
};

for (const [name, schema] of Object.entries(SCHEMAS)) {
  test(`structured-output schema: ${name}`, () => {
    assert.equal(schema.type, 'object');
    check(schema, name);
  });
}

test('decide: the schema names every question, its option keys and its level indexes', () => {
  const a = SCHEMAS.decide.properties.answers.properties;
  assert.deepEqual(Object.keys(a), ['q1', 'q2', 'q3']);
  assert.deepEqual(a.q2.properties.choice.enum, ['a', 'b']);
  assert.deepEqual(Object.keys(a.q3.properties.probabilities.properties), ['0', '1', '2']);
});

test('a per-turn helper never inherits a premium model from a general setting', async () => {
  const { helperModelFor, fastModelFor } = await import('../kb/usage.mjs');
  const fast = fastModelFor('anthropic');
  assert.equal(helperModelFor('anthropic', undefined, [undefined, undefined]), fast);
  assert.equal(helperModelFor('anthropic', undefined, ['claude-opus-5-5', 'claude-fable-5-2']), fast, 'a heavy summarize model does not run after every turn');
  assert.equal(helperModelFor('anthropic', undefined, ['claude-opus-5-5', 'claude-sonnet-5-5']), 'claude-sonnet-5-5', 'a non-premium general setting still applies');
  assert.equal(helperModelFor('anthropic', 'claude-opus-5-5', ['claude-haiku-5-5']), 'claude-opus-5-5', 'its own setting wins, premium or not');
});
