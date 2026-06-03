// agent-prompt tests — defensive parsing of LLM output.
//
// The Claude CLI returns a string blob.  draftQuestion is supposed
// to extract the JSON envelope from the LAST line, normalize every
// field through type checks + length caps + score clamping, and
// degrade to {shouldAsk:false} on any malformed input rather than
// throwing.  These tests pin that contract so a future prompt
// rewrite or Claude version bump can't silently break the pipeline.
//
// Strategy: pass a stub via the _runClaude seam — no spawning the
// real CLI, no DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEETNOTES_JWT_SECRET = 'a'.repeat(48);
process.env.MEETNOTES_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { draftQuestion } = await import('../agents/agent-prompt.mjs');

// Minimal fixture data.  Tests can override.
const PLAN = {
  title: 'Migrate auth to JWT',
  goal: 'Drop session cookies',
  tasks: [
    { id: 'task_a1', title: 'Add JWT issuance endpoint', status: 'in_progress' },
    { id: 'task_a2', title: 'Wire refresh-token rotation', status: 'pending' },
  ],
};
const TRANSCRIPT = [
  { speaker: 'Alice', text: 'we should look at migration 0042', ts: Date.now() - 2000 },
  { speaker: 'Bob',   text: 'do we have rollback?',             ts: Date.now() - 1000 },
];

function stub(returnValue) {
  return async () => returnValue;
}

// ── Happy path ──────────────────────────────────────────────────────

test('valid JSON envelope round-trips all fields', async () => {
  const llm = stub(JSON.stringify({
    shouldAsk: true,
    question: 'Do we have rollback for migration 0042?',
    score: 0.84,
    planTaskId: 'task_a1',
    reason: 'Alice mentioned migration without rollback',
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, true);
  assert.equal(r.question, 'Do we have rollback for migration 0042?');
  assert.equal(r.score, 0.84);
  assert.equal(r.planTaskId, 'task_a1');
  assert.match(r.reason, /Alice/);
});

test('JSON envelope wrapped in prose — extracts the last JSON line', async () => {
  const llm = stub(`Sure, here's my analysis:

The team mentioned a migration without discussing rollback safety.

{"shouldAsk":true,"question":"What's the rollback?","score":0.8,"planTaskId":"task_a1","reason":"missed risk"}`);
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, true);
  assert.equal(r.question, "What's the rollback?");
});

// ── Defensive normalization ─────────────────────────────────────────

test('shouldAsk:true with score below 0.7 is rejected (failed-gate)', async () => {
  const llm = stub(JSON.stringify({
    shouldAsk: true, question: 'noise', score: 0.42, planTaskId: '', reason: '',
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, false);
  assert.match(r.reason, /failed-gate/);
});

test('shouldAsk:true with empty question is rejected', async () => {
  const llm = stub(JSON.stringify({
    shouldAsk: true, question: '', score: 0.9, planTaskId: '', reason: 'x',
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, false);
});

test('score > 1 is clamped to 1 (untrusted model output)', async () => {
  const llm = stub(JSON.stringify({
    shouldAsk: true, question: 'q', score: 999, planTaskId: '', reason: '',
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.score, 1);
});

test('negative score is clamped to 0', async () => {
  const llm = stub(JSON.stringify({
    shouldAsk: false, question: '', score: -5, planTaskId: '', reason: 'no',
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.score, 0);
});

test('NaN / undefined / non-numeric score → 0', async () => {
  const llm = stub(JSON.stringify({
    shouldAsk: false, question: '', score: 'foo', planTaskId: '', reason: 'no',
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.score, 0);
});

test('planTaskId longer than 64 chars is truncated', async () => {
  const longId = 't'.repeat(200);
  const llm = stub(JSON.stringify({
    shouldAsk: true, question: 'q', score: 0.9, planTaskId: longId, reason: 'x',
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.planTaskId.length, 64);
});

test('reason longer than 200 chars is truncated', async () => {
  const longReason = 'a'.repeat(500);
  const llm = stub(JSON.stringify({
    shouldAsk: true, question: 'q', score: 0.9, planTaskId: '', reason: longReason,
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.reason.length, 200);
});

test('non-string fields coerce to safe defaults', async () => {
  const llm = stub(JSON.stringify({
    shouldAsk: false,
    question: 42,           // number, not string
    score: 0.5,
    planTaskId: { x: 1 },   // object
    reason: null,           // null
  }));
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, false);
  assert.equal(r.planTaskId, '');
  assert.equal(r.reason, '');
});

// ── Failure modes ──────────────────────────────────────────────────

test('completely non-JSON output returns shouldAsk:false reason:bad-llm-output', async () => {
  const llm = stub('I cannot answer that question. Please rephrase.');
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, false);
  assert.equal(r.reason, 'bad-llm-output');
});

test('truncated JSON returns shouldAsk:false reason:bad-llm-output', async () => {
  const llm = stub('{"shouldAsk":true,"questi');
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, false);
  assert.equal(r.reason, 'bad-llm-output');
});

test('runClaude throwing returns shouldAsk:false with claude-cli-error reason', async () => {
  const llm = async () => { throw new Error('CLI not found'); };
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(r.shouldAsk, false);
  assert.match(r.reason, /claude-cli-error/);
  assert.match(r.reason, /CLI not found/);
});

test('claude-cli error message is truncated to 80 chars', async () => {
  const huge = 'X'.repeat(500);
  const llm = async () => { throw new Error(huge); };
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  // Reason format: `claude-cli-error: <80 char message>`
  // Our slice(0, 80) cap is on the message, so total length ≤ ~100
  assert.ok(r.reason.length < 110, `reason should be capped, got ${r.reason.length}`);
});

// ── Empty-transcript guard ─────────────────────────────────────────

test('empty transcript window → no LLM call, returns no-transcript', async () => {
  let called = false;
  const llm = async () => { called = true; return ''; };
  const r = await draftQuestion({
    plan: PLAN, transcriptWindow: [], _runClaude: llm,
  });
  assert.equal(called, false, 'should not invoke LLM');
  assert.equal(r.shouldAsk, false);
  assert.equal(r.reason, 'no-transcript');
});

test('null plan → no LLM call, returns no-plan', async () => {
  let called = false;
  const llm = async () => { called = true; return ''; };
  const r = await draftQuestion({
    plan: null, transcriptWindow: TRANSCRIPT, _runClaude: llm,
  });
  assert.equal(called, false);
  assert.equal(r.shouldAsk, false);
  assert.equal(r.reason, 'no-plan');
});

// ── Persona suffix flows into the prompt ───────────────────────────

test('personaSuffix is appended to the system prompt', async () => {
  let capturedPrompt = '';
  const llm = async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({ shouldAsk: false, question: '', score: 0, planTaskId: '', reason: 'x' });
  };
  await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT,
    personaSuffix: 'Be terse. Only ask about risks.',
    _runClaude: llm,
  });
  // Persona suffix is now wrapped in a <persona-config id="<nonce>"> fence
  // (prompt-utils.mjs personaConfigBlock) rather than a heading. The fence
  // carries a per-call random nonce so an untrusted suffix can't forge the
  // closing tag.
  assert.match(capturedPrompt, /<persona-config id="[A-Za-z0-9_-]+">/);
  assert.match(capturedPrompt, /Be terse/);
});

test('Japanese language hint is included in the prompt', async () => {
  let capturedPrompt = '';
  const llm = async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({ shouldAsk: false, question: '', score: 0, planTaskId: '', reason: 'x' });
  };
  await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, language: 'ja',
    _runClaude: llm,
  });
  assert.match(capturedPrompt, /Meeting language/);
  assert.match(capturedPrompt, /Japanese/);
});

test('English language → no language directive (default behavior)', async () => {
  let capturedPrompt = '';
  const llm = async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({ shouldAsk: false, question: '', score: 0, planTaskId: '', reason: 'x' });
  };
  await draftQuestion({
    plan: PLAN, transcriptWindow: TRANSCRIPT, language: 'en',
    _runClaude: llm,
  });
  assert.equal(capturedPrompt.includes('Meeting language'), false);
});
