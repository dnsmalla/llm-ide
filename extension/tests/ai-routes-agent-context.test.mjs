// The legacy code-assist route rebuilds agentContext from a fixed field list.
// A field missing from that list is silently dropped before the agent sees it
// — activeRepoRoot was one, so the legacy engine never narrowed its repo scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { buildEnrichedAgentContext } = await import('../server/ai-routes.mjs');

test('activeRepoRoot reaches the legacy agent context', () => {
  const ctx = buildEnrichedAgentContext({ workspaceRoot: '~/p', activeRepoRoot: '~/p/code/app' }, []);
  assert.equal(ctx.activeRepoRoot, '~/p/code/app');
  assert.equal(ctx.workspaceRoot, '~/p');
});

test('a missing or non-string activeRepoRoot becomes null', () => {
  assert.equal(buildEnrichedAgentContext({}, []).activeRepoRoot, null);
  assert.equal(buildEnrichedAgentContext({ activeRepoRoot: 42 }, []).activeRepoRoot, null);
});

test('the existing fields are preserved', () => {
  const ctx = buildEnrichedAgentContext({ sessionId: 's', chatSessionId: 'c', activeProject: 'P' }, [{ id: 1 }]);
  assert.deepEqual([ctx.sessionId, ctx.chatSessionId, ctx.activeProject, ctx.recentMeetings], ['s', 'c', 'P', [{ id: 1 }]]);
});
