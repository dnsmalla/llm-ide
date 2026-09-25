// LLM-source update detection + update-and-repair, against REAL git: a bare
// repo in a temp dir plays "origin", sources are clones of it. No network.
//
// Guards: (1) detection says update-available / up-to-date / diverged / local
// / unknown correctly; (2) an update of a shallow clone really moves it (the
// old fetch + `checkout <ref>` left a shallow clone on its old commit); (3) an
// update never throws away local work — uncommitted edits refuse, and Central
// Skills only fast-forwards; (4) the item diff is reported, recorded for the
// New badge, and stale unchecks are pruned; (5) Central Skills as this
// checkout's .skills submodule re-runs the sync script (lock + tool defs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-upd-')));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
// A fake llm-ide checkout whose .skills is the Central Skills clone, with a
// stand-in sync script that records it ran (the real one needs the kit's
// agent-tools families).
const repoRoot = path.join(tmp, 'llm-ide');
process.env.LLMIDE_REPO_ROOT = repoRoot;

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

function skill(dir, name) {
  fs.mkdirSync(path.join(dir, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n# ${name}\n`);
}

// origin: a bare repo seeded from a work tree with skills alpha + beta.
const origin = path.join(tmp, 'origin.git');
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
git(work, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(work, 'registry.yaml'), 'registryVersion: "1.0.0"\n');
skill(work, 'alpha'); skill(work, 'beta');
git(work, 'add', '-A'); git(work, 'commit', '-qm', 'v1');
git(tmp, 'clone', '-q', '--bare', work, origin);
git(work, 'remote', 'add', 'origin', origin);

function pushNewVersion() {
  fs.rmSync(path.join(work, 'skills', 'beta'), { recursive: true });
  skill(work, 'gamma');
  fs.writeFileSync(path.join(work, 'registry.yaml'), 'registryVersion: "1.1.0"\n');
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'v2');
  git(work, 'push', '-q', 'origin', 'main');
}

// A git source: a SHALLOW single-branch clone, exactly as addSource makes one.
const gitSrc = path.join(tmp, 'plugins-sources', 'team');
fs.mkdirSync(path.dirname(gitSrc), { recursive: true });
git(tmp, 'clone', '-q', '--depth', '1', '--single-branch', '--branch', 'main', `file://${origin}`, gitSrc);

// Central Skills: a full clone at <repoRoot>/.skills + a stand-in sync script.
fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
const kit = path.join(repoRoot, '.skills');
git(tmp, 'clone', '-q', origin, kit);
fs.writeFileSync(path.join(repoRoot, 'scripts', 'sync-skills.sh'),
  '#!/usr/bin/env bash\ngit -C "$SKILLS_REPO" rev-parse HEAD > "$(dirname "$0")/../.skills-lock"\n');
process.env.SKILLS_REPO = kit;

const local = path.join(tmp, 'local-src');
fs.mkdirSync(local); skill(local, 'solo');
fs.writeFileSync(path.join(local, 'registry.yaml'), 'registryVersion: "0.1.0"\n');

const reg = await import('../llm-sources/registry.mjs');
const { setItemsEnabled, listDisabledItems } = await import('../llm-sources/state.mjs');
const { writeRegistry, seedBuiltinOnce, readRegistry, checkSourceUpdate, updateSource, getSource, BUILTIN_ID } = reg;

writeRegistry([]);
seedBuiltinOnce();
writeRegistry([
  ...readRegistry(),
  { id: 'team', name: 'team', origin: 'git', location: gitSrc, ref: 'main', builtin: false },
  { id: 'mine', name: 'mine', origin: 'local', location: local, builtin: false },
]);

test('everything is up to date before origin moves; a local folder has no remote', async () => {
  assert.equal((await checkSourceUpdate(getSource('team'))).status, 'up-to-date');
  assert.equal((await checkSourceUpdate(getSource(BUILTIN_ID))).status, 'up-to-date');
  assert.equal((await checkSourceUpdate(getSource('mine'))).status, 'local');
});

test('after origin moves, both git-backed sources report update-available', async () => {
  pushNewVersion();
  const team = await checkSourceUpdate(getSource('team'));
  assert.equal(team.status, 'update-available');
  assert.notEqual(team.localRev, team.remoteRev);
  assert.equal((await checkSourceUpdate(getSource(BUILTIN_ID))).status, 'update-available');
});

test('an update refuses while the clone has uncommitted edits, and changes nothing', async () => {
  const before = git(gitSrc, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(gitSrc, 'skills', 'alpha', 'SKILL.md'), '\nlocal edit\n');
  const r = await updateSource('team');
  assert.equal(r.status, 409);
  assert.match(r.error, /uncommitted/);
  assert.equal(git(gitSrc, 'rev-parse', 'HEAD'), before);
  git(gitSrc, 'checkout', '--', '.');
});

test('updating a shallow git source really moves it and reports the item diff', async () => {
  setItemsEnabled('u1', 'team', 'skill', ['beta', 'alpha'], false);
  const r = await updateSource('team');
  assert.equal(r.ok, true, r.error);
  assert.equal(git(gitSrc, 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'), 'working tree is at origin');
  assert.ok(fs.existsSync(path.join(gitSrc, 'skills', 'gamma')), 'new skill present on disk');
  assert.deepEqual(r.added, [{ kind: 'skill', name: 'gamma' }]);
  assert.deepEqual(r.removed, [{ kind: 'skill', name: 'beta' }]);
  assert.equal(getSource('team').version, '1.1.0');
  assert.deepEqual(getSource('team').lastUpdate.added, ['skill:gamma'], 'drives the New badge');
  assert.deepEqual([...listDisabledItems('u1', 'team')], ['skill:alpha'], 'uncheck of a removed item is pruned');
  assert.equal((await checkSourceUpdate(getSource('team'))).status, 'up-to-date');
});

test('Central Skills fast-forwards and re-runs the sync script when it is the .skills submodule', async () => {
  const r = await updateSource(BUILTIN_ID);
  assert.equal(r.ok, true, r.error);
  assert.equal(git(kit, 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(path.join(repoRoot, '.skills-lock'), 'utf8').trim(), r.toRev, 'lock written');
  assert.ok(r.corrected.some((c) => /skills-lock/.test(c)), `corrected lists the lock: ${r.corrected}`);
});

test('Central Skills with a local-only commit is diverged, and update refuses instead of dropping it', async () => {
  skill(kit, 'mine-only');
  git(kit, 'add', '-A');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'local'], { cwd: kit });
  const localHead = git(kit, 'rev-parse', 'HEAD');
  assert.equal((await checkSourceUpdate(getSource(BUILTIN_ID))).status, 'diverged');
  const r = await updateSource(BUILTIN_ID);
  assert.equal(r.status, 409);
  assert.equal(git(kit, 'rev-parse', 'HEAD'), localHead, 'local commit kept');
});

test('a local folder update is a rescan that reports what changed since the last one', async () => {
  const first = await updateSource('mine');
  assert.equal(first.ok, true, first.error);
  skill(local, 'solo2');
  const r = await updateSource('mine');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.added, [{ kind: 'skill', name: 'solo2' }]);
});

test('a broken remote is "unknown", never an error', async () => {
  git(gitSrc, 'remote', 'set-url', 'origin', path.join(tmp, 'nope.git'));
  const r = await checkSourceUpdate(getSource('team'));
  assert.equal(r.status, 'unknown');
  assert.ok(r.message);
});

test('cleanup', () => { fs.rmSync(tmp, { recursive: true, force: true }); });
