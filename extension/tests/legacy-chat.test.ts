// The old local chat buffer is never deleted blind (review item 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleLegacyChat, discardLegacyChat, legacyChatJson, type LegacyChatArea } from '../src/lib/legacy-chat.ts';

function area(initial: Record<string, unknown>, failRemove = false) {
  const store = new Map(Object.entries(initial));
  const a: LegacyChatArea = {
    async get(k) {
      const key = k as string;
      return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
    },
    async remove(keys) {
      if (failRemove) throw new Error('boom');
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
  return { store, a };
}
const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];

test('non-empty buffer + server unreachable: kept, surfaced', async () => {
  const f = area({ chatMessages: msgs, unifiedChatSessionId: 's1' });
  assert.deepEqual(await settleLegacyChat(f.a, false), msgs);
  assert.ok(f.store.has('chatMessages'));
  assert.ok(!f.store.has('unifiedChatSessionId'), 'the pointer goes freely');
});

test('non-empty buffer + server reached: STILL kept (only export/discard removes it)', async () => {
  const f = area({ chatMessages: msgs });
  assert.deepEqual(await settleLegacyChat(f.a, true), msgs);
  assert.ok(f.store.has('chatMessages'));
});

test('empty buffer: removed only after the server answered', async () => {
  const f = area({ chatMessages: [] });
  assert.deepEqual(await settleLegacyChat(f.a, false), []);
  assert.ok(f.store.has('chatMessages'), 'not touched before the server was reached');
  assert.deepEqual(await settleLegacyChat(f.a, true), []);
  assert.ok(!f.store.has('chatMessages'));
});

test('export then discard removes it; a failing remove does not throw out of settle', async () => {
  const f = area({ chatMessages: msgs });
  assert.match(legacyChatJson(msgs), /hello/);
  await discardLegacyChat(f.a);
  assert.ok(!f.store.has('chatMessages'));
  const g = area({ chatMessages: [] }, true);
  assert.deepEqual(await settleLegacyChat(g.a, true), []);
});

test('nothing stored at all: nothing to do', async () => {
  const f = area({});
  assert.deepEqual(await settleLegacyChat(f.a, true), []);
});
