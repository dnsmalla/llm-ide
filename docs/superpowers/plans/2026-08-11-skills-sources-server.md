# Skills Sources (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side "skills source" registry (multi-repo, read-in-place, discovery-only) so each skills repo is independently managed, and generalize the chat "/" menu catalog to draw from all enabled sources.

**Architecture:** A new `extension/skills-sources/` module (registry + per-user state) sits beside `extension/plugins/`. The registry seeds one `builtin` source pointing at the resolved `.skills` checkout; additional sources are cloned from Git URLs into a managed dir. `listSkillLibrary()` is generalized to iterate **enabled** sources (per-user) instead of one hard-coded repo, tagging each skill with its source. Five `/auth/me/skills-sources/*` HTTP endpoints expose list/toggle/add/update/remove. The agent *loading* path (`/kb/agent/catalog`) and the external-CLI project flow are untouched.

**Tech Stack:** Node 20+ ESM, pure HTTP (no framework), `node:test`, `js-yaml`. Mirrors the conventions of `extension/plugins/{state,installer}.mjs` and `extension/server/auth-routes.mjs`.

## Global Constraints

- Server binds 127.0.0.1 only; no remote bind unless `LLMIDE_ALLOW_REMOTE=1`.
- Every state-mutating helper is atomic (tmp file + rename) — mirror `extension/plugins/state.mjs`.
- Every `/auth/me/skills-sources/*` write is admin-gated (`requireAdmin`) and audited via `safeAudit` with `action: 'skills-source.*'`.
- Git URLs are hardened: reject `file://`, `ssh://`, localhost/`.local`, non-https; shallow clone with `--` arg guard and `GIT_TERMINAL_PROMPT=0` — mirror `mac/Sources/LlmIdeMac/Services/PluginGitInstaller.swift` `normalize()` rules.
- The `builtin` source cannot be removed or renamed.
- Only the `builtin` source may contribute agent-*loadable* tools; third-party sources are discovery-only (chat "/" menu).
- Bump `SERVER_API_VERSION` 25 → 26 and add the five new paths to `ENDPOINTS` in `extension/server.mjs`.
- Conventional Commits, one concern per commit, e.g. `feat(skills-sources): ...`.

## File Structure

- **Create** `extension/skills-sources/state.mjs` — per-user enable state (mirror of `extension/plugins/state.mjs`).
- **Create** `extension/skills-sources/registry.mjs` — registry CRUD, validity check, builtin seeding, hardened git clone, add/update/remove, skill counting, `listSourcesWithState(userId)`.
- **Modify** `extension/llm_agent/skills/skill-library.mjs` — `listSkillLibrary(userId)` iterates enabled sources; each skill gains `sourceId` + `sourceName`; backward-compatible `{ repo, skills }` shape preserved.
- **Modify** `extension/kb/routes/agent.mjs` — pass `userId` into `listSkillLibrary(userId)` at the `/kb/agent/skill-library` handler.
- **Modify** `extension/server/auth-routes.mjs` — five new endpoints (mirror the plugin handlers at `:757-892`).
- **Modify** `extension/server.mjs` — add five paths to `ENDPOINTS`; bump `SERVER_API_VERSION` to 26.
- **Create** `extension/tests/skills-sources-state.test.mjs`, `extension/tests/skills-sources-registry.test.mjs`; **modify** `extension/tests/skill-library.test.mjs`.

---

### Task 1: Per-user enable state module

**Files:**
- Create: `extension/skills-sources/state.mjs`
- Test: `extension/tests/skills-sources-state.test.mjs`

**Interfaces:**
- Produces: `listEnabled(userId) → Set<string>`, `setEnabled(userId, sourceId, enabled) → Set<string>`, `pruneOrphans(installedIds: Set<string>) → void`, `STATE_FILE` (path, for tests).

- [ ] **Step 1: Write the failing test**

Create `extension/tests/skills-sources-state.test.mjs`:

```js
// Per-user enable state for skills sources — mirrors plugins/state.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

// Point the state file at an isolated temp dir for this process.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-state-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins'); // defaultSourcesDir derives from this

const { listEnabled, setEnabled, pruneOrphans } =
  await import('../skills-sources/state.mjs');

test('first-time user has an empty enable set', () => {
  assert.deepEqual([...listEnabled('user-1')], []);
});

test('setEnabled toggles and persists per user', () => {
  setEnabled('user-1', 'builtin', true);
  setEnabled('user-1', 'my-repo', true);
  assert.deepEqual([...listEnabled('user-1')].sort(), ['builtin', 'my-repo']);
  setEnabled('user-1', 'my-repo', false);
  assert.deepEqual([...listEnabled('user-1')], ['builtin']);
  // Isolated per user.
  assert.deepEqual([...listEnabled('user-2')], []);
});

test('pruneOrphans drops entries for unregistered sources', () => {
  setEnabled('user-1', 'stale', true);
  pruneOrphans(new Set(['builtin'])); // only builtin still registered
  assert.deepEqual([...listEnabled('user-1')], ['builtin']);
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/skills-sources-state.test.mjs`
Expected: FAIL — module `../skills-sources/state.mjs` not found.

- [ ] **Step 3: Write minimal implementation**

Create `extension/skills-sources/state.mjs`, mirroring `extension/plugins/state.mjs` but with its own state file name:

```js
// Per-user skills-source enable state.
//
// Stored as a single JSON file next to the skills-sources directory so it
// survives source add/remove and is trivial to back up by hand. Keyed by
// userId so one server process can serve multiple authenticated users with
// different enabled sets. Writes are atomic (tmp + rename).
//
// File: <sourcesDir>/../skills-sources-state.json
// Shape: { [userId]: { enabled: string[] } }

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultSourcesDir } from './registry.mjs';

function stateFilePath() {
  return join(dirname(defaultSourcesDir()), 'skills-sources-state.json');
}

function readAll() {
  const path = stateFilePath();
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch { return {}; }
}

function writeAll(state) {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function listEnabled(userId) {
  if (!userId) return new Set();
  const all = readAll();
  const arr = all[userId]?.enabled;
  return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []);
}

export function setEnabled(userId, sourceId, enabled) {
  if (!userId || typeof sourceId !== 'string') return new Set();
  const all = readAll();
  const cur = new Set(all[userId]?.enabled || []);
  if (enabled) cur.add(sourceId);
  else cur.delete(sourceId);
  all[userId] = { enabled: [...cur].sort() };
  writeAll(all);
  return cur;
}

export function pruneOrphans(installedIds) {
  const all = readAll();
  let touched = false;
  for (const [userId, entry] of Object.entries(all)) {
    if (!entry || !Array.isArray(entry.enabled)) continue;
    const filtered = entry.enabled.filter((n) => installedIds.has(n));
    if (filtered.length !== entry.enabled.length) {
      all[userId] = { enabled: filtered };
      touched = true;
    }
    if (filtered.length === 0) { delete all[userId]; touched = true; }
  }
  if (touched) writeAll(all);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/skills-sources-state.test.mjs`
Expected: PASS (4 tests). Note: `state.mjs` imports `defaultSourcesDir` from `./registry.mjs`, which is created in Task 2 — so this test will only pass after Task 2 exists. To keep Task 1 independently testable, create a **minimal stub** `extension/skills-sources/registry.mjs` containing only:

```js
import { homedir } from 'node:os';
import { join } from 'node:path';
// Managed dir for cloned skills sources (siblings to plugins/).
export function defaultSourcesDir() {
  const base = process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
  return join(dirnameOf(base), 'skills-sources');
}
function dirnameOf(p) { return p.split('/').slice(0, -1).join('/') || '/'; }
```
(This stub is replaced by the full `registry.mjs` in Task 2; its `defaultSourcesDir` stays identical so the state module keeps working.)

- [ ] **Step 5: Commit**

```bash
git add extension/skills-sources/state.mjs extension/skills-sources/registry.mjs extension/tests/skills-sources-state.test.mjs
git commit -m "feat(skills-sources): per-user enable state module"
```

---

### Task 2: Registry core — load/save, validity, builtin seed, list/get

**Files:**
- Modify: `extension/skills-sources/registry.mjs` (replace the stub)
- Test: `extension/tests/skills-sources-registry.test.mjs`

**Interfaces:**
- Produces: `defaultSourcesDir() → string`, `readRegistry() → SkillsSource[]`, `writeRegistry(list) → void`, `isValidSkillsSource(dir) → boolean`, `seedBuiltinOnce() → void`, `listSources() → SkillsSource[]`, `getSource(id) → SkillsSource|null`, `BUILTIN_ID = 'builtin'`.
- Consumes: `resolveCentralSkillsRepo` from `../llm_agent/skills/skill-library.mjs`.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/skills-sources-registry.test.mjs`:

```js
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

const { readRegistry, writeRegistry, isValidSkillsSource, seedBuiltinOnce,
  listSources, getSource, BUILTIN_ID, countDiscoverySkills } =
  await import('../skills-sources/registry.mjs');

test('isValidSkillsSource accepts registry.yaml or plugin.json+skills/', () => {
  assert.ok(isValidSkillsSource(fakeRepo));
  const cp = path.join(tmpRoot, 'cp');
  fs.mkdirSync(path.join(cp, 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(cp, '.claude-plugin', 'plugin.json'), '{}'); // needs .claude-plugin + skills
  fs.mkdirSync(path.join(cp, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(cp, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
  assert.ok(isValidSkillsSource(cp));
  assert.ok(!isValidSkillsSource(tmpRoot)); // no markers
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

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/skills-sources-registry.test.mjs`
Expected: FAIL — the named exports don't exist on the stub.

- [ ] **Step 3: Write minimal implementation**

Replace `extension/skills-sources/registry.mjs` with the full core (clone/add/update/remove come in Task 3; add a placeholder guard so the file is valid without them):

```js
// Skills-source registry: a list of registered skills repos (builtin .skills +
// user-added git clones / local paths). Discovery-only, read in place — never
// copied into plugins/. The builtin source points at resolveCentralSkillsRepo().
//
// Registry file: <sourcesDir>/../skills-sources.json  (atomic writes)
// Cloned sources: <sourcesDir>/<id>/  (siblings to plugins/)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { resolveCentralSkillsRepo } from '../llm_agent/skills/skill-library.mjs';

export const BUILTIN_ID = 'builtin';
const LIBRARY_FAMILIES = ['skills', 'runtime'];

export function defaultSourcesDir() {
  const pluginDir = process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
  return join(dirname(pluginDir), 'skills-sources');
}

function registryFilePath() {
  return join(dirname(defaultSourcesDir()), 'skills-sources.json');
}

export function readRegistry() {
  const p = registryFilePath();
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data?.sources) ? data.sources.filter((s) => s && typeof s === 'object') : [];
  } catch { return []; }
}

export function writeRegistry(list) {
  const p = registryFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sources: list }, null, 2), 'utf8');
  renameSync(tmp, p);
}

// A directory is a valid skills source if it has registry.yaml OR
// (.claude-plugin/plugin.json + a skills/ directory).
export function isValidSkillsSource(dir) {
  try {
    if (!existsSync(dir)) return false;
    if (existsSync(join(dir, 'registry.yaml'))) return true;
    return existsSync(join(dir, '.claude-plugin', 'plugin.json')) && existsSync(join(dir, 'skills'));
  } catch { return false; }
}

// Read version string from registry.yaml or .claude-plugin/plugin.json, if present.
function readVersion(dir) {
  try {
    if (existsSync(join(dir, 'registry.yaml'))) {
      const raw = readFileSync(join(dir, 'registry.yaml'), 'utf8');
      const m = raw.match(/^registryVersion:\s*"?([^"\n]+)"?/m);
      if (m) return m[1].trim();
    }
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
      const j = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (typeof j.version === 'string') return j.version;
    }
  } catch { /* best-effort */ }
  return undefined;
}

export function countDiscoverySkills(dir) {
  let n = 0;
  for (const fam of LIBRARY_FAMILIES) {
    const d = join(dir, fam);
    if (!existsSync(d)) continue;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(d, e.name, 'SKILL.md'))) n += 1;
    }
  }
  return n;
}

// Ensure the builtin source exists, pointing at the resolved central repo.
// Idempotent. Does NOT throw if the repo isn't present locally — records the
// source with location = null so the UI can offer "Install".
export function seedBuiltinOnce() {
  const list = readRegistry();
  if (list.some((s) => s.id === BUILTIN_ID)) return;
  const repo = resolveCentralSkillsRepo();
  list.push({
    id: BUILTIN_ID,
    name: 'Central Skills',
    origin: 'builtin',
    location: repo || null,
    builtin: true,
    version: repo ? readVersion(repo) : undefined,
  });
  writeRegistry(list);
}

export function getSource(id) {
  return readRegistry().find((s) => s.id === id) || null;
}

export function listSources() {
  return readRegistry();
}

// Re-read live metadata (existence + skill count + version) for a snapshot.
export function snapshotSource(src) {
  const exists = !!src.location && existsSync(src.location);
  return {
    ...src,
    installed: exists,
    version: exists ? readVersion(src.location) : src.version,
    skillCount: exists ? countDiscoverySkills(src.location) : 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/skills-sources-registry.test.mjs`
Expected: PASS (5 tests). Re-run Task 1's test too: `node --test tests/skills-sources-state.test.mjs` — still PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/skills-sources/registry.mjs extension/tests/skills-sources-registry.test.mjs
git commit -m "feat(skills-sources): registry core — load/save, validity, builtin seed"
```

---

### Task 3: Registry — hardened git clone + add / update / remove

**Files:**
- Modify: `extension/skills-sources/registry.mjs` (append functions)
- Test: `extension/tests/skills-sources-registry.test.mjs` (append tests)

**Interfaces:**
- Produces: `normalizeGitUrl(raw) → {ok, url, error?}`, `addSource({url?, path?, ref?, name?}) → {source} | {error, status}`, `updateSource(id) → {ok} | {error, status}`, `removeSource(id) → {ok} | {error, status}`, `syncBuiltin() → {ok, installed: boolean}`.
- Consumes: `spawnSync` from `node:child_process`; `isValidSkillsSource`, `readRegistry`, `writeRegistry`, `defaultSourcesDir`, `BUILTIN_ID` from this module.

- [ ] **Step 1: Write the failing test (append to the registry test file)**

Append before the `cleanup` test:

```js
import { normalizeGitUrl, addSource, removeSource, updateSource, syncBuiltin } from '../skills-sources/registry.mjs';

test('normalizeGitUrl rejects unsafe schemes and localhost, accepts https', () => {
  assert.ok(normalizeGitUrl('https://github.com/o/r.git').ok);
  assert.ok(normalizeGitUrl('https://github.com/o/r').ok);
  assert.ok(!normalizeGitUrl('file:///etc/passwd').ok);
  assert.ok(!normalizeGitUrl('ssh://git@host/o/r').ok);
  assert.ok(!normalizeGitUrl('http://127.0.0.1/x').ok);
  assert.ok(!normalizeGitUrl('http://example.local/x').ok);
  assert.ok(!normalizeGitUrl('not a url').ok);
});

test('addSource rejects a non-valid directory at a local path', () => {
  const res = addSource({ path: tmpRoot }); // no markers
  assert.ok(!res.source, 'no source created');
  assert.ok(res.error);
  assert.equal(res.status, 400);
});

test('addSource registers a local valid source and removeSource deletes it', () => {
  const res = addSource({ path: fakeRepo, name: 'fake-local' });
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
```

(Move the existing `test('cleanup', ...)` to the very end so these run before cleanup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/skills-sources-registry.test.mjs`
Expected: FAIL — `normalizeGitUrl`/`addSource`/`removeSource` not exported.

- [ ] **Step 3: Write minimal implementation (append to registry.mjs)**

```js
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function normalizeGitUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'url is required' };
  const u = raw.trim();
  // Reject non-https schemes and local hosts (mirror PluginGitInstaller.normalize).
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(u)) {
    if (/^(file|ssh|git|ftp|http):/i.test(u) || /\/\/(localhost|127\.0\.0\.1|\.local)\b/i.test(u)) {
      return { ok: false, error: 'only public https URLs are allowed' };
    }
    return { ok: false, error: 'url must be a public https git URL' };
  }
  if (/\/\/(localhost|127\.0\.0\.1|[^/]*\.local)\b/i.test(u)) {
    return { ok: false, error: 'localhost/.local hosts are not allowed' };
  }
  return { ok: true, url: u };
}

function slugify(name, existing) {
  let base = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `s-${base}`;
  base = base.slice(0, 40);
  if (!SLUG_RE.test(base)) base = `source-${Date.now().toString(36)}`;
  let id = base, i = 2;
  while (existing.has(id)) { id = `${base}-${i++}`; }
  return id;
}

// Shallow clone into <sourcesDir>/<id>. Hardened: -- guard, no prompts, detached stdin.
function cloneShallow(url, ref, dest) {
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (ref) args.push('--branch', ref);
  args.push('--', url, dest);
  const r = spawnSync('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  if (!r.stdout) r.stdout = Buffer.alloc(0);
  if (r.status !== 0) {
    const err = (r.stderr ? r.stderr.toString() : '').slice(0, 200) || 'git clone failed';
    return { error: err };
  }
  return { ok: true };
}

export function addSource({ url, path, ref, name } = {}) {
  const list = readRegistry();
  const existing = new Set(list.map((s) => s.id));

  if (path) {
    if (!existsSync(path)) return { error: 'path does not exist', status: 400 };
    if (!isValidSkillsSource(path)) return { error: 'not a valid skills source (needs registry.yaml or .claude-plugin/plugin.json + skills/)', status: 400 };
    const id = slugify(name || path.split('/').pop(), existing);
    const src = { id, name: name || id, origin: 'local', location: path, builtin: false, version: readVersion(path) };
    list.push(src); writeRegistry(list);
    return { source: src };
  }

  if (url) {
    const n = normalizeGitUrl(url);
    if (!n.ok) return { error: n.error, status: 400 };
    const id = slugify(name || n.url.replace(/\.git$/, '').split('/').pop(), existing);
    const dest = join(defaultSourcesDir(), id);
    mkdirSync(defaultSourcesDir(), { recursive: true });
    const cl = cloneShallow(n.url, ref, dest);
    if (cl.error) { try { rmSync(dest, { recursive: true, force: true }); } catch { /* */ } return { error: cl.error, status: 400 }; }
    if (!isValidSkillsSource(dest)) { rmSync(dest, { recursive: true, force: true }); return { error: 'cloned repo is not a valid skills source', status: 400 }; }
    const src = { id, name: name || id, origin: 'git', location: dest, ref: ref || 'main', builtin: false, version: readVersion(dest) };
    list.push(src); writeRegistry(list);
    return { source: src };
  }

  return { error: 'provide either url or path', status: 400 };
}

export function updateSource(id) {
  const list = readRegistry();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return { error: 'source not found', status: 404 };
  const src = list[idx];
  if (src.origin === 'builtin') return syncBuiltin();
  if (!src.location || !existsSync(src.location)) return { error: 'source directory missing', status: 400 };
  if (src.origin === 'local') {
    // Read in place — just refresh version.
    list[idx].version = readVersion(src.location);
    writeRegistry(list);
    return { ok: true };
  }
  // git: fetch + checkout tracked ref.
  const ref = src.ref || 'main';
  let r = spawnSync('git', ['fetch', '--depth', '1', 'origin', ref], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: src.location,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  if (r.status !== 0) return { error: 'git fetch failed', status: 400 };
  r = spawnSync('git', ['checkout', ref], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: src.location,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  if (r.status !== 0) return { error: 'git checkout failed', status: 400 };
  list[idx].version = readVersion(src.location);
  writeRegistry(list);
  return { ok: true };
}

export function removeSource(id) {
  if (id === BUILTIN_ID) return { error: 'builtin source cannot be removed', status: 400 };
  const list = readRegistry();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return { error: 'source not found', status: 404 };
  const src = list[idx];
  if (src.origin === 'git' && src.location && existsSync(src.location)) {
    try { rmSync(src.location, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  list.splice(idx, 1);
  writeRegistry(list);
  return { ok: true };
}

// Builtin update = ensure the .skills submodule is checked out at its pin.
export function syncBuiltin() {
  const repoRoot = join(dirname(defaultSourcesDir()), '..', '..'); // best-effort; server may override
  const r = spawnSync('git', ['submodule', 'update', '--init', '.skills'], {
    cwd: process.env.LLMIDE_REPO_ROOT || repoRoot,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  });
  const installed = r.status === 0;
  // Refresh the builtin location/version regardless.
  const list = readRegistry();
  const idx = list.findIndex((s) => s.id === BUILTIN_ID);
  const resolved = resolveCentralSkillsRepo();
  if (idx >= 0) {
    list[idx].location = resolved || list[idx].location;
    if (resolved) list[idx].version = readVersion(resolved);
    writeRegistry(list);
  }
  return { ok: true, installed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/skills-sources-registry.test.mjs`
Expected: PASS (all, including the 3 new ones). (The git clone path itself isn't unit-tested without network; it's covered by the URL-normalization tests + a manual smoke in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add extension/skills-sources/registry.mjs extension/tests/skills-sources-registry.test.mjs
git commit -m "feat(skills-sources): hardened git clone + add/update/remove"
```

---

### Task 4: Registry — `listSourcesWithState(userId)` joined view

**Files:**
- Modify: `extension/skills-sources/registry.mjs` (append)
- Test: `extension/tests/skills-sources-registry.test.mjs` (append)

**Interfaces:**
- Produces: `listSourcesWithState(userId) → { sources: Array<SkillsSource & {enabled, installed, skillCount}> }`.
- Consumes: `listEnabled` from `./state.mjs`, `snapshotSource`/`listSources` from this module.

- [ ] **Step 1: Write the failing test (append)**

```js
import { listSourcesWithState } from '../skills-sources/registry.mjs';
import { setEnabled } from '../skills-sources/state.mjs';

test('listSourcesWithState joins per-user enable + live metadata', () => {
  writeRegistry([]); seedBuiltinOnce();
  setEnabled('viewer', BUILTIN_ID, true);
  const { sources } = listSourcesWithState('viewer');
  const b = sources.find((s) => s.id === BUILTIN_ID);
  assert.ok(b.enabled);
  assert.equal(b.origin, 'builtin');
  assert.ok(typeof b.skillCount === 'number');
  // A user who disabled builtin sees enabled=false.
  setEnabled('off', BUILTIN_ID, false);
  const off = listSourcesWithState('off').sources.find((s) => s.id === BUILTIN_ID);
  assert.equal(off.enabled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/skills-sources-registry.test.mjs`
Expected: FAIL — `listSourcesWithState` not exported.

- [ ] **Step 3: Write minimal implementation (append to registry.mjs)**

```js
import { listEnabled } from './state.mjs';

export function listSourcesWithState(userId) {
  const enabled = listEnabled(userId);
  return {
    sources: listSources().map((s) => {
      const snap = snapshotSource(s);
      return { ...snap, enabled: enabled.has(s.id) };
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/skills-sources-registry.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add extension/skills-sources/registry.mjs extension/tests/skills-sources-registry.test.mjs
git commit -m "feat(skills-sources): listSourcesWithState joined view"
```

---

### Task 5: Generalize `skill-library.mjs` to iterate enabled sources

**Files:**
- Modify: `extension/llm_agent/skills/skill-library.mjs`
- Modify: `extension/kb/routes/agent.mjs` (pass userId at the `/kb/agent/skill-library` handler)
- Test: `extension/tests/skill-library.test.mjs` (extend)

**Interfaces:**
- Produces: `listSkillLibrary(userId)` → `{ repo: <path|null>, skills: Array<skill & {sourceId, sourceName}> }` (backward-compatible shape; skills gain two fields).
- Consumes: `listSources`, `getSource`/`snapshotSource`, `BUILTIN_ID` from `../skills-sources/registry.mjs`; `listEnabled` from `../skills-sources/state.mjs`.

- [ ] **Step 1: Write the failing test (append to skill-library.test.mjs, before cleanup)**

```js
// Multi-source: a registered local source contributes its discovery skills,
// tagged with sourceId/sourceName. Disable it (per-user) and it disappears.
import os from 'node:os';
import { writeRegistry, addSource, seedBuiltinOnce, BUILTIN_ID } from '../skills-sources/registry.mjs';
import { setEnabled } from '../skills-sources/state.mjs';

test('listSkillLibrary(userId) unions enabled sources and tags each skill', () => {
  // Isolate registry/state to a temp dir so the real skills-sources.json is untouched.
  const tmpReg = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sl-'));
  process.env.LLMIDE_PLUGIN_DIR = path.join(tmpReg, 'plugins');
  // A second source repo alongside the existing fixture `repo` (= the builtin).
  const other = path.join(__dirname, `_skill-library-other-${process.pid}`);
  fs.mkdirSync(path.join(other, 'skills', 'extra'), { recursive: true });
  fs.writeFileSync(path.join(other, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
  fs.writeFileSync(path.join(other, 'skills', 'extra', 'SKILL.md'),
    '---\nname: extra\ndescription: from another source\n---\n\n# extra\n');
  writeRegistry([]);
  seedBuiltinOnce();
  addSource({ path: other, name: 'other' });
  const enabledUser = 'multi-1';
  setEnabled(enabledUser, BUILTIN_ID, true);
  setEnabled(enabledUser, 'other', true);
  _resetSkillLibraryCache();
  const { skills } = listSkillLibrary(enabledUser);
  const ids = skills.map((s) => s.id).sort();
  assert.ok(ids.includes('skills/extra'), 'second source contributed');
  const ex = skills.find((s) => s.id === 'skills/extra');
  assert.equal(ex.sourceName, 'other');
  assert.ok(ex.sourceId);
  // Disable the second source for this user → its skill disappears.
  setEnabled(enabledUser, 'other', false);
  _resetSkillLibraryCache();
  const after = listSkillLibrary(enabledUser).skills.map((s) => s.id);
  assert.ok(!after.includes('skills/extra'));
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(tmpReg, { recursive: true, force: true });
  delete process.env.LLMIDE_PLUGIN_DIR;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/skill-library.test.mjs`
Expected: FAIL — `listSkillLibrary` still reads one repo and skills have no `sourceId`.

- [ ] **Step 3: Write minimal implementation**

In `extension/llm_agent/skills/skill-library.mjs`, replace the body of `listSkillLibrary` to iterate enabled sources. Add imports at top:

```js
import { listSources, snapshotSource, BUILTIN_ID, seedBuiltinOnce } from '../../skills-sources/registry.mjs';
import { listEnabled } from '../../skills-sources/state.mjs';
```

Replace `listSkillLibrary()` with:

```js
// { repo: <builtin path|null>, skills: [{ id, family, name, description, path, sourceId, sourceName }] }
// Iterates the user's ENABLED skills sources (per-user state). Backward-compatible:
// `repo` is the builtin source's resolved path (null if absent); skills gain
// sourceId/sourceName. Cached per process; call _resetSkillLibraryCache() after
// any add/update/remove/toggle.
export function listSkillLibrary(userId) {
  if (_cache) return _cache;
  seedBuiltinOnce();
  const enabled = userId
    ? listEnabled(userId)
    : new Set(listSources().map((s) => s.id)); // no user (tests/default) → all enabled

  const skills = [];
  let builtinRepo = null;
  for (const src of listSources()) {
    if (!enabled.has(src.id)) continue;
    const snap = snapshotSource(src);
    if (src.id === BUILTIN_ID) builtinRepo = src.location || null;
    if (!snap.installed) continue;
    for (const family of LIBRARY_FAMILIES) {
      let entries;
      try { entries = readdirSync(join(src.location, family), { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const skillMd = join(src.location, family, e.name, 'SKILL.md');
        const fm = readNameDesc(skillMd);
        if (!fm) continue;
        skills.push({
          id: `${family}/${e.name}`,
          family,
          name: fm.name,
          description: fm.description,
          path: skillMd,
          sourceId: src.id,
          sourceName: src.name,
        });
      }
    }
  }
  skills.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
  _cache = { repo: builtinRepo, skills };
  return _cache;
}
```

Also update the caller in `extension/kb/routes/agent.mjs` at the `/kb/agent/skill-library` handler (currently `sendJSON(res, 200, listSkillLibrary());`) to pass the user:

```js
sendJSON(res, 200, listSkillLibrary(userId));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/skill-library.test.mjs`
Expected: PASS (existing tests still pass — the default no-user call returns the builtin's skills with `repo` set; the new multi-source test passes).

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/skills/skill-library.mjs extension/kb/routes/agent.mjs extension/tests/skill-library.test.mjs
git commit -m "feat(skills-sources): generalize skill-library across enabled sources"
```

---

### Task 6: HTTP endpoints in `auth-routes.mjs`

**Files:**
- Modify: `extension/server/auth-routes.mjs` (append before the final 404 at `:974`)
- Test: manual smoke (Task 7); module logic is covered by Tasks 1-5.

**Interfaces:**
- Produces five routes (see table). Each mutating route calls `_resetSkillLibraryCache()` (imported from `skill-library.mjs`) so the chat "/" menu reflects the change without a restart, and `safeAudit(...)`.

- [ ] **Step 1: Write the endpoints**

Insert before the `send(res, 404, ...)` line at the end of `handleAuth` in `extension/server/auth-routes.mjs`:

```js
  // ── Skills sources management ─────────────────────────────────────
  // GET  /auth/me/skills-sources          → list sources + per-user enable
  // POST /auth/me/skills-sources/toggle   → { id, enabled }
  // POST /auth/me/skills-sources/add      → { url|path, ref?, name? }  (admin)
  // POST /auth/me/skills-sources/update   → { id }                     (admin)
  // DELETE /auth/me/skills-sources/<id>                                (admin)
  if (method === 'GET' && url.split('?')[0] === '/auth/me/skills-sources') {
    const { listSourcesWithState, seedBuiltinOnce } = await import('../skills-sources/registry.mjs');
    seedBuiltinOnce();
    send(res, 200, listSourcesWithState(req.user.id));
    return;
  }

  if (method === 'POST' && url === '/auth/me/skills-sources/toggle') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id)) {
        throw errValidation('id must be a valid source slug');
      }
      if (typeof body.enabled !== 'boolean') throw errValidation('enabled must be a boolean');
      const { getSource } = await import('../skills-sources/registry.mjs');
      if (!getSource(body.id)) throw errValidation(`source '${body.id}' is not registered`);
      const { setEnabled } = await import('../skills-sources/state.mjs');
      setEnabled(req.user.id, body.id, body.enabled);
      const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
      _resetSkillLibraryCache();
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: body.enabled ? 'skills-source.enable' : 'skills-source.disable',
        resource: body.id, outcome: 'success',
      });
      send(res, 200, { ok: true, enabled: body.enabled });
    } catch (err) {
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  if (method === 'POST' && url === '/auth/me/skills-sources/add') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    const { addSource } = await import('../skills-sources/registry.mjs');
    const result = addSource({ url: body?.url, path: body?.path, ref: body?.ref, name: body?.name });
    if (result.error) {
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'skills-source.add', outcome: 'failure', detail: { error: result.error.slice(0, 200) } });
      send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } });
      return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'skills-source.add', resource: result.source.id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/skills-sources/update') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { updateSource } = await import('../skills-sources/registry.mjs');
    const result = updateSource(body.id);
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'UPDATE_FAILED', message: result.error } }); return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'skills-source.update', resource: body.id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'DELETE' && url.startsWith('/auth/me/skills-sources/')) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const id = decodeURIComponent(url.slice('/auth/me/skills-sources/'.length).split('?')[0]);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { removeSource } = await import('../skills-sources/registry.mjs');
    const result = removeSource(id);
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'REMOVE_FAILED', message: result.error } }); return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'skills-source.remove', resource: id, outcome: 'success' });
    send(res, 200, result);
    return;
  }
```

- [ ] **Step 2: Verify it parses**

Run: `cd extension && node --check server/auth-routes.mjs`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add extension/server/auth-routes.mjs
git commit -m "feat(skills-sources): five /auth/me/skills-sources HTTP endpoints"
```

---

### Task 7: Register endpoints + bump API version + integration smoke test

**Files:**
- Modify: `extension/server.mjs` (ENDPOINTS + SERVER_API_VERSION)

- [ ] **Step 1: Add the five paths to ENDPOINTS**

In `extension/server.mjs`, in the `ENDPOINTS` array (starts at `:39`), add after the `/kb/agent/skill-library` line:

```js
  '/auth/me/skills-sources',
  '/auth/me/skills-sources/toggle',
  '/auth/me/skills-sources/add',
  '/auth/me/skills-sources/update',
```

(The DELETE route `/auth/me/skills-sources/<id>` is parametric; if the array only holds literal prefixes, omit it — the auth-route matcher handles the prefix. Confirm by checking how `/auth/me/plugins/uninstall/<name>` is represented: it is NOT in ENDPOINTS, so parametric auth routes are excluded by convention. Follow that convention and do not add the DELETE path.)

- [ ] **Step 2: Bump SERVER_API_VERSION**

Change `const SERVER_API_VERSION = 25;` to `const SERVER_API_VERSION = 26;` and add a one-line comment noting the bump reason (skills-sources endpoints).

- [ ] **Step 3: Run the full extension test suite**

Run: `cd extension && npm test`
Expected: all green, including `skills-sources-state`, `skills-sources-registry`, `skill-library`, and existing `plugins-*` / `agent-skills` tests.

- [ ] **Step 4: Manual integration smoke test**

Start the server (`cd extension && npm run server`), then with a valid session cookie/token `T`:

```bash
# List (builtin should appear, enabled for your user):
curl -s http://127.0.0.1:3456/auth/me/skills-sources -H "Authorization: Bearer $T"
# Toggle off, confirm /kb/agent/skill-library shrinks, toggle back on:
curl -s -X POST http://127.0.0.1:3456/auth/me/skills-sources/toggle -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" -d '{"id":"builtin","enabled":false}'
curl -s http://127.0.0.1:3456/kb/agent/skill-library -H "Authorization: Bearer $T"   # skills: []
curl -s -X POST http://127.0.0.1:3456/auth/me/skills-sources/toggle -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" -d '{"id":"builtin","enabled":true}'
```
Expected: builtin row present; toggling off empties the discovery catalog; toggling on restores it.

- [ ] **Step 5: Commit**

```bash
git add extension/server.mjs
git commit -m "feat(skills-sources): register endpoints, bump SERVER_API_VERSION to 26"
```

---

## Self-Review notes

- **Spec coverage:** registry + state (Data model §) → Tasks 1-4; delivery generalization (Delivery §) → Task 5; HTTP surface table → Task 6; ENDPOINTS/VERSION + "Where to Add X" → Task 7; safety (URL hardening, builtin not removable, untrusted = discovery-only) → Task 3 + the design's catalog separation (catalog unchanged). Mac UI, marketplace import, local-path beyond `addSource({path})` are out of scope here — they belong to **Plan 2 (Mac)** and phase 2.
- **No placeholders:** every code step contains real code; the git-clone network path is covered by URL-normalization unit tests + a manual smoke (network clone can't be reliably unit-tested).
- **Type consistency:** `listEnabled`/`setEnabled`/`pruneOrphans` (state) and `listSources`/`getSource`/`addSource`/`updateSource`/`removeSource`/`listSourcesWithState`/`snapshotSource`/`seedBuiltinOnce`/`BUILTIN_ID` (registry) are referenced identically across tasks. `listSkillLibrary(userId)` signature matches the `agent.mjs` call.

## Execution Handoff

Plan 1 (server) is complete and testable end-to-end via HTTP + `node:test`. **Plan 2 (Mac):** `LlmIdeAPIClient+SkillsSources.swift` (DTOs + methods) + a "Skills Sources" sub-section in `LibraryView.swift` (rows, toggle, Add sheet, Update/Reveal/Remove) + chat-menu source labels — to be written as a follow-up plan once this server API is in place.
