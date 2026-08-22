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

test('missing plugin directory is the default state, not a warning (clean boot)', () => {
  const absent = join(newRoot(), 'does-not-exist');
  const { plugins, warnings, missing } = loadPlugins({ pluginDir: absent });
  assert.equal(plugins.size, 0);
  assert.equal(warnings.length, 0, `absence must not warn, got: ${warnings.join(', ')}`);
  assert.equal(missing, true, 'absence is surfaced via the missing flag');
});

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

// Regression: a template with NO {{}} placeholders at all (the norm for
// commands imported from Claude Code's own marketplace, e.g. the official
// code-review plugin — it expects a PR number as a bare positional argument,
// a convention this parser doesn't otherwise understand) must not silently
// drop whatever the user typed after the trigger. Before this fix,
// `/review` and `/review 123` expanded to byte-identical prompts — the "123"
// was parsed into args._rest and then never used anywhere, so the agent had
// nothing to review no matter what the user supplied.
test('slash: free-form argument is appended when the template has no placeholders at all', () => {
  const cmds = new Map([
    ['review', { description: '', args: {}, template: 'Review the given pull request.' }],
  ]);
  const bare = expandSlashCommand('/review', cmds);
  const withArg = expandSlashCommand('/review 123', cmds);
  assert.equal(bare.prompt, 'Review the given pull request.');
  assert.equal(withArg.prompt, 'Review the given pull request.\n\n123');
  assert.notEqual(bare.prompt, withArg.prompt, 'the PR number must actually reach the model');
});

test('slash: explicit {{_rest}} placeholder is not double-appended', () => {
  const cmds = new Map([
    ['hello', { description: '', args: {}, template: 'Greet: {{_rest}}' }],
  ]);
  const out = expandSlashCommand('/hello world', cmds);
  assert.equal(out.prompt, 'Greet: world', 'must appear exactly once, not "Greet: world\\n\\nworld"');
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

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
  rmSync(root, { recursive: true, force: true });
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
  const p = plugins.get('example');
  assert.equal(p?.skillFiles.length, 1);
  assert.ok(p.skillsDir.endsWith('custom-skills'),
    'the resolved skills dir travels with the plugin so the runtime reloads the same files');
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

test('vendor: a skills subdirectory without SKILL.md is not a skill', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'references'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, 'skills', 'references', 'notes.md'), 'not a skill', 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(plugins.get('example')?.skillFiles.length, 0);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  rmSync(root, { recursive: true, force: true });
});

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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

test('vendor agent: allowed_tools wins over tools when both are present', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, {
    'agents/s.md': `---
description: x
allowed_tools: [search-kb]
tools: Read, Bash
---
Body.`,
  });
  const { plugins } = loadPlugins({ pluginDir: root });
  assert.deepEqual(plugins.get('example')?.subagents.s.allowedTools, ['search-kb']);
  rmSync(root, { recursive: true, force: true });
});

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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

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
  // The catalogue must NOT be a warning: the installer fails a bundle on any
  // loader warning, and a real vendor package shipping themes/ must install.
  assert.equal(warnings.length, 0, `catalogue must not warn, got: ${warnings.join(', ')}`);
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

// --- Plugin-declared MCP servers (.mcp.json) ---

test('vendor: .mcp.json servers are parsed into declarations', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      local: { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: '${TOKEN}' } },
      hosted: { type: 'http', url: 'https://mcp.example.com/v1', headers: { 'X-A': 'b' } },
    },
  }), 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const p = plugins.get('example');
  assert.deepEqual(p.mcpServers.map((s) => s.name).sort(), ['hosted', 'local']);
  const local = p.mcpServers.find((s) => s.name === 'local');
  assert.equal(local.transport, 'stdio');
  assert.equal(local.command, 'npx');
  assert.deepEqual(local.args, ['-y', 'srv']);
  assert.deepEqual(local.env, { TOKEN: '${TOKEN}' });
  const hosted = p.mcpServers.find((s) => s.name === 'hosted');
  assert.equal(hosted.transport, 'http');
  assert.equal(hosted.url, 'https://mcp.example.com/v1');
  assert.deepEqual(hosted.headers, { 'X-A': 'b' });
  // Still catalogued as pending — nothing is active until the user consents.
  assert.deepEqual(p.pendingComponents, ['mcp']);
  rmSync(root, { recursive: true, force: true });
});

test('vendor: a malformed .mcp.json warns and yields no declarations', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, '.mcp.json'), '{ not json', 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.deepEqual(plugins.get('example')?.mcpServers, []);
  assert.ok(warnings.some((w) => w.includes('.mcp.json')), warnings.join(', '));
  rmSync(root, { recursive: true, force: true });
});

test('vendor: a server with neither command nor url is rejected', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { broken: { note: 'nothing runnable' }, ok: { command: 'srv' } },
  }), 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.deepEqual(plugins.get('example').mcpServers.map((s) => s.name), ['ok']);
  assert.ok(warnings.some((w) => w.includes('broken')), warnings.join(', '));
  rmSync(root, { recursive: true, force: true });
});

test('vendor: a non-http(s) url is refused rather than passed downstream', () => {
  const root = newRoot();
  const dir = join(root, 'example');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { sneaky: { type: 'http', url: 'file:///etc/passwd' } },
  }), 'utf8');
  const { plugins, warnings } = loadPlugins({ pluginDir: root });
  assert.deepEqual(plugins.get('example').mcpServers, []);
  assert.ok(warnings.some((w) => w.includes('sneaky')), warnings.join(', '));
  rmSync(root, { recursive: true, force: true });
});

test('own format: no mcp declarations are read even if a .mcp.json exists', () => {
  const root = newRoot();
  plugin(root, 'example', validManifest, { '.mcp.json': JSON.stringify({ mcpServers: { x: { command: 'y' } } }) });
  const { plugins } = loadPlugins({ pluginDir: root });
  assert.deepEqual(plugins.get('example').mcpServers, []);
  rmSync(root, { recursive: true, force: true });
});
