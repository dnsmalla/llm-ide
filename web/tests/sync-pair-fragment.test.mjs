// Design 5.2: the #pair= fragment is removed from the address bar and history before any other code runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the fragment is taken once and replaced away; main.tsx imports it first', async () => {
  const calls = [];
  globalThis.location = { hash: '#pair=sv%3D1', href: 'https://llm-ide.com/#pair=sv%3D1', pathname: '/', search: '' };
  globalThis.history = { replaceState: (...a) => calls.push(a) };
  try {
    const m = await import('../src/sync/pair-fragment.ts?case=1');
    assert.deepEqual(calls, [[null, '', '/']]);
    assert.equal(m.takePairLink(), 'https://llm-ide.com/#pair=sv%3D1');
    assert.equal(m.takePairLink(), null);
  } finally { delete globalThis.location; delete globalThis.history; }
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(main.split('\n')[0], /^import "\.\/sync\/pair-fragment\.ts";/);
});
