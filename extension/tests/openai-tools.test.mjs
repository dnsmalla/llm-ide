import test from 'node:test';
import assert from 'node:assert/strict';
import { skillToOpenAITool, skillsToOpenAITools } from '../llm_agent/runtime/openai-tools.mjs';

// The in-memory skill shape produced by loader.mjs loadSkills():
//   { name, kind, confirmation, description, schema, body }
// where schema = { [arg]: { type, required, maxLength, description, enum } }
// and type is one of 'string' | 'number' | 'boolean' | 'string[]'.

test('skillToOpenAITool: maps string+number schema to an OpenAI function tool', () => {
  const skill = {
    name: 'run-bash',
    kind: 'read',
    description: 'Run a shell command and return its output.',
    schema: {
      command: { type: 'string', required: true, maxLength: 2000, description: 'command to run', enum: undefined },
      timeout: { type: 'number', required: false, maxLength: null, description: 'seconds before kill', enum: undefined },
    },
    body: '',
  };
  const tool = skillToOpenAITool(skill);
  assert.equal(tool.type, 'function');
  assert.equal(tool.function.name, 'run-bash');
  assert.equal(tool.function.description, 'Run a shell command and return its output.');
  assert.deepEqual(tool.function.parameters, {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'command to run', maxLength: 2000 },
      timeout: { type: 'number', description: 'seconds before kill' },
    },
    required: ['command'],
  });
});

test('skillToOpenAITool: string[] becomes array-of-strings; enum preserved on strings', () => {
  const skill = {
    name: 'set-mode',
    kind: 'read',
    description: 'Switch the active mode.',
    schema: {
      mode: { type: 'string', required: true, maxLength: null, description: 'the mode', enum: ['a', 'b'] },
      tags: { type: 'string[]', required: false, maxLength: null, description: 'free-form tags', enum: undefined },
      enabled: { type: 'boolean', required: false, maxLength: null, description: 'on/off', enum: undefined },
    },
    body: '',
  };
  const tool = skillToOpenAITool(skill);
  const props = tool.function.parameters.properties;
  assert.deepEqual(props.mode, { type: 'string', description: 'the mode', enum: ['a', 'b'] });
  assert.deepEqual(props.tags, { type: 'array', items: { type: 'string' }, description: 'free-form tags' });
  assert.deepEqual(props.enabled, { type: 'boolean', description: 'on/off' });
  assert.deepEqual(tool.function.parameters.required, ['mode']);
});

test('skillsToOpenAITools: readOnly excludes write skills', () => {
  const skills = new Map([
    ['run-bash', { name: 'run-bash', kind: 'read', description: 'run a command', schema: {} }],
    ['bash', { name: 'bash', kind: 'write', description: 'run a command (client)', schema: {} }],
    ['update-file', { name: 'update-file', kind: 'write', description: 'edit a file', schema: {} }],
    ['read-file', { name: 'read-file', kind: 'read', description: 'read a file', schema: {} }],
  ]);
  assert.deepEqual(skillsToOpenAITools(skills).map((t) => t.function.name),
    ['run-bash', 'bash', 'update-file', 'read-file']);
  // Write tools need a client confirmation round-trip (pendingTool); on
  // native-tool providers that loop cycles and trips the rate limiter, so we
  // expose read tools only — they execute server-side in one turn.
  assert.deepEqual(skillsToOpenAITools(skills, { readOnly: true }).map((t) => t.function.name),
    ['run-bash', 'read-file']);
});

test('skillToOpenAITool: falls back to the name when description is empty', () => {
  const skill = {
    name: 'no-desc',
    kind: 'read',
    description: '',
    schema: {},
    body: '',
  };
  const tool = skillToOpenAITool(skill);
  assert.equal(tool.function.description, 'no-desc');
  assert.deepEqual(tool.function.parameters.properties, {});
  assert.deepEqual(tool.function.parameters.required, []);
});
