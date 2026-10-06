import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerSpec, withVersion } from '../mcp/package-spec.mjs';

const p = (command, args) => parseRunnerSpec({ command, args });

test('parseRunnerSpec formats', () => {
  const cases = [
    ['npx', ['-y', '@modelcontextprotocol/server-memory'], { runner: 'npx', name: '@modelcontextprotocol/server-memory', version: null, tag: null, argIndex: 1 }],
    ['npx', ['-y', '@scope/pkg@1.2.3'], { runner: 'npx', name: '@scope/pkg', version: '1.2.3', tag: null, argIndex: 1 }],
    ['npx', ['pkg@1.2.3-beta.1', 'x'], { runner: 'npx', name: 'pkg', version: '1.2.3-beta.1', tag: null, argIndex: 0 }],
    ['npx', ['-y', '@playwright/mcp@latest'], { runner: 'npx', name: '@playwright/mcp', version: null, tag: 'latest', argIndex: 1 }],
    ['/usr/local/bin/npx', ['--yes', '-q', 'pkg'], { runner: 'npx', name: 'pkg', version: null, tag: null, argIndex: 2 }],
    ['npx', ['-y', '--', 'pkg@1.0.0'], { runner: 'npx', name: 'pkg', version: '1.0.0', tag: null, argIndex: 2 }],
    ['npx', ['-y', 'pkg@1.2.3', '--flag'], { runner: 'npx', name: 'pkg', version: '1.2.3', tag: null, argIndex: 1 }],
    ['uvx', ['--quiet', '--offline', 'mcp-x'], { runner: 'uvx', name: 'mcp-x', version: null, tag: null, argIndex: 2 }],
    ['uvx', ['mcp-server-git'], { runner: 'uvx', name: 'mcp-server-git', version: null, tag: null, argIndex: 0 }],
    ['uvx', ['mcp-server-git@1.2.3'], { runner: 'uvx', name: 'mcp-server-git', version: '1.2.3', tag: null, argIndex: 0 }],
    ['uvx', ['mcp-server-git==1.2.3', '--repo', '.'], { runner: 'uvx', name: 'mcp-server-git', version: '1.2.3', tag: null, argIndex: 0 }],
  ];
  for (const [command, args, want] of cases) assert.deepEqual(p(command, args), want, `${command} ${args}`);
});

test('parseRunnerSpec rejects', () => {
  const nulls = [
    ['node', ['server.js']],
    ['npx', ['--package=x', 'y']],
    ['npx', ['-p', 'x', 'y']],
    ['uvx', ['--from', 'x', 'y']],
    ['uvx', ['--python', '3.12', 'mcp-x']],
    ['uvx', ['--with', 'requests', 'mcp-x']],
    ['npx', ['--registry', 'https://x', 'pkg']],
    ['npx', []],
    ['npx', ['-y']],
    ['npx', ['../evil']],
    ['npx', ['https://evil.example/x.tgz']],
    ['npx', ['git+https://evil.example/x.git']],
    ['npx', ['pkg@']],
    ['npx', ['pkg@^1.0.0']],
    ['npx', ['pkg@Latest']],
    ['npx', ['PKG']],
    ['uvx', ['pkg@latest']],
    ['uvx', ['pkg==1.0;rm']],
    ['uvx', ['git+https://evil.example/x']],
    ['npx', ['a'.repeat(215)]],
  ];
  for (const [command, args] of nulls) assert.equal(p(command, args), null, `${command} ${args}`);
  assert.equal(parseRunnerSpec({ command: 'npx' }), null);
});

test('withVersion rewrites only the spec arg', () => {
  const cfg = { command: 'npx', args: ['-y', '@scope/pkg@latest', '--flag', 'pkg@9.9.9'] };
  const parsed = parseRunnerSpec(cfg);
  const next = withVersion(parsed, cfg, '2.0.0');
  assert.deepEqual(next, ['-y', '@scope/pkg@2.0.0', '--flag', 'pkg@9.9.9']);
  assert.equal(cfg.args[1], '@scope/pkg@latest');
  assert.throws(() => withVersion(parsed, cfg, '1.0.0; rm'));
});

test('withVersion leaves trailing flags and normalizes uvx ==', () => {
  const cfg = { command: 'npx', args: ['-y', 'pkg@1.2.3', '--flag'] };
  assert.deepEqual(withVersion(parseRunnerSpec(cfg), cfg, '1.3.0'), ['-y', 'pkg@1.3.0', '--flag']);
  const uv = { command: 'uvx', args: ['mcp-x==1.0.0'] };
  assert.deepEqual(withVersion(parseRunnerSpec(uv), uv, '1.1.0'), ['mcp-x@1.1.0']);
});
