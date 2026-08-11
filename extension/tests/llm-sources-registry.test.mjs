import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-reg-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins');
// A fake "builtin" skills repo so seeding resolves without the real submodule.
const fakeRepo = path.join(tmpRoot, 'fake-skills');
fs.mkdirSync(path.join(fakeRepo, 'skills', 'demo'), { recursive: true });
fs.writeFileSync(path.join(fakeRepo, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
fs.writeFileSync(path.join(fakeRepo, 'skills', 'demo', 'SKILL.md'),
  '---\nname: demo\ndescription: d\n---\n\n# demo\n');
process.env.SKILLS_REPO = fakeRepo;

const { readRegistry, writeRegistry, isValidLlmSource, seedBuiltinOnce,
  listSources, getSource, BUILTIN_ID, countDiscoverySkills,
  countDiscoveryAgents, listDiscoveryAgents, countDiscoveryHooks, listDiscoveryHooks,
  sourceDiscoveryDetail } =
  await import('../llm-sources/registry.mjs');

test('isValidLlmSource accepts registry.yaml or plugin.json+skills/', () => {
  assert.ok(isValidLlmSource(fakeRepo));
  const cp = path.join(tmpRoot, 'cp');
  fs.mkdirSync(path.join(cp, 'skills', 'x'), { recursive: true });
  fs.mkdirSync(path.join(cp, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(cp, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
  assert.ok(isValidLlmSource(cp));
  assert.ok(!isValidLlmSource(tmpRoot)); // no markers
});

test('isValidLlmSource also accepts an agents/-only or hooks-manifest-only directory', () => {
  const agentsOnly = path.join(tmpRoot, 'agents-only');
  fs.mkdirSync(path.join(agentsOnly, 'agents'), { recursive: true });
  assert.ok(isValidLlmSource(agentsOnly));

  const hooksOnly = path.join(tmpRoot, 'hooks-only');
  fs.mkdirSync(path.join(hooksOnly, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(hooksOnly, 'hooks', 'hooks.json'), '{}');
  assert.ok(isValidLlmSource(hooksOnly));
});

test('seedBuiltinOnce adds exactly one builtin source pointing at the resolved repo', () => {
  writeRegistry([]); // start clean
  seedBuiltinOnce();
  const src = getSource(BUILTIN_ID);
  assert.ok(src, 'builtin source must exist');
  assert.equal(src.origin, 'builtin');
  assert.equal(src.builtin, true);
  assert.equal(src.location, fakeRepo);
  // Idempotent.
  seedBuiltinOnce();
  const builtins = readRegistry().filter((s) => s.id === BUILTIN_ID);
  assert.equal(builtins.length, 1);
});

test('listSources returns the registered sources', () => {
  seedBuiltinOnce();
  const ids = listSources().map((s) => s.id);
  assert.ok(ids.includes(BUILTIN_ID));
});

test('countDiscoverySkills counts skills/ + runtime/ SKILL.md', () => {
  fs.mkdirSync(path.join(fakeRepo, 'runtime', 'rt'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'runtime', 'rt', 'SKILL.md'),
    '---\nname: rt\ndescription: r\n---\n\n# rt\n');
  assert.equal(countDiscoverySkills(fakeRepo), 2);
});

test('countDiscoveryAgents + listDiscoveryAgents read agents/*.md frontmatter', () => {
  fs.mkdirSync(path.join(fakeRepo, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: reviews code\n---\n\nbody\n');
  fs.writeFileSync(path.join(fakeRepo, 'agents', 'not-an-agent.txt'), 'ignored, not .md');
  assert.equal(countDiscoveryAgents(fakeRepo), 1);
  const agents = listDiscoveryAgents(fakeRepo);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'reviewer');
  assert.equal(agents[0].description, 'reviews code');
});

test('countDiscoveryHooks + listDiscoveryHooks read the Claude-plugin hooks manifest — discovery only', () => {
  fs.mkdirSync(path.join(fakeRepo, '.claude-plugin', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, '.claude-plugin', 'hooks', 'hooks.json'), JSON.stringify({
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }],
  }));
  assert.equal(countDiscoveryHooks(fakeRepo), 2);
  const hooks = listDiscoveryHooks(fakeRepo);
  assert.equal(hooks.length, 2);
  assert.ok(hooks.some((h) => h.event === 'PreToolUse' && h.matcher === 'Bash' && h.command === 'echo pre'));
  assert.ok(hooks.some((h) => h.event === 'SessionStart' && h.command === 'echo start'));
});

test('sourceDiscoveryDetail returns the agents+hooks for a registered, installed source', () => {
  writeRegistry([]); seedBuiltinOnce(); // re-seed after writeRegistry([]) above cleared it
  const detail = sourceDiscoveryDetail(BUILTIN_ID);
  assert.ok(detail);
  assert.ok(Array.isArray(detail.agents));
  assert.ok(Array.isArray(detail.hooks));
  assert.equal(sourceDiscoveryDetail('not-a-real-id'), null);
});

import { normalizeGitUrl, addSource, removeSource, updateSource, syncBuiltin } from '../llm-sources/registry.mjs';

test('normalizeGitUrl rejects unsafe schemes and localhost, accepts https', () => {
  assert.ok(normalizeGitUrl('https://github.com/o/r.git').ok);
  assert.ok(normalizeGitUrl('https://github.com/o/r').ok);
  assert.ok(!normalizeGitUrl('file:///etc/passwd').ok);
  assert.ok(!normalizeGitUrl('ssh://git@host/o/r').ok);
  assert.ok(!normalizeGitUrl('http://127.0.0.1/x').ok);
  assert.ok(!normalizeGitUrl('http://example.local/x').ok);
  assert.ok(!normalizeGitUrl('not a url').ok);
});

test('addSource rejects a non-valid directory at a local path', async () => {
  const res = await addSource({ path: tmpRoot }); // no markers
  assert.ok(!res.source, 'no source created');
  assert.ok(res.error);
  assert.equal(res.status, 400);
});

test('addSource registers a local valid source and removeSource deletes it', async () => {
  const res = await addSource({ path: fakeRepo, name: 'fake-local' });
  assert.ok(res.source, 'source created');
  assert.equal(res.source.origin, 'local');
  assert.ok(res.source.location);
  const id = res.source.id;
  assert.ok(getSource(id), 'present in registry');
  // builtin not removable; arbitrary source is.
  const bad = removeSource(BUILTIN_ID);
  assert.ok(bad.error && bad.status === 400);
  const good = removeSource(id);
  assert.ok(good.ok);
  assert.equal(getSource(id), null);
});

test('addSource rejects a ref that looks like a git option (arg-injection guard)', async () => {
  const before = readRegistry().length;
  const res = await addSource({ url: 'https://github.com/o/r.git', ref: '-cCore.fsMonitor=/tmp/x' });
  assert.ok(res.error, 'must return an error');
  assert.equal(res.status, 400);
  assert.equal(readRegistry().length, before, 'must not persist a rejected source');
});

test('addSource surfaces a clone failure instead of throwing (unreachable host)', async () => {
  // No network access assumed reachable in CI/sandboxed environments — a
  // bogus but well-formed https URL exercises the async cloneShallow
  // failure path (previously untested) without needing a real network mock.
  const before = readRegistry().length;
  const res = await addSource({ url: 'https://example.invalid/nonexistent/repo.git' });
  assert.ok(res.error, 'must return an error, not throw');
  assert.equal(res.status, 400);
  assert.equal(readRegistry().length, before, 'must not persist a failed clone');
});

import { listSourcesWithState } from '../llm-sources/registry.mjs';
import { setEnabled } from '../llm-sources/state.mjs';

test('listSourcesWithState joins per-user enable + live metadata, including agent/hook counts', () => {
  writeRegistry([]); seedBuiltinOnce();
  setEnabled('viewer', BUILTIN_ID, true);
  const { sources } = listSourcesWithState('viewer');
  const b = sources.find((s) => s.id === BUILTIN_ID);
  assert.ok(b.enabled);
  assert.equal(b.origin, 'builtin');
  assert.ok(typeof b.skillCount === 'number');
  assert.ok(typeof b.agentCount === 'number');
  assert.ok(typeof b.hookCount === 'number');
  // A user who disabled builtin sees enabled=false.
  setEnabled('off', BUILTIN_ID, false);
  const off = listSourcesWithState('off').sources.find((s) => s.id === BUILTIN_ID);
  assert.equal(off.enabled, false);
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
