// Tests for the v2 decisions registry's generalization (Task 7): kind/action
// on registerDecision/answerDecision, back-compat with the pre-existing
// AskUserQuestion call site, and the new ToolApproval allow/deny/
// always-allow outcomes act-tool gating needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDecision, answerDecision } from '../llm_agent/sdk/decisions.mjs';

test('registerDecision defaults kind to AskUserQuestion (back-compat)', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's1', userId: 'u1' });
  const out = answerDecision({ requestId, sdkSessionId: 's1', userId: 'u1', answers: { q: 'yes' } });
  assert.equal(out.ok, true);
  assert.deepEqual(await promise, { action: 'answer', answers: { q: 'yes' } });
});

test('a ToolApproval decision resolves with allow/deny/always-allow actions', async () => {
  const { requestId: r1, promise: p1 } = registerDecision({ sdkSessionId: 's2', userId: 'u1', kind: 'ToolApproval' });
  answerDecision({ requestId: r1, sdkSessionId: 's2', userId: 'u1', action: 'allow' });
  assert.deepEqual(await p1, { action: 'allow' });

  const { requestId: r2, promise: p2 } = registerDecision({ sdkSessionId: 's2', userId: 'u1', kind: 'ToolApproval' });
  answerDecision({ requestId: r2, sdkSessionId: 's2', userId: 'u1', action: 'deny' });
  assert.deepEqual(await p2, { action: 'deny' });

  const { requestId: r3, promise: p3 } = registerDecision({ sdkSessionId: 's2', userId: 'u1', kind: 'ToolApproval' });
  answerDecision({ requestId: r3, sdkSessionId: 's2', userId: 'u1', action: 'always-allow' });
  assert.deepEqual(await p3, { action: 'always-allow' });
});

test('answerDecision rejects an invalid action and leaves the entry parked', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's3', userId: 'u1', kind: 'ToolApproval' });
  const out = answerDecision({ requestId, sdkSessionId: 's3', userId: 'u1', action: 'bogus' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid_action');
  // The entry is still parked — a valid follow-up answer still resolves it.
  const out2 = answerDecision({ requestId, sdkSessionId: 's3', userId: 'u1', action: 'allow' });
  assert.equal(out2.ok, true);
  assert.deepEqual(await promise, { action: 'allow' });
});

test('answerDecision tenancy/unknown reasons are unaffected by the new action param', () => {
  const { requestId } = registerDecision({ sdkSessionId: 's4', userId: 'owner', kind: 'ToolApproval' });
  const foreign = answerDecision({ requestId, sdkSessionId: 's4', userId: 'not-owner', action: 'allow' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'tenancy');

  const unknown = answerDecision({ requestId: 'no-such-id', sdkSessionId: 's4', userId: 'owner', action: 'allow' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown');

  // Clean up the still-parked entry so its timer doesn't outlive the test.
  answerDecision({ requestId, sdkSessionId: 's4', userId: 'owner', action: 'deny' });
});
