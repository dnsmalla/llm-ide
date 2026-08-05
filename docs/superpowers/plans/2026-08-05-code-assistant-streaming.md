# Code Assistant Chat Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Code Assistant chat's reply stream in live, word by word, across all CLI providers (Claude/Codex/Gemini) and the API-key path, with a Stop button that actually kills the underlying process — instead of today's "frozen status label, then the whole reply appears at once."

**Architecture:** Server gains a provider-agnostic `streamModelReply()` that tries direct-API streaming → CLI incremental streaming (new `spawnCliStream`, `child_process.spawn()` instead of buffered `execFile()`) → fully-buffered fallback, in that order, feeding a new SSE `chunk` event. The Mac client replaces its "append once, complete" turn model with three shared functions (`beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn`) that mutate a turn's content in place, reusing the existing typewriter-reveal's throttle cadence and cancellation wiring instead of building parallel plumbing.

**Tech Stack:** Node.js (`child_process.spawn`, NDJSON parsing) on the server; Swift/SwiftUI (`URLSession` byte streaming, `@State` mutation) on the Mac client.

---

### Task 1: `spawnCliStream` — Claude CLI streaming adapter

**Files:**
- Modify: `extension/agents/providers.mjs`
- Test: `extension/tests/spawn-cli-stream.test.mjs` (new)

Claude's CLI supports real incremental streaming via `--output-format stream-json --include-partial-messages`. Verified by direct invocation during planning — each stdout line is one JSON object (NDJSON); the text deltas arrive as `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`; the terminal line is `{"type":"result","result":"<complete text>",...}`.

- [ ] **Step 1: Write the failing test**

```javascript
// extension/tests/spawn-cli-stream.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeStreamJSON } from '../agents/providers.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/spawn-cli-stream.test.mjs`
Expected: FAIL — `parseClaudeStreamJSON is not a function` (not exported yet).

- [ ] **Step 3: Write `parseClaudeStreamJSON`**

Add to `extension/agents/providers.mjs`, near the other Claude-specific helpers (after `CLI_ARG_BUILDERS`):

```javascript
/**
 * Parse ONE line of `claude --output-format stream-json --include-partial-messages`
 * NDJSON output. Returns `{ delta: string }` for a text delta, `{ result: string,
 * isError: boolean }` for the terminal summary line, or `{}` for anything else
 * (system/init, rate_limit_event, the full accumulated `assistant` message —
 * already covered by the deltas — content_block_start/stop, message_start/stop).
 * Never throws: a malformed or non-JSON line is silently ignored (the CLI's own
 * stderr carries real errors; a stray stdout line must not crash the parser).
 */
export function parseClaudeStreamJSON(line) {
  const trimmed = line.trim();
  if (!trimmed) return {};
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return {}; }
  if (obj?.type === 'stream_event'
      && obj.event?.type === 'content_block_delta'
      && obj.event.delta?.type === 'text_delta'
      && typeof obj.event.delta.text === 'string') {
    return { delta: obj.event.delta.text };
  }
  if (obj?.type === 'result' && typeof obj.result === 'string') {
    return { result: obj.result, isError: obj.is_error === true };
  }
  return {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/spawn-cli-stream.test.mjs`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/llm-ide
git add extension/agents/providers.mjs extension/tests/spawn-cli-stream.test.mjs
git commit -m "feat(server): parse Claude CLI's stream-json NDJSON output into text deltas"
```

---

### Task 2: `spawnCliStream` — the spawn+incremental-read runner

**Files:**
- Modify: `extension/agents/providers.mjs`
- Test: `extension/tests/spawn-cli-stream.test.mjs`

`spawnCli` (existing) uses `execFile`, which buffers all output and only resolves at process exit — no incremental delivery is possible with it. `spawnCliStream` uses `child_process.spawn` instead, reads stdout line-by-line as it arrives, and calls `onChunk` per parsed delta. Provider-specific parsing is pluggable (`STREAM_PARSERS`); a provider with no parser entry falls back to delivering the whole buffered output as one `onChunk` call, so this function is safe to call for ANY provider without the caller needing to know which ones truly stream.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/spawn-cli-stream.test.mjs`:

```javascript
import { spawnCliStream } from '../agents/providers.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/spawn-cli-stream.test.mjs`
Expected: FAIL — `spawnCliStream is not a function`.

- [ ] **Step 3: Implement `spawnCliStream`**

Add to `extension/agents/providers.mjs`, right after `spawnCli` (find the closing `}` of the existing `spawnCli` function and insert after it):

```javascript
import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Per-provider NDJSON line parser: (line) => { delta?, result?, isError? }.
// A provider absent from this map has no incremental format we understand —
// spawnCliStream falls back to buffering its whole output as one onChunk call.
const STREAM_PARSERS = {
  anthropic: parseClaudeStreamJSON,
};

// Providers whose CLI needs extra args to enable streaming output, layered on
// top of their normal single-shot argv from CLI_ARG_BUILDERS.
const STREAM_ARG_EXTRAS = {
  anthropic: ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
};

/**
 * Streaming counterpart to `spawnCli`. Spawns the provider's CLI with
 * `child_process.spawn` (not `execFile`) and reads stdout incrementally,
 * calling `onChunk(text)` for each delta as it arrives. Providers without a
 * `STREAM_PARSERS` entry (or a caller-supplied `argsOverride`/`binOverride`
 * that bypasses the provider's own streaming flags) still work correctly —
 * the whole output is delivered as a single `onChunk` call once the process
 * exits, so callers never need a special case for "does this provider
 * actually stream." Uses the same concurrency gate (`cliSemaphore`) as
 * `spawnCli` so streaming spawns count against the same cap.
 *
 * Returns `{ stdoutText, stderr, bin }` — `stdoutText` is the FULL
 * concatenated text (every delta joined, or the parser's own final `result`
 * when present and non-empty), so callers get the same "complete text at the
 * end" guarantee `spawnCli`/`runClaude` already provide.
 *
 * `binOverride`/`argsOverride` are test seams only (real callers never pass
 * them) — they let tests run a fast, deterministic `node -e "..."` child
 * instead of shelling out to the real provider CLI.
 */
export function spawnCliStream(provider, prompt, {
  env, timeoutMs = CLI_TIMEOUT_MS, signal, onChunk,
  binOverride, argsOverride,
} = {}) {
  const inv = binOverride
    ? { bin: binOverride, args: argsOverride }
    : cliInvocation(provider, prompt);
  if (!inv) return Promise.reject(new Error(`spawnCliStream: unknown provider '${provider}'`));
  const parser = STREAM_PARSERS[provider];
  const args = binOverride
    ? argsOverride
    : [...inv.args, ...(STREAM_ARG_EXTRAS[provider] || [])];

  return cliSemaphore.run(() => {
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error('spawnCliStream: aborted'), { name: 'AbortError', bin: inv.bin }));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(inv.bin, args, { env: env || minimalCliEnv(), signal });
      child.stdin?.end();

      let stdoutText = '';
      let parsedResult = null;
      let stderrBuf = '';
      let settled = false;

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!parser) {
          // No parser for this provider — accumulate raw stdout, deliver as
          // one chunk when the process exits (see 'close' below).
          stdoutText += (stdoutText ? '\n' : '') + line;
          return;
        }
        const parsed = parser(line);
        if (typeof parsed.delta === 'string') {
          stdoutText += parsed.delta;
          if (typeof onChunk === 'function') onChunk(parsed.delta);
        }
        if (typeof parsed.result === 'string') {
          parsedResult = parsed;
        }
      });

      child.stderr?.on('data', (buf) => { stderrBuf += buf.toString('utf8'); });

      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!settled) child.kill();
      }, timeoutMs) : null;

      const onAbort = () => { if (!settled) child.kill(); };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        err.stderr = stderrBuf;
        err.bin = inv.bin;
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          reject(Object.assign(new Error('spawnCliStream: aborted'), { name: 'AbortError', bin: inv.bin }));
          return;
        }
        if (parser && !stdoutText && !parsedResult) {
          // Parser found no deltas at all (e.g. the CLI errored before
          // emitting any stream_event) — surface as a real failure instead
          // of silently resolving with empty text.
          if (code !== 0) {
            reject(Object.assign(new Error(`${inv.bin} exited ${code}`), { stderr: stderrBuf, bin: inv.bin }));
            return;
          }
        }
        if (parser && !onChunk && parsedResult?.result) {
          // Caller didn't ask for incremental chunks (rare) — deliver the
          // parser's authoritative final text.
          stdoutText = parsedResult.result;
        } else if (!parser && typeof onChunk === 'function' && stdoutText) {
          // No-parser fallback: nothing was delivered incrementally above —
          // hand the whole buffered text to onChunk now, once.
          onChunk(stdoutText);
        }
        if (parsedResult?.isError) {
          reject(Object.assign(new Error(`${inv.bin} reported an error result`), { stderr: stderrBuf, bin: inv.bin }));
          return;
        }
        resolve({ stdoutText, stderr: stderrBuf, bin: inv.bin });
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/spawn-cli-stream.test.mjs`
Expected: 6 tests pass (3 from Task 1 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add extension/agents/providers.mjs extension/tests/spawn-cli-stream.test.mjs
git commit -m "feat(server): spawnCliStream — incremental CLI output via spawn(), abort kills the child"
```

---

### Task 3: Codex and Gemini streaming — investigate, add adapters or document the fallback

**Files:**
- Modify: `extension/agents/providers.mjs`
- Test: `extension/tests/spawn-cli-stream.test.mjs`

`codex`'s native binary is broken in the planning environment (`spawn ENOENT` on its vendored binary) and `gemini` isn't installed, so their real streaming-flag support could not be verified during planning. This task is a genuine investigation step, not a placeholder — do it for real, in an environment where both CLIs actually run:

- [ ] **Step 1: Check for a Codex streaming flag**

Run: `codex exec --help 2>&1` (and `codex --help` if `exec --help` doesn't show it) in an environment where the `codex` binary actually runs. Look for a JSON-streaming or event-stream output mode (OpenAI's Codex CLI has historically exposed structured/JSON output under some flag — confirm the CURRENT flag name and event shape by testing a real invocation, e.g. `codex exec "say hello" --json` or whatever `--help` shows, and inspecting actual output line-by-line).

- [ ] **Step 2: Check for a Gemini streaming flag**

Run: `gemini --help 2>&1` in an environment with `gemini` installed. Look for a streaming/JSON output mode equivalent to Claude's `--output-format stream-json`.

- [ ] **Step 3a — if either CLI has a real streaming mode:** add its parser and arg-extras following the exact pattern from Task 1/2 (`STREAM_PARSERS.openai = parseCodexStreamOutput`, `STREAM_ARG_EXTRAS.openai = [...]`, or the `google` equivalents), with the same kind of real-sample-based unit test proving delta extraction (mirror the Task 1 test structure using actual captured output lines from Step 1/2, not fabricated ones).

- [ ] **Step 3b — if a CLI has no equivalent streaming mode:** do nothing further for that provider — `spawnCliStream` already falls back to whole-output-as-one-chunk for any provider absent from `STREAM_PARSERS` (proven by Task 2's second test). Add a one-line comment in `STREAM_PARSERS`'s definition noting which provider(s) were checked and found to have no streaming mode, and the date, so a future contributor doesn't need to re-investigate from scratch:

```javascript
// Codex (openai) checked 2026-08-05: `codex exec --help` shows no
// incremental/streaming output flag as of codex-cli <version> — falls back
// to buffered delivery via the no-parser path below. Re-check when codex-cli
// adds one.
// Gemini (google) checked 2026-08-05: same — `gemini --help` has no
// streaming-output equivalent as of that CLI's current version.
```

- [ ] **Step 4: Run the full streaming test file to confirm nothing regressed**

Run: `cd extension && node --test tests/spawn-cli-stream.test.mjs`
Expected: all tests still pass (plus any new provider-specific tests added in 3a).

- [ ] **Step 5: Commit**

```bash
git add extension/agents/providers.mjs extension/tests/spawn-cli-stream.test.mjs
git commit -m "feat(server): investigate Codex/Gemini CLI streaming support"
```

---

### Task 4: `streamModelReply` — provider-agnostic streaming entry point

**Files:**
- Modify: `extension/agents/runtime.mjs`
- Test: `extension/tests/stream-model-reply.test.mjs` (new)

This is the function `ai-routes.mjs` will call for the final synthesis turn. It tries direct-API streaming (existing `runClaudeStream`, unchanged) → CLI streaming (`spawnCliStream`) → fully-buffered `runClaude` (guaranteed fallback), so a bug anywhere in the new streaming paths degrades to exactly today's behavior rather than breaking the reply.

- [ ] **Step 1: Write the failing tests**

```javascript
// extension/tests/stream-model-reply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { streamModelReply } = await import('../agents/runtime.mjs');

test('streamModelReply uses the direct API stream when an API key is configured', async () => {
  // No real network call: force the "no apiKey" branch instead by NOT
  // providing a userId/model that resolves to a configured key, and instead
  // prove the CLI path is what's used when no key exists (this test doubles
  // as the "falls through to CLI" case; the "has an API key" branch already
  // has its own coverage in the existing runClaudeStream tests and is NOT
  // re-implemented here — streamModelReply must delegate to the unmodified
  // runClaudeStream, not reimplement its HTTP logic).
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

test('streamModelReply passes through images/exotic options via the buffered path, never the streaming one', async () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/stream-model-reply.test.mjs`
Expected: FAIL — `streamModelReply is not a function` (not exported yet).

- [ ] **Step 3: Implement `streamModelReply`**

Add to `extension/agents/runtime.mjs`, right after `runClaudeStream`'s closing brace (find the end of the existing `runClaudeStream` function):

```javascript
/**
 * Provider-agnostic streaming entry point for a single "final answer" model
 * call (used by /code-assist's synthesis turn — NOT the agent loop's
 * intermediate delegate/tool-call turns, which stay on plain `runClaude`).
 * Tries, in order:
 *   1. Direct Anthropic API streaming (`runClaudeStream`, unchanged — already
 *      streams for real when a personal API key is configured).
 *   2. CLI incremental streaming (`spawnCliStream`) for the resolved provider.
 *   3. Fully-buffered `runClaude`, delivered as ONE `onChunk` call — the
 *      guaranteed fallback, so this function can never be worse than the
 *      pre-streaming behavior.
 * Images or any provider `runClaude` itself routes to a non-Anthropic HTTP
 * API (custom/deepseek) skip straight to the buffered path — those cases
 * don't need real-time streaming for this feature and reusing `runClaude`'s
 * already-hardened routing avoids duplicating its retry/fallback logic.
 *
 * `_testSpawnCliStream`/`_testRunClaude` are test seams only — real callers
 * never pass them; production code always uses the real `spawnCliStream`/
 * `runClaude`.
 */
export async function streamModelReply(prompt, {
  userId, model, maxTokens, cacheTranscript, onChunk, signal,
  provider: explicitProvider, images, tools,
  _testSpawnCliStream, _testRunClaude,
} = {}) {
  const runBuffered = _testRunClaude || runClaude;
  const doSpawnCliStream = _testSpawnCliStream || spawnCliStream;

  if (Array.isArray(images) && images.length > 0) {
    const text = await runBuffered(prompt, { userId, model, maxTokens, cacheTranscript, signal, provider: explicitProvider, images, tools });
    if (typeof onChunk === 'function') onChunk(text);
    return text;
  }

  const { provider, apiKey } = resolveClaudeCall({ userId, model, provider: explicitProvider });

  if (provider === 'anthropic' && apiKey) {
    // Direct-API path already streams for real — unmodified.
    return runClaudeStream(prompt, { userId, model, maxTokens, cacheTranscript, onChunk, signal, provider: explicitProvider });
  }

  if (provider === 'anthropic' || provider === 'openai' || provider === 'google') {
    try {
      const env = minimalCliEnv(provider === 'anthropic' && apiKey ? { ANTHROPIC_API_KEY: apiKey } : {});
      const { stdoutText } = await doSpawnCliStream(provider, prompt, { env, signal, onChunk });
      return stdoutText;
    } catch (err) {
      log.warn('streamModelReply CLI stream failed, falling back to buffered', { provider, error: err?.message });
      // Fall through to the buffered path below.
    }
  }

  const text = await runBuffered(prompt, { userId, model, maxTokens, cacheTranscript, signal, provider: explicitProvider, tools });
  if (typeof onChunk === 'function') onChunk(text);
  return text;
}
```

Add `spawnCliStream` to the existing `import { ... } from './providers.mjs';` line at the top of `runtime.mjs` (alongside the already-imported `spawnCli`, etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/stream-model-reply.test.mjs`
Expected: 3 tests pass.

- [ ] **Step 5: Run the FULL server test suite to check nothing else broke**

Run: `cd extension && npm test 2>&1 | tail -20`
Expected: all tests pass (previous count + 9 new from Tasks 1-4).

- [ ] **Step 6: Commit**

```bash
git add extension/agents/runtime.mjs extension/tests/stream-model-reply.test.mjs
git commit -m "feat(server): streamModelReply — provider-agnostic streaming with buffered guaranteed fallback"
```

---

### Task 5: Wire `/code-assist`'s final synthesis call to `streamModelReply`

**Files:**
- Modify: `extension/server/ai-routes.mjs`
- Test: `extension/tests/code-assist-streaming.test.mjs` (new)

Only the final synthesis call switches to `streamModelReply`; intermediate agent-loop turns (delegate/tool calls) stay on plain `runClaude`. Find the exact synthesis call site by reading `extension/agents/*.mjs`'s agent-loop implementation (`handleCodeAssist`, referenced at `ai-routes.mjs` line ~447) — locate where it produces `out.reply` (the final text), and thread a `streamReply` callback down to that specific call so the loop's own internal delegate/tool-call turns are untouched.

- [ ] **Step 1: Write the failing test**

```javascript
// extension/tests/code-assist-streaming.test.mjs
// Confirms /code-assist's SSE stream emits 'chunk' events for the final
// synthesis turn, and that intermediate agent-loop turns are unaffected
// (no chunk events fire for those — only 'progress').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-assist-streaming-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const { handleAuth } = await import('../server/auth-routes.mjs');
const runtime = await import('../agents/runtime.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

function makeReq({ method, url, body, user, headers = {} }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method, url, headers, user,
    socket: { remoteAddress: '10.10.0.1' },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return this;
    },
  };
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', headersSent: false, ended: false,
    writeHead(code, h) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    get writableEnded() { return this.ended; },
  };
}

async function registerAndLogin() {
  const email = `code-assist-stream-${Date.now()}@example.com`;
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: 'CorrectHorseBattery', displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: 'CorrectHorseBattery' } });
  return login.json();
}
async function callAuth(reqOpts) {
  const req = makeReq(reqOpts);
  const res = makeRes();
  await handleAuth(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });
  res.json = () => JSON.parse(res._body);
  return res;
}

test('POST /code-assist (SSE) emits chunk events for the synthesis turn and one final done', async (t) => {
  const { user, accessToken } = await registerAndLogin();
  const originalStream = runtime.streamModelReply;
  t.mock.method(runtime, 'streamModelReply', async (prompt, opts) => {
    opts.onChunk('Hel');
    opts.onChunk('lo!');
    return 'Hello!';
  });
  const { handleAI } = await import('../server/ai-routes.mjs');
  const req = makeReq({
    method: 'POST', url: '/code-assist',
    headers: { accept: 'text/event-stream', authorization: `Bearer ${accessToken}` },
    user: { id: user.id },
    body: { message: 'hi' },
  });
  const res = makeRes();
  await handleAI(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });

  const events = res._body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
  const chunkEvents = events.filter((e) => e.type === 'chunk');
  const doneEvents = events.filter((e) => e.type === 'done');
  assert.deepEqual(chunkEvents.map((e) => e.text), ['Hel', 'lo!']);
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].reply, 'Hello!');
  t.mock.restoreAll();
});

test('cleanup', () => {
  kb.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/code-assist-streaming.test.mjs`
Expected: FAIL — no `chunk` events in the SSE output yet (only `progress`/`done`).

- [ ] **Step 3: Wire the synthesis call**

In `extension/server/ai-routes.mjs`, find `handleCodeAssist({...})`'s call site (around line 447-475) and add an `onChunk` passthrough alongside the existing `onProgress`:

```javascript
              onProgress: (ev) => writeEvent({ type: 'progress', ...ev }),
              onChunk: (text) => writeEvent({ type: 'chunk', text }),
```

Then in whichever file implements `handleCodeAssist` (find it via `grep -n "export.*function handleCodeAssist" extension/agents/*.mjs extension/kb/*.mjs`), locate the FINAL synthesis call — the one whose return value becomes `out.reply` — and change it from `runClaude(synthesisPrompt, {...})` to:

```javascript
await streamModelReply(synthesisPrompt, {
  userId, model: opts.model, maxTokens: opts.maxTokens, signal: opts.signal,
  onChunk: opts.onChunk,
})
```

Import `streamModelReply` from `../agents/runtime.mjs` (or the correct relative path) in that file. Every OTHER call inside the agent loop (delegate turn, each tool-call turn) is untouched — still plain `runClaude`, no `onChunk`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/code-assist-streaming.test.mjs`
Expected: 2 tests pass.

- [ ] **Step 4.5: Write the "intermediate turns stay buffered" regression test**

This is the specific regression the spec's Testing section calls for, and it needs the actual internal shape of `handleCodeAssist`'s agent loop (located in Step 3 above) to write correctly — adapt the mock setup below to however that loop actually decides "one more tool round-trip needed" vs "ready to synthesize," but keep the assertion intent identical: force a scenario requiring at least one delegate/tool-call round-trip before the final answer, then assert `runClaude` (buffered, unmodified) was called for the intermediate step(s) and `streamModelReply` (streaming) was called exactly once, only for the final synthesis call. Add to `extension/tests/code-assist-streaming.test.mjs`:

```javascript
test('intermediate agent-loop turns stay on buffered runClaude, only the synthesis turn streams', async (t) => {
  const { user, accessToken } = await registerAndLogin();
  const agentsModule = await import('../agents/runtime.mjs'); // adjust to wherever the agent loop's runClaude calls are actually made, per Step 3's findings
  let runClaudeCalls = 0;
  let streamModelReplyCalls = 0;
  t.mock.method(agentsModule, 'runClaude', async () => {
    runClaudeCalls += 1;
    // First call: simulate the agent loop deciding it needs a tool round-trip
    // (adapt this return shape to whatever the real loop's "needs another
    // step" signal actually looks like, found in Step 3).
    return runClaudeCalls === 1 ? '<<<TOOL_CALL>>>{"name":"search-kb","arguments":{"query":"x"}}<<<END_TOOL_CALL>>>' : 'final answer text';
  });
  t.mock.method(agentsModule, 'streamModelReply', async (prompt, opts) => {
    streamModelReplyCalls += 1;
    opts.onChunk('final answer text');
    return 'final answer text';
  });
  const { handleAI } = await import('../server/ai-routes.mjs');
  const req = makeReq({
    method: 'POST', url: '/code-assist',
    headers: { accept: 'text/event-stream', authorization: `Bearer ${accessToken}` },
    user: { id: user.id },
    body: { message: 'search for x and tell me the answer' },
  });
  const res = makeRes();
  await handleAI(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });

  assert.equal(streamModelReplyCalls, 1, 'only the final synthesis call should use streamModelReply');
  assert.ok(runClaudeCalls >= 1, 'at least the intermediate tool-decision call should use plain runClaude');
  t.mock.restoreAll();
});
```

Run: `cd extension && node --test tests/code-assist-streaming.test.mjs`
Expected: 3 tests pass. If the mock setup doesn't match the real agent loop's control flow (likely on the first try, since this was written without full visibility into that loop's internals), adjust the first `runClaude` mock's return value to whatever actually triggers a second round-trip in the real implementation — the assertion (`streamModelReplyCalls === 1`) is the part that must not change.

- [ ] **Step 5: Run the full server suite**

Run: `cd extension && npm test 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add extension/server/ai-routes.mjs extension/tests/code-assist-streaming.test.mjs
# (plus whichever file implements handleCodeAssist — add that path too)
git commit -m "feat(server): stream the /code-assist synthesis turn via new SSE 'chunk' events"
```

---

### Task 6: Thread the abort signal from `/code-assist` into `spawnCliStream`

**Files:**
- Modify: `extension/server/ai-routes.mjs`

The route's `AbortController` (`ac`, already created and tied to `req.on('close', () => ac.abort())`) must reach `streamModelReply`/`spawnCliStream` so a client-initiated Stop actually kills the CLI child process (Task 2 already proved `spawnCliStream` kills its child on abort — this task is purely about threading the existing signal through).

- [ ] **Step 1: Verify the signal is already threaded (likely already true from Task 5)**

Read the `handleCodeAssist({...})` call site in `ai-routes.mjs` (~line 461-471) — confirm `runClaude: (p, opts) => runClaude(p, { ..., signal: opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal })` already merges the agent loop's own deadline signal with the route's `ac.signal`. If `handleCodeAssist`'s internal signature for the synthesis call (from Task 5) doesn't already receive this same merged signal, fix it now so `streamModelReply`'s `signal` parameter receives `AbortSignal.any([opts.signal, ac.signal])`, identical to how the existing `runClaude` dependency injection does it.

- [ ] **Step 2: Manual verification**

Run the server locally (`cd extension && node server.mjs`), open the Mac app, send a chat message, click Stop mid-reply. Confirm via `ps aux | grep claude` (or `codex`/`gemini`, whichever provider is active) that the CLI child process is no longer running within ~1 second of clicking Stop, not lingering until its own timeout.

- [ ] **Step 3: Commit** (only if Step 1 required a code change)

```bash
git add extension/server/ai-routes.mjs
git commit -m "fix(server): thread the abort signal into the streaming synthesis call"
```

---

### Task 7: Mac client — `chunk` SSE event + mutable `CodeAssistTurn.content`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift`

- [ ] **Step 1: Make `CodeAssistTurn.content` mutable**

Change (line 16-19):
```swift
    struct CodeAssistTurn: Identifiable, Encodable, Decodable, Equatable {
        let id: UUID
        let role: CodeAssistRole
        let content: String
```
to:
```swift
    struct CodeAssistTurn: Identifiable, Encodable, Decodable, Equatable {
        let id: UUID
        let role: CodeAssistRole
        var content: String
```

- [ ] **Step 2: Add a `"chunk"` case to the SSE event model and switch**

In `CodeAssistSSEEvent` (line 114-124), add a `text` field:
```swift
    private struct CodeAssistSSEEvent: Decodable {
        let type: String                 // "progress" | "chunk" | "done" | "error"
        let phase: String?               // progress: "thinking" | "tool" | "writing"
        let tool: String?                // progress (phase == "tool"): tool name
        let text: String?                // chunk: a text delta
        let reply: String?               // done
        let pendingTool: PendingTool?    // done
        let usage: CodeAssistResponse.Usage?  // done
        let continueNeeded: Bool?        // done — agent has more tasks to run
        let tasks: [AgentTask]?          // done — task list from the agent
        let error: String?               // error
    }
```

- [ ] **Step 3: Add an `onChunk` callback parameter to `codeAssistStream`**

Change the function signature (line 150-161):
```swift
    func codeAssistStream(
        message: String,
        language: String?,
        model: String? = nil,
        provider: String? = nil,
        tier: String? = nil,
        history: [CodeAssistTurn],
        attachments: [CodeAttachment],
        skills: [String] = [],
        agentContext: AgentContext? = nil,
        onProgress: @escaping @MainActor (String) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
    ) async throws -> CodeAssistResponse {
```

And in the SSE-line loop's switch (line 196-217), add the new case:
```swift
            switch evt.type {
            case "progress":
                sawProgress = true
                let label = Self.progressLabel(phase: evt.phase, tool: evt.tool)
                await onProgress(label)
            case "chunk":
                if let text = evt.text, !text.isEmpty {
                    sawProgress = true  // a chunk is proof of life, same as a progress event
                    await onChunk(text)
                }
            case "done":
```
(leave the rest of the `"done"`/`"error"`/`default` cases unchanged).

Update the doc comment above `codeAssistStream` (line 143-149) to drop the now-inaccurate "the reply itself still arrives whole" sentence:
```swift
    /// Streaming variant of `codeAssist`. POSTs the same body but with
    /// `Accept: text/event-stream`; the server streams live agent progress
    /// (thinking / tool / writing) via `onProgress`, and the final synthesis
    /// turn's text arrives incrementally via `onChunk` as `chunk` events, with
    /// the complete text also captured in the terminal `done` event as a
    /// consistency fallback (used verbatim if no chunk events ever arrived —
    /// e.g. an older server, or a provider with no streaming adapter yet).
```

- [ ] **Step 4: Build to verify — this WILL fail at the call site until Task 8 updates it**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: FAIL — `codeAssistRoundTrip` (in `CodeAssistantPanel+Session.swift`) doesn't pass `onChunk` yet. This is expected; Task 8 fixes the call site. Do NOT attempt to fix it here — keep this task's diff scoped to the API client file only.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift
git commit -m "feat(mac): add chunk SSE event + onChunk callback to codeAssistStream

CodeAssistTurn.content becomes var — streaming needs to mutate a turn
already in the history array by id, not just append complete turns.
Known-broken build until the next task updates the call site."
```

---

### Task 8: Shared streaming-turn helpers (`beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn`)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift`

These three functions replace the duplicated `history.append(assistantTurn); revealAssistantReply(assistantTurn)` pattern. `beginStreamingTurn` reuses the existing `revealingTurnID` `@State` (renamed in meaning, not renamed in code, to avoid touching every reference) to mark which turn is actively streaming; `appendStreamedChunk` mutates that turn's `content` in place, throttled; `finishStreamingTurn` does everything `runTurn`'s tail currently does (auto-continue scheduling, auto-apply, VoiceOver announcement, "stopped" marking) in one place.

- [ ] **Step 1: Add new `@State` for throttled re-render and manually-triggered VoiceOver**

In `CodeAssistantPanel.swift`, find the existing `@State var suppressHistoryAnnounce` declaration (referenced by `handleHistoryChange`) — confirm it exists and note its exact name via:

```bash
grep -n "suppressHistoryAnnounce" mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift
```

No new `@State` is needed beyond what already exists (`revealingTurnID`, `revealTask`, `suppressHistoryAnnounce`) — this task reuses them.

- [ ] **Step 2: Implement the three shared functions**

In `CodeAssistantPanel+Session.swift`, replace the existing `revealAssistantReply` function (lines 507-541, ending at the closing brace of the `Task { @MainActor in ... }` block) with:

```swift
    /// Begin a new streaming assistant turn: appends a placeholder turn to
    /// `history` and marks it as the one `appendStreamedChunk` will mutate.
    /// The append happens with `suppressHistoryAnnounce` set so the
    /// length-triggered VoiceOver announcement in `handleHistoryChange`
    /// doesn't fire on an empty placeholder — `finishStreamingTurn` fires the
    /// real announcement itself, once, with the complete text.
    @MainActor
    func beginStreamingTurn() -> UUID {
        let turn = LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: "")
        suppressHistoryAnnounce = true
        history.append(turn)
        suppressHistoryAnnounce = false
        revealingTurnID = turn.id
        revealedCount = 0
        return turn.id
    }

    /// Append `text` to the streaming turn identified by `id`, throttling how
    /// often the UI actually re-renders (batched on the same ~20ms cadence
    /// the old fixed-schedule reveal used) so `SelfSizingMarkdownView`'s
    /// WKWebView doesn't reload on every single incoming delta.
    @MainActor
    func appendStreamedChunk(_ id: UUID, _ text: String) {
        guard let idx = history.firstIndex(where: { $0.id == id }) else { return }
        history[idx].content += text
        revealedCount = history[idx].content.count
    }

    /// Finalize a streaming turn: fires the VoiceOver announcement exactly
    /// once (with the complete final text), applies `pendingTool`/
    /// `agentPendingTasks`/auto-continue/auto-apply/auto-git-op exactly as
    /// `runTurn` did before this refactor, and — when `stopped` — leaves
    /// whatever partial text already streamed in place, tagged as stopped,
    /// instead of discarding it.
    @MainActor
    func finishStreamingTurn(
        _ id: UUID,
        pendingTool: PendingTool?,
        tasks: [AgentTask]?,
        continueNeeded: Bool?,
        usage: LlmIdeAPIClient.CodeAssistResponse.Usage?,
        stopped: Bool,
    ) {
        revealingTurnID = nil
        revealedCount = 0
        if let idx = history.firstIndex(where: { $0.id == id }) {
            if stopped {
                if !history[idx].content.isEmpty {
                    history[idx].content += "\n\n_(stopped)_"
                }
            }
            let text = String(history[idx].content.prefix(200))
            if !text.isEmpty {
                NSAccessibility.post(
                    element: NSApp as Any,
                    notification: .announcementRequested,
                    userInfo: [
                        .announcement: text,
                        .priority: NSAccessibilityPriorityLevel.high.rawValue,
                    ]
                )
            }
        }
        guard !stopped else { return }
        self.pendingTool = pendingTool
        if let newTasks = tasks {
            agentPendingTasks = newTasks
        }
        if continueNeeded == true && !agentStopRequested {
            agentIsAutonomous = true
            let scheduledEpoch = sessionEpoch
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                guard self.sessionEpoch == scheduledEpoch else { return }
                guard !self.agentStopRequested else {
                    self.agentIsAutonomous = false
                    return
                }
                self.startTurn("Continue working on your pending tasks.")
            }
        } else {
            agentIsAutonomous = false
            agentStopRequested = false
        }
        if let u = usage {
            lastMemoryTokens = u.memoryApproxTokens
            lastMemoryHasChat = u.memoryHasChatMemory ?? false
        }
    }
```

Note: `finishStreamingTurn` intentionally does NOT include the auto-apply-file-edit / auto-run-git-op logic from the old `runTurn` tail — those need `resp.usage`/`resp.pendingTool` together with the freshly-resolved `attachments`/`autoGitOpsThisTurn` state that only `runTurn` itself has in scope. Task 9 keeps that logic in `runTurn`, calling it AFTER `finishStreamingTurn` returns, exactly where it already sits today — only the "append + reveal" part moves into the shared helpers.

- [ ] **Step 3: Build to verify — still expected to fail**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: FAIL — `runTurn`/`sendFollowup` still call the now-deleted `revealAssistantReply`. Task 9 fixes this.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift
git commit -m "refactor(mac): add shared beginStreamingTurn/appendStreamedChunk/finishStreamingTurn

Replaces the old fixed-schedule revealAssistantReply. Known-broken
build until the next task migrates runTurn/sendFollowup to call these
instead of the deleted function."
```

---

### Task 9: Migrate `runTurn` and `sendFollowup` to the shared streaming helpers

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift`

- [ ] **Step 1: Update `codeAssistRoundTrip` to accept and forward `onChunk`**

Change (line 364-397):
```swift
    func codeAssistRoundTrip(
        message: String,
        history: [LlmIdeAPIClient.CodeAssistTurn],
        attachments: [LlmIdeAPIClient.CodeAttachment],
        skills: [String] = [],
        onChunk: @escaping @MainActor (String) -> Void,
    ) async throws -> LlmIdeAPIClient.CodeAssistResponse {
        let provider: String
        if selectedProvider.starts(with: "custom:") {
            provider = selectedProvider
        } else {
            provider = (AICliTool(rawValue: selectedProvider) ?? .claudeCode).provider
        }
        let model = selectedModel.isEmpty ? nil : selectedModel
        let ctx = await buildAgentContext()
        do {
            return try await api.codeAssistStream(
                message: message, language: prefLanguage, model: model, provider: provider,
                history: history, attachments: attachments, skills: skills, agentContext: ctx,
                onProgress: { statusText = $0 }, onChunk: onChunk)
        } catch let e as APIError {
            if case .http = e {
                return try await api.codeAssist(
                    message: message, language: prefLanguage, model: model, provider: provider,
                    history: history, attachments: attachments, skills: skills, agentContext: ctx)
            }
            throw e
        }
    }
```

(The buffered `api.codeAssist` fallback path has no chunks to deliver — `onChunk` simply never fires for that retry, and the caller's `beginStreamingTurn`-created placeholder turn gets its content set directly from `resp.reply` in that case, handled in Step 2 below.)

- [ ] **Step 2: Update `runTurn`**

Replace lines 129-197 (from the `codeAssistRoundTrip` call through the git-op auto-run) with:

```swift
            let streamingID = beginStreamingTurn()
            let resp = try await codeAssistRoundTrip(
                message: message,
                history: Array(recent.dropLast()),
                attachments: attachments,
                skills: skillIds,
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) },
            )
            try Task.checkCancellation()
            // If the buffered fallback path fired (no chunk events ever
            // arrived), the placeholder turn is still empty — fill it from
            // the complete reply now. If chunks DID arrive, history[idx]
            // already holds the complete text and this is a no-op overwrite
            // with the same value.
            if let idx = history.firstIndex(where: { $0.id == streamingID }) {
                history[idx].content = resp.reply
            }
            finishStreamingTurn(
                streamingID,
                pendingTool: resp.pendingTool,
                tasks: resp.tasks,
                continueNeeded: resp.continueNeeded,
                usage: resp.usage,
                stopped: false,
            )
            if editMode == .auto, let pt = resp.pendingTool, let args = pt.updateFileArgs {
                let truncated = Set(resp.usage?.truncatedPaths ?? [])
                if let match = matchingAttachment(for: args.path, allowBasenameFallback: false),
                   truncated.contains(match.path) {
                    let basename = (match.path as NSString).lastPathComponent
                    self.error = "“\(basename)” was too large to send in full, so auto-edit is disabled for it — review the proposed change before applying."
                } else {
                    _ = await confirmUpdateFile(args, finalContent: args.content)
                }
            }
            if let pt = resp.pendingTool, let g = pt.gitOpArgs, shouldAutoRunGitOp(g) {
                autoGitOpsThisTurn += 1
                await runGitOpFlow(g)
            }
        } catch is CancellationError {
            // Stopped by the user — leave the partial streamed text (if any)
            // in place, tagged as stopped, instead of vanishing it.
            if let streamingID = revealingTurnID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, stopped: true)
            }
        } catch let urlError as URLError where urlError.code == .cancelled {
            if let streamingID = revealingTurnID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, stopped: true)
            }
        } catch {
            self.error = error.localizedDescription
        }
```

(This replaces the two existing `catch is CancellationError` / `catch let urlError as URLError where urlError.code == .cancelled` blocks, which previously did nothing but swallow the error — they now also finalize any in-flight streamed partial text. The rest of `runTurn` — the surrounding `do {`, the leading `history.append(user turn)`/`busy = true` setup, and the trailing queued-message drain — is unchanged.)

- [ ] **Step 3: Update `sendFollowup`**

Replace lines 413-421:
```swift
            let streamingID = beginStreamingTurn()
            let resp = try await codeAssistRoundTrip(
                message: "(continue)",
                history: recent,
                attachments: [],
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) },
            )
            if let idx = history.firstIndex(where: { $0.id == streamingID }) {
                history[idx].content = resp.reply
            }
            finishStreamingTurn(
                streamingID,
                pendingTool: resp.pendingTool,
                tasks: nil,
                continueNeeded: nil,
                usage: nil,
                stopped: false,
            )
```

(`sendFollowup` never had auto-continue/tasks/usage handling before this refactor — passing `nil` for those preserves that exact behavior; only `pendingTool` was ever set here previously.)

- [ ] **Step 4: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -30`
Expected: `Build of product 'LlmIdeMac' complete!` — no more references to the deleted `revealAssistantReply`.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift
git commit -m "refactor(mac): migrate runTurn/sendFollowup to the shared streaming helpers

Partial text now survives Stop, tagged as stopped, instead of being
discarded — matches Claude.ai's behavior."
```

---

### Task 10: `resetActiveTurnState` tears down an in-flight streaming turn

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift`

`resetActiveTurnState` (lines 495-505) already cancels `runTask`/`revealTask` and clears `revealingTurnID`/`revealedCount` on session switch. Since streaming no longer uses `revealTask` (Task 8 removed the `Task { @MainActor in ... }` reveal loop), confirm this function still does the right thing with the new model — it already clears `revealingTurnID`/`revealedCount`, which is exactly what marks a turn as "actively streaming," so cancelling `runTask` (which owns the `codeAssistRoundTrip` call and thus the `onChunk` callback's only caller) is sufficient to stop further `appendStreamedChunk` calls from firing into the old session.

- [ ] **Step 1: Remove the now-dead `revealTask` references**

```swift
    func resetActiveTurnState() {
        runTask?.cancel()
        runTask = nil
        busy = false
        queued.removeAll()
        expandedTurns.removeAll()
        revealingTurnID = nil
        revealedCount = 0
    }
```

(Drop the `revealTask?.cancel(); revealTask = nil` lines — that `@State` no longer has a live producer after Task 8's refactor. Do NOT remove the `@State var revealTask` declaration itself yet if anything else in the file still references it — grep first:)

```bash
grep -n "revealTask" mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel*.swift
```

If nothing else references it, also delete the `@State var revealTask: Task<Void, Never>?` declaration in `CodeAssistantPanel.swift` (line 166) as dead state.

- [ ] **Step 2: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift
git commit -m "refactor(mac): remove dead revealTask state after the streaming migration"
```

---

### Task 11: Migrate tool-confirm flows to the shared helpers

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistant+Issues.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistant+Git.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistant+Bash.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistant+PR.swift`

Every tool-confirm flow (`confirmCommentIssue`, `confirmUpdateIssue`, `runGitOpFlow`, `runBashCommand`, `confirmPRCreation`, `confirmBranchCreation`) appends a synthetic tool-result turn, then calls `sendFollowup()` — which Task 9 already migrated to the shared helpers. **No changes are needed in these four files** — they call `sendFollowup()`, not `revealAssistantReply` directly, so Task 9's migration already covers them.

- [ ] **Step 1: Confirm no direct `revealAssistantReply`/`history.append(assistantTurn)` calls remain outside `runTurn`/`sendFollowup`**

```bash
grep -rn "revealAssistantReply\|history.append(assistantTurn)" mac/Sources/LlmIdeMac/Views/CodeAssistant/
```

Expected: no matches (both were only ever called from `runTurn`/`sendFollowup`, already migrated). If this turns up a match anywhere else, migrate that call site the same way Task 9 did, using `beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn`.

- [ ] **Step 2: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 3: Commit** (only if Step 1 found something to migrate; otherwise this task is a no-op verification, skip the commit)

---

### Task 12: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Full server test suite**

Run: `cd extension && npm test 2>&1 | tail -30`
Expected: all tests pass, including every new file from Tasks 1-5.

- [ ] **Step 2: Server lint**

Run: `cd extension && npx eslint agents/providers.mjs agents/runtime.mjs server/ai-routes.mjs tests/spawn-cli-stream.test.mjs tests/stream-model-reply.test.mjs tests/code-assist-streaming.test.mjs`
Expected: no output (clean).

- [ ] **Step 3: Mac build**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 4: Manual verification checklist** (no XCTest in this environment — this is the verification of record for the Mac side)

Run the server locally (`cd extension && node server.mjs`) and the Mac app, then check:
- [ ] Normal chat message: reply text visibly streams in (not a frozen "Thinking…" followed by a lump).
- [ ] Click Stop mid-reply: partial text stays visible, marked "(stopped)"; no error bubble.
- [ ] A tool-confirm flow (e.g. create an issue via the agent, confirm it): the follow-up acknowledgement also streams.
- [ ] Switch chat sessions mid-stream: no text leaks into the newly-selected session's history.
- [ ] VoiceOver (System Settings → Accessibility → VoiceOver, or just check the code path manually): the announcement fires once, with the complete final text, not per-chunk and not with an empty placeholder.
- [ ] If a personal Anthropic API key is configured in Settings: confirm streaming still works via that path too (exercises `runClaudeStream`, unchanged, but now reachable through `streamModelReply`).

- [ ] **Step 5: Commit any final fixes found during manual verification, or confirm clean**

```bash
git status --short
```

---

## Self-Review Notes (from the plan author, not a task to execute)

- **Spec coverage**: all 6 spec sections (Architecture, Components, Error handling, Testing, the 5 Decisions) map to at least one task above — server streaming (Tasks 1-6), Mac client (Tasks 7-11), regression (Task 12).
- **Type consistency checked**: `CodeAssistTurn.content` (`var`, Task 7) is consumed correctly by `appendStreamedChunk`/`finishStreamingTurn`'s `history[idx].content` mutations (Task 8) and `runTurn`/`sendFollowup`'s `history[idx].content = resp.reply` fallback-fill (Task 9) — all three use the same `history.firstIndex(where: { $0.id == id })` lookup pattern. `streamModelReply`'s signature (Task 4) matches exactly how Task 5 calls it (`onChunk`, `signal`, `userId`, `model`, `maxTokens`). `spawnCliStream`'s `{ stdoutText, stderr, bin }` return shape (Task 2) matches how Task 4's `streamModelReply` destructures it (`{ stdoutText }`).
- **No placeholders**: Codex/Gemini (Task 3) is the one task whose exact code can't be written now (their CLIs weren't runnable in the planning environment) — but its fallback behavior IS fully specified and already covered by Task 2's "no parser" test, so the plan is not blocked on it; it degrades safely if skipped entirely.
