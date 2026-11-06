import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingDepends, listingProblems } from './verify-linux-bundle.mjs';

test('Depends must name webkit, gtk and the appindicator runtime (alternatives and versions allowed)', () => {
  assert.deepEqual(missingDepends('libwebkit2gtk-4.1-0, libgtk-3-0 (>= 3.24), libayatana-appindicator3-1 | libappindicator3-1'), []);
  assert.deepEqual(missingDepends('libwebkit2gtk-4.1-0, libgtk-3-0'), ['libayatana-appindicator3-1']);
  assert.deepEqual(missingDepends(''), ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libayatana-appindicator3-1']);
});

test('deb listing: core node and server present, no SDK platform package', () => {
  const ok = ['./usr/bin/llmide-desktop-poc', './usr/lib/LLM-IDE/core/node/node', './usr/lib/LLM-IDE/core/root/extension/server.mjs'];
  assert.deepEqual(listingProblems(ok), []);
  assert.match(listingProblems(ok.slice(0, 2)).join(), /server\.mjs/);
  assert.match(listingProblems([...ok, './usr/lib/LLM-IDE/core/root/extension/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude']).join(), /claude/);
});
