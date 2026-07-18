import test from 'node:test';
import assert from 'node:assert/strict';
import { completeViaApi } from '../agents/providers.mjs';
import { parseFence } from '../llm_agent/runtime/fence.mjs';

// deepseek/openai/custom speak the OpenAI function-calling API. When the model
// picks a tool it returns message.tool_calls (NOT content). callOpenAI must
// translate that into the <<<TOOL_CALL>>> fence so the existing loop dispatches it.

function mockResponse(toolCalls, content = null) {
  return {
    ok: true,
    headers: new Map(),
    json: async () => ({
      choices: [{ message: { role: 'assistant', content, tool_calls: toolCalls } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  };
}

test('completeViaApi: deepseek tool_calls are translated to a <<<TOOL_CALL>>> fence', async () => {
  const saved = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return mockResponse([{
      id: 'call_1', type: 'function',
      function: { name: 'run-bash', arguments: JSON.stringify({ command: 'uname -a', cwd: '/tmp' }) },
    }]);
  };
  try {
    const tools = [{ type: 'function', function: { name: 'run-bash', parameters: { type: 'object', properties: {} } } }];
    const text = await completeViaApi('deepseek', {
      apiKey: 'sk-test', model: 'deepseek-chat', prompt: 'run uname', tools,
    });
    // tools were sent on the wire
    assert.deepEqual(capturedBody.tools, tools);
    assert.equal(capturedBody.tool_choice, 'auto');
    // ...and the tool_call came back as a fence the loop understands
    const { fence } = parseFence(text);
    assert.equal(fence.name, 'run-bash');
    assert.deepEqual(fence.arguments, { command: 'uname -a', cwd: '/tmp' });
  } finally {
    globalThis.fetch = saved;
  }
});

test('completeViaApi: plain text content still returned when no tool_calls', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => mockResponse(undefined, 'hello there');
  try {
    const text = await completeViaApi('deepseek', {
      apiKey: 'sk-test', model: 'deepseek-chat', prompt: 'hi',
    });
    assert.equal(text, 'hello there');
  } finally {
    globalThis.fetch = saved;
  }
});
