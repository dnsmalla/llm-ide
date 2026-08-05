import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { streamModelReply } = await import('../agents/runtime.mjs');

test('streamModelReply uses the CLI streaming path when no API key resolves', async () => {
  const chunks = [];
  const result = await streamModelReply('hi', {
    onChunk: (t) => chunks.push(t),
    provider: 'anthropic',
    // Test seam: force the CLI path directly, bypassing the real CLI binary,
    // by injecting a fake spawnCliStream-compatible override.
    _testSpawnCliStream: async (_provider, _prompt, opts) => {
      opts.onChunk('streamed via CLI');
      return { stdoutText: 'streamed via CLI', stderr: '', bin: 'claude' };
    },
  });
  assert.deepEqual(chunks, ['streamed via CLI']);
  assert.equal(result, 'streamed via CLI');
});

test('streamModelReply falls back to fully-buffered runClaude when the CLI stream throws', async () => {
  const chunks = [];
  const result = await streamModelReply('hi', {
    onChunk: (t) => chunks.push(t),
    provider: 'anthropic',
    _testSpawnCliStream: async () => { throw new Error('cli exploded'); },
    _testRunClaude: async () => 'buffered fallback text',
  });
  // Guaranteed fallback delivers the whole text as ONE chunk.
  assert.deepEqual(chunks, ['buffered fallback text']);
  assert.equal(result, 'buffered fallback text');
});

test('streamModelReply passes through images via the buffered path, never the streaming one', async () => {
  const chunks = [];
  let sawStreamCall = false;
  const result = await streamModelReply('hi', {
    onChunk: (t) => chunks.push(t),
    images: [{ mediaType: 'image/png', data: 'base64...' }],
    _testSpawnCliStream: async () => { sawStreamCall = true; return { stdoutText: 'x' }; },
    _testRunClaude: async () => 'vision reply',
  });
  assert.equal(sawStreamCall, false);
  assert.deepEqual(chunks, ['vision reply']);
  assert.equal(result, 'vision reply');
});

test('streamModelReply works with no onChunk callback at all (still returns the text)', async () => {
  const result = await streamModelReply('hi', {
    provider: 'anthropic',
    _testSpawnCliStream: async (_provider, _prompt, opts) => {
      // opts.onChunk may be undefined here — must not throw if so.
      if (typeof opts.onChunk === 'function') opts.onChunk('text');
      return { stdoutText: 'text', stderr: '', bin: 'claude' };
    },
  });
  assert.equal(result, 'text');
});

test('streamModelReply does NOT fall back to buffered (and does not double-deliver) when the CLI stream fails after already delivering partial chunks', async () => {
  const chunks = [];
  let runBufferedCalled = false;
  await assert.rejects(
    streamModelReply('hi', {
      onChunk: (t) => chunks.push(t),
      provider: 'anthropic',
      _testSpawnCliStream: async (_provider, _prompt, opts) => {
        opts.onChunk('partial chunk 1');
        opts.onChunk('partial chunk 2');
        throw new Error('cli crashed mid-stream');
      },
      _testRunClaude: async () => { runBufferedCalled = true; return 'this must never be delivered'; },
    }),
    /cli crashed mid-stream/,
  );
  assert.deepEqual(chunks, ['partial chunk 1', 'partial chunk 2'], 'only the partial chunks that arrived before the crash should have been delivered — nothing duplicated on top');
  assert.equal(runBufferedCalled, false, 'buffered fallback must not run once partial content has already been shown to the user');
});

test('streamModelReply still falls back to buffered when the CLI stream fails cleanly with zero chunks delivered', async () => {
  const chunks = [];
  const result = await streamModelReply('hi', {
    onChunk: (t) => chunks.push(t),
    provider: 'anthropic',
    _testSpawnCliStream: async () => { throw new Error('cli exploded before any output'); },
    _testRunClaude: async () => 'buffered fallback text',
  });
  assert.deepEqual(chunks, ['buffered fallback text']);
  assert.equal(result, 'buffered fallback text');
});
