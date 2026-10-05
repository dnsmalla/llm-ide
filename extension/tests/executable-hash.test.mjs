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
