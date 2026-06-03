// Tests for extension/plugins/loader.mjs — discovery + validation of
// plugin folders, with particular focus on the new subagent type.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPlugins, expandSlashCommand } from '../plugins/loader.mjs';

function newRoot() {
  return mkdtempSync(join(tmpdir(), 'plugins-loader-'));
}

function plugin(root, name, manifest, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return dir;
}

const validManifest = {
  name: 'example',
  version: '0.1.0',
  displayName: 'Example',
  description: 'test',
};

test('subagent: valid agents/*.md is discovered with parsed metadata', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/summarizer.md': `---
description: Make summaries
allowed_tools: [search-kb]
maxIterations: 2
---
# Summarizer
You are a summarizer.`,
  });
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const p = plugins.get('example');
  assert.ok(p, 'plugin missing');
  const sub = p.subagents.summarizer;
  assert.ok(sub, 'summarizer subagent missing');
  assert.equal(sub.description, 'Make summaries');
  assert.deepEqual(sub.allowedTools, ['search-kb']);
  assert.equal(sub.maxIterations, 2);
  assert.match(sub.systemPrompt, /You are a summarizer/);
  rmSync(root, { recursive: true, force: true });
});

test('subagent: empty body is rejected with a warning', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/empty.md': `---
description: foo
---
`,
  });
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('example').subagents.empty, undefined);
  assert.ok(warnings.some((w) => w.includes('agents/empty.md') && w.includes('empty body')),
    `expected an 'empty body' warning, got: ${warnings.join(', ')}`);
  rmSync(root, { recursive: true, force: true });
});

test('subagent: filename with invalid characters is rejected', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/BAD!.md': `---
description: x
---
body`,
  });
  const { warnings } = loadPlugins({ pluginDir: root });
  assert.ok(warnings.some((w) => w.includes('subagent name invalid')),
    `expected invalid-name warning, got: ${warnings.join(', ')}`);
  rmSync(root, { recursive: true, force: true });
});

test('subagent: missing frontmatter still parses (body becomes the prompt)', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/plain.md': 'Just a body, no frontmatter.',
  });
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  const sub = plugins.get('example').subagents.plain;
  assert.ok(sub, `expected subagent, warnings=${warnings.join(', ')}`);
  assert.equal(sub.description, '');
  assert.deepEqual(sub.allowedTools, []);
  assert.equal(sub.maxIterations, 3);   // default
  assert.match(sub.systemPrompt, /Just a body/);
  rmSync(root, { recursive: true, force: true });
});

test('subagent: maxIterations is capped server-side at 5', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/long.md': `---
description: x
maxIterations: 99
---
body`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('example').subagents.long.maxIterations, 5);
  rmSync(root, { recursive: true, force: true });
});

test('subagent: allowed_tools entries with invalid slugs are dropped silently', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/picky.md': `---
description: x
allowed_tools: [search-kb, "BAD TOOL", 42, "another-valid"]
---
body`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  // Filter keeps only strings matching /^[a-z][a-z0-9-]{0,40}$/
  assert.deepEqual(plugins.get('example').subagents.picky.allowedTools,
    ['search-kb', 'another-valid']);
  rmSync(root, { recursive: true, force: true });
});

test('subagent: agents/ directory missing → empty subagents map, no warnings', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {});
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.deepEqual(plugins.get('example').subagents, {});
  assert.equal(warnings.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('manifest: reserved name "system" rejected with warning', () => {
  const root = newRoot();
  plugin(root, 'system-plugin', { ...validManifest, name: 'system' });
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.size, 0);
  assert.ok(warnings.some((w) => w.includes('reserved')));
  rmSync(root, { recursive: true, force: true });
});

test('manifest: bad slug rejected', () => {
  const root = newRoot();
  plugin(root, 'bad-slug', { ...validManifest, name: 'Has Spaces' });
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.size, 0);
  assert.ok(warnings.some((w) => w.includes('name must match')));
  rmSync(root, { recursive: true, force: true });
});

test('manifest: duplicate name across folders — first wins', () => {
  const root = newRoot();
  plugin(root, 'a', { ...validManifest, name: 'dup' });
  plugin(root, 'b', { ...validManifest, name: 'dup' });
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.size, 1);
  assert.ok(warnings.some((w) => w.includes('duplicate plugin name')));
  rmSync(root, { recursive: true, force: true });
});

test('slash: command parses key=value and folds remainder into _rest', () => {
  const cmds = new Map([
    ['hello', {
      description: '',
      args: { name: { type: 'string', required: false, description: '' } },
      template: 'Greet {{name}}: {{_rest}}',
    }],
  ]);
  const out = expandSlashCommand('/hello name=Alice the rest goes here', cmds);
  assert.equal(out.trigger, 'hello');
  assert.equal(out.args.name, 'Alice');
  assert.equal(out.args._rest, 'the rest goes here');
  assert.equal(out.prompt, 'Greet Alice: the rest goes here');
});

test('slash: required arg missing yields error envelope (not crash)', () => {
  const cmds = new Map([
    ['need', {
      description: '',
      args: { who: { type: 'string', required: true, description: '' } },
      template: '{{who}}',
    }],
  ]);
  const out = expandSlashCommand('/need', cmds);
  assert.equal(out.trigger, 'need');
  assert.match(out.error, /Missing required argument 'who'/);
});

test('slash: unknown trigger returns null (lets caller fall through to normal prompt)', () => {
  const cmds = new Map();
  assert.equal(expandSlashCommand('/nope x y z', cmds), null);
});

test('slash: malformed leading slash patterns return null', () => {
  const cmds = new Map([['t', { description: '', args: {}, template: 'x' }]]);
  assert.equal(expandSlashCommand('', cmds), null);
  assert.equal(expandSlashCommand('/', cmds), null);
  assert.equal(expandSlashCommand('///t', cmds), null);
  assert.equal(expandSlashCommand('/UPPER', cmds), null);
  // Plain text starting with non-/ should not invoke the parser.
  assert.equal(expandSlashCommand('hello /t', cmds), null);
});

test('slash: quoted values support spaces', () => {
  const cmds = new Map([
    ['q', {
      description: '', args: { reason: { type: 'string', required: false, description: '' } },
      template: '{{reason}}',
    }],
  ]);
  const out = expandSlashCommand('/q reason="multi word value"', cmds);
  assert.equal(out.args.reason, 'multi word value');
  assert.equal(out.prompt, 'multi word value');
});
