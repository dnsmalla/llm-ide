import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHome, scanInstalled, scanMarketplace, importPlugin, listImportedNames, getImportedVersion, checkForUpdates } from '../plugins/codex-adapter.mjs';
import { loadPlugins } from '../plugins/loader.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';

test('codexHome returns ~/.codex', () => {
  const root = codexHome();
  assert.ok(root.endsWith('.codex'), `got: ${root}`);
  assert.ok(root.startsWith('/'), 'must be absolute');
});

function writeCodexManifest(dir, manifest) {
  mkdirSync(join(dir, '.codex-plugin'), { recursive: true });
  writeFileSync(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

function makeFakeCodexHome() {
  const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
  writeFileSync(join(root, 'config.toml'), `
model = "gpt-5.4"

[marketplaces.openai-bundled]
last_updated = "2026-06-01T08:39:20Z"
source_type = "local"
source = "${join(root, 'marketplace-src')}"

[plugins."documents@openai-bundled"]
enabled = true
`, 'utf8');

  const pluginDir = join(root, 'plugins', 'cache', 'openai-bundled', 'documents', '26.521.10419');
  mkdirSync(pluginDir, { recursive: true });
  writeCodexManifest(pluginDir, { name: 'documents', version: '26.521.10419', description: 'Create and edit documents' });
  mkdirSync(join(pluginDir, 'skills', 'documents'), { recursive: true });
  writeFileSync(join(pluginDir, 'skills', 'documents', 'SKILL.md'), '---\nname: documents\ndescription: Edit docs\n---\n# Documents', 'utf8');
  return root;
}

test('scanInstalled returns codex plugins with metadata from config.toml', () => {
  const root = makeFakeCodexHome();
  try {
    const plugins = scanInstalled(root);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, 'documents');
    assert.equal(plugins[0].version, '26.521.10419');
    assert.equal(plugins[0].marketplace, 'openai-bundled');
    assert.equal(plugins[0].skillCount, 1);
    assert.equal(plugins[0].enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanInstalled returns empty array when config.toml is missing', () => {
  assert.deepStrictEqual(scanInstalled('/nonexistent/path'), []);
});

test('scanInstalled respects enabled = false', () => {
  const root = makeFakeCodexHome();
  const toml = readFileSync(join(root, 'config.toml'), 'utf8').replace('enabled = true', 'enabled = false');
  writeFileSync(join(root, 'config.toml'), toml, 'utf8');
  try {
    const plugins = scanInstalled(root);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFakeMarketplace(root) {
  const mpSrc = join(root, 'marketplace-src');
  writeFileSync(join(root, 'config.toml'), `
[marketplaces.openai-bundled]
source_type = "local"
source = "${mpSrc}"
`, 'utf8');

  const feDir = join(mpSrc, 'plugins', 'frontend-design');
  mkdirSync(join(feDir, 'skills', 'frontend-design'), { recursive: true });
  writeFileSync(join(feDir, 'skills', 'frontend-design', 'SKILL.md'), '# FE Design', 'utf8');
  writeCodexManifest(feDir, { name: 'frontend-design', version: '1.0.0', description: 'Build UIs with best practices.' });

  const browserDir = join(mpSrc, 'plugins', 'browser');
  mkdirSync(browserDir, { recursive: true });
  writeCodexManifest(browserDir, { name: 'browser', version: '0.1.0', description: 'Control the in-app browser.' });
  return root;
}

test('scanMarketplace returns marketplace plugins from config.toml sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-mp-'));
  makeFakeMarketplace(root);
  try {
    const plugins = scanMarketplace(root);
    assert.ok(plugins.length >= 2);
    const fe = plugins.find((p) => p.name === 'frontend-design');
    assert.ok(fe, 'frontend-design not found');
    assert.equal(fe.hasSkills, true);
    assert.equal(fe.description, 'Build UIs with best practices.');
    const browser = plugins.find((p) => p.name === 'browser');
    assert.ok(browser, 'browser not found');
    assert.equal(browser.hasSkills, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanMarketplace returns empty when config.toml has no marketplaces', () => {
  assert.deepStrictEqual(scanMarketplace('/nonexistent'), []);
});

function makeFakeCodexWithSkills() {
  const root = mkdtempSync(join(tmpdir(), 'codex-import-'));
  const mpSrc = join(root, 'marketplace-src');
  writeFileSync(join(root, 'config.toml'), `
[marketplaces.openai-bundled]
source_type = "local"
source = "${mpSrc}"
`, 'utf8');
  const pDir = join(mpSrc, 'plugins', 'documents');
  mkdirSync(join(pDir, 'skills', 'documents'), { recursive: true });
  writeFileSync(join(pDir, 'skills', 'documents', 'SKILL.md'), '---\nname: documents\ndescription: Edit docs\n---\n# Documents\nEdit document artifacts.', 'utf8');
  writeCodexManifest(pDir, { name: 'documents', version: '1.5.0', description: 'Create and edit document artifacts.' });
  return root;
}

// Every real Codex plugin carries `.codex-plugin/plugin.json`, so import
// copies the tree whole and llm-ide's loader reads that manifest in place —
// no generated root manifest, no flattened skills.
test('importPlugin copies a manifest-bearing Codex plugin whole', () => {
  const codexRoot = makeFakeCodexWithSkills();
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-codex-'));
  try {
    const result = importPlugin({ codexRoot, llmidePluginDir: mnRoot, source: 'marketplace', name: 'documents' });
    assert.equal(result.ok, true);
    assert.equal(result.plugin.name, 'codex-documents');
    assert.equal(result.plugin.version, '1.5.0');
    assert.ok(result.plugin.skillCount >= 1);
    assert.equal(result.plugin.origin, 'codex');
    const target = join(mnRoot, 'codex-documents');
    assert.ok(!existsSync(join(target, 'plugin.json')), 'no generated root manifest');
    assert.ok(existsSync(join(target, 'skills', 'documents', 'SKILL.md')), 'nested layout preserved');
    const manifest = JSON.parse(readFileSync(join(target, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'codex-documents', 'name namespaced to the directory');
    assert.equal(manifest.description, 'Create and edit document artifacts.', 'rest preserved verbatim');
    const { plugins } = loadPlugins({ pluginDir: mnRoot });
    const p = plugins.get('codex-documents');
    assert.ok(p, 'plugin not loaded by llm-ide loader');
    assert.equal(p.format, 'claude');
    assert.equal(p.skillFiles.length, 1);
  } finally {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('importPlugin does not double-prefix codex- names', () => {
  const codexRoot = mkdtempSync(join(tmpdir(), 'codex-prefix-'));
  const mpSrc = join(codexRoot, 'marketplace-src');
  writeFileSync(join(codexRoot, 'config.toml'), `[marketplaces.mp]\nsource = "${mpSrc}"\n`, 'utf8');
  const pDir = join(mpSrc, 'plugins', 'codex-setup');
  mkdirSync(join(pDir, 'skills', 'setup'), { recursive: true });
  writeFileSync(join(pDir, 'skills', 'setup', 'SKILL.md'), '# Setup', 'utf8');
  writeCodexManifest(pDir, { name: 'codex-setup', version: '1.0.0', description: 'Setup guide.' });
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-codex-prefix-'));
  try {
    const result = importPlugin({ codexRoot, llmidePluginDir: mnRoot, source: 'marketplace', name: 'codex-setup' });
    assert.equal(result.ok, true);
    assert.equal(result.plugin.name, 'codex-setup');
  } finally {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('importPlugin rejects if plugin not found in Codex dirs', () => {
  const codexRoot = mkdtempSync(join(tmpdir(), 'codex-empty-'));
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-empty-'));
  try {
    const result = importPlugin({ codexRoot, llmidePluginDir: mnRoot, source: 'marketplace', name: 'nonexistent' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  } finally {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('full round-trip: scan installed → import → verify (real cache/version layout)', () => {
  const codexRoot = makeFakeCodexHome();
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-codex-roundtrip-'));
  try {
    const installed = scanInstalled(codexRoot);
    assert.ok(installed.some((p) => p.name === 'documents'));

    const result = importPlugin({ codexRoot, llmidePluginDir: mnRoot, source: 'installed', name: 'documents' });
    assert.equal(result.ok, true);

    const { plugins } = loadPlugins({ pluginDir: mnRoot });
    const imported = plugins.get('codex-documents');
    assert.ok(imported, 'imported plugin not found in loader');
    assert.ok(imported.skillFiles.length >= 1, 'no skills loaded');
  } finally {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('listImportedNames / getImportedVersion work for codex-* plugins (shared with claude-adapter)', () => {
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-codex-list-'));
  mkdirSync(join(mnRoot, 'codex-foo'));
  writeFileSync(join(mnRoot, 'codex-foo', 'plugin.json'), JSON.stringify({ name: 'codex-foo', version: '3.0.0' }), 'utf8');
  try {
    const names = listImportedNames(mnRoot);
    assert.ok(names.has('codex-foo'));
    assert.equal(getImportedVersion('codex-foo', mnRoot), '3.0.0');
  } finally {
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('checkForUpdates detects version mismatch against Codex source', () => {
  const codexRoot = makeFakeCodexWithSkills();
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-codex-updates-'));
  const result = importPlugin({ codexRoot, llmidePluginDir: mnRoot, source: 'marketplace', name: 'documents' });
  assert.equal(result.ok, true);
  // A whole-tree import keeps its version in the vendor manifest.
  const manifestPath = join(mnRoot, 'codex-documents', '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = '1.0.0'; // simulate a stale import vs the 1.5.0 source
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  try {
    const updates = checkForUpdates({ codexRoot, llmidePluginDir: mnRoot });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].name, 'codex-documents');
    assert.equal(updates[0].importedVersion, '1.0.0');
    assert.equal(updates[0].sourceVersion, '1.5.0');
  } finally {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('imported Codex skills pass skill-loader validation (kind + name injected)', () => {
  const codexRoot = mkdtempSync(join(tmpdir(), 'codex-runtime-'));
  const mpSrc = join(codexRoot, 'marketplace-src');
  writeFileSync(join(codexRoot, 'config.toml'), `[marketplaces.mp]\nsource = "${mpSrc}"\n`, 'utf8');
  const pDir = join(mpSrc, 'plugins', 'my-tool');
  mkdirSync(join(pDir, 'skills', 'helper'), { recursive: true });
  // Real Codex skills have name + description but NO kind field.
  writeFileSync(join(pDir, 'skills', 'helper', 'SKILL.md'),
    '---\nname: helper\ndescription: "Helps with stuff"\n---\n# Helper\nDo helpful things.', 'utf8');
  writeCodexManifest(pDir, { name: 'my-tool', version: '1.0.0', description: 'A tool.' });

  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-codex-runtime-'));
  try {
    const result = importPlugin({ codexRoot, llmidePluginDir: mnRoot, source: 'marketplace', name: 'my-tool' });
    assert.equal(result.ok, true);
    assert.equal(result.plugin.skillCount, 1);

    const loaded = loadSkills(join(mnRoot, 'codex-my-tool', 'skills'));
    const kindWarnings = loaded.warnings.filter((w) => w.includes('kind'));
    assert.equal(kindWarnings.length, 0, `Unexpected kind warnings: ${kindWarnings.join('; ')}`);
    assert.ok(loaded.skills.has('helper'), 'helper skill not loaded');
    assert.equal(loaded.skills.get('helper').kind, 'read');
    assert.ok(loaded.skills.get('helper').body.includes('Do helpful things'));
  } finally {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('whole-tree Codex import preserves agents/ and catalogues inert components', () => {
  const codexRoot = mkdtempSync(join(tmpdir(), 'codex-tree-'));
  const mpSrc = join(codexRoot, 'marketplace-src');
  writeFileSync(join(codexRoot, 'config.toml'), `[marketplaces.mp]\nsource = "${mpSrc}"\n`, 'utf8');
  const pDir = join(mpSrc, 'plugins', 'treeplug');
  mkdirSync(join(pDir, 'skills', 'nested'), { recursive: true });
  writeFileSync(join(pDir, 'skills', 'nested', 'SKILL.md'),
    '---\nname: nested\ndescription: nested skill\n---\nBody.', 'utf8');
  mkdirSync(join(pDir, 'agents'), { recursive: true });
  writeFileSync(join(pDir, 'agents', 'researcher.md'),
    '---\ndescription: researches\ntools: Read\nmaxTurns: 9\n---\nYou research.', 'utf8');
  mkdirSync(join(pDir, 'hooks'), { recursive: true });
  writeFileSync(join(pDir, 'hooks', 'hooks.json'), '{}', 'utf8');
  mkdirSync(join(pDir, 'themes'), { recursive: true });
  writeCodexManifest(pDir, { name: 'treeplug', version: '1.0.0', description: 'A tree.' });
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-codex-tree-'));
  try {
    assert.equal(importPlugin({ codexRoot, llmidePluginDir: mnRoot, source: 'marketplace', name: 'treeplug' }).ok, true);
    const { plugins } = loadPlugins({ pluginDir: mnRoot });
    const p = plugins.get('codex-treeplug');
    assert.ok(p, 'plugin not loaded');
    assert.ok(p.subagents.researcher, 'agents/ must no longer be dropped');
    assert.equal(p.subagents.researcher.maxIterations, 5, 'maxTurns clamped');
    assert.deepEqual(p.pendingComponents, ['hooks'], 'hooks are catalogued, never run');
    assert.deepEqual(p.unsupportedComponents, ['themes']);
    const loaded = loadSkills(join(mnRoot, 'codex-treeplug', 'skills'));
    assert.ok(loaded.skills.has('nested'), 'nested skill not loadable at runtime');
  } finally {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});
