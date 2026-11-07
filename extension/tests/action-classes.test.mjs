// Plan H1.2 Task 2: the class table is the one statement of what each kind of action needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const { CLASS_GRANTS, classRefusal, permittedClasses } = await import('../kb/members.mjs');

const m = (teamRole, maxMode, usdCapMonth = 0) => ({ teamRole, maxMode, usdCapMonth });

// [class, member, expected refusal]
const MATRIX = [
  ['public', null, null],
  ['self.read', null, 'role_denied'],
  ['self.read', m('viewer', 'none'), null],
  ['self.write', m('viewer', 'none'), null],
  ['model.ask', m('viewer', 'read_only'), null],
  ['model.ask', m('viewer', 'none'), 'max_mode_none'],
  ['model.read', m('viewer', 'execute'), 'role_denied'],
  ['model.read', m('member', 'none'), 'max_mode_none'],
  ['model.read', m('member', 'read_only'), null],
  ['model.exec', m('member', 'read_only'), 'max_mode_insufficient'],
  ['model.exec', m('member', 'execute'), null],
  ['fs.read', m('viewer', 'execute'), 'role_denied'],
  ['fs.read', m('member', 'read_only'), null],
  ['fs.write', m('member', 'read_only'), 'max_mode_insufficient'],
  ['external.read', m('member', 'read_only'), null],
  ['external.write', m('member', 'execute'), null],
  ['install', m('viewer', 'execute'), 'role_denied'],
  ['install', m('member', 'execute'), null],
  ['install', m('member', 'read_only'), 'max_mode_insufficient'],
  ['install', m('admin', 'execute'), null],
  ['admin', m('member', 'execute'), 'role_denied'],
  ['admin', m('admin', 'none'), null],
  ['host', m('viewer', 'none'), null],
  ['no.such.class', m('owner', 'execute'), 'unknown_class'],
];

test('every class answers the matrix', () => {
  for (const [cls, member, want] of MATRIX) {
    assert.equal(classRefusal(member, cls), want, `${cls} for ${JSON.stringify(member)}`);
  }
});

test('the cap applies only to capped classes, only when a cap is set, and only when spend is known', () => {
  const capped = m('member', 'execute', 20);
  assert.equal(classRefusal(capped, 'model.read', () => 20), 'usd_cap');
  assert.equal(classRefusal(capped, 'model.read', () => 19.99), null);
  assert.equal(classRefusal(capped, 'model.read'), null, 'no spend function: the caller skips the cap');
  assert.equal(classRefusal(capped, 'fs.write', () => 999), null, 'fs.write is not a spending class');
  assert.equal(classRefusal(m('member', 'execute', 0), 'model.exec', () => 1e9), null, '0 = no cap');
});

test('every class except public has a role and a mode; public is null', () => {
  for (const [cls, g] of Object.entries(CLASS_GRANTS)) {
    if (cls === 'public') { assert.equal(g, null); continue; }
    assert.ok(['viewer', 'member', 'admin', 'owner'].includes(g.role), cls);
    assert.ok(['none', 'read_only', 'execute'].includes(g.mode), cls);
    assert.equal(typeof g.cap, 'boolean', cls);
  }
});

test('permittedClasses lists what the member may do, in table order', () => {
  assert.deepEqual(permittedClasses(m('viewer', 'read_only')), ['self.read', 'self.write', 'model.ask', 'host']);
  assert.deepEqual(permittedClasses(null), []);
  assert.ok(permittedClasses(m('owner', 'execute')).includes('install'));
});
