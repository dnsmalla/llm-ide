// deleteSourcesByPrefix escapes LIKE wildcards: an underscore (or percent) in a repo path must not delete a
// sibling repo's rows. (Restored after the classic-runtime test file that held it was removed.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './provider-test-env.mjs';

const dbmod = await import('../kb/db.mjs');
after(() => dbmod.closeDb());

test('deleteSourcesByPrefix: underscore in the prefix does not match sibling paths', () => {
  const { db, users: [userId] } = freshDb(1);
  void db;
  dbmod.ingestSources(userId, [
    { kind: 'code', ref: '/repo/my_app/a.js', title: 'a', body: 'alpha' },
    { kind: 'code', ref: '/repo/myXapp/b.js', title: 'b', body: 'beta' },
  ]);
  assert.equal(dbmod.deleteSourcesByPrefix(userId, 'code', '/repo/my_app/'), 1, 'exactly the my_app row');
  const remaining = dbmod.getDb().prepare('SELECT ref FROM sources WHERE user_id = ?').all(userId).map((r) => r.ref);
  assert.deepEqual(remaining, ['/repo/myXapp/b.js']);
});

test('deleteSourcesByPrefix: a percent sign in the prefix is literal too, and another user is untouched', () => {
  const { users: [a, b] } = freshDb(2);
  dbmod.ingestSources(a, [{ kind: 'code', ref: '/r/100%/x.js', title: 'x', body: 'x' }, { kind: 'code', ref: '/r/1000/y.js', title: 'y', body: 'y' }]);
  dbmod.ingestSources(b, [{ kind: 'code', ref: '/r/100%/x.js', title: 'x', body: 'x' }]);
  assert.equal(dbmod.deleteSourcesByPrefix(a, 'code', '/r/100%/'), 1);
  assert.equal(dbmod.getDb().prepare('SELECT COUNT(*) n FROM sources WHERE user_id = ?').get(a).n, 1);
  assert.equal(dbmod.getDb().prepare('SELECT COUNT(*) n FROM sources WHERE user_id = ?').get(b).n, 1);
});
