// Proof of use in chat: which plugins and MCP servers a chat's turns load, said once per chat and again on a change.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extensionsLoadedNotice } = await import('../llm_agent/sdk/engine.mjs');

const ids = (o = {}) => ({ nativePlugins: [], pluginSkills: [], commands: [], subagents: [], mcpServers: [], ...o });

test('a chat hears what it loads once; the same set again is silent', () => {
  const n = extensionsLoadedNotice('u1', 'c1', ids({ nativePlugins: [{ name: 'runner' }], pluginSkills: ['tidy/fmt'], mcpServers: ['github'] }));
  assert.equal(n.kind, 'extensions_loaded');
  assert.equal(n.level, 'info');
  assert.equal(n.text, 'This chat uses your extensions: plugins runner, tidy; MCP servers github.');
  assert.deepEqual(n.data, { plugins: ['runner', 'tidy'], mcpServers: ['github'] });
  assert.equal(extensionsLoadedNotice('u1', 'c1', ids({ nativePlugins: [{ name: 'runner' }], pluginSkills: ['tidy/fmt'], mcpServers: ['github'] })), null);
});

test('switching something off shows the new set; switching everything off says so; nothing loaded at all is silent', () => {
  assert.match(extensionsLoadedNotice('u2', 'c', ids({ mcpServers: ['a', 'b'] })).text, /MCP servers a, b/);
  assert.match(extensionsLoadedNotice('u2', 'c', ids({ mcpServers: ['a'] })).text, /MCP servers a\.$/);
  assert.equal(extensionsLoadedNotice('u2', 'c', ids()).text, 'This chat now uses none of your plugins or MCP servers.');
  assert.equal(extensionsLoadedNotice('u3', 'c', ids()), null, 'a chat that never loaded anything gets no notice');
});

test('chats and users are separate; long lists are shortened', () => {
  const many = ids({ mcpServers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
  assert.match(extensionsLoadedNotice('u4', 'x', many).text, /a, b, c, d, e, f and 2 more/);
  assert.ok(extensionsLoadedNotice('u4', 'y', many), 'another chat hears it too');
  assert.ok(extensionsLoadedNotice('u5', 'x', many), 'another user hears it too');
});

test('names from manifests are cleaned and capped', () => {
  const n = extensionsLoadedNotice('u6', 'c', ids({ mcpServers: [`evil‮${'x'.repeat(200)}`, 'ok'] }));
  assert.ok(!n.text.includes('‮'));
  assert.ok(n.data.mcpServers.every((s) => s.length <= 60));
});
