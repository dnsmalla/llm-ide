// Guards the dependency-pinning invariants that are easy to lose in an
// unrelated `npm install`. Two entries: the MCP SDK, which
// connectors/mcp-client.mjs imports directly (before this test it arrived
// only as a transitive dependency of @anthropic-ai/claude-agent-sdk — an
// upgrade there could have deleted it from node_modules and broken every
// MCP-backed connector with a MODULE_NOT_FOUND at request time), and the
// Claude Agent SDK itself (the Claude linker's core dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const SDK = '@modelcontextprotocol/sdk';

test('the MCP SDK is a declared RUNTIME dependency, not a dev or transitive one', () => {
  assert.ok(pkg.dependencies?.[SDK], `${SDK} must be in "dependencies"`);
  assert.equal(pkg.devDependencies?.[SDK], undefined,
    `${SDK} must not also be a devDependency`);
});

test('the MCP SDK is pinned exactly (no ^ or ~)', () => {
  assert.match(pkg.dependencies[SDK], /^\d+\.\d+\.\d+$/,
    'protocol code must not float across minor versions');
});

test('the pin matches what is installed on disk', () => {
  const installed = JSON.parse(
    readFileSync(path.join(root, 'node_modules', SDK, 'package.json'), 'utf8'),
  ).version;
  assert.equal(pkg.dependencies[SDK], installed);
});

test('the lockfile records it as a root dependency', () => {
  const rootEntry = lock.packages?.[''];
  assert.ok(rootEntry?.dependencies?.[SDK],
    'package-lock.json root entry must list the SDK — run `npm install` after editing package.json');
});

// The Claude Agent SDK is the server-side Claude linker's core dependency
// (docs/explanation/claude-linker.md — its update playbook starts at this
// pin). Same invariants as the MCP SDK above: exact pin, and node_modules
// actually holding the pinned version — a stale install would run every
// SDK-shaped test against a different SDK than the pin claims.
const AGENT_SDK = '@anthropic-ai/claude-agent-sdk';

test('the Agent SDK is pinned exactly (no ^ or ~)', () => {
  assert.match(pkg.dependencies?.[AGENT_SDK] ?? '', /^\d+\.\d+\.\d+$/,
    `${AGENT_SDK} must be an exact runtime-dependency pin`);
});

test('the Agent SDK pin matches what is installed on disk', () => {
  const installed = JSON.parse(
    readFileSync(path.join(root, 'node_modules', AGENT_SDK, 'package.json'), 'utf8'),
  ).version;
  assert.equal(pkg.dependencies[AGENT_SDK], installed,
    'run `npm install` — node_modules holds a different Agent SDK than the pin');
});
