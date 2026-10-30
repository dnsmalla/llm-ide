// The catalog item model (llm_agent/extensions/model.mjs): ids, sources,
// trust levels and members. Pure; no registries, no files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, TRUST_LEVELS, itemId, parseItemId, memberId, parseMemberId, publisherFromSource, normalizeItem, isMemberEnabled,
} from '../llm_agent/extensions/model.mjs';

const SHA = 'a'.repeat(40);

test('item ids are <kind>:<publisher>/<name>, lowercase, and round-trip', () => {
  assert.deepEqual(KINDS, ['skill', 'plugin', 'mcp', 'llm-source']);
  const id = itemId('plugin', 'Anthropics', 'Code Review!');
  assert.equal(id, 'plugin:anthropics/code-review');
  assert.deepEqual(parseItemId(id), { kind: 'plugin', publisher: 'anthropics', name: 'code-review' });
  assert.throws(() => itemId('widget', 'a', 'b'), /unknown kind/);
  for (const bad of ['plugin:a', 'plugin:/x', 'nope:a/b', 'plugin:A/b', 'plugin:a/b/c', '', null, 42, 'plugin:a/../b', 'plugin:a/b\n']) {
    assert.equal(parseItemId(bad), null, String(bad));
  }
});

test('lookalike and control characters cannot form an id', () => {
  // A non-ASCII lookalike of "anthropics" is slugged away, never preserved.
  assert.equal(itemId('plugin', 'anthrоpics', 'x'), 'plugin:anthr-pics/x');
  assert.equal(parseItemId('plugin:anthrоpics/x'), null);
  assert.equal(parseItemId('plugin:a‮b/x'), null);
  assert.equal(itemId('mcp', '\u0000', 'ok'), 'mcp:local/ok');
});

test('member ids are <type>:<name>; a third-party name may be any printable text', () => {
  assert.equal(memberId('skill', 'Code Reviewer'), 'skill:Code Reviewer');
  assert.deepEqual(parseMemberId('skill:Code Reviewer'), { type: 'skill', name: 'Code Reviewer' });
  assert.deepEqual(parseMemberId('skill:日本語'), { type: 'skill', name: '日本語' });
  assert.equal(parseMemberId('skill:'), null);
  assert.equal(parseMemberId('widget:x'), null);
  assert.equal(parseMemberId('skill:a\u0007b'), null);
  assert.equal(parseMemberId(`skill:${'x'.repeat(121)}`), null);
  assert.throws(() => memberId('skill', ''), /invalid member name/);
});

test('publisher and trust come from the recorded source; an imported item never earns more than it has', () => {
  assert.deepEqual(publisherFromSource(null), { id: 'local', trust: 'local' });
  assert.deepEqual(publisherFromSource({ kind: 'zip', fileName: 'x.zip' }), { id: 'local', trust: 'local' });
  assert.deepEqual(publisherFromSource({ url: 'https://github.com/anthropics/skills' }), { id: 'anthropics', trust: 'official' });
  assert.deepEqual(publisherFromSource({ url: 'https://github.com/Anthropics/skills' }), { id: 'anthropics', trust: 'official' });
  // the same owner name on another host is not official
  assert.deepEqual(publisherFromSource({ url: 'https://gitlab.com/anthropics/skills' }), { id: 'anthropics', trust: 'unknown' });
  assert.deepEqual(publisherFromSource({ url: 'git@github.com:someone/else.git' }), { id: 'someone', trust: 'unknown' });
  assert.deepEqual(publisherFromSource({ url: 'https://github.com/obra/superpowers' }), { id: 'obra', trust: 'unknown' });
  assert.ok(TRUST_LEVELS.includes('verified') && TRUST_LEVELS.includes('community'));
});

test('normalizeItem validates source with the plugin provenance rules and keeps only known fields', () => {
  const ok = normalizeItem({
    id: 'plugin:obra/superpowers', source: { kind: 'git', url: 'https://github.com/obra/superpowers', ref: 'main', commit: SHA, extra: 'dropped' },
    version: '1.2.3', members: [{ type: 'skill', name: 'brainstorming' }, { type: 'hook', name: 'hooks' }, { type: 'skill', name: 'brainstorming' }, { type: 'bogus', name: 'x' }],
    state: { enabled: true, disabledMembers: ['skill:brainstorming', 'garbage', 'skill:brainstorming'] },
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.item.source.commit, SHA);
  assert.equal(ok.item.source.extra, undefined);
  assert.equal(ok.item.publisher.trust, 'unknown');
  assert.deepEqual(ok.item.members.map((m) => [m.memberId, m.executable]), [['skill:brainstorming', false], ['hook:hooks', true]]);
  assert.deepEqual(ok.item.state.disabledMembers, ['skill:brainstorming']);
  assert.equal(isMemberEnabled(ok.item, 'skill:brainstorming'), false);
  assert.equal(isMemberEnabled(ok.item, 'skill:other'), true, 'a member nobody unchecked is on');

  for (const [raw, why] of [
    [{ id: 'plugin:a/b', source: { kind: 'git', url: 'https://github.com/a/b', commit: 'main' } }, /commit/],
    [{ id: 'plugin:a/b', source: { kind: 'git', url: 'http://github.com/a/b', commit: SHA } }, /url/],
    [{ id: 'plugin:a/b', source: { kind: 'git', url: 'https://user:pw@github.com/a/b', commit: SHA } }, /url/],
    [{ id: 'plugin:a/b', source: { kind: 'git', url: 'https://localhost/a/b', commit: SHA } }, /url/],
    [{ id: 'bad id' }, /id/],
    [{ id: 'plugin:a/b', kind: 'mcp' }, /kind/],
    [null, /object/],
  ]) assert.match(normalizeItem(raw).error ?? '', why);
  // no source at all is a local item
  assert.equal(normalizeItem({ id: 'skill:local/x' }).item.source.kind, 'local');
  // a self-declared trust level is accepted only from the known set
  assert.equal(normalizeItem({ id: 'skill:local/x', publisher: { trust: 'god' } }).item.publisher.trust, 'local');
});
