// Tests for llm_agent/default-snapshot.mjs — the llm_default_sources folder
// that materializes everything chat can actually use (skills + agents copied
// from ENABLED sources, hooks discovery catalog, effective MCP servers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'def-snap-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins');
// The snapshot lives in the REPO (committed), not app-support.
process.env.LLMIDE_REPO_ROOT = path.join(tmpRoot, 'repo');

const USER = 'u1';

// Fake builtin skills repo (seeds without the real submodule).
const fakeRepo = path.join(tmpRoot, 'fake-skills');
fs.mkdirSync(path.join(fakeRepo, 'skills', 'code-review'), { recursive: true });
fs.writeFileSync(path.join(fakeRepo, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
fs.writeFileSync(path.join(fakeRepo, 'skills', 'code-review', 'SKILL.md'),
  '---\nname: code-review\ndescription: d\n---\n\n# code-review\n');
process.env.SKILLS_REPO = fakeRepo;

// An extra enabled source: a skill, an agent, a hooks manifest, an MCP manifest.
const extra = path.join(tmpRoot, 'extra-src');
fs.mkdirSync(path.join(extra, 'skills', 'multi'), { recursive: true });
fs.mkdirSync(path.join(extra, 'agents'), { recursive: true });
fs.mkdirSync(path.join(extra, 'hooks'), { recursive: true });
fs.writeFileSync(path.join(extra, 'skills', 'multi', 'SKILL.md'),
  '---\nname: multi\ndescription: m\n---\n\n# multi\n');
fs.writeFileSync(path.join(extra, 'agents', 'helper.md'),
  '---\nname: helper\ndescription: helps\n---\n\nYou are a helper.\n');
fs.writeFileSync(path.join(extra, 'hooks', 'hooks.json'), JSON.stringify({
  PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
}));
fs.writeFileSync(path.join(extra, '.mcp.json'), JSON.stringify({
  mcpServers: { 'never-spawned': { command: 'node', args: ['x.js'] } },
}));

// A source that will stay DISABLED — nothing from it may appear.
const third = path.join(tmpRoot, 'ghost-src');
fs.mkdirSync(path.join(third, 'skills', 'ghost'), { recursive: true });
fs.writeFileSync(path.join(third, 'skills', 'ghost', 'SKILL.md'),
  '---\nname: ghost\ndescription: g\n---\n\n# ghost\n');

const { writeRegistry, BUILTIN_ID, DEFAULT_SOURCES_ID } = await import('../llm-sources/registry.mjs');
const { setEnabled } = await import('../llm-sources/state.mjs');
const { writeMcpRegistry, setConsented, setEnabledMcp } = await import('../mcp/state.mjs');
const { refreshDefaultSnapshot, defaultSnapshotDir } =
  await import('../llm_agent/default-snapshot.mjs');

writeRegistry([
  { id: BUILTIN_ID, name: 'Central Skills', origin: 'builtin', location: fakeRepo, builtin: true },
  { id: 'extra', name: 'Extra', origin: 'local', location: extra, builtin: false },
  { id: 'ghost', name: 'Ghost', origin: 'local', location: third, builtin: false },
]);
setEnabled(USER, BUILTIN_ID, true);
setEnabled(USER, 'extra', true);

// One enabled+consented MCP plugin — this is what chat actually gets.
writeMcpRegistry([{ id: 'fs-server', name: 'FS', command: 'npx', args: ['-y', 'fs-mcp'], builtin: false }]);
// Consent BEFORE enable — the order the state layer enforces (enabling an
// unconsented server is refused, so the reverse order stores nothing).
setConsented(USER, 'fs-server', true);
setEnabledMcp(USER, 'fs-server', true);

test('refreshDefaultSnapshot materializes skills+agents from enabled sources only', () => {
  const summary = refreshDefaultSnapshot(USER);
  const dir = defaultSnapshotDir();

  // Skills: enabled sources copied as real files, FLAT (no per-source
  // subfolder — this folder is itself read back as the `default-sources`
  // llm-source, which expects the same one-level shape every source uses).
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'code-review', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'multi', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'skills', 'ghost')), 'disabled source must be excluded');

  // Agents: real files from enabled sources, flat.
  assert.ok(fs.existsSync(path.join(dir, 'agents', 'helper.md')));

  // Hooks: discovery catalog, clearly stamped as never executed. Standard
  // Claude-Code hook-manifest shape (event name at the TOP level), not a
  // custom {sources: {...}} wrapper — see the regression test below for why.
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
  assert.match(hooks._note, /never execut/i);
  assert.equal(hooks.PreToolUse[0].hooks[0].command, 'echo hi');
  assert.equal(hooks.PreToolUse[0].hooks[0]._source, 'extra');

  // MCP: the EFFECTIVE chat config (enabled+consented plugins) — not the
  // discovery-only source manifests.
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['fs-server'].command, 'npx');
  assert.ok(!mcp.mcpServers['never-spawned'], 'source-manifest MCP must not appear as used');

  // Meta: provenance.
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
  assert.equal(meta.userId, USER);
  assert.equal(meta.counts.skills, 2);
  assert.equal(meta.counts.agents, 1);
  assert.equal(summary.ok, true);
});

test('rebuild removes stale entries when a source is disabled', () => {
  setEnabled(USER, 'extra', false);
  refreshDefaultSnapshot(USER);
  const dir = defaultSnapshotDir();
  assert.ok(!fs.existsSync(path.join(dir, 'skills', 'multi')), 'stale skills must be gone');
  assert.ok(!fs.existsSync(path.join(dir, 'agents', 'helper.md')), 'stale agents must be gone');
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'code-review', 'SKILL.md')),
    'still-enabled source survives');
});

// CONTRACT CHANGE (2026-08-18): this used to assert "nothing enabled → a
// valid EMPTY snapshot" — i.e. the refresh replaced the folder with nothing.
// That exact behavior deleted every committed skill in production the first
// time a user with only default-sources enabled clicked Refresh. A no-input
// refresh now leaves the existing folder alone and reports noSources.
test('user with nothing enabled keeps the previous snapshot untouched (noSources)', () => {
  const dir = defaultSnapshotDir();
  const before = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
  const result = refreshDefaultSnapshot('nobody');
  assert.equal(result.noSources, true);
  assert.equal(result.counts.skills, 0, 'reported counts describe the aborted rebuild, not the kept folder');
  const after = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
  assert.deepEqual(after, before, 'the folder on disk must be byte-identical to before the no-input refresh');
});

// ── Review-fix behaviors ────────────────────────────────────────────────────

test('runtime-family skills are included alongside skills-family', () => {
  fs.mkdirSync(path.join(extra, 'runtime', 'late-skill'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'runtime', 'late-skill', 'SKILL.md'),
    '---\nname: late-skill\ndescription: r\n---\n\n# late\n');
  setEnabled(USER, 'extra', true);
  refreshDefaultSnapshot(USER);
  assert.ok(fs.existsSync(path.join(defaultSnapshotDir(), 'skills', 'late-skill', 'SKILL.md')),
    'runtime/ family skill must be copied too');
  fs.rmSync(path.join(extra, 'runtime'), { recursive: true, force: true });
});

test('same skill name in skills/ and runtime/ keeps skills-family, records the drop', () => {
  fs.mkdirSync(path.join(extra, 'runtime', 'multi'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'runtime', 'multi', 'SKILL.md'),
    '---\nname: multi\ndescription: runtime copy\n---\n\n# multi (runtime)\n');
  setEnabled(USER, 'extra', true);
  refreshDefaultSnapshot(USER);
  const copied = fs.readFileSync(path.join(defaultSnapshotDir(), 'skills', 'multi', 'SKILL.md'), 'utf8');
  assert.match(copied, /description: m\n/, 'skills-family copy must win');
  const meta = JSON.parse(fs.readFileSync(path.join(defaultSnapshotDir(), '_meta.json'), 'utf8'));
  assert.ok(meta.skipped.some((s) => s.source === 'extra' && s.skill === 'multi'
    && /runtime-family duplicate/.test(s.reason)));
  fs.rmSync(path.join(extra, 'runtime'), { recursive: true, force: true });
});

test('over-budget skills are skipped and recorded, not copied', () => {
  // Big file under a skill dir; tiny limits force the skip.
  const big = path.join(extra, 'skills', 'multi', 'blob.bin');
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024)); // 1 MiB
  setEnabled(USER, 'extra', true);
  const r = refreshDefaultSnapshot(USER, { maxSkillBytes: 1024, maxSkillFiles: 100, maxTotalBytes: 1024 * 1024 });
  assert.ok(!fs.existsSync(path.join(defaultSnapshotDir(), 'skills', 'multi', 'blob.bin')),
    'over-budget skill content must not be copied');
  const meta = JSON.parse(fs.readFileSync(path.join(defaultSnapshotDir(), '_meta.json'), 'utf8'));
  assert.ok(meta.skipped.some((s) => s.skill === 'multi' && /size budget/.test(s.reason)));
  // Only builtin's tiny code-review skill survives the tiny budgets.
  assert.equal(r.counts.skills, 1);
  fs.rmSync(big, { force: true });
});

test('a source with a missing location is skipped without throwing', () => {
  writeRegistry([
    { id: BUILTIN_ID, name: 'Central Skills', origin: 'builtin', location: fakeRepo, builtin: true },
    { id: 'gone', name: 'Gone', origin: 'local', location: path.join(tmpRoot, 'does-not-exist'), builtin: false },
  ]);
  refreshDefaultSnapshot(USER); // must not throw
  assert.ok(!fs.existsSync(path.join(defaultSnapshotDir(), 'skills', 'gone')));
});

test('cross-source duplicate skill names are deduplicated (first enabled source wins)', () => {
  const other = path.join(tmpRoot, 'other-src');
  fs.mkdirSync(path.join(other, 'skills', 'multi'), { recursive: true });
  fs.writeFileSync(path.join(other, 'skills', 'multi', 'SKILL.md'),
    '---\nname: multi\ndescription: other copy\n---\n\n# multi (other)\n');
  writeRegistry([
    { id: BUILTIN_ID, name: 'Central Skills', origin: 'builtin', location: fakeRepo, builtin: true },
    { id: 'extra', name: 'Extra', origin: 'local', location: extra, builtin: false },
    { id: 'other', name: 'Other', origin: 'local', location: other, builtin: false },
  ]);
  setEnabled(USER, 'extra', true);
  setEnabled(USER, 'other', true);
  refreshDefaultSnapshot(USER);
  const dir = defaultSnapshotDir();
  assert.equal(dir, path.join(tmpRoot, 'repo', 'llm_default_sources'), 'repo location');
  const copy = fs.readFileSync(path.join(dir, 'skills', 'multi', 'SKILL.md'), 'utf8');
  assert.match(copy, /description: m\n/, 'earlier source in registry order wins');
  assert.ok(!fs.existsSync(path.join(dir, 'skills', 'other')), 'duplicate copy dropped, no other-sourced folder at all');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
  assert.ok(meta.skipped.some((x) => x.source === 'other' && x.skill === 'multi'));
});

test('legacy app-support snapshot location is retired after a refresh', () => {
  const legacy = path.join(tmpRoot, 'llm-sources', 'llm_default_sources');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'stale.txt'), 'x');
  setEnabled(USER, BUILTIN_ID, true);
  refreshDefaultSnapshot(USER);
  assert.ok(!fs.existsSync(legacy), 'old app-support copy must be removed');
});

test('MCP plugin env vars are carried into the snapshot .mcp.json', () => {
  writeMcpRegistry([{ id: 'env-server', name: 'Env', command: 'node', args: ['e.js'],
    env: { TOKEN: 'secret' }, builtin: false }]);
  setConsented(USER, 'env-server', true);
  setEnabledMcp(USER, 'env-server', true);
  setEnabled(USER, BUILTIN_ID, true);
  refreshDefaultSnapshot(USER);
  const mcp = JSON.parse(fs.readFileSync(path.join(defaultSnapshotDir(), '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['env-server'].env.TOKEN, 'secret');
});

// Regression: a brand-new user (enabled only in default-sources, per
// state.mjs listEnabled's fallback) must see the skills that were snapshotted
// into their own `default-sources` folder. Before the flat-layout fix,
// default-sources's own location was read back by listSkillLibrary with the
// SAME one-level expectation every other source uses, but the snapshot wrote
// a per-source-id subfolder — so this always came back empty regardless of
// what had been copied in. Exercise the real reader, not just the writer.
test('the default-sources folder itself is readable by listSkillLibrary (fresh-user path)', async () => {
  writeRegistry([
    { id: BUILTIN_ID, name: 'Central Skills', origin: 'builtin', location: fakeRepo, builtin: true },
  ]);
  setEnabled(USER, BUILTIN_ID, true);
  refreshDefaultSnapshot(USER);

  const { listSkillLibrary, _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
  writeRegistry([
    { id: DEFAULT_SOURCES_ID, name: 'Default Sources', origin: 'local', location: defaultSnapshotDir(), builtin: true },
  ]);
  _resetSkillLibraryCache();
  // A never-before-seen userId: listEnabled() falls back to {default-sources}
  // with no explicit setEnabled call, mirroring a truly fresh install.
  const { skills } = listSkillLibrary('never-configured-fresh-user');
  assert.ok(skills.some((s) => s.id === 'skills/code-review'),
    'default-sources must surface the already-snapshotted code-review skill to a fresh user');
});

// ── Curated fundamental-skills set + self-reference guard + commands catalog ──

test('BUILTIN_ID is filtered to the curated core set; other sources ship unfiltered', () => {
  // fakeRepo (BUILTIN_ID) has one core skill ('code-review') plus a
  // non-core one ('not-core-at-all') added here. 'extra' (a plain
  // user-added source) keeps its own skill regardless of the allowlist.
  fs.mkdirSync(path.join(fakeRepo, 'skills', 'not-core-at-all'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'skills', 'not-core-at-all', 'SKILL.md'),
    '---\nname: not-core-at-all\ndescription: n\n---\n\n# not-core-at-all\n');
  writeRegistry([
    { id: BUILTIN_ID, name: 'Central Skills', origin: 'builtin', location: fakeRepo, builtin: true },
    { id: 'extra', name: 'Extra', origin: 'local', location: extra, builtin: false },
  ]);
  setEnabled(USER, BUILTIN_ID, true);
  setEnabled(USER, 'extra', true);
  const summary = refreshDefaultSnapshot(USER);
  const dir = defaultSnapshotDir();

  assert.ok(fs.existsSync(path.join(dir, 'skills', 'code-review')), 'core builtin skill ships');
  assert.ok(!fs.existsSync(path.join(dir, 'skills', 'not-core-at-all')),
    'non-core builtin skill must be filtered out');
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'multi')),
    'a user-added source is NOT filtered by the builtin curation allowlist');
  assert.ok(summary.skipped.some((s) => s.source === BUILTIN_ID && s.skill === 'not-core-at-all'
    && /curated fundamental-skills set/.test(s.reason)));

  fs.rmSync(path.join(fakeRepo, 'skills', 'not-core-at-all'), { recursive: true, force: true });
});

test('default-sources is never read as an input source (self-reference guard)', () => {
  // Simulate a PRIOR refresh's output containing a skill that no longer
  // exists in any currently-enabled source (as if it were removed upstream
  // or dropped by a curation-list change). If default-sources were read as
  // an ordinary source, this stale entry would win the "first source wins"
  // dedup (it's seeded before BUILTIN_ID) and persist forever.
  const dir = defaultSnapshotDir();
  fs.mkdirSync(path.join(dir, 'skills', 'long-gone'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'long-gone', 'SKILL.md'),
    '---\nname: long-gone\ndescription: stale\n---\n\n# stale\n');

  writeRegistry([
    { id: DEFAULT_SOURCES_ID, name: 'Default Sources', origin: 'local', location: dir, builtin: true },
    { id: BUILTIN_ID, name: 'Central Skills', origin: 'builtin', location: fakeRepo, builtin: true },
  ]);
  setEnabled(USER, DEFAULT_SOURCES_ID, true);
  setEnabled(USER, BUILTIN_ID, true);
  refreshDefaultSnapshot(USER);

  assert.ok(!fs.existsSync(path.join(dir, 'skills', 'long-gone')),
    'a stale self-referenced entry must not survive a refresh');
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'code-review')),
    'builtin still contributes normally');
});

test('commands/commands.json is always written, independent of enabled sources', () => {
  writeRegistry([]);
  refreshDefaultSnapshot('nobody-with-nothing-enabled');
  const dir = defaultSnapshotDir();
  const commandsFile = JSON.parse(fs.readFileSync(path.join(dir, 'commands', 'commands.json'), 'utf8'));
  assert.match(commandsFile._note, /not sourced from any registered llm-source/i);
  const names = commandsFile.commands.map((c) => c.name);
  assert.ok(names.includes('/clear'));
  assert.ok(names.includes('/compact'));
  assert.ok(names.includes('/help'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
  assert.equal(meta.counts.commands, commandsFile.commands.length);
});

// Regression: default-sources' own hookCount/hooks list — as shown by the
// Mac app's Library "Default Sources" row via GET /auth/me/llm-sources/
// <id>/discovery — must reflect real cataloged hooks. Before this fix, the
// snapshot's hooks.json used a custom {sources: {...}} wrapper that
// listDiscoveryHooks (the SAME generic reader every other source's hookCount
// goes through) cannot parse, since it only recognizes event-name keys
// mapped to arrays at the TOP level — so "Default Sources" always showed 0
// hooks, no matter what was actually cataloged behind it.
test('default-sources own hooks.json is readable by the generic per-source hook reader', async () => {
  writeRegistry([
    { id: 'extra', name: 'Extra', origin: 'local', location: extra, builtin: false },
  ]);
  setEnabled(USER, 'extra', true);
  refreshDefaultSnapshot(USER);

  const { listDiscoveryHooks, countDiscoveryHooks } = await import('../llm-sources/registry.mjs');
  const found = listDiscoveryHooks(defaultSnapshotDir());
  assert.equal(found.length, 1, 'the generic reader must find the real hook cataloged in this folder');
  assert.equal(found[0].event, 'PreToolUse');
  assert.equal(found[0].command, 'echo hi');
  assert.equal(countDiscoveryHooks(defaultSnapshotDir()), 1);
});

// The event VOCABULARY is a reference catalog, so it must live in its own
// file: hooks.json is read by the generic hook reader, which treats every
// array-valued key as an event with declared hooks behind it — an events list
// in there would be counted as real hooks and inflate every hookCount.
test('the hook event catalog is written beside hooks.json without inflating the hook count', async () => {
  writeRegistry([
    { id: 'extra', name: 'Extra', origin: 'local', location: extra, builtin: false },
  ]);
  setEnabled(USER, 'extra', true);
  const res = refreshDefaultSnapshot(USER);

  const { CLAUDE_CODE_HOOK_EVENTS } = await import('../llm_agent/claude-code-hooks.mjs');
  const events = JSON.parse(fs.readFileSync(path.join(defaultSnapshotDir(), 'hooks', 'events.json'), 'utf8'));
  assert.equal(events.events.length, CLAUDE_CODE_HOOK_EVENTS.length);
  assert.ok(events.events.some((e) => e.name === 'PreToolUse'));
  assert.ok(events.events.some((e) => e.name === 'SessionStart'));
  assert.equal(res.counts.hookEvents, CLAUDE_CODE_HOOK_EVENTS.length);

  // The declared-hook count is unchanged by the catalog's presence.
  const { countDiscoveryHooks } = await import('../llm-sources/registry.mjs');
  assert.equal(countDiscoveryHooks(defaultSnapshotDir()), 1, 'events.json must not read as declared hooks');
  assert.equal(res.counts.hooks, 1);
});

// Regression: a user whose only enabled source is default-sources itself has
// ZERO input sources (the folder is output, never input). A refresh used to
// rebuild anyway and swap in an EMPTY snapshot — silently deleting every
// committed skill from llm_default_sources/ (observed live 2026-08-18:
// _meta.json "sources": 0 and all SKILL.md files gone after one Refresh
// click). With no inputs the refresh must keep the existing folder untouched
// and say so, instead of wiping it.
test('refresh with zero enabled input sources keeps the existing snapshot and reports noSources', () => {
  writeRegistry([
    { id: DEFAULT_SOURCES_ID, name: 'Default Sources', origin: 'local',
      location: defaultSnapshotDir(), builtin: true },
    { id: 'extra', name: 'Extra', origin: 'local', location: extra, builtin: false },
  ]);
  const emptyUser = 'u-empty';
  setEnabled(emptyUser, DEFAULT_SOURCES_ID, true); // enabled set = [default-sources] only

  const dir = defaultSnapshotDir();
  fs.mkdirSync(path.join(dir, 'skills', 'committed-marker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'committed-marker', 'SKILL.md'),
    '---\nname: committed-marker\ndescription: c\n---\n');

  const result = refreshDefaultSnapshot(emptyUser);
  assert.equal(result.ok, true);
  assert.equal(result.noSources, true);
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'committed-marker', 'SKILL.md')),
    'a no-input refresh must never wipe the existing snapshot');
});
