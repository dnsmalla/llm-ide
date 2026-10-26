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

test('forwards currentBranch and gitStatus counts; bounds and drops anything else', () => {
  const ctx = buildEnrichedAgentContext({
    currentBranch: 'feat/x'.padEnd(500, 'y'),
    gitStatus: { staged: 2, unstaged: -1, ahead: 1.7, behind: 0, hasUpstream: true, extra: 'dropped' },
  }, []);
  assert.equal(ctx.currentBranch.length, 200);
  assert.deepEqual(ctx.gitStatus, { staged: 2, unstaged: 0, ahead: 1, behind: 0, hasUpstream: true });

  const junk = buildEnrichedAgentContext({ currentBranch: 42, gitStatus: ['not', 'an', 'object'] }, []);
  assert.equal(junk.currentBranch, null);
  assert.equal(junk.gitStatus, null);

  const long = buildEnrichedAgentContext({ gitStatus: 'g'.repeat(5000) }, []);
  assert.equal(long.gitStatus.length, 2000);
});
