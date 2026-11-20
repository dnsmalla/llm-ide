import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FACTORY_BRANCH_RE, isFactoryWorktree, parseShipBody } from '../agents/factory-ship.mjs';

const ID = '20261120-101500-abc123';

test('the ship branch rule accepts factory/<id> and loop/<slug>/<id> only', () => {
  for (const ok of [`factory/${ID}`, 'loop/regression', 'loop/test-and-fix', 'loop/a', `loop/${'a'.repeat(32)}`]) {
    assert.ok(FACTORY_BRANCH_RE.test(ok), ok);
  }
  for (const bad of [
    'main', 'loop/', 'loop//x', 'loop/-x', 'loop/x-', 'loop/Up', 'loop/a b', 'loop/..', 'loop/a..b', 'refs/heads/loop/x', '-loop/x',
    `loop/regression/${ID}`, 'loop/x/y', `loop/${'a'.repeat(33)}`, 'loop/x ', 'loop/x\n', `factory/${ID}/x`, 'factory/', 'loop',
  ]) {
    assert.ok(!FACTORY_BRANCH_RE.test(bad), JSON.stringify(bad));
  }
});

test('a ship body names a loop branch; anything else is refused', () => {
  const body = (branch) => ({ worktree: '/p/system/loop-worktrees/r1', branch, provider: 'github', repo: 'o/r', base: 'main', title: 't', patchId: 'a'.repeat(64) });
  assert.equal(parseShipBody(body('loop/regression')).branch, 'loop/regression');
  assert.match(parseShipBody(body('loop/regression/r1')).error, /branch must be/);
  assert.match(parseShipBody(body('loop/..')).error, /branch must be/);
  assert.match(parseShipBody(body('refs/heads/main')).error, /branch must be/);
});

test('a loop branch ships only from the worktree folder named for its slug', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-branch-'));
  try {
    const make = (name) => {
      const wt = path.join(dir, 'system', 'loop-worktrees', name);
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(wt, '.git'), 'gitdir: x\n');
      return wt;
    };
    const loop = make('regression');
    assert.ok(isFactoryWorktree(loop, 'loop/regression'));
    assert.ok(!isFactoryWorktree(loop, 'loop/test'), 'another loop\'s branch from this folder');
    assert.ok(!isFactoryWorktree(loop, 'loop/regression/x'));
    assert.ok(!isFactoryWorktree(loop, 'main'));
    const run = make('r1');
    assert.ok(isFactoryWorktree(run, 'factory/r1'));
    assert.ok(!isFactoryWorktree(run, 'factory/r2'), 'another run id');
    assert.ok(!isFactoryWorktree(run, 'loop/r1/r1'));
    // The loop shape needs a valid slug folder: a run-id-shaped folder cannot claim loop/<id> when the id is not a slug.
    const upper = make('Run1');
    assert.ok(!isFactoryWorktree(upper, 'loop/Run1'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
