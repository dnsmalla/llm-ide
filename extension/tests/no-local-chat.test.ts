// Q18: the extension stores no chat. Source-level guards (the hooks are React
// and cannot run under the plain Node runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('useChat never writes chrome.storage (only removes the legacy keys)', () => {
  const s = src('sidepanel/hooks/useChat.ts');
  assert.doesNotMatch(s, /storage\??\.local\??\.set/);
  assert.doesNotMatch(s, /storage\??\.local\??\.get/);
  assert.match(s, /LEGACY_LOCAL_KEYS/);
  assert.match(s, /setOffline\(true\)/);
});

test('unified-chat caches no session id in chrome.storage', () => {
  const s = src('lib/unified-chat.ts');
  assert.doesNotMatch(s, /chrome\.storage\??\.local/);
});

test('no code writes the transcripts history or chatMessages', () => {
  for (const f of ['sidepanel/hooks/useTranscript.ts', 'sidepanel/hooks/useLiveSync.ts', 'sidepanel/hooks/useChat.ts']) {
    const s = src(f);
    assert.doesNotMatch(s, /['"]transcripts['"]/, f);
    assert.doesNotMatch(s, /set\(\{\s*\[?\s*['"]?chatMessages/, f);
  }
  // the only mention of the legacy `transcripts` key is the read-only view + verified delete
  const store = src('lib/capture-store.ts');
  assert.doesNotMatch(store, /set\(\{\s*\[LEGACY_KEY\]:\s*\[/);
});

test('the offline banner names the Mac app, not node server.mjs', () => {
  const app = src('sidepanel/App.tsx');
  assert.match(app, /Mac app not running/);
  assert.doesNotMatch(app, /Make sure <code>node server\.mjs/);
  const kb = src('lib/kb.ts');
  assert.match(kb, /OFFLINE_MESSAGE = 'Mac app not running/);
});
