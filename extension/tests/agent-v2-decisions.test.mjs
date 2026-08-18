// Tests for the v2 pending-approval registry (llm_agent/sdk/decisions.mjs).
//
// The registry is pure in-process state (Map + timers, no SDK import, no
// DB), so this suite is hermetic: it parks decisions, answers/aborts/expiry
// them, and pins the resolution shapes the v2 engine (canUseTool await) and
// the decision route both depend on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDecision, answerDecision, abortDecisionsForSession } from '../llm_agent/sdk/decisions.mjs';

test('register → answer resolves the promise; registry empties', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's1', userId: 'u1', questions: [] });
  const res = answerDecision({ requestId, sdkSessionId: 's1', userId: 'u1', answers: { 'Pick one?': 'A' } });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(await promise, { action: 'answer', answers: { 'Pick one?': 'A' } });
  assert.equal(answerDecision({ requestId, sdkSessionId: 's1', userId: 'u1', answers: {} }).reason, 'unknown');
});

test('tenancy: a different user cannot answer', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's2', userId: 'u1', questions: [] });
  assert.equal(answerDecision({ requestId, sdkSessionId: 's2', userId: 'u2', answers: {} }).reason, 'tenancy');
  assert.equal(answerDecision({ requestId, sdkSessionId: 'other', userId: 'u1', answers: {} }).reason, 'tenancy');
  abortDecisionsForSession('s2');
  assert.deepEqual(await promise, { action: 'aborted' });
});

test('timeout expires unanswered decisions', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's3', userId: 'u1', questions: [], timeoutMs: 20 });
  assert.deepEqual(await promise, { action: 'expired' });
  assert.equal(answerDecision({ requestId, sdkSessionId: 's3', userId: 'u1', answers: {} }).reason, 'expired');
});
