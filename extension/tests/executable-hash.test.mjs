import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { hashExecutables } from '../plugins/executable-hash.mjs';

function dir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'exehash-'));
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), body); }
  return d;
}

test('skill text changes keep the hash; hook / mcp / bin changes move it', () => {
  const a = hashExecutables(dir({ 'skills/x/SKILL.md': 'a', 'hooks/hooks.json': '{}' }));
  assert.equal(a, hashExecutables(dir({ 'skills/x/SKILL.md': 'CHANGED', 'hooks/hooks.json': '{}' })));
  assert.notEqual(a, hashExecutables(dir({ 'skills/x/SKILL.md': 'a', 'hooks/hooks.json': '{"x":1}' })));
  assert.notEqual(a, hashExecutables(dir({ 'skills/x/SKILL.md': 'a', 'hooks/hooks.json': '{}', '.mcp.json': '{}' })));
  assert.notEqual(a, hashExecutables(dir({ 'skills/x/SKILL.md': 'a', 'hooks/hooks.json': '{}', 'bin/run': 'echo' })));
});

test('empty dir is hashable; execute-bit files count', () => {
  assert.equal(hashExecutables(dir({})), hashExecutables(dir({ 'skills/x/SKILL.md': 'a' })));
  const d = dir({ 'tool.sh': 'x' });
  const before = hashExecutables(d);
  fs.chmodSync(path.join(d, 'tool.sh'), 0o755);
  assert.notEqual(before, hashExecutables(d));
});

test('inline manifest hooks/mcpServers move the hash; version stamps do not', () => {
  const m = (extra) => JSON.stringify({ name: 'p', ...extra });
  const base = hashExecutables(dir({ '.claude-plugin/plugin.json': m({ version: '1' }) }));
  assert.equal(base, hashExecutables(dir({ '.claude-plugin/plugin.json': m({ version: '2', llmideSourceVersion: '2' }) })));
  assert.notEqual(base, hashExecutables(dir({ '.claude-plugin/plugin.json': m({ mcpServers: { a: { command: 'x' } } }) })));
  assert.notEqual(base, hashExecutables(dir({ '.claude-plugin/plugin.json': m({ hooks: { PreToolUse: [] } }) })));
});

test('monitors and lsp changes move the hash; manifest key order does not', () => {
  const base = hashExecutables(dir({ 'monitors/monitors.json': '[{"command":"a"}]', '.lsp.json': '{}' }));
  assert.notEqual(base, hashExecutables(dir({ 'monitors/monitors.json': '[{"command":"b"}]', '.lsp.json': '{}' })));
  assert.notEqual(base, hashExecutables(dir({ 'monitors/monitors.json': '[{"command":"a"}]', '.lsp.json': '{"x":1}' })));
  const m = (o) => JSON.stringify({ name: 'p', ...o });
  const a = hashExecutables(dir({ '.claude-plugin/plugin.json': m({ mcpServers: { a: { command: 'x', args: [] }, b: 1 } }) }));
  assert.equal(a, hashExecutables(dir({ '.claude-plugin/plugin.json': m({ mcpServers: { b: 1, a: { args: [], command: 'x' } } }) })));
  const none = hashExecutables(dir({ '.claude-plugin/plugin.json': m({}) }));
  assert.notEqual(none, hashExecutables(dir({ '.claude-plugin/plugin.json': m({ experimental: { monitors: [{ command: 'x' }] } }) })));
  assert.notEqual(none, hashExecutables(dir({ '.claude-plugin/plugin.json': m({ lspServers: { ts: { command: 'x' } } }) })));
  assert.notEqual(none, hashExecutables(dir({ '.claude-plugin/plugin.json': m({ monitors: [{ command: 'x' }] }) })));
});

test('manifest string paths hash the named file; escapes are ignored', () => {
  const m = JSON.stringify({ name: 'p', lspServers: './lsp-config.json' });
  const a = hashExecutables(dir({ '.claude-plugin/plugin.json': m, 'lsp-config.json': 'one' }));
  assert.notEqual(a, hashExecutables(dir({ '.claude-plugin/plugin.json': m, 'lsp-config.json': 'two' })));
  const esc = JSON.stringify({ name: 'p', lspServers: '../../../etc/hosts' });
  assert.equal(hashExecutables(dir({ '.claude-plugin/plugin.json': esc })), hashExecutables(dir({ '.claude-plugin/plugin.json': esc })));
});
