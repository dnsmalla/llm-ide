import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewPromptFor, runReviewTask } from '../agents/tasks/review.mjs';

test('review.conflicts uses the registry prompt verbatim', () => {
  // Captured from the pre-migration reviewPrompt('conflicts') (extension/tests/fixtures), byte for byte.
  const want = readFileSync(new URL('./fixtures/review-prompt-conflicts.txt', import.meta.url), 'utf8');
  assert.equal(reviewPromptFor('review.conflicts', ''), want);
});

test('a clean worktree answers with no model call', async () => {
  let modelCalls = 0;
  const out = await runReviewTask({
    userId: 'u1',
    args: { focus: 'conflicts' },
    cwd: '/p',
    signal: null,
    spawn: null,
    emit: () => {},
    deps: {
      runGit: async (_spawn, _cwd, args) => {
        if (args.includes('rev-parse')) return { code: 0, stdout: 'true\n' };
        if (args.includes('ls-files') || args.includes('--check')) return { code: 0, stdout: '', stderr: '' };
        modelCalls += 1;
        return { code: 0, stdout: 'should not run', stderr: '' };
      },
      runTask: async () => { modelCalls += 1; return { text: 'x' }; },
      engineIdFor: () => 'claude',
    },
  });
  assert.equal(out.modelCalls, 0);
  assert.equal(modelCalls, 0);
  assert.match(out.text, /No findings/);
});

test('a dirty worktree runs the registry conflicts prompt once', async () => {
  let sent = null;
  await runReviewTask({
    userId: 'u1',
    args: { focus: 'conflicts' },
    cwd: '/p',
    signal: null,
    spawn: null,
    emit: () => {},
    deps: {
      runGit: async (_spawn, _cwd, args) => {
        if (args.includes('rev-parse')) return { code: 0, stdout: 'true\n' };
        if (args.includes('ls-files')) return { code: 0, stdout: '100644 abc 1\tsrc/a.js\n' };
        return { code: 0, stdout: '' };
      },
      runTask: async (opts) => { sent = opts; return { text: '- src/a.js:1 high', engine: 'claude', stopReason: 'end_turn' }; },
      engineIdFor: () => 'claude',
    },
  });
  assert.equal(sent.prompt.startsWith(reviewPromptFor('review.conflicts', '').split('\n\n')[0]), true);
  assert.equal(sent.prompt.includes('src/a.js'), true);
});
