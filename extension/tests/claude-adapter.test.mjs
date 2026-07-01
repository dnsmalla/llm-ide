import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudePluginsRoot, scanInstalled, scanMarketplace, importPlugin, listImportedNames, getImportedVersion, checkForUpdates } from '../plugins/claude-adapter.mjs';
import { loadPlugins } from '../plugins/loader.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';

test('claudePluginsRoot returns ~/.claude/plugins on macOS', () => {
  const root = claudePluginsRoot();
  assert.ok(root.endsWith('.claude/plugins'), `got: ${root}`);
  assert.ok(root.startsWith('/'), 'must be absolute');
});

function makeFakeClaudeDir() {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugins-'));
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

function makeFakeClaudeWithSkills() {
  const root = mkdtempSync(join(tmpdir(), 'claude-import-'));
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
    // Verify manifest
    const manifest = JSON.parse(readFileSync(join(mnRoot, 'claude-code-review', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'claude-code-review');
    assert.equal(manifest.origin, 'claude');
    assert.equal(manifest.sourcePlugin, 'code-review');
    // Verify LLM IDE loader can load it
    const { plugins } = loadPlugins({ pluginDir: mnRoot });
    assert.ok(plugins.has('claude-code-review'), 'plugin not loaded by LLM IDE loader');
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('full round-trip: scan → import → verify', () => {
  const claudeRoot = makeFakeClaudeWithSkills();
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-roundtrip-'));
  try {
    const marketplace = scanMarketplace(claudeRoot);
    assert.ok(marketplace.some(p => p.name === 'code-review'));

    const result = importPlugin({
      claudeRoot,
      llmidePluginDir: mnRoot,
      source: 'marketplace',
      name: 'code-review',
    });
    assert.equal(result.ok, true);

    const { plugins } = loadPlugins({ pluginDir: mnRoot });
    const imported = plugins.get('claude-code-review');
    assert.ok(imported, 'imported plugin not found in loader');
    assert.ok(imported.skillFiles.length >= 1, 'no skills loaded');
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('importPlugin does not double-prefix claude- names', () => {
  const claudeRoot = mkdtempSync(join(tmpdir(), 'claude-prefix-'));
  const pDir = join(claudeRoot, 'marketplaces', 'claude-plugins-official', 'plugins', 'claude-code-setup');
  mkdirSync(join(pDir, 'skills', 'setup'), { recursive: true });
  writeFileSync(join(pDir, 'skills', 'setup', 'SKILL.md'), '# Setup\nSetup guide.', 'utf8');
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-prefix-'));
  try {
    const result = importPlugin({
      claudeRoot,
      llmidePluginDir: mnRoot,
      source: 'marketplace',
      name: 'claude-code-setup',
    });
    assert.equal(result.ok, true);
    assert.equal(result.plugin.name, 'claude-code-setup');
    const manifest = JSON.parse(readFileSync(join(mnRoot, 'claude-code-setup', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'claude-code-setup');
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

test('countSkills only counts SKILL.md in nested dirs, not READMEs', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-count-'));
  const installed = {
    version: 2,
    plugins: {
      'test-plugin@official': [{
        scope: 'project',
        installPath: join(root, 'cache', 'official', 'test-plugin', '1.0.0'),
        version: '1.0.0',
      }],
    },
  };
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify(installed), 'utf8');
  const pDir = join(root, 'cache', 'official', 'test-plugin', '1.0.0');
  // Create a skill dir with SKILL.md + README.md
  mkdirSync(join(pDir, 'skills', 'my-skill'), { recursive: true });
  writeFileSync(join(pDir, 'skills', 'my-skill', 'SKILL.md'), '# Skill', 'utf8');
  writeFileSync(join(pDir, 'skills', 'my-skill', 'README.md'), '# Readme', 'utf8');
  // Create a nested dir without SKILL.md (just helper docs)
  mkdirSync(join(pDir, 'skills', 'docs'), { recursive: true });
  writeFileSync(join(pDir, 'skills', 'docs', 'guide.md'), '# Guide', 'utf8');
  // Create a flat skill
  writeFileSync(join(pDir, 'skills', 'quick.md'), '# Quick Skill', 'utf8');
  try {
    const plugins = scanInstalled(root);
    assert.equal(plugins.length, 1);
    // Should count 2: my-skill/SKILL.md + quick.md. NOT the README or guide.md
    assert.equal(plugins[0].skillCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listImportedNames returns plugin directory names', () => {
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-list-'));
  mkdirSync(join(mnRoot, 'claude-foo'));
  writeFileSync(join(mnRoot, 'claude-foo', 'plugin.json'), '{"name":"claude-foo"}', 'utf8');
  mkdirSync(join(mnRoot, 'my-plugin'));
  writeFileSync(join(mnRoot, 'my-plugin', 'plugin.json'), '{"name":"my-plugin"}', 'utf8');
  // Dir without plugin.json should be ignored
  mkdirSync(join(mnRoot, 'not-a-plugin'));
  try {
    const names = listImportedNames(mnRoot);
    assert.equal(names.size, 2);
    assert.ok(names.has('claude-foo'));
    assert.ok(names.has('my-plugin'));
    assert.ok(!names.has('not-a-plugin'));
  } finally {
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('getImportedVersion reads version from manifest', () => {
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-ver-'));
  mkdirSync(join(mnRoot, 'claude-test'));
  writeFileSync(join(mnRoot, 'claude-test', 'plugin.json'), JSON.stringify({ name: 'claude-test', version: '2.1.0' }), 'utf8');
  try {
    assert.equal(getImportedVersion('claude-test', mnRoot), '2.1.0');
    assert.equal(getImportedVersion('nonexistent', mnRoot), null);
  } finally {
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('checkForUpdates detects version mismatch', () => {
  const claudeRoot = makeFakeClaudeWithSkills();
  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-updates-'));
  // First import the plugin
  const result = importPlugin({
    claudeRoot,
    llmidePluginDir: mnRoot,
    source: 'marketplace',
    name: 'code-review',
  });
  assert.equal(result.ok, true);
  // Manually set a different version in the imported manifest to simulate stale import
  const manifestPath = join(mnRoot, 'claude-code-review', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = '0.9.0';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  // Now add a package.json to the source with a newer version
  const sourceDir = join(claudeRoot, 'marketplaces', 'claude-plugins-official', 'plugins', 'code-review');
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ version: '1.2.0' }), 'utf8');
  try {
    const updates = checkForUpdates({ claudeRoot, llmidePluginDir: mnRoot });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].name, 'claude-code-review');
    assert.equal(updates[0].importedVersion, '0.9.0');
    assert.equal(updates[0].sourceVersion, '1.2.0');
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});

test('imported skills pass skill-loader validation (kind + name injected)', () => {
  // Create a Claude plugin with a skill that has NO kind field (like real Claude Code skills)
  const claudeRoot = mkdtempSync(join(tmpdir(), 'claude-runtime-'));
  const pDir = join(claudeRoot, 'marketplaces', 'official', 'plugins', 'my-tool');
  mkdirSync(join(pDir, 'skills', 'helper'), { recursive: true });
  // Claude Code skill: has name + description but NO kind
  writeFileSync(join(pDir, 'skills', 'helper', 'SKILL.md'),
    '---\nname: helper\ndescription: "Helps with stuff"\n---\n# Helper\nDo helpful things.', 'utf8');
  // Another skill with no frontmatter at all
  writeFileSync(join(pDir, 'skills', 'quick.md'),
    '# Quick Skill\nA skill with no frontmatter.', 'utf8');

  const mnRoot = mkdtempSync(join(tmpdir(), 'mn-runtime-'));
  try {
    const result = importPlugin({
      claudeRoot,
      llmidePluginDir: mnRoot,
      source: 'marketplace',
      name: 'my-tool',
    });
    assert.equal(result.ok, true);
    assert.equal(result.plugin.skillCount, 2);

    // Now run the actual LLM IDE skill-loader on the imported skills
    const skillsDir = join(mnRoot, 'claude-my-tool', 'skills');
    const loaded = loadSkills(skillsDir);

    // Both skills should load successfully — no "kind undefined" warnings
    const kindWarnings = loaded.warnings.filter(w => w.includes("kind"));
    assert.equal(kindWarnings.length, 0, `Unexpected kind warnings: ${kindWarnings.join('; ')}`);

    // Skills should be in the map
    assert.ok(loaded.skills.has('helper'), 'helper skill not loaded');
    assert.ok(loaded.skills.has('quick'), 'quick skill not loaded');
    assert.equal(loaded.skills.get('helper').kind, 'read');
    assert.equal(loaded.skills.get('quick').kind, 'read');
    assert.ok(loaded.skills.get('helper').body.includes('Do helpful things'));
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(mnRoot, { recursive: true, force: true });
  }
});
