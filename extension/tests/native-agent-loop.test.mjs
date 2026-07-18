import test from 'node:test';
import assert from 'node:assert/strict';
import { runNativeAgentLoop } from '../llm_agent/runtime/loop.mjs';

// The native tool-calling loop (Cursor / OpenAI pattern): maintain a messages
// array, feed tool results back as {role:'tool', tool_call_id}, terminate when
// the model returns no tool_calls. `complete` is injected so no real API is hit.

test('runNativeAgentLoop: runs a read tool, feeds result as a tool message, then terminates', async () => {
  const skills = new Map([
    ['run-bash', { name: 'run-bash', kind: 'read', schema: { command: { type: 'string', required: true } }, description: 'run', body: '' }],
  ]);
  const handlers = { 'run-bash': async (args) => ({ output: `out:${args.command}`, exitCode: 0 }) };
  const calls = [];
  const complete = async ({ messages }) => {
    calls.push(messages);
    if (calls.length === 1) {
      return { text: 'Let me run that.', toolCalls: [{ id: 'call_1', name: 'run-bash', arguments: { command: 'echo hi' } }] };
    }
    return { text: 'Done: out:echo hi', toolCalls: [] };
  };

  const out = await runNativeAgentLoop({
    systemPrompt: 'sys', userMessage: 'run echo hi', skills,
    tools: [], complete, userId: 'u1', handlers, kb: null, depth: 0,
  });

  assert.equal(out.reply, 'Done: out:echo hi');
  assert.equal(out.pendingTool, null);
  // The 2nd completion call's messages MUST contain the assistant tool_call
  // turn AND a native tool-result message — the thing the fence hack got wrong.
  const second = calls[1];
  assert.ok(
    second.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls[0].function.name === 'run-bash'),
    'assistant tool_calls message appended',
  );
  assert.ok(
    second.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1'),
    'tool result fed back as a native tool message',
  );
});

test('runNativeAgentLoop: folds prior history into the messages array', async () => {
  const skills = new Map();
  const handlers = {};
  const calls = [];
  const complete = async ({ messages }) => { calls.push(messages); return { text: 'ok', toolCalls: [] }; };
  await runNativeAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'now',
    history: [
      { role: 'user', content: 'an earlier question' },
      { role: 'assistant', content: 'an earlier reply' },
    ],
    skills, tools: [], complete, userId: 'u1', handlers, kb: null, depth: 0,
  });
  const first = calls[0];
  assert.equal(first[0].role, 'system');
  assert.equal(first[1].role, 'user');
  assert.ok(first[1].content.includes('an earlier question'));
  assert.equal(first[2].role, 'assistant');
  assert.ok(first[2].content.includes('an earlier reply'));
  assert.equal(first[3].role, 'user');
  assert.equal(first[3].content, 'now');
});

test('runNativeAgentLoop: a write tool surfaces as pendingTool (client confirms), loop stops', async () => {
  const skills = new Map([
    ['bash', { name: 'bash', kind: 'write', schema: { command: { type: 'string', required: true } }, description: 'run', body: '' }],
  ]);
  const handlers = {};
  const complete = async () => ({ text: 'I will run it.', toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'uname -a' } }] });
  const out = await runNativeAgentLoop({
    systemPrompt: 'sys', userMessage: 'run uname', skills,
    tools: [], complete, userId: 'u1', handlers, kb: null, depth: 0,
  });
  assert.deepEqual(out.pendingTool, { name: 'bash', arguments: { command: 'uname -a' } });
});
