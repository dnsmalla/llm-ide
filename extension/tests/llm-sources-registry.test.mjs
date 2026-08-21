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
  listSources, getSource, BUILTIN_ID, DEFAULT_SOURCES_ID, defaultSourcesLocation, countDiscoverySkills,
  countDiscoveryAgents, listDiscoveryAgents, countDiscoveryHooks, listDiscoveryHooks,
  countDiscoveryMcpServers, listDiscoveryMcpServers,
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

  const mcpOnly = path.join(tmpRoot, 'mcp-only');
  fs.mkdirSync(mcpOnly, { recursive: true });
  fs.writeFileSync(path.join(mcpOnly, '.mcp.json'), '{}');
  assert.ok(isValidLlmSource(mcpOnly));
});

test('seeding registers default-sources FIRST (dedup preference), pointing at the repo folder, not removable', () => {
  process.env.LLMIDE_REPO_ROOT = path.join(tmpRoot, 'repo-root');
  writeRegistry([]); // start clean
  seedBuiltinOnce();
  const list = readRegistry();
  assert.equal(list[0].id, DEFAULT_SOURCES_ID, 'default sources must be first in registry order');
  assert.equal(list[0].location, path.join(tmpRoot, 'repo-root', 'llm_default_sources'));
  assert.equal(list[0].builtin, true);
  const rm = removeSource(DEFAULT_SOURCES_ID);
  assert.ok(rm.error, 'default-sources must not be removable');
  delete process.env.LLMIDE_REPO_ROOT;
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

// The kit declares hooks the SETTINGS way, not the plugin way, which is why
// it reported zero hooks while shipping two (a SessionStart memory loader and
// a PreToolUse Write|Edit check). Both conventions must be read.
test('listDiscoveryHooks reads a settings.json `hooks` block, including the kit config/tool/claude layout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-hooks-settings-'));
  fs.mkdirSync(path.join(dir, 'config', 'tool', 'claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'tool', 'claude', 'settings.json'), JSON.stringify({
    // A real settings.json is mostly NOT hooks — everything else must be
    // ignored rather than mistaken for an event.
    permissions: { deny: ['**/.env'] },
    env: { PYTHONPATH: '.' },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: './load-memory.sh' }] }],
      PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: './tier-a-check.sh' }] }],
    },
  }));
  const hooks = listDiscoveryHooks(dir);
  assert.equal(countDiscoveryHooks(dir), 2);
  assert.ok(hooks.some((h) => h.event === 'SessionStart' && h.command === './load-memory.sh'));
  assert.ok(hooks.some((h) => h.event === 'PreToolUse' && h.matcher === 'Write|Edit'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listDiscoveryHooks unions both conventions and de-duplicates a hook declared twice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-hooks-both-'));
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  // Same hook in the plugin manifest and in settings — counted once…
  const shared = { Stop: [{ hooks: [{ type: 'command', command: './done.sh' }] }] };
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(shared));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { ...shared, SessionEnd: [{ hooks: [{ type: 'command', command: './bye.sh' }] }] },
  }));
  // …and the settings-only hook is not lost to the plugin manifest winning.
  assert.equal(countDiscoveryHooks(dir), 2);
  const events = listDiscoveryHooks(dir).map((h) => h.event).sort();
  assert.deepEqual(events, ['SessionEnd', 'Stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listDiscoveryHooks tolerates a settings.json with no hooks block, and a malformed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-hooks-edge-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: [] } }));
  assert.deepEqual(listDiscoveryHooks(dir), []);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
  assert.deepEqual(listDiscoveryHooks(dir), []);
  // A hooks key of the wrong type must not throw either.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: 'nope' }));
  assert.deepEqual(listDiscoveryHooks(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('countDiscoveryMcpServers + listDiscoveryMcpServers read .mcp.json — discovery only, never spawned', () => {
  fs.writeFileSync(path.join(fakeRepo, '.mcp.json'), JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      broken: { notACommandField: true }, // must be skipped, not throw
    },
  }));
  assert.equal(countDiscoveryMcpServers(fakeRepo), 1);
  const servers = listDiscoveryMcpServers(fakeRepo);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'filesystem');
  assert.equal(servers[0].command, 'npx');
  assert.deepEqual(servers[0].args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
});

test('sourceDiscoveryDetail returns the skills+agents+hooks+mcpServers for a registered, installed source', () => {
  writeRegistry([]); seedBuiltinOnce(); // re-seed after writeRegistry([]) above cleared it
  const detail = sourceDiscoveryDetail(BUILTIN_ID);
  assert.ok(detail);
  // Skills were the one discoverable kind the detail endpoint never listed —
  // the Mac detail pane could show a skill COUNT but no skills, which read as
  // "update did nothing" whenever the user went looking for them.
  assert.ok(Array.isArray(detail.skills));
  // fakeRepo holds skills/demo (setup) + runtime/rt (added by the count test
  // above) — both families must be listed, and frontmatter feeds name/desc.
  assert.equal(detail.skills.length, countDiscoverySkills(fakeRepo),
    'the list must never contradict its own count');
  const demo = detail.skills.find((s) => s.name === 'demo');
  assert.ok(demo, 'skills/demo must be listed');
  assert.equal(demo.description, 'd');
  assert.ok(Array.isArray(detail.agents));
  assert.ok(Array.isArray(detail.hooks));
  assert.ok(Array.isArray(detail.mcpServers));
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

test('listSourcesWithState joins per-user enable + live metadata, including agent/hook/mcp counts', () => {
  writeRegistry([]); seedBuiltinOnce();
  setEnabled('viewer', BUILTIN_ID, true);
  const { sources } = listSourcesWithState('viewer');
  const b = sources.find((s) => s.id === BUILTIN_ID);
  assert.ok(b.enabled);
  assert.equal(b.origin, 'builtin');
  assert.ok(typeof b.skillCount === 'number');
  assert.ok(typeof b.agentCount === 'number');
  assert.ok(typeof b.hookCount === 'number');
  assert.ok(typeof b.mcpCount === 'number');
  // A user who disabled builtin sees enabled=false.
  setEnabled('off', BUILTIN_ID, false);
  const off = listSourcesWithState('off').sources.find((s) => s.id === BUILTIN_ID);
  assert.equal(off.enabled, false);
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
