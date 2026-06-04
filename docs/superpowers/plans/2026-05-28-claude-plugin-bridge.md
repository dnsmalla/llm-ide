# Claude Plugin Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge Claude Code's plugin ecosystem into LLM IDE so users can discover, import, and toggle Claude plugins alongside native ones.

**Architecture:** A server-side adapter module (`claude-adapter.mjs`) scans `~/.claude/plugins/` for installed plugins and marketplace catalogs, converts Claude's `package.json` format into LLM IDE' `plugin.json` format, and copies skill/command files through the existing validation pipeline. Four new API routes expose this to the Mac app, which adds a "Import from Claude Code" sheet to the unified PLUGINS section.

**Tech Stack:** Node.js (server-side adapter + routes), Swift/SwiftUI (Mac app UI), `node:test` (tests)

---

### Task 1: Claude Adapter — `scanClaudeDir()` helper

**Files:**
- Create: `extension/plugins/claude-adapter.mjs`
- Create: `extension/tests/claude-adapter.test.mjs`

- [ ] **Step 1: Write the failing test for `claudePluginsRoot()`**

```js
// extension/tests/claude-adapter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudePluginsRoot } from '../plugins/claude-adapter.mjs';

test('claudePluginsRoot returns ~/.claude/plugins on macOS', () => {
  const root = claudePluginsRoot();
  assert.ok(root.endsWith('.claude/plugins'), `got: ${root}`);
  assert.ok(root.startsWith('/'), 'must be absolute');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement `claudePluginsRoot()`**

```js
// extension/plugins/claude-adapter.mjs
import { join } from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * Root directory where Claude Code stores plugins.
 * Override via $CLAUDE_PLUGINS_DIR for tests.
 */
export function claudePluginsRoot() {
  if (process.env.CLAUDE_PLUGINS_DIR) return process.env.CLAUDE_PLUGINS_DIR;
  return join(os.homedir(), '.claude', 'plugins');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/claude-adapter.mjs extension/tests/claude-adapter.test.mjs
git commit -m "feat(plugins): add claude-adapter with claudePluginsRoot helper"
```

---

### Task 2: Claude Adapter — `scanInstalled()`

**Files:**
- Modify: `extension/plugins/claude-adapter.mjs`
- Modify: `extension/tests/claude-adapter.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstalled } from '../plugins/claude-adapter.mjs';

function makeFakeClaudeDir() {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugins-'));
  // installed_plugins.json
  const installed = {
    version: 2,
    plugins: {
      'code-review@claude-plugins-official': [{
        scope: 'project',
        installPath: join(root, 'cache', 'claude-plugins-official', 'code-review', '1.0.0'),
        version: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      }],
    },
  };
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify(installed), 'utf8');
  // Create the cached plugin directory with skills
  const pluginDir = join(root, 'cache', 'claude-plugins-official', 'code-review', '1.0.0');
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(join(pluginDir, 'skills', 'review'), { recursive: true });
  writeFileSync(join(pluginDir, 'skills', 'review', 'SKILL.md'), '# Review\nReview code.', 'utf8');
  mkdirSync(join(pluginDir, 'commands'), { recursive: true });
  writeFileSync(join(pluginDir, 'commands', 'review.md'), '# /review\nReview a PR.', 'utf8');
  return root;
}

test('scanInstalled returns claude plugins with metadata', () => {
  const root = makeFakeClaudeDir();
  try {
    const plugins = scanInstalled(root);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, 'code-review');
    assert.equal(plugins[0].version, '1.0.0');
    assert.equal(plugins[0].marketplace, 'claude-plugins-official');
    assert.equal(plugins[0].skillCount, 1);
    assert.equal(plugins[0].commandCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanInstalled returns empty array when dir missing', () => {
  const plugins = scanInstalled('/nonexistent/path');
  assert.deepStrictEqual(plugins, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: FAIL — `scanInstalled` not exported.

- [ ] **Step 3: Implement `scanInstalled()`**

Add to `extension/plugins/claude-adapter.mjs`:

```js
/**
 * Parse installed_plugins.json and scan cache dirs for skill/command counts.
 * @param {string} [rootOverride] - Override root for tests
 * @returns {ClaudePlugin[]}
 */
export function scanInstalled(rootOverride) {
  const root = rootOverride || claudePluginsRoot();
  const indexPath = join(root, 'installed_plugins.json');
  if (!existsSync(indexPath)) return [];

  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch { return []; }

  if (!index || typeof index.plugins !== 'object') return [];

  const results = [];
  for (const [key, entries] of Object.entries(index.plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // key format: "pluginName@marketplaceName"
    const atIdx = key.lastIndexOf('@');
    const pluginName = atIdx > 0 ? key.slice(0, atIdx) : key;
    const marketplace = atIdx > 0 ? key.slice(atIdx + 1) : 'unknown';

    // Use the most recent entry
    const entry = entries[entries.length - 1];
    const installPath = entry.installPath;
    if (!installPath || !existsSync(installPath)) continue;

    const skillCount = countMdFiles(join(installPath, 'skills'));
    const commandCount = countMdFiles(join(installPath, 'commands'));

    results.push({
      name: pluginName,
      version: entry.version || '0.0.0',
      marketplace,
      installPath,
      skillCount,
      commandCount,
      installedAt: entry.installedAt || null,
    });
  }
  return results;
}

/**
 * Recursively count .md files in a directory.
 */
function countMdFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        count += countMdFiles(join(dir, e.name));
      } else if (e.name.endsWith('.md')) {
        count++;
      }
    }
  } catch { /* permission error, etc. */ }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/claude-adapter.mjs extension/tests/claude-adapter.test.mjs
git commit -m "feat(plugins): scanInstalled reads Claude Code installed_plugins.json"
```

---

### Task 3: Claude Adapter — `scanMarketplace()`

**Files:**
- Modify: `extension/plugins/claude-adapter.mjs`
- Modify: `extension/tests/claude-adapter.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { scanMarketplace } from '../plugins/claude-adapter.mjs';

function makeFakeMarketplace(root) {
  const mpDir = join(root, 'marketplaces', 'claude-plugins-official', 'plugins');
  mkdirSync(mpDir, { recursive: true });
  // Plugin with skills
  mkdirSync(join(mpDir, 'frontend-design', 'skills', 'frontend-design'), { recursive: true });
  writeFileSync(join(mpDir, 'frontend-design', 'skills', 'frontend-design', 'SKILL.md'), '# FE Design', 'utf8');
  writeFileSync(join(mpDir, 'frontend-design', 'README.md'), 'Build UIs with best practices.', 'utf8');
  // Plugin with commands only
  mkdirSync(join(mpDir, 'commit-commands', 'commands'), { recursive: true });
  writeFileSync(join(mpDir, 'commit-commands', 'commands', 'commit.md'), '# /commit', 'utf8');
  return root;
}

test('scanMarketplace returns marketplace plugins', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-mp-'));
  makeFakeMarketplace(root);
  try {
    const plugins = scanMarketplace(root);
    assert.ok(plugins.length >= 2);
    const fe = plugins.find(p => p.name === 'frontend-design');
    assert.ok(fe, 'frontend-design not found');
    assert.equal(fe.hasSkills, true);
    assert.equal(fe.hasCommands, false);
    const cc = plugins.find(p => p.name === 'commit-commands');
    assert.ok(cc, 'commit-commands not found');
    assert.equal(cc.hasSkills, false);
    assert.equal(cc.hasCommands, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanMarketplace returns empty when no marketplaces dir', () => {
  const plugins = scanMarketplace('/nonexistent');
  assert.deepStrictEqual(plugins, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: FAIL — `scanMarketplace` not exported.

- [ ] **Step 3: Implement `scanMarketplace()`**

Add to `extension/plugins/claude-adapter.mjs`:

```js
/**
 * Scan Claude Code marketplace cache directories.
 * @param {string} [rootOverride] - Override root for tests
 * @returns {MarketplacePlugin[]}
 */
export function scanMarketplace(rootOverride) {
  const root = rootOverride || claudePluginsRoot();
  const mpRoot = join(root, 'marketplaces');
  if (!existsSync(mpRoot)) return [];

  const results = [];
  let marketplaceDirs;
  try { marketplaceDirs = readdirSync(mpRoot, { withFileTypes: true }); }
  catch { return []; }

  for (const mpEntry of marketplaceDirs) {
    if (!mpEntry.isDirectory()) continue;
    const pluginsDir = join(mpRoot, mpEntry.name, 'plugins');
    if (!existsSync(pluginsDir)) continue;

    let pluginDirs;
    try { pluginDirs = readdirSync(pluginsDir, { withFileTypes: true }); }
    catch { continue; }

    for (const pEntry of pluginDirs) {
      if (!pEntry.isDirectory()) continue;
      const pDir = join(pluginsDir, pEntry.name);
      const hasSkills = existsSync(join(pDir, 'skills'));
      const hasCommands = existsSync(join(pDir, 'commands'));
      // Read first line of README for description
      let description = '';
      const readmePath = join(pDir, 'README.md');
      if (existsSync(readmePath)) {
        try {
          const raw = readFileSync(readmePath, 'utf8');
          // Skip markdown heading, take first non-empty content line
          const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'));
          description = (lines[0] || '').trim().slice(0, 200);
        } catch { /* ignore */ }
      }
      results.push({
        name: pEntry.name,
        marketplace: mpEntry.name,
        description,
        hasSkills,
        hasCommands,
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/claude-adapter.mjs extension/tests/claude-adapter.test.mjs
git commit -m "feat(plugins): scanMarketplace reads Claude marketplace cache dirs"
```

---

### Task 4: Claude Adapter — `importPlugin()`

**Files:**
- Modify: `extension/plugins/claude-adapter.mjs`
- Modify: `extension/tests/claude-adapter.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { importPlugin } from '../plugins/claude-adapter.mjs';
import { loadPlugins } from '../plugins/loader.mjs';

function makeFakeClaudeWithSkills() {
  const root = mkdtempSync(join(tmpdir(), 'claude-import-'));
  // Marketplace plugin
  const pDir = join(root, 'marketplaces', 'claude-plugins-official', 'plugins', 'code-review');
  mkdirSync(join(pDir, 'skills', 'code-review'), { recursive: true });
  writeFileSync(join(pDir, 'skills', 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: Review code\n---\n# Code Review\nReview diffs.', 'utf8');
  mkdirSync(join(pDir, 'commands'), { recursive: true });
  writeFileSync(join(pDir, 'commands', 'review.md'), '---\nargs:\n  url:\n    type: string\n    required: true\n---\nReview the PR at {{url}}.', 'utf8');
  return root;
}

test('importPlugin converts Claude plugin into LLM IDE format', () => {
  const claudeRoot = makeFakeClaudeWithSkills();
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-plugins-'));
  try {
    const result = importPlugin({
      claudeRoot,
      llmidePluginDir: mnRoot,
      source: 'marketplace',
      name: 'code-review',
    });
    assert.equal(result.ok, true);
    assert.equal(result.plugin.name, 'claude-code-review');
    assert.ok(result.plugin.skillCount >= 1);
    assert.ok(result.plugin.commandCount >= 1);
    // Verify the LLM IDE plugin was created with correct manifest
    const manifest = JSON.parse(readFileSync(join(mnRoot, 'claude-code-review', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'claude-code-review');
    assert.equal(manifest.origin, 'claude');
    assert.equal(manifest.sourcePlugin, 'code-review');
    // Verify the plugin loads through LLM IDE loader
    const { plugins, warnings } = loadPlugins({ pluginDir: mnRoot });
    assert.ok(plugins.has('claude-code-review'), 'plugin not loaded by LLM IDE loader');
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('importPlugin rejects if plugin not found in Claude dirs', () => {
  const claudeRoot = mkdtempSync(join(tmpdir(), 'claude-empty-'));
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-empty-'));
  try {
    const result = importPlugin({
      claudeRoot,
      llmidePluginDir: mnRoot,
      source: 'marketplace',
      name: 'nonexistent',
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: FAIL — `importPlugin` not exported.

- [ ] **Step 3: Implement `importPlugin()`**

Add to `extension/plugins/claude-adapter.mjs`:

```js
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { defaultPluginDir } from './loader.mjs';

// Reuse the existing security scanners from the loader
import { loadPlugins } from './loader.mjs';

/**
 * Import a Claude Code plugin into LLM IDE' plugin directory.
 *
 * @param {object} opts
 * @param {string} [opts.claudeRoot] - Override Claude plugins root
 * @param {string} [opts.llmidePluginDir] - Override LLM IDE plugin dir
 * @param {'installed'|'marketplace'} opts.source - Where to find the plugin
 * @param {string} opts.name - Plugin name (e.g. 'code-review')
 * @returns {{ ok: boolean, plugin?: object, error?: string }}
 */
export function importPlugin(opts) {
  const claudeRoot = opts.claudeRoot || claudePluginsRoot();
  const mnDir = opts.llmidePluginDir || defaultPluginDir();
  const { source, name } = opts;

  // 1. Locate the source plugin directory
  const sourceDir = findClaudePlugin(claudeRoot, source, name);
  if (!sourceDir) {
    return { ok: false, error: `Plugin '${name}' not found in Claude ${source} directory` };
  }

  // 2. Build LLM IDE plugin name and target dir
  const mnName = `claude-${name}`;
  const targetDir = join(mnDir, mnName);

  // 3. Read version from package.json if present
  let version = '0.0.0';
  const pkgPath = join(sourceDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.version === 'string') version = pkg.version;
    } catch { /* use default */ }
  }

  // 4. Create target directory and write plugin.json
  mkdirSync(targetDir, { recursive: true });
  const manifest = {
    name: mnName,
    version,
    displayName: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description: `Imported from Claude Code (${source})`,
    author: 'Claude Code',
    origin: 'claude',
    sourcePlugin: name,
    sourceMarketplace: source === 'marketplace' ? findMarketplaceName(claudeRoot, name) : null,
  };
  writeFileSync(join(targetDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 5. Copy skills — Claude format: skills/<name>/SKILL.md → LLM IDE: skills/<name>.md
  let skillCount = 0;
  const skillsDir = join(sourceDir, 'skills');
  if (existsSync(skillsDir)) {
    const targetSkills = join(targetDir, 'skills');
    mkdirSync(targetSkills, { recursive: true });
    skillCount = copySkills(skillsDir, targetSkills);
  }

  // 6. Copy commands — same format in both systems
  let commandCount = 0;
  const cmdsDir = join(sourceDir, 'commands');
  if (existsSync(cmdsDir)) {
    const targetCmds = join(targetDir, 'commands');
    mkdirSync(targetCmds, { recursive: true });
    commandCount = copyCmds(cmdsDir, targetCmds);
  }

  return {
    ok: true,
    plugin: {
      name: mnName,
      version,
      displayName: manifest.displayName,
      description: manifest.description,
      author: manifest.author,
      skillCount,
      commandCount,
      origin: 'claude',
    },
  };
}

function findClaudePlugin(root, source, name) {
  if (source === 'installed') {
    // Search in cache dirs
    const cacheDir = join(root, 'cache');
    if (!existsSync(cacheDir)) return null;
    try {
      for (const mp of readdirSync(cacheDir, { withFileTypes: true })) {
        if (!mp.isDirectory()) continue;
        const pluginDir = join(cacheDir, mp.name, name);
        if (existsSync(pluginDir)) {
          // Find the version subdirectory (e.g., cache/mp/plugin/1.0.0/)
          const versions = readdirSync(pluginDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort()
            .reverse();
          if (versions.length > 0) return join(pluginDir, versions[0]);
          return pluginDir;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  if (source === 'marketplace') {
    const mpRoot = join(root, 'marketplaces');
    if (!existsSync(mpRoot)) return null;
    try {
      for (const mp of readdirSync(mpRoot, { withFileTypes: true })) {
        if (!mp.isDirectory()) continue;
        const pDir = join(mpRoot, mp.name, 'plugins', name);
        if (existsSync(pDir)) return pDir;
      }
    } catch { /* ignore */ }
    return null;
  }

  return null;
}

function findMarketplaceName(root, pluginName) {
  const mpRoot = join(root, 'marketplaces');
  if (!existsSync(mpRoot)) return null;
  try {
    for (const mp of readdirSync(mpRoot, { withFileTypes: true })) {
      if (!mp.isDirectory()) continue;
      if (existsSync(join(mpRoot, mp.name, 'plugins', pluginName))) return mp.name;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Copy Claude skill files into LLM IDE format.
 * Claude: skills/<name>/SKILL.md  →  LLM IDE: skills/<name>.md
 * Also handles flat skills/<name>.md directly.
 */
function copySkills(src, dst) {
  let count = 0;
  const MAX_BYTES = 32_768;
  try {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Claude nested format: skills/<name>/SKILL.md
        const skillFile = join(src, entry.name, 'SKILL.md');
        if (existsSync(skillFile)) {
          const stat = statSync(skillFile);
          if (stat.size <= MAX_BYTES) {
            copyFileSync(skillFile, join(dst, `${entry.name}.md`));
            count++;
          }
        }
      } else if (entry.name.endsWith('.md')) {
        // Flat format: skills/<name>.md
        const stat = statSync(join(src, entry.name));
        if (stat.size <= MAX_BYTES) {
          copyFileSync(join(src, entry.name), join(dst, entry.name));
          count++;
        }
      }
    }
  } catch { /* ignore */ }
  return count;
}

function copyCmds(src, dst) {
  let count = 0;
  const MAX_BYTES = 16_384;
  try {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const stat = statSync(join(src, entry.name));
      if (stat.size <= MAX_BYTES) {
        copyFileSync(join(src, entry.name), join(dst, entry.name));
        count++;
      }
    }
  } catch { /* ignore */ }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/claude-adapter.mjs extension/tests/claude-adapter.test.mjs
git commit -m "feat(plugins): importPlugin converts Claude plugins to LLM IDE format"
```

---

### Task 5: API Routes — Claude plugin endpoints

**Files:**
- Modify: `extension/server/auth-routes.mjs` (add 4 routes after existing plugin routes)

- [ ] **Step 1: Write the failing test**

```js
// Add to extension/tests/claude-adapter.test.mjs
// Integration test: verify the adapter functions work end-to-end
// (Route tests require the full server; we test the adapter layer directly)

test('full round-trip: scan → import → verify', () => {
  const claudeRoot = makeFakeClaudeWithSkills();
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-roundtrip-'));
  try {
    // Scan marketplace
    const marketplace = scanMarketplace(claudeRoot);
    assert.ok(marketplace.some(p => p.name === 'code-review'));

    // Import
    const result = importPlugin({
      claudeRoot,
      llmidePluginDir: mnRoot,
      source: 'marketplace',
      name: 'code-review',
    });
    assert.equal(result.ok, true);

    // Verify via LLM IDE loader
    const { plugins } = loadPlugins({ pluginDir: mnRoot });
    const imported = plugins.get('claude-code-review');
    assert.ok(imported, 'imported plugin not found in loader');
    assert.ok(imported.skills.length >= 1, 'no skills loaded');
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it passes** (this uses already-implemented functions)

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: PASS

- [ ] **Step 3: Add API routes to `auth-routes.mjs`**

Add after the existing `DELETE /auth/me/plugins/uninstall/` block (around line 645):

```js
  // ── Claude Plugin Bridge ───────────────────────────────────────────
  // GET  /auth/me/claude-plugins/installed   → scan Claude Code installed plugins
  // GET  /auth/me/claude-plugins/marketplace → scan Claude marketplace cache
  // POST /auth/me/claude-plugins/import      → import a plugin into LLM IDE
  // POST /auth/me/claude-plugins/refresh     → re-scan Claude dirs

  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/installed') {
    const { scanInstalled } = await import('../plugins/claude-adapter.mjs');
    const plugins = scanInstalled();
    // Cross-reference with LLM IDE installed plugins to mark already-imported
    const { loadPlugins: mnPlugins } = await import('../plugins/loader.mjs');
    const mnInstalled = mnPlugins();
    for (const p of plugins) {
      p.alreadyImported = mnInstalled.plugins.has(`claude-${p.name}`);
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/marketplace') {
    const { scanMarketplace, scanInstalled } = await import('../plugins/claude-adapter.mjs');
    const plugins = scanMarketplace();
    const installed = scanInstalled();
    const installedNames = new Set(installed.map(p => p.name));
    const { loadPlugins: mnPlugins } = await import('../plugins/loader.mjs');
    const mnInstalled = mnPlugins();
    for (const p of plugins) {
      p.installedInClaude = installedNames.has(p.name);
      p.alreadyImported = mnInstalled.plugins.has(`claude-${p.name}`);
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'POST' && url === '/auth/me/claude-plugins/import') {
    const body = await readBody(req, false);
    if (!body || !body.name || !body.source) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'name and source required' } });
      return;
    }
    if (!['installed', 'marketplace'].includes(body.source)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'source must be installed or marketplace' } });
      return;
    }
    const { importPlugin } = await import('../plugins/claude-adapter.mjs');
    const result = importPlugin({ source: body.source, name: body.name });
    if (!result.ok) {
      send(res, 404, { error: { code: 'NOT_FOUND', message: result.error } });
      return;
    }
    // Reload so the runtime picks up the new plugin
    const { reloadPlugins } = await import('../llm_agent/runtime/route.mjs');
    reloadPlugins();
    auditLog(req, {
      action: 'claude-plugin.import', resource: result.plugin.name, outcome: 'success',
      detail: { source: body.source, version: result.plugin.version },
    });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/claude-plugins/refresh') {
    const { scanInstalled, scanMarketplace } = await import('../plugins/claude-adapter.mjs');
    const installed = scanInstalled();
    const marketplace = scanMarketplace();
    send(res, 200, { installed: installed.length, marketplace: marketplace.length });
    return;
  }
```

- [ ] **Step 4: Add the new paths to the auth check whitelist**

In the JWT middleware path check (around line 122), add:

```js
      || path === '/auth/me/claude-plugins/installed'
      || path === '/auth/me/claude-plugins/marketplace'
      || path === '/auth/me/claude-plugins/import'
      || path === '/auth/me/claude-plugins/refresh'
```

- [ ] **Step 5: Commit**

```bash
git add extension/server/auth-routes.mjs extension/tests/claude-adapter.test.mjs
git commit -m "feat(plugins): add Claude plugin bridge API routes"
```

---

### Task 6: Mac API Client — Claude plugin methods

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Auth.swift`

- [ ] **Step 1: Add response types**

Add after the existing `PluginUninstallResponse` struct:

```swift
// MARK: - Claude Plugin Bridge

struct ClaudePlugin: Decodable, Identifiable {
    let name: String
    let version: String
    let marketplace: String
    let installPath: String?
    let skillCount: Int
    let commandCount: Int
    var alreadyImported: Bool
    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, version, marketplace, installPath, skillCount, commandCount, alreadyImported
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.version = try c.decodeIfPresent(String.self, forKey: .version) ?? "0.0.0"
        self.marketplace = try c.decodeIfPresent(String.self, forKey: .marketplace) ?? "unknown"
        self.installPath = try c.decodeIfPresent(String.self, forKey: .installPath)
        self.skillCount = try c.decodeIfPresent(Int.self, forKey: .skillCount) ?? 0
        self.commandCount = try c.decodeIfPresent(Int.self, forKey: .commandCount) ?? 0
        self.alreadyImported = try c.decodeIfPresent(Bool.self, forKey: .alreadyImported) ?? false
    }
}

struct ClaudeMarketplacePlugin: Decodable, Identifiable {
    let name: String
    let marketplace: String
    let description: String
    let hasSkills: Bool
    let hasCommands: Bool
    var installedInClaude: Bool
    var alreadyImported: Bool
    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, marketplace, description, hasSkills, hasCommands, installedInClaude, alreadyImported
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.marketplace = try c.decodeIfPresent(String.self, forKey: .marketplace) ?? "unknown"
        self.description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        self.hasSkills = try c.decodeIfPresent(Bool.self, forKey: .hasSkills) ?? false
        self.hasCommands = try c.decodeIfPresent(Bool.self, forKey: .hasCommands) ?? false
        self.installedInClaude = try c.decodeIfPresent(Bool.self, forKey: .installedInClaude) ?? false
        self.alreadyImported = try c.decodeIfPresent(Bool.self, forKey: .alreadyImported) ?? false
    }
}

struct ClaudePluginsListResponse: Decodable {
    let plugins: [ClaudePlugin]
}

struct ClaudeMarketplaceListResponse: Decodable {
    let plugins: [ClaudeMarketplacePlugin]
}

struct ClaudeImportResponse: Decodable {
    let ok: Bool
    let plugin: ImportedPluginInfo?
    let error: String?
    struct ImportedPluginInfo: Decodable {
        let name: String
        let version: String
        let displayName: String
        let skillCount: Int
        let commandCount: Int
    }
}
```

- [ ] **Step 2: Add API methods**

Add to the `LlmIdeAPIClient` extension in the same file:

```swift
    // MARK: - Claude Plugin Bridge

    func listClaudeInstalled() async throws -> ClaudePluginsListResponse {
        try await get("/auth/me/claude-plugins/installed", authenticated: true)
    }

    func listClaudeMarketplace() async throws -> ClaudeMarketplaceListResponse {
        try await get("/auth/me/claude-plugins/marketplace", authenticated: true)
    }

    func importClaudePlugin(name: String, source: String) async throws -> ClaudeImportResponse {
        struct Req: Encodable { let name: String; let source: String }
        return try await post("/auth/me/claude-plugins/import",
                              body: Req(name: name, source: source),
                              authenticated: true)
    }

    func refreshClaudePlugins() async throws {
        struct Empty: Encodable {}
        struct Ack: Decodable { let installed: Int; let marketplace: Int }
        let _: Ack = try await post("/auth/me/claude-plugins/refresh",
                                    body: Empty(),
                                    authenticated: true)
    }
```

- [ ] **Step 3: Build to verify compilation**

Run: `cd mac && swift build -c release --product LlmIdeMac 2>&1 | grep -E "error:|Build of product"`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Auth.swift
git commit -m "feat(mac): add Claude plugin bridge API client methods"
```

---

### Task 7: Mac UI — Claude Import Sheet

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Library/ClaudePluginImportSheet.swift`

- [ ] **Step 1: Create the import sheet view**

```swift
import SwiftUI

/// Sheet for browsing and importing Claude Code plugins. Two tabs:
/// "Installed" (plugins already in Claude Code) and "Marketplace"
/// (available from Claude plugin catalogs).
struct ClaudePluginImportSheet: View {
    let api: LlmIdeAPIClient
    let onDismiss: () -> Void
    let onImported: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var tab: Tab = .installed
    @State private var installedPlugins: [ClaudePlugin] = []
    @State private var marketplacePlugins: [ClaudeMarketplacePlugin] = []
    @State private var loading = true
    @State private var error: String?
    @State private var importingName: String?
    @State private var importMessage: String?

    enum Tab: String, CaseIterable {
        case installed = "Installed in Claude"
        case marketplace = "Marketplace"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            if loading {
                Spacer()
                ProgressView("Scanning Claude Code plugins…")
                    .controlSize(.small)
                Spacer()
            } else if let err = error {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title2).foregroundStyle(.secondary)
                    Text(err).font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                Spacer()
            } else {
                list
            }

            if let msg = importMessage {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text(msg).font(.caption)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
        .frame(width: 520, minHeight: 400, idealHeight: 500, maxHeight: 600)
        .task { await load() }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Import from Claude Code")
                    .font(.headline)
                Text("Browse and import plugins from your Claude Code installation")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Done") { onDismiss() }
                .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(16)
    }

    // MARK: - List

    @ViewBuilder
    private var list: some View {
        switch tab {
        case .installed:
            if installedPlugins.isEmpty {
                emptyState(
                    icon: "puzzlepiece.extension",
                    title: "No Claude Code plugins found",
                    subtitle: "Install plugins in Claude Code first, then import them here."
                )
            } else {
                List(installedPlugins) { plugin in
                    installedRow(plugin)
                }
                .listStyle(.inset)
            }
        case .marketplace:
            if marketplacePlugins.isEmpty {
                emptyState(
                    icon: "building.columns",
                    title: "No marketplace data",
                    subtitle: "Open Claude Code to sync the plugin marketplace, then come back here."
                )
            } else {
                List(marketplacePlugins) { plugin in
                    marketplaceRow(plugin)
                }
                .listStyle(.inset)
            }
        }
    }

    // MARK: - Rows

    private func installedRow(_ plugin: ClaudePlugin) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "puzzlepiece.extension.fill")
                .foregroundStyle(.teal)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(plugin.name).font(.callout.weight(.medium))
                HStack(spacing: 4) {
                    Text("v\(plugin.version)").font(.caption2).foregroundStyle(.secondary)
                    if plugin.skillCount > 0 {
                        Text("·").foregroundStyle(.tertiary)
                        Text("\(plugin.skillCount) skill\(plugin.skillCount == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if plugin.commandCount > 0 {
                        Text("·").foregroundStyle(.tertiary)
                        Text("\(plugin.commandCount) cmd\(plugin.commandCount == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            importButton(name: plugin.name, source: "installed", alreadyImported: plugin.alreadyImported)
        }
        .padding(.vertical, 2)
    }

    private func marketplaceRow(_ plugin: ClaudeMarketplacePlugin) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "puzzlepiece.extension")
                .foregroundStyle(plugin.installedInClaude ? .teal : .secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(plugin.name).font(.callout.weight(.medium))
                    if plugin.hasSkills {
                        badge("skills", color: .green)
                    }
                    if plugin.hasCommands {
                        badge("cmds", color: .blue)
                    }
                }
                if !plugin.description.isEmpty {
                    Text(plugin.description)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            importButton(name: plugin.name, source: "marketplace", alreadyImported: plugin.alreadyImported)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func importButton(name: String, source: String, alreadyImported: Bool) -> some View {
        if alreadyImported {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .help("Already imported")
        } else if importingName == name {
            ProgressView().controlSize(.small)
        } else {
            Button("Import") {
                Task { await doImport(name: name, source: source) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func emptyState(icon: String, title: String, subtitle: String) -> some View {
        VStack(spacing: 8) {
            Spacer()
            Image(systemName: icon)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title).font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            Text(subtitle).font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(20)
    }

    // MARK: - Actions

    private func load() async {
        loading = true
        error = nil
        do {
            async let i = try api.listClaudeInstalled()
            async let m = try api.listClaudeMarketplace()
            let (iResp, mResp) = try await (i, m)
            installedPlugins = iResp.plugins
            marketplacePlugins = mResp.plugins
        } catch {
            self.error = "Could not scan Claude plugins: \(error.localizedDescription)"
        }
        loading = false
    }

    private func doImport(name: String, source: String) async {
        importingName = name
        importMessage = nil
        do {
            let resp = try await api.importClaudePlugin(name: name, source: source)
            if resp.ok, let p = resp.plugin {
                importMessage = "Imported \(p.displayName) (\(p.skillCount) skill\(p.skillCount == 1 ? "" : "s"), \(p.commandCount) cmd\(p.commandCount == 1 ? "" : "s"))"
                // Mark as imported in local state
                if let idx = installedPlugins.firstIndex(where: { $0.name == name }) {
                    installedPlugins[idx].alreadyImported = true
                }
                if let idx = marketplacePlugins.firstIndex(where: { $0.name == name }) {
                    marketplacePlugins[idx].alreadyImported = true
                }
                onImported()
            } else {
                importMessage = resp.error ?? "Import failed"
            }
        } catch {
            importMessage = "Import failed: \(error.localizedDescription)"
        }
        importingName = nil
        // Auto-clear success message after 4 seconds
        let msg = importMessage
        Task {
            try? await Task.sleep(for: .seconds(4))
            if importMessage == msg { importMessage = nil }
        }
    }
}
```

- [ ] **Step 2: Build to verify compilation**

Run: `cd mac && swift build -c release --product LlmIdeMac 2>&1 | grep -E "error:|Build of product"`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/ClaudePluginImportSheet.swift
git commit -m "feat(mac): add ClaudePluginImportSheet for browsing and importing"
```

---

### Task 8: Mac UI — Wire import sheet into PLUGINS section + Claude badge

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/PluginLibraryRow.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/PluginDetailView.swift`

- [ ] **Step 1: Add "Import from Claude Code" to the plugin install menu in LibraryView.swift**

In `pluginsHeader`, add to the `Menu` after the "Install from Git URL…" button and before the Divider:

```swift
                Divider()
                Button {
                    showingClaudeImportSheet = true
                } label: { Label("Import from Claude Code…", systemImage: "arrow.down.circle") }
```

Add state variable near `showingGitInstallSheet`:

```swift
    @State private var showingClaudeImportSheet = false
```

Add sheet modifier after the existing `pluginsHeader`'s `.sheet(isPresented: $showingGitInstallSheet)`:

```swift
        .sheet(isPresented: $showingClaudeImportSheet) {
            ClaudePluginImportSheet(api: api,
                onDismiss: { showingClaudeImportSheet = false },
                onImported: { Task { await refreshPlugins() } })
                .environmentObject(theme)
        }
```

- [ ] **Step 2: Add Claude badge to PluginLibraryRow.swift**

Replace the existing `HStack` content to add a "Claude" badge when the plugin name starts with `claude-`:

After the existing `if !plugin.enabled` badge block, add:

```swift
                    if plugin.name.hasPrefix("claude-") {
                        Text("Claude")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Color(red: 0.85, green: 0.55, blue: 0.25))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color(red: 0.85, green: 0.55, blue: 0.25).opacity(0.15))
                            .clipShape(Capsule())
                    }
```

- [ ] **Step 3: Add source info to PluginDetailView.swift**

In the `header` section, after the version/author `HStack`, add:

```swift
                    if plugin.name.hasPrefix("claude-") {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.caption2)
                                .foregroundStyle(Color(red: 0.85, green: 0.55, blue: 0.25))
                            Text("Imported from Claude Code")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
```

- [ ] **Step 4: Build to verify compilation**

Run: `cd mac && swift build -c release --product LlmIdeMac 2>&1 | grep -E "error:|Build of product"`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift \
        mac/Sources/LlmIdeMac/Views/Library/PluginLibraryRow.swift \
        mac/Sources/LlmIdeMac/Views/Library/PluginDetailView.swift
git commit -m "feat(mac): wire Claude import sheet, add Claude badge to plugin rows"
```

---

### Task 9: Full build + manual verification

**Files:** None (verification only)

- [ ] **Step 1: Run server-side tests**

Run: `cd extension && node --test tests/claude-adapter.test.mjs`
Expected: All tests PASS.

- [ ] **Step 2: Run full server test suite**

Run: `cd extension && npm test`
Expected: All tests pass (existing 4 known failures in path-traversal + password-reset are pre-existing, not caused by these changes).

- [ ] **Step 3: Build the Mac app**

Run: `cd mac && swift build -c release --product LlmIdeMac 2>&1 | grep -E "error:|Build of product"`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 4: Build the extension**

Run: `cd extension && npm run build`
Expected: Clean build with no errors.

- [ ] **Step 5: Deploy and verify UI**

Run: `cd mac && bash Scripts/build.sh && open LlmIdeMac.app`
Verify:
1. Profile menu → PLUGINS → `+` button shows "Import from Claude Code…"
2. Clicking opens the import sheet with two tabs
3. "Installed" tab shows any Claude Code plugins on the machine
4. "Marketplace" tab shows available plugins from the Claude catalog
5. Importing a plugin adds it to the PLUGINS section with a "Claude" badge
6. The enable/disable toggle works on imported plugins

- [ ] **Step 6: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address any build/test issues from Claude plugin bridge"
```
