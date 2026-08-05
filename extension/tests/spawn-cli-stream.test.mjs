import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeStreamJSON, spawnCliStream } from '../agents/providers.mjs';

test('parseClaudeStreamJSON extracts text deltas from real Claude CLI NDJSON output', () => {
  const lines = [
    '{"type":"system","subtype":"init","session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-sonnet-5"}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello there"}},"session_id":"abc"}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", nice to meet you!"}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"message_stop"},"session_id":"abc"}',
    '{"is_error":false,"result":"Hello there, nice to meet you!","type":"result","subtype":"success"}',
  ];
  const deltas = [];
  let finalResult = null;
  for (const line of lines) {
    const parsed = parseClaudeStreamJSON(line);
    if (parsed.delta) deltas.push(parsed.delta);
    if (parsed.result !== undefined) finalResult = parsed.result;
  }
  assert.deepEqual(deltas, ['Hello there', ', nice to meet you!']);
  assert.equal(finalResult, 'Hello there, nice to meet you!');
});

test('parseClaudeStreamJSON ignores non-delta event types without throwing', () => {
  const lines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"rate_limit_event","rate_limit_info":{}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"whole message, not a delta"}]}}',
    'not even json',
    '',
  ];
  for (const line of lines) {
    const parsed = parseClaudeStreamJSON(line);
    assert.equal(parsed.delta, undefined);
    assert.equal(parsed.result, undefined);
  }
});

test('parseClaudeStreamJSON surfaces an error result', () => {
  const parsed = parseClaudeStreamJSON('{"type":"result","is_error":true,"result":"","subtype":"error_max_turns"}');
  assert.equal(parsed.isError, true);
});

test('spawnCliStream delivers incremental chunks for a provider with a stream parser', async () => {
  // A fake "cli" that just echoes 3 pre-baked NDJSON lines to stdout, mimicking
  // claude --output-format stream-json --include-partial-messages.
  const chunks = [];
  const result = await spawnCliStream('anthropic', 'ignored prompt', {
    onChunk: (text) => chunks.push(text),
    // Test seam: override the argv so we run a real, fast, deterministic child
    // process (`node -e`) instead of the real `claude` binary.
    binOverride: process.execPath,
    argsOverride: ['-e', `
      process.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\\n');
      process.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}\\n');
      process.stdout.write('{"type":"result","result":"Hello","is_error":false}\\n');
    `],
  });
  assert.deepEqual(chunks, ['Hel', 'lo']);
  assert.equal(result.stdoutText, 'Hello');
});

test('spawnCliStream falls back to one buffered onChunk call for a provider with no parser', async () => {
  const chunks = [];
  const result = await spawnCliStream('unknown-provider-xyz', 'ignored', {
    onChunk: (text) => chunks.push(text),
    binOverride: process.execPath,
    argsOverride: ['-e', `process.stdout.write('whole output, no streaming')`],
  });
  assert.deepEqual(chunks, ['whole output, no streaming']);
  assert.equal(result.stdoutText, 'whole output, no streaming');
});

test('spawnCliStream kills the child process when the signal aborts mid-stream', async () => {
  const ac = new AbortController();
  const chunks = [];
  const runPromise = spawnCliStream('anthropic', 'ignored', {
    onChunk: (text) => chunks.push(text),
    signal: ac.signal,
    binOverride: process.execPath,
    argsOverride: ['-e', `
      process.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}\\n');
      setTimeout(() => {}, 5000); // hang — the test proves this never completes naturally
    `],
  });
  await new Promise((r) => setTimeout(r, 200)); // let the first chunk arrive
  ac.abort();
  await assert.rejects(runPromise, /aborted/i);
  assert.deepEqual(chunks, ['partial']);
});

test('spawnCliStream rejects on non-zero exit even for a provider with no parser', async () => {
  const chunks = [];
  await assert.rejects(
    spawnCliStream('unknown-provider-xyz', 'ignored', {
      onChunk: (text) => chunks.push(text),
      binOverride: process.execPath,
      argsOverride: ['-e', `process.stdout.write('partial output'); process.exit(1);`],
    }),
    /exited 1/,
  );
});

test('spawnCliStream rejects when the parsed provider crashes mid-stream before a terminal result line', async () => {
  const chunks = [];
  await assert.rejects(
    spawnCliStream('anthropic', 'ignored', {
      onChunk: (text) => chunks.push(text),
      binOverride: process.execPath,
      argsOverride: ['-e', `
        process.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial answer"}}}\\n');
        process.exit(1); // crashes before ever writing a "result" line
      `],
    }),
    /exited 1/,
  );
  assert.deepEqual(chunks, ['partial answer'], 'the delta that arrived before the crash should still have been delivered');
});

test('spawnCliStream rejects with a clear message when the internal timeout fires', async () => {
  const chunks = [];
  await assert.rejects(
    spawnCliStream('anthropic', 'ignored', {
      onChunk: (text) => chunks.push(text),
      timeoutMs: 100,
      binOverride: process.execPath,
      argsOverride: ['-e', `setTimeout(() => {}, 5000);`], // hangs well past the 100ms timeout
    }),
    /timed out after 100ms/,
  );
});

test('spawnCliStream still resolves normally when the parser reports a clean result even with a non-zero exit code', async () => {
  // Defensive edge case: some CLIs exit non-zero for benign reasons (e.g. a
  // shutdown-hook warning) even after successfully emitting a clean result.
  const chunks = [];
  const result = await spawnCliStream('anthropic', 'ignored', {
    onChunk: (text) => chunks.push(text),
    binOverride: process.execPath,
    argsOverride: ['-e', `
      process.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}\\n');
      process.stdout.write('{"type":"result","result":"Hello","is_error":false}\\n');
      process.exitCode = 1;
    `],
  });
  assert.equal(result.stdoutText, 'Hello');
});
