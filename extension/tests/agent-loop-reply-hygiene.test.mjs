// Reply hygiene for the fence agent loop.
//
// replyMode contract:
//  - 'final' (the user-visible /code-assist call in route.mjs): the reply is
//    the FINAL iteration's text — earlier tool-hop narration ("Let me read
//    that file.") is dropped, with two safety nets: an empty final pass and
//    a too-brief final pass (< MIN_FINAL_REPLY_CHARS) both fall back to the
//    accumulated narration so facts stated before a tool call can't vanish.
//  - 'accumulated' (the default; ask-internal / ask-subagent delegation):
//    the OLD concatenated reply — those consumers are machines whose outer
//    agent re-synthesizes, so more information is always correct there.
//
// Abnormal endings (deadline / iteration cap / echo stall) always return the
// accumulated text, tail-capped so a 1000-iteration turn can't dump an
// unbounded work log into the bubble.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'global');

// Injected fake read handler — no network, returns a stable result.
const handlers = {
  'web-search': async () => ({ results: [{ title: 'R', url: 'https://example.com' }] }),
};

const FENCE = (name, args) =>
  `<<<TOOL_CALL>>>\n${JSON.stringify({ name, arguments: args })}\n<<<END_TOOL_CALL>>>`;

function scriptedClaude(responses) {
  let i = 0;
  return async (prompt, opts) => {
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (opts?.onChunk) for (const ch of resp) opts.onChunk(ch);
    return resp;
  };
}

function loop(overrides) {
  const { skills } = loadSkills(SKILLS_DIR);
  return runAgentLoop({
    skills,
    userMessage: 'Question.',
    history: [],
    agentContext: { base: '' },
    kb: null,
    userId: 'u1',
    handlers,
    ...overrides,
  });
}

test('final mode: reply excludes earlier iterations’ tool-hop narration', async () => {
  const finalAnswer = 'Here is the final answer based on the search.';
  const result = await loop({
    replyMode: 'final',
    runClaude: scriptedClaude([
      `Let me search for that.\n${FENCE('web-search', { query: 'x' })}`,
      finalAnswer,
    ]),
  });
  assert.equal(result.reply, finalAnswer,
    'the reply must be the final iteration’s text only — no "Let me search" narration');
});

test('final mode: write-tool pendingTool reply carries only the proposing iteration’s text', async () => {
  const proposal = 'I will update the file as requested.';
  const result = await loop({
    replyMode: 'final',
    runClaude: scriptedClaude([
      `First let me look at the search results.\n${FENCE('web-search', { query: 'bug' })}`,
      `${proposal}\n${FENCE('update-file', { path: 'a.txt', old_text: 'x', new_text: 'y' })}`,
    ]),
  });
  assert.ok(result.pendingTool, 'the write fence must surface as pendingTool');
  assert.equal(result.reply, proposal,
    'the pendingTool reply must be the proposing iteration’s prose only');
});

test('final mode: a handler-propagated pendingTool reply also uses the current iteration’s text', async () => {
  const relay = 'Delegating produced a proposal — here it is for your review.';
  const propagatingHandlers = {
    ...handlers,
    'web-search': async () => ({ pendingTool: { name: 'update-file', arguments: { path: 'a.txt' } } }),
  };
  const result = await loop({
    replyMode: 'final',
    handlers: propagatingHandlers,
    runClaude: scriptedClaude([
      `${relay}\n${FENCE('web-search', { query: 'x' })}`,
    ]),
  });
  assert.ok(result.pendingTool, 'the propagated pendingTool must surface');
  assert.equal(result.reply, relay);
});

test('final mode: falls back to accumulated narration when the final text is empty', async () => {
  const result = await loop({
    replyMode: 'final',
    runClaude: scriptedClaude([
      `The answer is 42 — verifying.\n${FENCE('web-search', { query: 'x' })}`,
      '   ',
    ]),
  });
  assert.equal(result.reply, 'The answer is 42 — verifying.',
    'an empty final iteration must not produce an empty bubble when narration exists');
});

test('final mode: a too-brief final ack keeps the substantive earlier narration', async () => {
  // prompt.md tells the model to explain a failure BEFORE calling
  // task-update — the explanation must not vanish behind a one-line ack.
  const explanation = 'The build failed: `swift build` exited 1 because ResourceGuard.swift:42 references a symbol removed in the last commit.';
  const result = await loop({
    replyMode: 'final',
    runClaude: scriptedClaude([
      `${explanation}\n${FENCE('web-search', { query: 'ResourceGuard' })}`,
      'Marked as failed.',
    ]),
  });
  assert.ok(result.reply.includes(explanation),
    'a final pass under the brevity threshold must fall back to the accumulated text');
});

test('default (accumulated) mode: delegation consumers keep the old concatenated reply', async () => {
  // ask-internal / ask-subagent read result.reply as machine input for the
  // outer agent — facts stated before a tool call must survive there.
  const facts = 'Found 3 meetings: Alpha (Jun 2), Beta (Jun 9), Gamma (Jul 1).';
  const result = await loop({
    // no replyMode — the default must stay 'accumulated'
    runClaude: scriptedClaude([
      `${facts}\n${FENCE('web-search', { query: 'meetings' })}`,
      'That is everything.',
    ]),
  });
  assert.ok(result.reply.includes(facts),
    'accumulated mode must keep earlier iterations’ facts for the outer agent');
  assert.ok(result.reply.includes('That is everything.'));
});

test('in-flight deadline abort: streamed partial text survives into the reply, tail flushed', async () => {
  // "<<" is a possible <<<TOOL_CALL>>> prefix, so the sniffer holds it back
  // until it is ruled out — an abort before that ruling must still flush it.
  const streamed = 'Partial answer <<';
  const abortingClaude = async (prompt, opts) => {
    if (opts?.onChunk) for (const ch of streamed) opts.onChunk(ch);
    await new Promise((res) => opts.signal.addEventListener('abort', res, { once: true }));
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const chunks = [];
  const result = await loop({
    replyMode: 'final',
    runClaude: abortingClaude,
    deadlineMs: 60,
    onChunk: (text) => chunks.push(text),
  });
  assert.match(result.reply, /deadline/, 'the abort must surface as the graceful deadline reply');
  assert.equal(chunks.join(''), streamed,
    'every streamed character — including the held-back marker-prefix tail — must reach the client');
  assert.ok(result.reply.includes('Partial answer'),
    'the aborted iteration’s streamed text must survive into the reply the client overwrites with');
});

test('final mode: a concise but complete Japanese final answer stands alone', async () => {
  // Japanese complete answers are short in UTF-16 units — the brevity
  // threshold must not re-glue the work log onto them.
  const jaAnswer = 'はい、auth.mjs の 42 行目を修正しました。';
  const result = await loop({
    replyMode: 'final',
    runClaude: scriptedClaude([
      `ファイルを確認します。\n${FENCE('web-search', { query: 'auth' })}`,
      jaAnswer,
    ]),
  });
  assert.equal(result.reply, jaAnswer,
    'a complete Japanese final answer must not fall back to the accumulated narration');
});

test('tail-capped abnormal reply never splits a surrogate pair', async () => {
  // A lone surrogate in the reply makes ai-routes' JSON.stringify emit a raw
  // \udXXX escape that Swift's JSONDecoder rejects — the Mac then drops the
  // whole `done` event and the user loses the turn to an opaque error.
  // Deterministic construction: the odd-length 'x' shifts UTF-16 parity so
  // the cap boundary (t.length - 4000) lands exactly on the LOW surrogate of
  // a 👍 pair — the case a naive .slice() splits.
  const para = '👍'.repeat(1000) + 'x' + '👍'.repeat(1500); // 5001 UTF-16 units
  const result = await loop({
    replyMode: 'final',
    maxIterations: 1,
    runClaude: scriptedClaude([
      `${para}\n${FENCE('web-search', { query: 'x' })}`,
    ]),
  });
  assert.match(result.reply, /iteration limit/);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!loneSurrogate.test(result.reply),
    'the tail cap must not split a surrogate pair — a lone surrogate makes the SSE done event undecodable on the Mac client');
});

test('iteration-cap reply keeps the accumulated narration but is tail-capped', async () => {
  const para = 'This narration line is long enough to add up quickly. '.repeat(20); // ~1.1k chars
  const result = await loop({
    replyMode: 'final',
    maxIterations: 6,
    runClaude: scriptedClaude([
      `${para}\n${FENCE('web-search', { query: 'x' })}`,
    ]),
  });
  assert.match(result.reply, /iteration limit/, 'the cap marker must be present');
  assert.ok(result.reply.length < 4600,
    `an abnormal ending must not dump an unbounded work log (got ${result.reply.length} chars)`);
  assert.ok(result.reply.includes('narration line'),
    'the most recent narration (the tail) must be what survives the cap');
});
