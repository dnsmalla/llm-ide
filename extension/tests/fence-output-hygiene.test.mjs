// Tool-call fences are machine syntax and must never reach the user's chat.
// Two independent leaks are covered here, both reported as "it shows
// <<<TOOL_CALL>>> {json} which is difficult to know":
//
//   1. STREAMING — makeSniffingChunkHandler only inspected the first 15 chars,
//      so "prose, then a fence" (by far the most common shape) forwarded the
//      whole fence live into the reply bubble.
//   2. FINAL TEXT — parseFence only strips a WELL-FORMED fence, so a near-miss
//      spelling or a ZWJ-redacted fence echoed back from replayed history was
//      handed to the user as prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFenceRemnants } from '../llm_agent/runtime/fence.mjs';
import { makeSniffingChunkHandler, toolActivityDetail } from '../llm_agent/runtime/loop.mjs';
import { redactFence } from '../llm_agent/runtime/redaction.mjs';

const FENCE = '<<<TOOL_CALL>>>';
const CALL = `{"name": "read-file", "arguments": {"path": "a/b/C.swift"}}`;

// ── streaming ────────────────────────────────────────────────────────
function streamed(deltas) {
  const out = [];
  const sniff = makeSniffingChunkHandler((t) => out.push(t));
  for (const d of deltas) sniff.onChunk(d);
  sniff.flush();
  return out.join('');
}

test('a fence AFTER prose is not streamed (the reported leak)', () => {
  const got = streamed([`Let me read that file.\n${FENCE}\n${CALL}\n<<<END_TOOL_CALL>>>`]);
  assert.equal(got, 'Let me read that file.\n');
  assert.ok(!got.includes('TOOL_CALL'));
  assert.ok(!got.includes('read-file'), 'the JSON payload must not appear either');
});

test('a fence split across chunk boundaries is still caught', () => {
  // The marker arrives in pieces, which a naive indexOf-per-chunk misses.
  const got = streamed(['Reading now.\n', '<<<TOO', 'L_CALL', '>>>\n', CALL]);
  assert.equal(got, 'Reading now.\n');
});

test('a response that is only a fence streams nothing', () => {
  assert.equal(streamed([FENCE, '\n', CALL]), '');
});

test('prose with no fence streams in full', () => {
  const got = streamed(['The bug is in ', 'BashService.swift', ' — it deadlocks.']);
  assert.equal(got, 'The bug is in BashService.swift — it deadlocks.');
});

test('a short answer still arrives (flush releases the held-back tail)', () => {
  // Shorter than the 15-char marker, so it can never be ruled out live; the
  // old implementation had a separate flushIfUndecided path for exactly this.
  assert.equal(streamed(['ok']), 'ok');
});

test('text that merely resembles the marker start is not swallowed', () => {
  assert.equal(streamed(['compare a <<< b']), 'compare a <<< b');
  assert.equal(streamed(['<<<TOOL_RESULT>>> is a different sentinel']),
               '<<<TOOL_RESULT>>> is a different sentinel');
});

// ── final text ───────────────────────────────────────────────────────
test('stripFenceRemnants removes a ZWJ-redacted fence echoed from history', () => {
  // This is the self-sustaining loop: a leaked fence gets redacted on replay,
  // the model imitates the redacted spelling, and parseFence can't match it.
  const redacted = redactFence(`${FENCE}\n${CALL}\n<<<END_TOOL_CALL>>>`);
  assert.notEqual(redacted, `${FENCE}\n${CALL}\n<<<END_TOOL_CALL>>>`, 'redaction changed it');
  const out = stripFenceRemnants(`Sure, reading it.\n${redacted}`);
  assert.equal(out, 'Sure, reading it.');
});

test('stripFenceRemnants removes near-miss spellings the parser cannot see', () => {
  for (const marker of ['<<< TOOL_CALL >>>', '<<<TOOLCALL>>>', '<<<tool_call>>>']) {
    const out = stripFenceRemnants(`Working on it.\n${marker}\n${CALL}\n<<<END_TOOL_CALL>>>`);
    assert.equal(out, 'Working on it.', `failed for ${marker}`);
  }
});

test('stripFenceRemnants drops an unterminated directive to the end', () => {
  const out = stripFenceRemnants(`Here goes.\n${FENCE}\n${CALL}`);
  assert.equal(out, 'Here goes.');
});

test('stripFenceRemnants PRESERVES prose that merely mentions the protocol', () => {
  // This repo documents the fence; the agent has to be able to explain it.
  // A marker with no JSON payload after it is discussion, not a directive.
  const prose = `The runtime parses ${FENCE} … <<<END_TOOL_CALL>>> pairs from the reply.`;
  assert.equal(stripFenceRemnants(prose), prose);
});

test('stripFenceRemnants handles several directives and is bounded', () => {
  const out = stripFenceRemnants(
    `One.\n${FENCE}\n${CALL}\n<<<END_TOOL_CALL>>>\nTwo.\n${FENCE}\n${CALL}\n<<<END_TOOL_CALL>>>`);
  assert.ok(!out.includes('TOOL_CALL'));
  // Also assert no ORPHANED brackets: an ungrouped alternation used to match
  // from the word rather than the angles, leaving `<<<` in the reply while
  // still passing a naive "no TOOL_CALL" check.
  assert.ok(!out.includes('<<<') && !out.includes('>>>'), `stray brackets in: ${out}`);
  assert.ok(!out.includes('read-file'), 'no JSON payload survives');
  assert.ok(out.includes('One.') && out.includes('Two.'));
});

test('stripFenceRemnants passes through clean text and non-strings', () => {
  assert.equal(stripFenceRemnants('just an answer'), 'just an answer');
  assert.equal(stripFenceRemnants(''), '');
  assert.equal(stripFenceRemnants(null), null);
});

// ── progress detail ──────────────────────────────────────────────────
test('toolActivityDetail names what a tool acts on, compactly', () => {
  assert.equal(
    toolActivityDetail('read-file', { path: 'mac/Sources/LlmIdeMac/Agent/Views/UpdateFileSheet.swift' }),
    'Views/UpdateFileSheet.swift', 'a deep path shows its last two segments');
  assert.equal(toolActivityDetail('bash', { command: 'npm test' }), 'npm test');
  assert.equal(toolActivityDetail('web-search', { query: 'swift  concurrency' }), 'swift concurrency');
  assert.equal(toolActivityDetail('read-file', {}), undefined, 'no guessable argument → no detail');
  assert.equal(toolActivityDetail('x', null), undefined);
});

test('toolActivityDetail is bounded — it crosses SSE on every tool call', () => {
  const detail = toolActivityDetail('bash', { command: 'x'.repeat(500) });
  assert.ok(detail.length <= 81, `got ${detail.length}`);
  assert.ok(detail.endsWith('…'));
});
