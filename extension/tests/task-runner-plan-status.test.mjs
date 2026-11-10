import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoreTask } from '../agents/task-runner.mjs';

test('plan.status refreshes outcomes and makes no model call', async () => {
  let refreshed = 0;
  const out = await runCoreTask({
    taskId: 'updatePlanStatus',
    userId: 'u1',
    projectRoot: '/p',
    args: {},
    deps: {
      refreshAllOutcomes: async () => { refreshed += 1; return { refreshed: 3 }; },
      runLoopAgent: async () => { throw new Error('no model'); },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.runner, 'core-route');
  assert.equal(refreshed, 1);
  assert.match(out.summary, /3/);
});
