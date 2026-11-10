import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoreTask } from '../agents/task-runner.mjs';

test('sources.update runs the deterministic adapter and never the agent', async () => {
  const calls = [];
  const out = await runCoreTask({
    taskId: 'sourceUpdate',
    userId: 'u1',
    projectRoot: '/p',
    args: {},
    deps: {
      runSourcesUpdate: async (a) => {
        calls.push(a);
        return { synced: 2, refused: 0, skipped: 0, results: [], text: 'Synced 2 of 2 sources.' };
      },
      runLoopAgent: async () => { throw new Error('the agent must not run'); },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.runner, 'core-route');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.sourceIds, undefined);
  assert.match(out.summary, /Synced 2 of 2/);
});
