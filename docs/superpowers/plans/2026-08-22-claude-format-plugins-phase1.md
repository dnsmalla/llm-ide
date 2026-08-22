# Claude-Format Plugins — Phase 1 (Loader Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The plugin loader natively accepts Claude Code / Codex plugin packages (`.claude-plugin/plugin.json`, nested `skills/<name>/SKILL.md`, `agents/`, Claude command conventions), and the import adapters stop being lossy for manifest-bearing sources.

**Architecture:** One format detector in `extension/plugins/loader.mjs` dispatches to either the existing own-format path (untouched) or a new vendor-manifest path that normalizes into the same internal plugin model. Nested skill directories are taught to the ONE strict skill loader (`extension/llm_agent/skills/loader.mjs`) so both consumers (catalog + per-user set) get them for free. Unsupported vendor components are catalogued, never executed. Whole-tree import copies preserve layout.

**Tech Stack:** Node 20+ ESM, node:test, js-yaml (already a dependency); Swift/SwiftUI for the one UI task.

**Spec:** `docs/superpowers/specs/2026-08-22-claude-format-plugins-design.md` (Phase 1 section; hard constraints section applies to every task)

## Global Constraints

- Existing own-format plugins (`plugin.json` at root) load through today's code path unchanged — behavior byte-identical.
- State files (`plugin-state.json`, `mcp-plugins.json`, `mcp-plugins-state.json`) are untouched in this phase — no new fields at all.
- Plugin name rules verbatim: `/^[a-z][a-z0-9-]{1,40}$/`, reserved set `{global, internal, core, kb, system}`.
- Content caps verbatim: 32,768 B per skill (strict loader), 16,384 B per command, 32,768 B per subagent, 50 files per component dir, 5 MB zip.
- `manifest.defaultEnabled` is display-only: LLM-IDE stays opt-in; nothing auto-enables.
- No server-side URL fetching, ever (SSRF posture is a project invariant).
- ESLint module boundaries: `extension/plugins/` is L3 — may import Node built-ins, 3rd-party libs, and `core/` only. Do not add imports from `kb/`, `server/`, `routes/`, or `llm_agent/` into `plugins/`.
- `/auth/me/*` endpoints are excluded from `server.mjs`'s `ENDPOINTS` array by convention — additive optional response fields there need no `SERVER_API_VERSION` bump; the Mac client decodes leniently.
- Every task ends green under: `cd extension && node --test tests/<file>` and `npm run lint` (max-warnings 0). Mac tasks additionally: `cd mac && swift build && swift test`.
- Hook/MCP execution is Phase 2/3 — Phase 1 only *catalogues* `hooks/` and `.mcp.json`.

---

### Task 1: Format detection + vendor manifest validation

**Files:**
- Modify: `extension/plugins/loader.mjs` (header comment, new helpers before `validateManifest`, `loadOnePlugin` at line 221)
- Test: `extension/tests/plugins-loader.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: plugin objects gain `format: 'llmide' | 'claude'` (Tasks 6, 7 read it). `loadOnePlugin` accepts vendor manifests. Component-path overrides flow to Task 3 as `{ skills?, commands?, agents? }` (directory names, `./` stripped).

- [x] **Step 1: Write failing tests** — append to `extension/tests/plugins-loader.test.mjs`:

```js
// --- Vendor (Claude Code / Codex) format detection ---

test('vendor: minimal .claude-plugin manifest loads with defaults', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example' }), 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const p = plugins.get('example');
  assert.ok(p, 'plugin missing');
  assert.equal(p.format, 'claude');
  assert.equal(p.version, '0.0.0', 'version defaults when manifest lacks one');
  assert.equal(p.displayName, 'example');
});

test('vendor: .codex-plugin manifest uses the same path', () => {
  const root = newRoot();
  const dir = join(root, 'codexplug');
  mkdirSync(join(dir, '.codex-plugin'), { recursive: true });
  writeFileSync(join(dir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'codexplug', version: '1.2.3', description: 'd' }), 'utf8');
  const { plugins } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('codexplug')?.format, 'claude');
  assert.equal(plugins.get('codexplug')?.version, '1.2.3');
});

test('vendor: author object maps to a name string', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0',
      author: { name: 'Ada', email: 'a@x.io', url: 'https://x.io' } }), 'utf8');
  const { plugins } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('example')?.author, 'Ada');
});

test('vendor: reserved name is rejected', () => {
  const root = newRoot();
  const dir = join(root, 'p1');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'core' }), 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.size, 0);
  assert.ok(warnings.some((w) => w.includes('reserved')), warnings.join(', '));
});

test('vendor: traversal component path is rejected', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', skills: '../outside' }), 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.size, 0);
  assert.ok(warnings.some((w) => w.includes('component path')), warnings.join(', '));
});

test('own format wins when both manifests exist', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest);
  mkdirSync(join(root, 'example', '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'example', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', description: 'vendor copy' }), 'utf8');
  const { plugins } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('example')?.format, 'llmide');
  assert.equal(plugins.get('example')?.description, 'test');
});
```

- [x] **Step 2: Run tests — verify they fail**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: FAIL — `format` is undefined / vendor plugins skipped with "no plugin.json".

- [x] **Step 3: Implement.** In `extension/plugins/loader.mjs`:

Update the header comment block (lines 1–21) to describe both layouts (add: "A vendor plugin (Claude Code / Codex) carries `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` instead; components live in `skills/<name>/SKILL.md`, `commands/*.md`, `agents/*.md`").

Add after the `RESERVED_NAMES`/`NAME_RE` declarations:

```js
// Vendor plugin manifests (Claude Code `.claude-plugin/plugin.json`, Codex
// `.codex-plugin/plugin.json`). Codex's format is a near-subset of Claude's,
// so one code path serves both. `plugin.json` at the root always wins — an
// own-format plugin is never reinterpreted.
const VENDOR_MANIFEST_DIRS = ['.claude-plugin', '.codex-plugin'];

function detectPluginFormat(dir) {
  if (existsSync(join(dir, 'plugin.json'))) return 'llmide';
  for (const sub of VENDOR_MANIFEST_DIRS) {
    if (existsSync(join(dir, sub, 'plugin.json'))) return 'claude';
  }
  return null;
}

/**
 * Validate a vendor manifest into the same normalized shape the own-format
 * path produces, plus component-path overrides (./skills etc.). Only `name`
 * is required by the vendor spec; version defaults. `defaultEnabled` is
 * parsed nowhere on purpose — LLM-IDE stays opt-in regardless of manifest.
 */
function validateClaudeManifest(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'manifest is not an object' };
  const { name, version } = raw;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { error: `name must match ${NAME_RE} (got ${JSON.stringify(name)})` };
  }
  if (RESERVED_NAMES.has(name)) return { error: `name '${name}' is reserved` };
  const author = typeof raw.author === 'string' ? raw.author.slice(0, 120)
    : (raw.author && typeof raw.author === 'object' && typeof raw.author.name === 'string')
      ? raw.author.name.slice(0, 120)
      : '';
  const components = {};
  for (const key of ['skills', 'commands', 'agents']) {
    const p = raw[key];
    if (p === undefined) continue;
    if (typeof p !== 'string' || !/^\.\/[A-Za-z0-9._-]+$/.test(p)) {
      return { error: `component path '${key}' must be a './'-prefixed relative path` };
    }
    if (p.includes('..')) return { error: `component path '${key}' must not traverse` };
    components[key] = p.slice(2);
  }
  return {
    manifest: {
      name,
      version: (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) ? version : '0.0.0',
      displayName: typeof raw.displayName === 'string' ? raw.displayName.slice(0, 80) : name,
      description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : '',
      author,
    },
    components,
  };
}
```

Replace the top of `loadOnePlugin` (lines 221–229) with format dispatch:

```js
function loadOnePlugin(dir) {
  const format = detectPluginFormat(dir);
  if (format === null) return { error: 'no plugin manifest (plugin.json or .claude-plugin/plugin.json)' };
  let manifest;
  let components = {};
  if (format === 'llmide') {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')); }
    catch (err) { return { error: `plugin.json parse: ${err.message}` }; }
    const v = validateManifest(raw);
    if (v.error) return { error: v.error };
    manifest = v.manifest;
  } else {
    let manifestPath = null;
    for (const sub of VENDOR_MANIFEST_DIRS) {
      const p = join(dir, sub, 'plugin.json');
      if (existsSync(p)) { manifestPath = p; break; }
    }
    let raw;
    try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (err) { return { error: `vendor plugin.json parse: ${err.message}` }; }
    const v = validateClaudeManifest(raw);
    if (v.error) return { error: v.error };
    manifest = v.manifest;
    components = v.components;
  }
  const warnings = [];
```

(Keep the rest of the function as-is for now — `format` and `components` are consumed in Task 3/6. To avoid an unused-variable lint error in this task, add `format` and `components` to the returned plugin object now:)

```js
  return {
    plugin: {
      ...manifest,
      dir,
      format,
      skillFiles,
      commands,
      subagents,
    },
    warnings,
  };
```

- [x] **Step 4: Run tests — verify pass**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: PASS (all, including pre-existing).

- [x] **Step 5: Commit**

```bash
git add extension/plugins/loader.mjs extension/tests/plugins-loader.test.mjs
git commit -m "feat(plugins): detect Claude/Codex vendor manifests in the loader"
```

---

### Task 2: Nested `skills/<name>/SKILL.md` in the strict skill loader

**Files:**
- Modify: `extension/llm_agent/skills/loader.mjs` (`loadSkills`, line 92)
- Test: `extension/tests/skills-loader.test.mjs` (create if absent; check `ls extension/tests/skills*` first — if an existing file covers `loadSkills`, append there instead)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadSkills(dir)` additionally returns skills from one-level-deep `<name>/SKILL.md` directories. Skill entry shape unchanged (`{ name, kind, confirmation, description, schema, body }`). Both existing consumers (`listAllSkills`, `buildPerUserSkillSet` in `extension/llm_agent/skills/registry.mjs`) pick this up with zero changes because they call `loadSkills(join(p.dir, 'skills'))`.

- [x] **Step 1: Write failing tests** (new file `extension/tests/skills-loader.test.mjs`, or append to the existing skills-loader test file if one exists):

```js
// Nested vendor skill layout: skills/<name>/SKILL.md (Claude Code / Codex).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills } from '../llm_agent/skills/loader.mjs';

function newDir() {
  return mkdtempSync(join(tmpdir(), 'skills-loader-'));
}

const FLAT = `---
name: flat-skill
kind: read
description: a flat skill
---
Body of flat skill.`;

const NESTED = `---
name: nested-skill
description: A nested vendor skill.
---
Body of nested skill.`;

test('nested <name>/SKILL.md is loaded with kind defaulting to read', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'nested-skill'), { recursive: true });
  writeFileSync(join(dir, 'nested-skill', 'SKILL.md'), NESTED, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const s = skills.get('nested-skill');
  assert.ok(s, 'nested skill missing');
  assert.equal(s.kind, 'read', 'kind defaults to read when frontmatter omits it');
  assert.equal(s.description, 'A nested vendor skill.');
  assert.match(s.body, /Body of nested skill/);
  rmSync(dir, { recursive: true, force: true });
});

test('nested skill missing frontmatter name falls back to directory name', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'anon-skill'), { recursive: true });
  writeFileSync(join(dir, 'anon-skill', 'SKILL.md'),
    `---\ndescription: no name field\n---\nBody.`, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.ok(skills.get('anon-skill'), 'dirname should become the skill name');
  rmSync(dir, { recursive: true, force: true });
});

test('nested and flat skills coexist; flat behavior unchanged', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'nested-skill'), { recursive: true });
  writeFileSync(join(dir, 'nested-skill', 'SKILL.md'), NESTED, 'utf8');
  writeFileSync(join(dir, 'flat-skill.md'), FLAT, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.ok(skills.get('nested-skill'));
  assert.ok(skills.get('flat-skill'));
  rmSync(dir, { recursive: true, force: true });
});

test('symlinked skill directory is rejected', () => {
  const dir = newDir();
  const outside = newDir();
  writeFileSync(join(outside, 'evil.md'), `---\nname: evil\nkind: read\n---\nx`, 'utf8');
  symlinkSync(join(outside, 'evil.md'), join(dir, 'evil.md'));
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.equal(skills.get('evil'), undefined);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
```

- [x] **Step 2: Run tests — verify they fail**

Run: `cd extension && node --test tests/skills-loader.test.mjs`
Expected: FAIL — nested skills not discovered ("nested skill missing").

- [x] **Step 3: Implement.** In `loadSkills` (`extension/llm_agent/skills/loader.mjs`), restructure the entry scan. Add to imports: `lstatSync`. Replace lines 102–104 and extend the per-entry loop:

```js
  const dirents = readdirSync(dir, { withFileTypes: true });
  const entries = dirents
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .filter((f) => !ignoreSet.has(f));
  // Vendor layout (Claude Code / Codex): one-level-deep `<name>/SKILL.md`
  // directories alongside flat files. Adapted in memory — never rewritten.
  const nested = [];
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const skillPath = join(dir, e.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    let st;
    try { st = lstatSync(skillPath); } catch { continue; }
    if (st.isSymbolicLink()) {
      warnings.push(`${e.name}/SKILL.md: symbolic link rejected`);
      continue;
    }
    nested.push({ label: `${e.name}/SKILL.md`, path: skillPath, dirname: e.name });
  }
```

(Keep the `_base.md` check reading `entries`.) Then after the flat-file loop, add:

```js
  for (const { label, path, dirname } of nested) {
    const parsed = parseSkillFile(path);
    if (parsed.error) {
      warnings.push(`${label}: ${parsed.error}`);
      continue;
    }
    const fm = parsed.frontmatter;
    // Vendor SKILL.md carries `name` + `description` but never `kind`.
    // Name falls back to the directory; an explicit name wins only when
    // it matches the directory (same rule flat files follow, so a plugin
    // cannot smuggle in a name that collides with a core skill).
    const name = (typeof fm.name === 'string' && fm.name) ? fm.name : dirname;
    if (name !== dirname) {
      warnings.push(`${label}: name '${name}' does not match directory name`);
      continue;
    }
    const kind = (typeof fm.kind === 'string' && fm.kind) ? fm.kind : 'read';
    if (!VALID_KINDS.has(kind)) {
      warnings.push(`${label}: kind '${kind}' is not 'read' or 'write'`);
      continue;
    }
    if (kind === 'write' && !VALID_CONFIRMATIONS.has(fm.confirmation)) {
      warnings.push(`${label}: write skills must have confirmation: editable-sheet or gitop-sheet`);
      continue;
    }
    const schemaResult = validateSchema(fm.schema);
    if (schemaResult.error) {
      warnings.push(`${label}: ${schemaResult.error}`);
      continue;
    }
    const bodyDescription = extractBodyDescription(parsed.body);
    const description = typeof fm.description === 'string' && fm.description.trim()
      ? fm.description.trim()
      : bodyDescription;
    skills.set(name, {
      name,
      kind,
      confirmation: fm.confirmation || null,
      description,
      schema: schemaResult.schema,
      body: parsed.body.trim(),
    });
  }
```

- [x] **Step 4: Run tests — verify pass**

Run: `cd extension && node --test tests/skills-loader.test.mjs tests/plugins-loader.test.mjs`
Expected: PASS both files (no regression in flat handling).

- [x] **Step 5: Commit**

```bash
git add extension/llm_agent/skills/loader.mjs extension/tests/skills-loader.test.mjs
git commit -m "feat(skills): load nested skills/<name>/SKILL.md vendor layout"
```

---

### Task 3: Plugin-loader skills scan — nested dirs + component path overrides

**Files:**
- Modify: `extension/plugins/loader.mjs` (`loadOnePlugin` skills block, lines ~250–280)
- Test: `extension/tests/plugins-loader.test.mjs`

**Interfaces:**
- Consumes: Task 1's `components` map (`{ skills?, commands?, agents? }` directory names).
- Produces: `plugin.skillFiles` may now point at `…/skills/<name>/SKILL.md` paths. `skillCount` in `/auth/me/plugins` derives from `skillFiles.length` — automatically correct.

- [x] **Step 1: Write failing tests** — append:

```js
test('vendor: nested skill directory counted and stashed with SKILL.md path', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'code-helper'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, 'skills', 'code-helper', 'SKILL.md'),
    `---\nname: code-helper\ndescription: helps\n---\nBody.`, 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const p = plugins.get('example');
  assert.equal(p.skillFiles.length, 1);
  assert.ok(p.skillFiles[0].endsWith(join('skills', 'code-helper', 'SKILL.md')));
});

test('vendor: component path override relocates the skills dir', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'custom-skills'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0', skills: './custom-skills' }), 'utf8');
  writeFileSync(join(dir, 'custom-skills', 'x.md'),
    `---\nname: x\nkind: read\ndescription: d\n---\nBody.`, 'utf8');
  const { plugins } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('example')?.skillFiles.length, 1);
});

test('vendor: nested skill exceeding the byte cap is skipped with a warning', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'big'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, 'skills', 'big', 'SKILL.md'), 'x'.repeat(33_000), 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('example')?.skillFiles.length, 0);
  assert.ok(warnings.some((w) => w.includes('big/SKILL.md') && w.includes('byte limit')),
    warnings.join(', '));
});
```

- [x] **Step 2: Run tests — verify fail**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: FAIL — nested dirs invisible (`skillFiles.length` 0), override ignored.

- [x] **Step 3: Implement.** In `loadOnePlugin`, first apply the override to the three component dirs (replace the three `const skillsDir/cmdDir/agentsDir` lines):

```js
  // Vendor manifests may relocate component dirs (./skills etc.); the
  // own format always uses the conventional names.
  const skillsDir = join(dir, components.skills ?? 'skills');
  const cmdDir = join(dir, components.commands ?? 'commands');
  const agentsDir = join(dir, components.agents ?? 'agents');
```

Then extend the skills scan loop to handle directories. Replace the `for (const entry of readdirSync(skillsDir))` loop body's head and skillPath computation:

```js
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        let skillPath;
        let label;
        if (entry.isDirectory()) {
          skillPath = join(skillsDir, entry.name, 'SKILL.md');
          if (!existsSync(skillPath)) continue; // a plain folder, not a skill
          label = `${entry.name}/SKILL.md`;
        } else {
          if (!entry.name.endsWith('.md')) continue;
          skillPath = join(skillsDir, entry.name);
          label = entry.name;
        }
        if (count >= MAX_FILES_PER_DIR) {
          warnings.push(`skills/ has more than ${MAX_FILES_PER_DIR} files — extras ignored`);
          break;
        }
        // Reject symlinks at whichever level they appear — the entry
        // itself or the nested SKILL.md inside a directory entry.
        try {
          if (lstatSync(join(skillsDir, entry.name)).isSymbolicLink()
            || lstatSync(skillPath).isSymbolicLink()) {
            warnings.push(`${label}: symbolic link rejected in plugin content`);
            continue;
          }
        } catch { /* stat failure — readFileSync will also fail */ }
        try {
          const content = readFileSync(skillPath, 'utf8');
          if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
            warnings.push(`skills/${label}: exceeds ${MAX_SKILL_BYTES} byte limit`);
            continue;
          }
          const suspicious = scanForSuspiciousContent(content);
          if (suspicious.length) {
            warnings.push(`skills/${label}: suspicious content detected — ${suspicious.join(', ')}`);
          }
        } catch { /* read error — runtime loader will also fail and skip */ }
        skillFiles.push(skillPath);
        count++;
      }
```

(Delete the old `rejectSymlink(skillsDir, entry)` usage in the skills loop only — the helper stays for commands/agents. The warning strings change slightly for skills; update any test asserting the exact old string.)

- [x] **Step 4: Run tests — verify pass**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extension/plugins/loader.mjs extension/tests/plugins-loader.test.mjs
git commit -m "feat(plugins): scan nested skills and manifest path overrides"
```

---

### Task 4: Agent frontmatter mapping (`tools`, `maxTurns`)

**Files:**
- Modify: `extension/plugins/loader.mjs` (`parseSubagentFile`, lines ~138–180)
- Test: `extension/tests/plugins-loader.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged `subagent` shape `{ description, allowedTools, maxIterations, model, systemPrompt }`; `allowedTools` entries may now contain underscores (e.g. `mcp__server__tool`) and up to 64 chars.

- [x] **Step 1: Write failing tests** — append:

```js
test('vendor agent: Claude tools CSV + maxTurns map onto the subagent model', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/researcher.md': `---
description: Researches things
tools: Read, Grep, mcp__web__fetch
maxTurns: 8
---
You research.`,
  });
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const sub = plugins.get('example')?.subagents.researcher;
  assert.ok(sub);
  assert.deepEqual(sub.allowedTools, ['read', 'grep', 'mcp__web__fetch']);
  assert.equal(sub.maxIterations, 5, 'maxTurns clamps to the existing cap of 5');
});

test('vendor agent: tools as a YAML list also works; maxTurns absent defaults to 3', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/researcher.md': `---
description: Researches things
tools: [Bash, WebSearch]
---
You research.`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  const sub = plugins.get('example')?.subagents.researcher;
  assert.deepEqual(sub.allowedTools, ['bash', 'websearch']);
  assert.equal(sub.maxIterations, 3);
});

test('vendor agent: own-format allowed_tools keeps working unchanged', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/s.md': `---
description: x
allowed_tools: [search-kb]
maxIterations: 2
---
Body.`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  const sub = plugins.get('example')?.subagents.s;
  assert.deepEqual(sub.allowedTools, ['search-kb']);
  assert.equal(sub.maxIterations, 2);
});
```

- [x] **Step 2: Run tests — verify fail**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: FAIL — `tools`/`maxTurns` ignored (allowedTools `[]`, maxIterations 3-with-clamp mismatch on the 8 case).

- [x] **Step 3: Implement.** In `parseSubagentFile`, replace the `allowedTools` and `maxIters` computations:

```js
  // Tool list: own format uses `allowed_tools` (YAML list of lowercase
  // ids). Vendor frontmatter (Claude Code / Codex) uses `tools` — a CSV
  // string or list of Capitalized names — normalized here: lowercased,
  // and widened to allow underscores (mcp__server__tool) up to 64 chars.
  let toolList = fm.allowed_tools;
  if (toolList === undefined && fm.tools !== undefined) {
    toolList = typeof fm.tools === 'string'
      ? fm.tools.split(',').map((s) => s.trim()).filter(Boolean)
      : fm.tools;
  }
  const allowedTools = Array.isArray(toolList)
    ? toolList
        .filter((s) => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[a-z][a-z0-9_-]{0,63}$/.test(s))
    : [];

  // Vendor `maxTurns` maps onto our maxIterations, same clamp.
  const rawIters = fm.maxIterations ?? fm.maxTurns;
  const maxIters = Number.isFinite(rawIters) && rawIters > 0
    ? Math.min(rawIters, 5)
    : 3;
```

- [x] **Step 4: Run tests — verify pass**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extension/plugins/loader.mjs extension/tests/plugins-loader.test.mjs
git commit -m "feat(plugins): map vendor agent frontmatter (tools, maxTurns)"
```

---

### Task 5: Command conventions (`$ARGUMENTS`, `argument-hint`)

**Files:**
- Modify: `extension/plugins/loader.mjs` (`parseCommandFile`, lines ~182–216)
- Test: `extension/tests/plugins-loader.test.mjs`

**Interfaces:**
- Consumes: `expandSlashCommand`'s existing `{{_rest}}` semantics (unchanged).
- Produces: `command.template` may contain `{{_rest}}` where the source had `$ARGUMENTS`. `command.description` may carry an `(args: …)` suffix.

- [x] **Step 1: Write failing tests** — append:

```js
test('vendor command: $ARGUMENTS maps to {{_rest}} expansion', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'commands/review.md': `---\ndescription: Review a PR\nargument-hint: <pr-number>\n---\nReview $ARGUMENTS carefully.`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  const cmd = plugins.get('example')?.commands.review;
  assert.ok(cmd);
  assert.match(cmd.description, /\(args: <pr-number>\)/);
  const expanded = expandSlashCommand('/review 1234', new Map([['review', cmd]]));
  assert.match(expanded.prompt, /Review 1234 carefully\.$/);
  assert.doesNotMatch(expanded.prompt, /\$ARGUMENTS|\{\{_rest\}\}/);
});

test('own-format {{arg}} substitution is untouched', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'commands/summary.md': `---\ndescription: Summarize\nargs:\n  repo:\n    type: string\n    required: true\n---\nSummarize {{repo}}.`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  const expanded = expandSlashCommand('/summary repo=foo',
    new Map([['summary', plugins.get('example').commands.summary]]));
  assert.match(expanded.prompt, /Summarize foo\./);
});
```

- [x] **Step 2: Run tests — verify fail**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: FAIL — `$ARGUMENTS` survives verbatim; no `(args: …)` suffix.

- [x] **Step 3: Implement.** In `parseCommandFile`, after `const fm = parsed.frontmatter || {};` apply vendor translation before building the result:

```js
  // Vendor command bodies (Claude Code / Codex) use `$ARGUMENTS` for
  // "everything after the trigger" — exactly our `{{_rest}}` semantics,
  // so translate at parse time and let expandSlashCommand do the rest.
  const template = parsed.body.trim().replace(/\$ARGUMENTS\b/g, '{{_rest}}');

  // `argument-hint` (vendor) is display-only — fold into description.
  const hint = typeof fm['argument-hint'] === 'string' ? fm['argument-hint'].slice(0, 80) : '';
  const baseDescription = typeof fm.description === 'string' ? fm.description.slice(0, 200) : '';
  const description = hint ? `${baseDescription} (args: ${hint})`.slice(0, 240) : baseDescription;
```

Then use `template` and `description` in the returned `command` object (replace `parsed.body.trim()` / the old description expression).

- [x] **Step 4: Run tests — verify pass**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extension/plugins/loader.mjs extension/tests/plugins-loader.test.mjs
git commit -m "feat(plugins): translate vendor command conventions ($ARGUMENTS, argument-hint)"
```

---

### Task 6: Unsupported/pending components catalogue + API exposure

**Files:**
- Modify: `extension/plugins/loader.mjs` (`loadOnePlugin`)
- Modify: `extension/llm_agent/skills/registry.mjs` (`listInstalledPlugins`, line 173)
- Test: `extension/tests/plugins-loader.test.mjs`

**Interfaces:**
- Consumes: Task 1's `format`.
- Produces: plugin objects gain `unsupportedComponents: string[]` (themes, output-styles, monitors, workflows, bin, `.lsp.json`, root `settings.json`) and `pendingComponents: string[]` (`'hooks'`, `'mcp'` — present but inactive until Phase 2/3). `/auth/me/plugins` serializes both fields (Task 7's Swift model decodes them).

- [x] **Step 1: Write failing tests** — append:

```js
test('vendor: unsupported and pending components are catalogued, never executed', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'themes'), { recursive: true });
  mkdirSync(join(dir, 'output-styles'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, 'themes', 'dark.json'), '{}', 'utf8');
  writeFileSync(join(dir, 'hooks', 'hooks.json'), '{}', 'utf8');
  writeFileSync(join(dir, '.mcp.json'), '{}', 'utf8');
  writeFileSync(join(dir, '.lsp.json'), '{}', 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  const p = plugins.get('example');
  assert.ok(p);
  assert.deepEqual([...p.unsupportedComponents].sort(), ['.lsp.json', 'output-styles', 'themes']);
  assert.deepEqual([...p.pendingComponents].sort(), ['hooks', 'mcp']);
  assert.ok(warnings.some((w) => w.includes('unsupported components')),
    `expected an info warning, got: ${warnings.join(', ')}`);
});

test('own format: no unsupported/pending fields leak into old plugins', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'skills/x.md': `---\nname: x\nkind: read\ndescription: d\n---\nBody.`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  const p = plugins.get('example');
  assert.deepEqual(p.unsupportedComponents, []);
  assert.deepEqual(p.pendingComponents, []);
});
```

- [x] **Step 2: Run tests — verify fail**

Run: `cd extension && node --test tests/plugins-loader.test.mjs`
Expected: FAIL — fields undefined.

- [x] **Step 3: Implement.** In `loadOnePlugin`, after the subagents block (own-format plugins skip it — `components` is `{}` and the catalogue runs only for `format === 'claude'`):

```js
  // Vendor components LLM-IDE does not run. Catalogued for display only —
  // parsing them must never lead to execution (spec: parse-and-ignore).
  const unsupportedComponents = [];
  const pendingComponents = [];
  if (format === 'claude') {
    for (const rel of ['themes', 'output-styles', 'monitors', 'workflows', 'bin', '.lsp.json', 'settings.json']) {
      if (existsSync(join(dir, rel))) unsupportedComponents.push(rel);
    }
    if (existsSync(join(dir, 'hooks', 'hooks.json'))) pendingComponents.push('hooks');
    if (existsSync(join(dir, '.mcp.json'))) pendingComponents.push('mcp');
    if (unsupportedComponents.length) {
      warnings.push(`unsupported components ignored: ${unsupportedComponents.join(', ')}`);
    }
  }
```

Add both arrays to the returned plugin object. Then in `extension/llm_agent/skills/registry.mjs` `listInstalledPlugins`, extend each item:

```js
      format: p.format || 'llmide',
      unsupportedComponents: p.unsupportedComponents || [],
      pendingComponents: p.pendingComponents || [],
```

- [x] **Step 4: Run tests — verify pass**

Run: `cd extension && node --test tests/plugins-loader.test.mjs tests/route-modes.test.mjs`
Expected: PASS. (Also run the full suite once here: `npm test` — this touches the API payload.)

- [x] **Step 5: Commit**

```bash
git add extension/plugins/loader.mjs extension/llm_agent/skills/registry.mjs extension/tests/plugins-loader.test.mjs
git commit -m "feat(plugins): catalogue unsupported and pending vendor components"
```

---

### Task 7: Mac UI — show component status in PluginDetailView

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Auth.swift:191` (`PluginInfo`)
- Modify: `mac/Sources/LlmIdeMac/Views/Library/PluginDetailView.swift`
- Test: `mac/Tests/LlmIdeMacTests/PluginInfoDecodingTests.swift` (create)

**Interfaces:**
- Consumes: Task 6's `/auth/me/plugins` fields (`format`, `unsupportedComponents`, `pendingComponents`).
- Produces: `PluginInfo.format: String`, `PluginInfo.unsupportedComponents: [String]`, `PluginInfo.pendingComponents: [String]` — decode with defaults so older servers still decode (house pattern, see the `subagents` field comment).

- [x] **Step 1: Write the failing test** — create `mac/Tests/LlmIdeMacTests/PluginInfoDecodingTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// PluginInfo decodes the /auth/me/plugins payload leniently — servers
/// predating the vendor-format fields must still decode (house pattern).
final class PluginInfoDecodingTests: XCTestCase {
    func testVendorFieldsDecode() throws {
        let json = """
        {"name":"example","version":"1.0.0","displayName":"Example","description":"d",
         "author":"a","enabled":false,"skillCount":1,"commands":[],"subagents":[],
         "format":"claude","unsupportedComponents":["themes",".lsp.json"],
         "pendingComponents":["hooks"]}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PluginInfo.self, from: json)
        XCTAssertEqual(info.format, "claude")
        XCTAssertEqual(info.unsupportedComponents, ["themes", ".lsp.json"])
        XCTAssertEqual(info.pendingComponents, ["hooks"])
    }

    func testOlderServerPayloadStillDecodesWithDefaults() throws {
        let json = """
        {"name":"example","version":"1.0.0","displayName":"Example","description":"d",
         "author":"a","enabled":false,"skillCount":1,"commands":[],"subagents":[]}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PluginInfo.self, from: json)
        XCTAssertEqual(info.format, "llmide")
        XCTAssertEqual(info.unsupportedComponents, [])
        XCTAssertEqual(info.pendingComponents, [])
    }
}
```

- [x] **Step 2: Run — verify fail**

Run: `cd mac && swift test --filter PluginInfoDecodingTests`
Expected: FAIL — no such members. (Build first: `swift build`.)

- [x] **Step 3: Implement.** In `PluginInfo` add three stored properties, their `CodingKeys`, and in `init(from:)`:

```swift
    /// "llmide" (own format) or "claude" (vendor package). Older servers
    /// predate the field — default to the own format.
    let format: String
    /// Vendor components present but never executed (themes, .lsp.json, …).
    let unsupportedComponents: [String]
    /// Vendor components present but inactive until a later phase (hooks, MCP).
    let pendingComponents: [String]
```

```swift
        self.format = (try? c.decode(String.self, forKey: .format)) ?? "llmide"
        self.unsupportedComponents = (try? c.decode([String].self, forKey: .unsupportedComponents)) ?? []
        self.pendingComponents = (try? c.decode([String].self, forKey: .pendingComponents)) ?? []
```

(Add the three cases to `CodingKeys`. Note the existing `static func ==` stays name/enabled-only.)

Then in `PluginDetailView`, after `subagentsBlock(plugin)` add a `componentsBlock(plugin)` call and builder:

```swift
    /// Vendor-package components LLM-IDE does not run — shown so the user
    /// knows what a Claude plugin brought along that stays inert here.
    @ViewBuilder
    private func componentsBlock(_ plugin: PluginInfo) -> some View {
        if !plugin.pendingComponents.isEmpty || !plugin.unsupportedComponents.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Components").font(.headline)
                if plugin.pendingComponents.contains("hooks") {
                    Label("Hooks — detected, not run yet (requires plugin hook trust)", systemImage: "clock")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if plugin.pendingComponents.contains("mcp") {
                    Label("MCP servers — detected, not active yet", systemImage: "clock")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(plugin.unsupportedComponents, id: \.self) { c in
                    Label("\(c) — unsupported, ignored", systemImage: "minus.circle")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }
```

- [x] **Step 4: Run — verify pass**

Run: `cd mac && swift build && swift test --filter PluginInfoDecodingTests`
Expected: PASS. Then full gate: `swift test` (all green).

- [x] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Auth.swift mac/Sources/LlmIdeMac/Views/Library/PluginDetailView.swift mac/Tests/LlmIdeMacTests/PluginInfoDecodingTests.swift
git commit -m "feat(mac): surface vendor plugin component status in the detail view"
```

---

### Task 8: Installer accepts vendor-manifest zips

**Files:**
- Modify: `extension/plugins/installer.mjs` (`findManifest`, line 96, and the post-extract validation path at line ~192)
- Test: `extension/tests/plugins-installer.test.mjs`

**Interfaces:**
- Consumes: Task 1's loader support (post-install re-validation via `loadPlugins()` already covers vendor manifests once Task 1 lands).
- Produces: `installFromZip` accepts zips whose manifest is `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` (root or single top-level dir). Response shape unchanged.

- [x] **Step 1: Write failing test** — append to `extension/tests/plugins-installer.test.mjs` (reuses the file's existing `newTempRoot`/`zipDirectory` helpers and `skipReason` guard; add `loadPlugins` to the import from `'../plugins/loader.mjs'` — a new import line):

```js
test('installs a vendor zip whose .claude-plugin/plugin.json sits in a top-level dir', { skip: skipReason || false }, async () => {
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    const srcPlugin = join(stage, 'vendor-plug');
    mkdirSync(join(srcPlugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(srcPlugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'vendor-plug', version: '1.0.0' }), 'utf8');
    mkdirSync(join(srcPlugin, 'skills', 'helper'), { recursive: true });
    writeFileSync(join(srcPlugin, 'skills', 'helper', 'SKILL.md'),
      '---\nname: helper\ndescription: helps\n---\nBody.', 'utf8');
    const zipPath = join(stage, 'pkg.zip');
    zipDirectory(srcPlugin, zipPath, { includeParent: true });

    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir });
    assert.equal(result.ok, true, `install failed: ${result.error || ''}`);
    assert.equal(result.plugin.name, 'vendor-plug');
    assert.ok(existsSync(join(installDir, 'vendor-plug', '.claude-plugin', 'plugin.json')));
    const { plugins } = loadPlugins({ pluginDir: installDir });
    const p = plugins.get('vendor-plug');
    assert.equal(p?.format, 'claude');
    assert.equal(p?.skillFiles.length, 1);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/plugins-installer.test.mjs`
Expected: FAIL — "plugin.json not found at zip root or in a single top-level directory".

- [x] **Step 3: Implement.** In `findManifest`:

```js
// Manifest candidates, own format first (a plugin carrying BOTH is an
// own-format plugin; the loader enforces the same precedence).
const MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

async function findManifest(stagingDir) {
  // Root first …
  for (const rel of MANIFESTS) {
    if (existsSync(join(stagingDir, rel))) return { manifestDir: stagingDir };
  }
  // … then a single top-level dir (how `Compress with Finder` and
  // `zip -r foo.zip my-plugin/` build archives). Dot-dirs (e.g.
  // __MACOSX) don't count toward "single".
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX');
  if (dirs.length === 1) {
    for (const rel of MANIFESTS) {
      if (existsSync(join(stagingDir, dirs[0].name, rel))) {
        return { manifestDir: join(stagingDir, dirs[0].name) };
      }
    }
  }
  return { error: 'plugin manifest not found at zip root or in a single top-level directory (plugin.json, .claude-plugin/plugin.json, or .codex-plugin/plugin.json)' };
}
```

(The existing return shape `{ manifestDir }` is preserved — the caller at line ~192 uses it as the plugin ROOT for re-validation and rename; a vendor manifest's plugin root is still the staging root / single top-level dir, NOT `.claude-plugin/`. No caller changes needed.)

- [x] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/plugins-installer.test.mjs tests/plugins-loader.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extension/plugins/installer.mjs extension/tests/plugins-installer.test.mjs
git commit -m "feat(plugins): install vendor-format (Claude/Codex) plugin zips"
```

---

### Task 9: Import adapters — whole-tree copy for manifest-bearing sources

**Files:**
- Modify: `extension/plugins/vendor-import-shared.mjs` (new `copyPluginTree`)
- Modify: `extension/plugins/claude-adapter.mjs` (`importPlugin` line 125, `checkForUpdates` line 264)
- Modify: `extension/plugins/codex-adapter.mjs` (mirror changes; read it first — it shares the same shape)
- Test: `extension/tests/claude-adapter.test.mjs`, `extension/tests/codex-adapter.test.mjs`

**Interfaces:**
- Consumes: Task 1's native loader (the copied tree needs NO generated manifest — the loader reads the vendor manifest in place).
- Produces: `copyPluginTree(src, dst)` → `{ files: number, skipped: string[] }`; throws on tree limits. Import result shape unchanged.

- [x] **Step 1: Write failing tests** — append to `extension/tests/claude-adapter.test.mjs` (extends the existing `makeFakeMarketplace` fixture pattern):

```js
test('manifest-bearing marketplace plugin imports whole with layout preserved', () => {
  const claudeRoot = makeFakeMarketplace(mkdtempSync(join(tmpdir(), 'claude-mp-')));
  const llmideDir = mkdtempSync(join(tmpdir(), 'llmide-plugins-'));
  const mpDir = join(claudeRoot, 'marketplaces', 'claude-plugins-official', 'plugins', 'treeplug');
  mkdirSync(join(mpDir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(mpDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'treeplug', version: '2.0.0', description: 'tree plugin' }), 'utf8');
  mkdirSync(join(mpDir, 'skills', 'nested'), { recursive: true });
  writeFileSync(join(mpDir, 'skills', 'nested', 'SKILL.md'),
    '---\nname: nested\ndescription: nested skill\n---\nBody.', 'utf8');
  mkdirSync(join(mpDir, 'agents'), { recursive: true });
  writeFileSync(join(mpDir, 'agents', 'researcher.md'),
    '---\ndescription: researches\ntools: Read, Grep\n---\nYou research.', 'utf8');
  try {
    const result = importPlugin({ claudeRoot, llmidePluginDir: llmideDir, source: 'marketplace', name: 'treeplug' });
    assert.equal(result.ok, true, `import failed: ${result.error || ''}`);
    const target = join(llmideDir, 'claude-treeplug');
    assert.ok(existsSync(join(target, '.claude-plugin', 'plugin.json')), 'vendor manifest must survive');
    assert.ok(!existsSync(join(target, 'plugin.json')), 'no generated root manifest for vendor plugins');
    assert.ok(existsSync(join(target, 'agents', 'researcher.md')), 'agents/ must no longer be dropped');
    assert.ok(existsSync(join(target, 'skills', 'nested', 'SKILL.md')), 'nested layout must not be flattened');
    assert.equal(result.plugin.version, '2.0.0', 'version comes from the vendor manifest');
    // Identity: the copied manifest's name is rewritten to the namespaced
    // directory name so enable-state and update-check key consistently.
    const copied = JSON.parse(readFileSync(join(target, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(copied.name, 'claude-treeplug');
    const { plugins } = loadPlugins({ pluginDir: llmideDir });
    const p = plugins.get('claude-treeplug');
    assert.equal(p?.format, 'claude');
    assert.ok(p?.subagents.researcher, 'agent must be discovered');
    assert.equal(p?.skillFiles.length, 1);
    // Update checking still sees the imported plugin.
    assert.ok([...listImportedNames(llmideDir)].includes('claude-treeplug'));
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(llmideDir, { recursive: true, force: true });
  }
});
```

Write the analogous test in `extension/tests/codex-adapter.test.mjs` against its `.codex-plugin/plugin.json` fixture conventions (read its fixture helpers first; same assertions with the codex name prefix and origin).

- [x] **Step 2: Run — verify fail**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: FAIL — no `.claude-plugin/` in the import output; `agents/` absent.

- [x] **Step 3: Implement.** In `vendor-import-shared.mjs` add:

```js
// Tree-copy limits for whole-plugin imports. Deliberately more generous
// than the zip path (5 MB) because vendor trees can carry references/ and
// assets/ alongside SKILL.md — but still bounded.
export const TREE_COPY_LIMITS = Object.freeze({
  maxFileBytes: 512 * 1024, maxTotalBytes: 10 * 1024 * 1024, maxFiles: 500,
});

/**
 * Copy a vendor plugin tree wholesale, layout preserved. Symlinks are
 * skipped (same policy as the loader), oversized files skipped, and the
 * whole copy aborts if the tree exceeds the total/file-count limits —
 * a half-copied plugin must never be left behind. Throws on limit breach.
 * @returns {{files: number, skipped: string[]}}
 */
export function copyPluginTree(src, dst) {
  let totalBytes = 0;
  let files = 0;
  const skipped = [];
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (e.isSymbolicLink()) { skipped.push(`${e.name}: symlink rejected`); continue; }
      const fromPath = join(from, e.name);
      const toPath = join(to, e.name);
      if (e.isDirectory()) { walk(fromPath, toPath); continue; }
      if (!e.isFile()) continue; // fifos, sockets, devices
      if (files >= TREE_COPY_LIMITS.maxFiles) throw new Error('plugin exceeds max file count');
      const size = statSync(fromPath).size;
      if (size > TREE_COPY_LIMITS.maxFileBytes) { skipped.push(`${e.name}: too large`); continue; }
      totalBytes += size;
      files += 1;
      if (totalBytes > TREE_COPY_LIMITS.maxTotalBytes) throw new Error('plugin exceeds max total bytes');
      copyFileSync(fromPath, toPath);
    }
  };
  walk(src, dst);
  return { files, skipped };
}
```

(Add `mkdirSync` to the existing `node:fs` import line.)

In `claude-adapter.mjs` `importPlugin`, after `sourceDir` is found and before the legacy `version`/`mkdirSync` block, add the vendor branch:

```js
  // Manifest-bearing source: copy the tree whole — the loader reads the
  // vendor manifest natively (Phase 1), so no generated plugin.json and
  // no lossy flattening. agents/, hooks/ (catalogued), and nested skills
  // all survive. Manifest-less sources keep the legacy adapted path.
  const vendorManifestPath =
    existsSync(join(sourceDir, '.claude-plugin', 'plugin.json')) ? join(sourceDir, '.claude-plugin', 'plugin.json')
    : existsSync(join(sourceDir, '.codex-plugin', 'plugin.json')) ? join(sourceDir, '.codex-plugin', 'plugin.json')
    : null;
  if (vendorManifestPath) {
    const vendorManifestRel = vendorManifestPath.slice(sourceDir.length + 1);
    let vendorManifest;
    try { vendorManifest = JSON.parse(readFileSync(vendorManifestPath, 'utf8')); }
    catch { return { ok: false, error: 'vendor plugin.json is not valid JSON' }; }
    if (typeof vendorManifest.name !== 'string' || !PLUGIN_NAME_RE.test(vendorManifest.name)) {
      return { ok: false, error: `vendor manifest name invalid (got ${JSON.stringify(vendorManifest.name)})` };
    }
    const version = (typeof vendorManifest.version === 'string' && /^\d+\.\d+\.\d+/.test(vendorManifest.version))
      ? vendorManifest.version : '0.0.0';
    const targetDir = join(mnDir, mnName);
    // Clean start — a stale file from a previous lossy import must not
    // linger beside the whole-tree copy.
    rmSync(targetDir, { recursive: true, force: true });
    const copied = copyPluginTree(sourceDir, targetDir);
    // Namespace the copy: rewrite ONLY the name field so the imported
    // plugin's identity matches its directory (claude-<name>) — enable
    // state and update-checking key off that identity. Everything else
    // in the manifest is preserved verbatim; this is not a lossy
    // regeneration.
    writeFileSync(join(targetDir, vendorManifestRel),
      JSON.stringify({ ...vendorManifest, name: mnName, version }, null, 2), 'utf8');
    return {
      ok: true,
      warnings: copied.skipped.length > 0 ? copied.skipped : undefined,
      plugin: {
        name: mnName,
        version,
        displayName: vendorManifest.displayName || name,
        description: vendorManifest.description || `Imported from Claude Code (${source})`,
        author: typeof vendorManifest.author === 'string' ? vendorManifest.author
          : vendorManifest.author?.name || 'Claude Code',
        skillCount: countSkills(join(targetDir, 'skills')),
        commandCount: countCommands(join(targetDir, 'commands')),
        origin: 'claude',
      },
    };
  }
```

(Add `rmSync`, `copyPluginTree` to imports.) Two shared-helper fixes so whole-tree imports stay visible to update checking:

In `vendor-import-shared.mjs` `listImportedNames` — a vendor-copied plugin has no root `plugin.json`, so it is currently invisible:

```js
      if (existsSync(join(dir, entry.name, 'plugin.json'))
        || existsSync(join(dir, entry.name, '.claude-plugin', 'plugin.json'))
        || existsSync(join(dir, entry.name, '.codex-plugin', 'plugin.json'))) names.add(entry.name);
```

In `claude-adapter.mjs` `checkForUpdates`, a vendor copy also lacks the `origin: 'claude'` marker — treat a vendor-manifest directory as claude-origin by construction, and read the imported version from the vendor manifest:

```js
  for (const mnName of imported) {
    // Own-format imports carry `origin` in their generated manifest;
    // whole-tree vendor copies ARE claude-origin by construction.
    const vendorManifestRel = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']
      .find((rel) => existsSync(join(mnDir, mnName, rel)));
    let importedVersion = null;
    const sourceName = mnName.replace(/^claude-/, '');
    if (vendorManifestRel) {
      try {
        importedVersion = JSON.parse(readFileSync(join(mnDir, mnName, vendorManifestRel), 'utf8')).version || null;
      } catch { continue; }
    } else {
      const manifestPath = join(mnDir, mnName, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
      if (manifest.origin !== 'claude') continue;
      importedVersion = manifest.version || '0.0.0';
    }
    // (existing loop body follows, using importedVersion; note the old
    // sourceName derivation from manifest.sourcePlugin only applies to the
    // legacy path — vendor copies derive it from the directory name above)
```

Then in the existing per-source version read, prefer the vendor manifest before `package.json`:

```js
      let sourceVersion = '0.0.0';
      for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'package.json']) {
        const p = join(sourceDir, rel);
        if (!existsSync(p)) continue;
        try {
          const parsed = JSON.parse(readFileSync(p, 'utf8'));
          if (typeof parsed.version === 'string') sourceVersion = parsed.version;
        } catch { /* use default */ }
        break; // first present file wins; vendor manifest outranks package.json
      }
```

Mirror both changes in `codex-adapter.mjs` (its `importPlugin`/`checkForUpdates` share the shape — read it first; the vendor branch's origin string is `'codex'` and the name prefix follows its existing convention).

- [x] **Step 4: Run — verify pass**

Run: `cd extension && node --test tests/claude-adapter.test.mjs tests/codex-adapter.test.mjs`
Expected: PASS (old lossy-path tests too — they use manifest-less fixtures).

- [x] **Step 5: Full gate + commit**

Run: `cd extension && npm run lint && npm test`
Expected: lint clean (max-warnings 0), full suite green.

```bash
git add extension/plugins/ extension/tests/claude-adapter.test.mjs extension/tests/codex-adapter.test.mjs
git commit -m "feat(plugins): import manifest-bearing vendor plugins whole"
```

---

## Final verification (after all tasks)

- [x] `cd extension && npm run lint && npm test` — full suite green.
- [x] `cd mac && swift build && swift test` — full suite green (needs sandbox disabled on this machine).
- [ ] Manual smoke: install a real Claude Code plugin zip through the Mac Library UI ("Install from .zip…"), verify it lists with `format: claude`, its nested skills appear in the "/" menu when enabled, and unsupported components show in the detail view.
- [ ] Regression Loop stage (`Loop` → Regression) green — the spec's hard constraint #1, enforced mechanically.

## Deferred to later plans (do NOT do in Phase 1)

- Phase 2: plugin `.mcp.json` registration + v2-engine user MCP + credential-add flow.
- Phase 3: hooks parsing/execution with the per-plugin consent gate.
- Phase 4: marketplace browsing, update-badge UI wiring the orphaned endpoints, help-copy/admin-gate-comment fixes, Plugins+MCP System Check stage.
