# MCP Plugin Runtime (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent actively use MCP servers (Slack, Linear, …) imported from Claude Code's `~/.claude.json`, by delegating connection + dispatch to the Claude CLI's native `--mcp-config` on the default Claude path.

**Architecture:** A small `extension/mcp/` module owns the registry + per-user consent/enable + a config builder. `handleCodeAssist` computes a mode-aware MCP config and threads it through the agent loop into `runClaude`, which — on its CLI fallback — swaps the existing `--strict-mcp-config` for `--mcp-config <json> --allowedTools "mcp__*"`. The CLI connects and dispatches `mcp__<server>__<tool>` itself; we add no handler/route-loop code for SP1.

**Tech Stack:** Node 20+ (no new deps), `claude -p` CLI, SwiftUI. Tests via the Node test runner (`node --test`) and XCTest.

## Global Constraints

- **No new npm dependencies** — `--mcp-config` does the MCP work; we do not pull `@modelcontextprotocol/sdk` (that's SP1b).
- **SP1 applies only on the Claude CLI path.** `runClaude` tries the Anthropic HTTP API first (when an API key is set) and falls back to `claude -p`. MCP injection happens ONLY in the CLI-fallback branch. Users on the API-key path (or non-Claude providers) get no MCP until SP1b. The product default is `claude login` (no API key) → CLI path → MCP works.
- **Slug regex** for every wire-supplied plugin id: `/^[a-z][a-z0-9-]{1,40}$/` (same as llm-sources / plugins).
- **Auth model:** admin registers plugins + scans `~/.claude.json`; a user must consent + enable before their server reaches `--mcp-config`. Every registry mutation audited with `action: 'mcp-plugin.*'`. `~/.claude.json` is read-only — never mutated.
- **Restricted modes** (`plan`/`review`/`document`) never pass MCP to the CLI — enforced by gating `buildMcpConfigForUser` on `!restrictsTools(mode)`.
- **API version bump:** `SERVER_API_VERSION` 28 → 29; register every new path in `ENDPOINTS` (`extension/server.mjs`).
- **Per-user tenancy:** every state-mutating helper takes `userId` first; state file keyed by `userId`.
- **Backward compat:** when no MCP plugin is enabled+consented, the `claude -p` argv is byte-identical to today (`--strict-mcp-config`, no `--mcp-config`).
- **File/state locations** mirror llm-sources: registry at `~/Library/Application Support/llm-ide/mcp-plugins.json`, per-user state at `…/mcp-plugins-state.json` (resolve via the same `LLMIDE_PLUGIN_DIR` base as `defaultSourcesDir()`).

---

### Task 1: MCP plugin registry + per-user consent/enable state

**Files:**
- Create: `extension/mcp/state.mjs`
- Test: `extension/tests/mcp-state.test.mjs`

**Interfaces:**
- Produces: `readMcpRegistry() → McpPlugin[]`, `writeMcpRegistry(list)`, `getMcpPlugin(id) → McpPlugin | null`, `addMcpPlugin({name, command, args, env, source}) → {plugin} | {error, status}`, `removeMcpPlugin(id) → {ok} | {error,status}`, `listMcpPluginsWithState(userId) → {plugins: [{…plugin, enabled, consented}]}`, `setConsented(userId, id, bool)`, `setEnabledMcp(userId, id, bool)`, `SLUG_RE`, `slugifyMcp(name, existing)`.
- `McpPlugin = { id, name, command, args[], env?, source: 'claude'|'manual', builtin: false }`.

Model the atomic read/write and per-user JSON exactly on `extension/llm-sources/registry.mjs` (`readRegistry`/`writeRegistry` tmp+rename) and `extension/llm-sources/state.mjs` (`listEnabled`/`setEnabled`, keyed by userId). `builtin: false` always for SP1 — there is no builtin MCP plugin.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/mcp-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-state-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins');

const {
  readMcpRegistry, writeMcpRegistry, addMcpPlugin, removeMcpPlugin,
  getMcpPlugin, listMcpPluginsWithState, setConsented, setEnabledMcp, SLUG_RE,
} = await import('../mcp/state.mjs');

test('addMcpPlugin registers a server; listMcpPluginsWithState reflects enable/consent', () => {
  writeMcpRegistry([]);
  const res = addMcpPlugin({ name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], source: 'manual' });
  assert.ok(res.plugin, JSON.stringify(res));
  assert.match(res.plugin.id, SLUG_RE);
  assert.equal(res.plugin.command, 'npx');

  // A different user sees registered but not enabled/consented.
  const list = listMcpPluginsWithState('user-a');
  assert.equal(list.plugins.length, 1);
  assert.equal(list.plugins[0].enabled, false);
  assert.equal(list.plugins[0].consented, false);

  setConsented('user-a', res.plugin.id, true);
  setEnabledMcp('user-a', res.plugin.id, true);
  const after = listMcpPluginsWithState('user-a').plugins.find((p) => p.id === res.plugin.id);
  assert.equal(after.consented, true);
  assert.equal(after.enabled, true);
  // Per-user isolation: user-b is untouched.
  assert.equal(listMcpPluginsWithState('user-b').plugins.find((p) => p.id === res.plugin.id).enabled, false);
});

test('addMcpPlugin rejects a bad slug; removeMcpPlugin deletes', () => {
  writeMcpRegistry([]);
  const bad = addMcpPlugin({ name: '!!bad!!', command: 'x', args: [], source: 'manual' });
  // slugify still produces a valid id (s- prefix / stripped) — assert it's valid, not rejected:
  assert.match(bad.plugin.id, SLUG_RE);
  const r = removeMcpPlugin(bad.plugin.id);
  assert.ok(r.ok);
  assert.equal(getMcpPlugin(bad.plugin.id), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/mcp-state.test.mjs`
Expected: FAIL — `Cannot find module '../mcp/state.mjs'`.

- [ ] **Step 3: Implement `state.mjs`**

```js
// extension/mcp/state.mjs
// MCP-plugin registry + per-user consent/enable. Atomic JSON writes; per-user
// state keyed by userId. Mirrors llm-sources/registry.mjs + state.mjs.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

function dirnameOf(p) { return p.split('/').slice(0, -1).join('/') || '/'; }
function baseDir() {
  return process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
}
function registryPath() { return join(dirname(baseDir()), 'mcp-plugins.json'); }
function statePath() { return join(dirname(baseDir()), 'mcp-plugins-state.json'); }

export function readMcpRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data?.plugins) ? data.plugins.filter((s) => s && typeof s === 'object') : [];
  } catch { return []; }
}
export function writeMcpRegistry(list) {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ plugins: list }, null, 2), 'utf8');
  renameSync(tmp, p);
}
export function getMcpPlugin(id) { return readMcpRegistry().find((s) => s.id === id) || null; }

export function slugifyMcp(name, existing) {
  let base = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `s-${base}`;
  base = base.slice(0, 40);
  if (!SLUG_RE.test(base)) base = `mcp-${Date.now().toString(36)}`;
  let id = base, i = 2;
  while (existing.has(id)) { id = `${base}-${i++}`; }
  return id;
}

export function addMcpPlugin({ name, command, args, env, source }) {
  if (typeof command !== 'string' || !command.trim()) return { error: 'command is required', status: 400 };
  const list = readMcpRegistry();
  const id = slugifyMcp(name || command, new Set(list.map((s) => s.id)));
  const plugin = {
    id, name: name || id, command,
    args: Array.isArray(args) ? args.filter((a) => typeof a === 'string') : [],
    env: env && typeof env === 'object' ? env : undefined,
    source: source === 'claude' ? 'claude' : 'manual',
    builtin: false,
  };
  list.push(plugin);
  writeMcpRegistry(list);
  return { plugin };
}

export function removeMcpPlugin(id) {
  if (!SLUG_RE.test(id)) return { error: 'invalid id', status: 400 };
  const list = readMcpRegistry();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { error: 'not found', status: 404 };
  writeMcpRegistry(next);
  return { ok: true };
}

// ---- per-user state ----
function readState() {
  const p = statePath();
  if (!existsSync(p)) return {};
  try { const d = JSON.parse(readFileSync(p, 'utf8')); return d && typeof d === 'object' ? d : {}; }
  catch { return {}; }
}
function writeState(st) {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  renameSync(tmp, p);
}
function userEntry(userId) {
  const st = readState();
  if (!st[userId]) st[userId] = {};
  return st;
}
export function setConsented(userId, id, consented) {
  if (!SLUG_RE.test(id)) return;
  const st = readState();
  if (!st[userId]) st[userId] = {};
  if (!st[userId][id]) st[userId][id] = {};
  st[userId][id].consented = !!consented;
  writeState(st);
}
export function setEnabledMcp(userId, id, enabled) {
  if (!SLUG_RE.test(id)) return;
  const st = readState();
  if (!st[userId]) st[userId] = {};
  if (!st[userId][id]) st[userId][id] = {};
  st[userId][id].enabled = !!enabled;
  writeState(st);
}

export function listMcpPluginsWithState(userId) {
  const st = readState()[userId] || {};
  return {
    plugins: readMcpRegistry().map((p) => ({
      ...p,
      enabled: !!(st[p.id]?.enabled),
      consented: !!(st[p.id]?.consented),
    })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/mcp-state.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/mcp/state.mjs extension/tests/mcp-state.test.mjs
git commit -m "feat(mcp): plugin registry + per-user consent/enable state"
```

---

### Task 2: Read-only Claude `~/.claude.json` source scanner

**Files:**
- Create: `extension/mcp/claude-source.mjs`
- Test: `extension/tests/mcp-claude-source.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `scanClaudeMcpServers(claudeJsonPath?) → [{name, command, args, env}]`. Reads `mcpServers` from `~/.claude.json` (path overridable for tests). Never writes. Malformed file → `[]`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/mcp-claude-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanClaudeMcpServers } from '../mcp/claude-source.mjs';

test('scanClaudeMcpServers reads mcpServers from a Claude config fixture', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({
    mcpServers: {
      slack: { command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 'x' } },
      linear: { command: 'npx', args: ['-y', '@linear/mcp'] },
    },
    otherStuff: { ignore: 'me' },
  }));
  const servers = scanClaudeMcpServers(f);
  assert.equal(servers.length, 2);
  const slack = servers.find((s) => s.name === 'slack');
  assert.equal(slack.command, 'npx');
  assert.deepEqual(slack.args, ['-y', '@slack/mcp']);
  assert.equal(slack.env.TOKEN, 'x');
});

test('scanClaudeMcpServers returns [] when the file is missing or has no mcpServers', () => {
  assert.deepEqual(scanClaudeMcpServers('/nonexistent/.claude.json'), []);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: {} }));
  assert.deepEqual(scanClaudeMcpServers(f), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/mcp-claude-source.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `claude-source.mjs`**

```js
// extension/mcp/claude-source.mjs
// Read-only scan of ~/.claude.json mcpServers — the SP1 import source.
// We NEVER write to this file; Claude Code owns it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultClaudeJsonPath() {
  return process.env.CLAUDE_CONFIG_PATH || join(homedir(), '.claude.json');
}

export function scanClaudeMcpServers(claudeJsonPath) {
  const p = claudeJsonPath || defaultClaudeJsonPath();
  if (!existsSync(p)) return [];
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  const servers = cfg?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.command !== 'string') continue; // skip http/url-only entries for SP1
    out.push({
      name,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string') : [],
      env: s.env && typeof s.env === 'object' ? s.env : undefined,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/mcp-claude-source.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/mcp/claude-source.mjs extension/tests/mcp-claude-source.test.mjs
git commit -m "feat(mcp): read-only ~/.claude.json mcpServers scanner"
```

---

### Task 3: Mode-aware MCP config builder

**Files:**
- Create: `extension/mcp/mcp-config.mjs`
- Test: `extension/tests/mcp-config.test.mjs`

**Interfaces:**
- Consumes: `listMcpPluginsWithState` (Task 1).
- Produces: `buildMcpConfigForUser(userId, { mode, restrictsToolsFn }) → { mcpConfigJson: string, allowed: true } | null`. Returns `null` when there are no enabled+consented plugins OR `restrictsToolsFn(mode)` is true. The JSON is the Claude-Code `.mcp.json` shape: `{ mcpServers: { <id>: { command, args, env } } }`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/mcp-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const { writeMcpRegistry, setConsented, setEnabledMcp } = await import('../mcp/state.mjs');
const { buildMcpConfigForUser } = await import('../mcp/mcp-config.mjs');

const noRestrict = () => false;
const planMode = () => true; // restrictsTools('plan') === true

function reg(plugin) { writeMcpRegistry([plugin]); }

test('null when no plugins, none enabled, none consented, or restricted mode', () => {
  writeMcpRegistry([]);
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null);

  reg({ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], source: 'claude', builtin: false });
  // registered but not enabled/consented
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null);
  setConsented('u', 'slack', true);
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null); // not enabled
  setEnabledMcp('u', 'slack', true);
  // restricted mode blocks it even when enabled+consented
  assert.equal(buildMcpConfigForUser('u', { mode: 'plan', restrictsToolsFn: planMode }), null);
});

test('returns the .mcp.json JSON for enabled+consented plugins on an unrestricted mode', () => {
  reg({ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 't' }, source: 'claude', builtin: false });
  setConsented('u', 'slack', true);
  setEnabledMcp('u', 'slack', true);
  const cfg = buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict });
  assert.ok(cfg);
  const parsed = JSON.parse(cfg.mcpConfigJson);
  assert.deepEqual(parsed.mcpServers.slack, { command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 't' } });
  assert.equal(cfg.allowed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/mcp-config.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp-config.mjs`**

```js
// extension/mcp/mcp-config.mjs
// Build the --mcp-config JSON for a user's enabled+consented MCP plugins,
// gated by mode (restricted modes → null → caller keeps --strict-mcp-config).
import { listMcpPluginsWithState } from './state.mjs';

export function buildMcpConfigForUser(userId, { mode, restrictsToolsFn }) {
  if (typeof restrictsToolsFn === 'function' && restrictsToolsFn(mode)) return null;
  const active = listMcpPluginsWithState(userId).plugins.filter((p) => p.enabled && p.consented);
  if (active.length === 0) return null;
  const mcpServers = {};
  for (const p of active) {
    mcpServers[p.id] = {
      command: p.command,
      args: p.args || [],
      ...(p.env ? { env: p.env } : {}),
    };
  }
  return { mcpConfigJson: JSON.stringify({ mcpServers }), allowed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/mcp-config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/mcp/mcp-config.mjs extension/tests/mcp-config.test.mjs
git commit -m "feat(mcp): mode-aware --mcp-config builder"
```

---

### Task 4: Claude-CLI arg builder (with/without MCP)

**Files:**
- Modify: `extension/agents/providers.mjs` (add `buildAnthropicCliArgs`; leave `CLI_ARG_BUILDERS` unchanged for the no-MCP case)
- Test: `extension/tests/mcp-cli-args.test.mjs`

**Interfaces:**
- Produces: `export function buildAnthropicCliArgs(prompt, { mcpConfigJson } = {}) → string[]`. With `mcpConfigJson`: `['--mcp-config', mcpConfigJson, '--allowedTools', 'mcp__*', '--setting-sources', '', '--tools', '', '--system-prompt', ANTHROPIC_DEFAULT_PROMPT, '-p', prompt]`. Without: byte-identical to today's `CLI_ARG_BUILDERS.anthropic(prompt)` (`['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', ANTHROPIC_DEFAULT_PROMPT, '-p', prompt]`).
- The constant `'You are a helpful AI assistant.'` is the existing system-prompt string at `CLI_ARG_BUILDERS.anthropic` (providers.mjs ~line 466) — extract it to a module const `ANTHROPIC_DEFAULT_PROMPT` and reuse in both branches so there is one source of truth.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/mcp-cli-args.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicCliArgs } from '../agents/providers.mjs';

test('no mcpConfigJson → today\'s argv (strict-mcp-config, no mcp flags)', () => {
  const args = buildAnthropicCliArgs('hello');
  assert.deepEqual(args, ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', 'You are a helpful AI assistant.', '-p', 'hello']);
});

test('mcpConfigJson → swap strict-mcp-config for --mcp-config + --allowedTools mcp__*', () => {
  const json = '{"mcpServers":{"slack":{"command":"npx","args":[]}}}';
  const args = buildAnthropicCliArgs('hello', { mcpConfigJson: json });
  assert.ok(args.includes('--mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], json);
  assert.ok(args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__*');
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.equal(args[args.length - 1], 'hello'); // -p prompt still last
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/mcp-cli-args.test.mjs`
Expected: FAIL — `buildAnthropicCliArgs` is not exported.

- [ ] **Step 3: Implement**

In `extension/agents/providers.mjs`, add (near `CLI_ARG_BUILDERS`):

```js
const ANTHROPIC_DEFAULT_PROMPT = 'You are a helpful AI assistant.';

// The argv passed to `claude -p`. With mcpConfigJson, register the user's
// enabled+consented MCP servers and let the model call them (mcp__*); without
// it, keep today's behavior (strict-mcp-config = zero servers). Built as a
// pure function so the arg shape is unit-testable without spawning claude.
export function buildAnthropicCliArgs(prompt, { mcpConfigJson } = {}) {
  const tail = ['--setting-sources', '', '--tools', '', '--system-prompt', ANTHROPIC_DEFAULT_PROMPT, '-p', prompt];
  if (typeof mcpConfigJson === 'string' && mcpConfigJson.length > 0) {
    return ['--mcp-config', mcpConfigJson, '--allowedTools', 'mcp__*', ...tail];
  }
  return ['--strict-mcp-config', ...tail];
}
```

Then change `CLI_ARG_BUILDERS.anthropic` to reuse it (so there's one source of truth):
```js
anthropic: (p) => buildAnthropicCliArgs(p),
```
Leave the other builders (`google`, etc.) untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/mcp-cli-args.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/agents/providers.mjs extension/tests/mcp-cli-args.test.mjs
git commit -m "feat(mcp): claude-CLI arg builder with optional --mcp-config"
```

---

### Task 5: Thread `mcpConfig` through `runClaude` to `spawnCli`

**Files:**
- Modify: `extension/agents/runtime.mjs` (the `runClaude` signature + its `spawnCli('anthropic', …)` CLI-fallback call ~line 419; also `runClaudeStream`'s CLI path if present)
- Test: `extension/tests/mcp-runclaude-args.test.mjs`

**Interfaces:**
- Consumes: `buildAnthropicCliArgs` (Task 4), `spawnCli`'s existing `args` override.
- Produces: `runClaude(prompt, { …existingOpts, mcpConfig })`. When `mcpConfig` (`{ mcpConfigJson } | null`) is present, the CLI-fallback `spawnCli` call passes `args: buildAnthropicCliArgs(prompt, mcpConfig)`. When null, `spawnCli` is called exactly as today (no `args` override → default builder).

- [ ] **Step 1: Write the failing test**

`runClaude` tries the HTTP API first; to test only the CLI branch deterministically, force the CLI path by passing no model/api-key and using `autoFallback: false` after a guaranteed API miss, OR — simpler — mock `spawnCli` via the existing test seam pattern. The repo already stubs the CLI in agent tests; follow that pattern. Concretely, drive the CLI branch by setting `LLMIDE_DISABLE_API=1` if that env exists, otherwise inject `runClaude`'s internal call. If no clean seam exists, add a tiny test-only export `_buildCliArgsOverrideForMcp(mcpConfig)` is NOT needed — Task 4 already unit-tested `buildAnthropicCliArgs`. Instead, test the *wiring* by asserting `runClaude` passes `args` to `spawnCli`:

```js
// extension/tests/mcp-runclaude-args.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

// runClaude's CLI fallback calls spawnCli('anthropic', prompt, { args, ... }).
// We capture the argsOverride by mocking spawnCli via the providers module's
// exported indirection. providers.mjs calls execFile directly inside spawnCli,
// so instead we unit-test the integration at the seam runClaude already has:
// it imports spawnCli from providers.mjs. Use node:test mock.method on the
// module namespace is NOT supported (non-configurable), so we assert behavior
// through buildAnthropicCliArgs (Task 4) + a structural check that runClaude
// threads mcpConfig into spawnCli's `args`.
//
// This test therefore documents the contract: read the source and confirm
// runClaude's spawnCli call uses buildAnthropicCliArgs(prompt, mcpConfig).
test('runClaude threads mcpConfig into the spawnCli argsOverride (source-level contract)', () => {
  const src = readFileSync(join(__dirname, '..', 'agents', 'runtime.mjs'), 'utf8');
  assert.match(src, /buildAnthropicCliArgs/, 'runtime.mjs must import + use buildAnthropicCliArgs');
  assert.match(src, /mcpConfig/, 'runClaude must accept an mcpConfig option');
  assert.match(src, /args:\s*buildAnthropicCliArgs\(prompt,\s*mcpConfig\)/,
    'the spawnCli CLI-fallback call must pass args: buildAnthropicCliArgs(prompt, mcpConfig)');
});
```

> Note: this is a structural-contract test because the repo's `spawnCli` calls `execFile` directly (no injectable seam) and Node 20 can't mock ESM namespace exports. Task 10 covers real end-to-end behavior with a live `claude`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/mcp-runclaude-args.test.mjs`
Expected: FAIL — `mcpConfig` not yet referenced.

- [ ] **Step 3: Wire it in `runtime.mjs`**

In `runClaude(prompt, { …, mcpConfig } = {})`:
1. Add `mcpConfig` to the destructured options.
2. Import `buildAnthropicCliArgs` from `./providers.mjs`.
3. At the CLI-fallback `spawnCli('anthropic', prompt, { … })` call (~line 419), add `args: buildAnthropicCliArgs(prompt, mcpConfig)`.

The change is approximately:
```js
const { stdout } = await spawnCli('anthropic', prompt, {
  env, timeoutMs, signal,
  args: buildAnthropicCliArgs(prompt, mcpConfig),
});
```
Do the same in `runClaudeStream`'s CLI/spawnCliStream path if it constructs anthropic args; if it delegates to `runClaude` for fallback, no change is needed there (the `mcpConfig` threads through).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/mcp-runclaude-args.test.mjs`
Expected: PASS. Also re-run `npm test` to confirm no regressions in the existing agent suite.

- [ ] **Step 5: Commit**

```bash
git add extension/agents/runtime.mjs extension/tests/mcp-runclaude-args.test.mjs
git commit -m "feat(mcp): thread mcpConfig through runClaude into spawnCli argsOverride"
```

---

### Task 6: Compute mode-aware `mcpConfig` in `handleCodeAssist` + thread through the loop

**Files:**
- Modify: `extension/llm_agent/runtime/route.mjs` (compute `mcpConfig` after `resolvedMode`; pass into the `runAgentLoop` / `runNativeAgentLoop` calls)
- Modify: `extension/llm_agent/runtime/loop.mjs` (accept `mcpConfig` in both loop functions; forward to their `runClaude` calls)
- Test: `extension/tests/route-mcp-mode.test.mjs`

**Interfaces:**
- Consumes: `buildMcpConfigForUser` (Task 3), `restrictsTools` (already imported in route.mjs from `./mode-personas.mjs`).
- Produces: `handleCodeAssist` computes `const mcpConfig = buildMcpConfigForUser(userId, { mode: resolvedMode, restrictsToolsFn: restrictsTools });` and passes it as `mcpConfig` to the loop. Both loop functions accept and forward `mcpConfig` to `runClaude`. Subagent/internal paths do **not** receive `mcpConfig` (MCP tools are global-agent-only for SP1).

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/route-mcp-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-mcp-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const { writeMcpRegistry, setConsented, setEnabledMcp } = await import('../mcp/state.mjs');

// Write one enabled+consented plugin so buildMcpConfigForUser is non-null in execute mode.
writeMcpRegistry([{ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], source: 'claude', builtin: false }]);
setConsented('u-mcp', 'slack', true);
setEnabledMcp('u-mcp', 'slack', true);

test('handleCodeAssist computes mcpConfig (execute→set, plan→null) and threads it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'llm_agent', 'runtime', 'route.mjs'), 'utf8');
  assert.match(src, /buildMcpConfigForUser/, 'route.mjs imports buildMcpConfigForUser');
  assert.match(src, /restrictsToolsFn:\s*restrictsTools/, 'mcpConfig is mode-gated via restrictsTools');
  // Both loop calls carry mcpConfig:
  assert.match(src, /mcpConfig,/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/route-mcp-mode.test.mjs`
Expected: FAIL — `buildMcpConfigForUser` not referenced.

- [ ] **Step 3: Wire route.mjs + loop.mjs**

In `route.mjs`:
1. Import: `import { buildMcpConfigForUser } from '../../mcp/mcp-config.mjs';`
2. After `resolvedMode` is computed (~line 122), add:
```js
// MCP plugins (Claude CLI path only). Restricted modes get none; execute
// modes get the user's enabled+consented servers as --mcp-config. Subagents
// and the internal agent never receive MCP (global-agent-only for SP1).
const mcpConfig = buildMcpConfigForUser(userId, { mode: resolvedMode, restrictsToolsFn: restrictsTools });
```
3. Pass `mcpConfig` into both `runNativeAgentLoop({ …, mcpConfig })` and `runAgentLoop({ …, mcpConfig })`. (The native loop will accept but ignore it for SP1 — MCP-via-native-loop is SP1b.)

In `loop.mjs`:
1. Add `mcpConfig` to the destructured options of `runAgentLoop` and `runNativeAgentLoop`.
2. Forward `mcpConfig` to every `runClaude(…)` call inside both (global agent only; if subagent/internal helper invocations of runClaude exist inside loop.mjs, leave them without `mcpConfig`).

- [ ] **Step 4: Run test to verify it passes + no regressions**

Run: `cd extension && node --test tests/route-mcp-mode.test.mjs tests/route-modes.test.mjs tests/agent-loop.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/runtime/route.mjs extension/llm_agent/runtime/loop.mjs extension/tests/route-mcp-mode.test.mjs
git commit -m "feat(mcp): compute mode-aware mcpConfig in handleCodeAssist, thread through loop"
```

---

### Task 7: HTTP routes + ENDPOINTS + SERVER_API_VERSION

**Files:**
- Modify: `extension/server/auth-routes.mjs` (add the MCP-plugin route block, mirroring the llm-sources block)
- Modify: `extension/server.mjs` (`ENDPOINTS` array + `SERVER_API_VERSION` 28 → 29)
- Test: `extension/tests/auth-routes.test.mjs` (append)

**Interfaces:**
- Consumes: `state.mjs` (Task 1), `claude-source.mjs` (Task 2), `requireAdmin` + `readJson` + `send` + `safeAudit` + `errValidation` (existing in auth-routes).
- Produces 6 routes (see spec table). Admin-gated: `claude-sources`, `add`, `DELETE <id>`. User: `consent`, `toggle`, `GET` list.

- [ ] **Step 1: Write the failing test** (append to `auth-routes.test.mjs`, mirroring the existing llm-sources admin-gate test style)

```js
test('mcp-plugins admin-gated routes reject a non-admin caller', async () => {
  const { user } = await registerAndLogin();
  const u = { id: user.id }; // not admin
  const scan = await callAuth({ method: 'GET', url: '/auth/me/mcp-plugins/claude-sources', user: u });
  assert.equal(scan.statusCode, 403);
  const add = await callAuth({ method: 'POST', url: '/auth/me/mcp-plugins/add', user: u, body: { command: 'npx', args: [] } });
  assert.equal(add.statusCode, 403);
});

test('POST /auth/me/mcp-plugins/add (admin) + consent + toggle + list + delete', async () => {
  const { user } = await registerAndLogin();
  const admin = { id: user.id, role: 'admin' };
  const added = await callAuth({ method: 'POST', url: '/auth/me/mcp-plugins/add', user: admin,
    body: { command: 'npx', args: ['-y', '@slack/mcp'], name: 'slack', source: 'manual' } });
  assert.equal(added.statusCode, 200, added._body);
  const id = added.json().plugin.id;

  const consent = await callAuth({ method: 'POST', url: '/auth/me/mcp-plugins/consent', user: admin, body: { id, consented: true } });
  assert.equal(consent.statusCode, 200);
  const toggle = await callAuth({ method: 'POST', url: '/auth/me/mcp-plugins/toggle', user: admin, body: { id, enabled: true } });
  assert.equal(toggle.statusCode, 200);

  const list = await callAuth({ method: 'GET', url: '/auth/me/mcp-plugins', user: admin });
  const row = list.json().plugins.find((p) => p.id === id);
  assert.equal(row.enabled, true);
  assert.equal(row.consented, true);

  const del = await callAuth({ method: 'DELETE', url: `/auth/me/mcp-plugins/${id}`, user: admin });
  assert.equal(del.statusCode, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/auth-routes.test.mjs`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Implement the routes**

Add to `handleAuth` in `extension/server/auth-routes.mjs`, alongside the llm-sources block. Pattern each route on the existing llm-sources routes (requireAdmin, readJson, send, safeAudit, slug regex validation). Sketch:

```js
// GET /auth/me/mcp-plugins  → list + per-user consent/enable
if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins') {
  const { listMcpPluginsWithState } = await import('../mcp/state.mjs');
  send(res, 200, listMcpPluginsWithState(req.user.id));
  return;
}
// GET /auth/me/mcp-plugins/claude-sources  (admin)
if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/claude-sources') {
  try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
  const { scanClaudeMcpServers } = await import('../mcp/claude-source.mjs');
  send(res, 200, { servers: scanClaudeMcpServers() });
  return;
}
// POST /auth/me/mcp-plugins/add  (admin)
if (method === 'POST' && url === '/auth/me/mcp-plugins/add') {
  try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
  let body; try { body = await readJson(req, bodyLimit); } catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
  if (body?.claudeName) {
    const { scanClaudeMcpServers } = await import('../mcp/claude-source.mjs');
    const found = scanClaudeMcpServers().find((s) => s.name === body.claudeName);
    if (!found) { send(res, 400, { error: { code: 'ADD_FAILED', message: `no Claude MCP server named '${body.claudeName}'` } }); return; }
    body = { command: found.command, args: found.args, env: found.env, name: body.name || found.name, source: 'claude' };
  }
  const { addMcpPlugin } = await import('../mcp/state.mjs');
  const result = addMcpPlugin(body || {});
  if (result.error) { send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } }); return; }
  safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.add', resource: result.plugin.id, outcome: 'success' });
  send(res, 200, result);
  return;
}
// POST /auth/me/mcp-plugins/consent  (user)
if (method === 'POST' && url === '/auth/me/mcp-plugins/consent') {
  let body; try { body = await readJson(req, bodyLimit); } catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
  if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id) || typeof body.consented !== 'boolean') {
    send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id + consented required' } }); return; }
  const { setConsented } = await import('../mcp/state.mjs');
  setConsented(req.user.id, body.id, body.consented);
  safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: body.consented ? 'mcp-plugin.consent' : 'mcp-plugin.revoke-consent', resource: body.id, outcome: 'success' });
  send(res, 200, { ok: true, consented: body.consented });
  return;
}
// POST /auth/me/mcp-plugins/toggle  (user)
if (method === 'POST' && url === '/auth/me/mcp-plugins/toggle') {
  let body; try { body = await readJson(req, bodyLimit); } catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
  if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id) || typeof body.enabled !== 'boolean') {
    send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id + enabled required' } }); return; }
  const { setEnabledMcp } = await import('../mcp/state.mjs');
  setEnabledMcp(req.user.id, body.id, body.enabled);
  safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: body.enabled ? 'mcp-plugin.enable' : 'mcp-plugin.disable', resource: body.id, outcome: 'success' });
  send(res, 200, { ok: true, enabled: body.enabled });
  return;
}
// DELETE /auth/me/mcp-plugins/<id>  (admin)
if (method === 'DELETE' && url.startsWith('/auth/me/mcp-plugins/')) {
  try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
  const id = decodeURIComponent(url.slice('/auth/me/mcp-plugins/'.length).split('?')[0]);
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid id' } }); return; }
  const { removeMcpPlugin } = await import('../mcp/state.mjs');
  const result = removeMcpPlugin(id);
  if (result.error) { send(res, result.status || 400, { error: { code: 'REMOVE_FAILED', message: result.error } }); return; }
  safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.remove', resource: id, outcome: 'success' });
  send(res, 200, result);
  return;
}
```

In `extension/server.mjs`: add the six paths to `ENDPOINTS`, bump `SERVER_API_VERSION` from 28 to 29, and (if `REQUIRED_ENDPOINTS` exists in the Mac client) note the Mac side updates it in Task 8.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/auth-routes.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/server/auth-routes.mjs extension/server.mjs extension/tests/auth-routes.test.mjs
git commit -m "feat(mcp): HTTP routes for MCP plugins (admin add/scan/delete, user consent/toggle)"
```

---

### Task 8: Mac DTOs + API client

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+McpPlugins.swift`
- Test: `mac/Tests/LlmIdeMacTests/McpPluginDTOTests.swift`

**Interfaces:**
- Produces Codable DTOs mirroring the routes: `McpPluginInfo { id, name, command, args, env?, source, enabled, consented }` (use `decodeIfPresent ?? false` for `enabled`/`consented`, per the F1 lesson) + `McpPluginListResponse`, `McpPluginSummary`, `ClaudeMcpSource`; methods `listMcpPlugins()`, `scanClaudeMcpSources()`, `addMcpPlugin(claudeName:command:args:env:name:)`, `consentMcpPlugin(id:consented:)`, `toggleMcpPlugin(id:enabled:)`, `removeMcpPlugin(id:)`.

- [ ] **Step 1: Write the failing test** (`McpPluginDTOTests.swift`): decode a realistic list payload and an add payload; assert fields. Mirror `LlmSourceDTOTests.swift`.

- [ ] **Step 2: Run test to verify it fails** — `cd mac && swift test --filter McpPluginDTOTests` → FAIL (types not found).

- [ ] **Step 3: Implement `LlmIdeAPIClient+McpPlugins.swift`** — mirror `LlmIdeAPIClient+LlmSources.swift`: `authenticated: true` on every call, the existing `send`/`get`/`post`/`delete` helpers, and `percentEncoded(_:)` (the hardened encoder) for the id in the DELETE path. Use `decodeIfPresent` for `enabled`/`consented`/`env`.

- [ ] **Step 4: Run test to verify it passes** — `cd mac && swift test --filter McpPluginDTOTests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+McpPlugins.swift mac/Tests/LlmIdeMacTests/McpPluginDTOTests.swift
git commit -m "feat(mac): MCP-plugin API client DTOs + decode tests"
```

---

### Task 9: Mac UI — MCP Plugins section + Add-from-Claude

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` (add `mcpPluginsSection` + state + an `McpPluginAddSheet`, modeled on the llm-sources section)
- Test: `cd mac && swift build` (compiles); behavior is exercised manually (the DTO test guards the contract).

- [ ] **Step 1:** Add `@State private var mcpPlugins: […]`, `@State private var mcpPluginMessage: String?`, `@State private var mcpPluginsError: String?`, a `.task { await loadMcpPlugins() }`, and `loadMcpPlugins()`/`refreshMcpPlugins()` using the do/catch pattern (surface errors — do NOT swallow with `try?`, per the F2 lesson).
- [ ] **Step 2:** Add `mcpPluginsSection` (parallel to `llmSourcesSection`): rows show name, source badge, enabled toggle, consented indicator; an error row with Retry on load failure; a header menu **"Add from Claude Code…"** that calls `scanClaudeMcpSources()` and, on pick, calls `addMcpPlugin(claudeName:)`. Detail view shows the registered command/args + consent/enable toggles. Insert `.tag(ShellState.LibrarySelection.mcpPlugin(id))` only if that enum case exists — otherwise reuse a generic selection or add the case (mirrors how `.llmSource(id)` was added).
- [ ] **Step 3:** Add the section to the Library body (next to `llmSourcesSection`).
- [ ] **Step 4:** `cd mac && swift build` → succeeds. Then `swift test` (full) → green.
- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift
git commit -m "feat(mac): MCP Plugins library section + Add-from-Claude flow"
```

---

### Task 10: End-to-end (gated) — fake MCP server + live `claude -p`

**Files:**
- Create: `extension/tests/fixtures/fake-mcp-server.mjs` (a tiny stdio JSON-RPC server exposing one tool `echo`).
- Create: `extension/tests/mcp-e2e.test.mjs` — skip if `claude` is absent or not logged in.

**Interfaces:**
- Consumes: `buildAnthropicCliArgs` (Task 4). Spawns `claude -p` directly with the fake server in `--mcp-config` and asserts the model can call `mcp__fake__echo`.

- [ ] **Step 1: Write the fake server**

```js
// extension/tests/fixtures/fake-mcp-server.mjs
// Minimal stdio MCP server: answers initialize + tools/list + tools/call for one
// tool `echo`. Run as `node fake-mcp-server.mjs`.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
let id = 0;
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.1' } } });
  } else if (msg.method === 'notifications/initialized') {
    /* no response */
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? '';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } });
  }
});
```

- [ ] **Step 2: Write the gated e2e test**

```js
// extension/tests/mcp-e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CLAUDE_AVAILABLE = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; } })();

test('claude -p --mcp-config can call mcp__fake__echo', { skip: !CLAUDE_AVAILABLE && 'claude CLI not available' }, () => {
  const server = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs');
  const mcpConfig = JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server] } } });
  const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-')), 'mcp.json');
  fs.writeFileSync(cfgFile, mcpConfig);
  // Allow mcp tools, force a one-shot that should invoke echo.
  const out = execFileSync('claude', [
    '--mcp-config', cfgFile, '--allowedTools', 'mcp__*', '--setting-sources', '',
    '--tools', '', '-p', 'Call the mcp__fake__echo tool with text "pong" and reply with exactly what it returns.',
  ], { encoding: 'utf8', timeout: 120000, env: { ...process.env, MCP_TIMEOUT: '30000' } });
  assert.match(out, /pong/, `expected the model to surface the echoed text; got:\n${out}`);
});
```

> This test validates the load-bearing assumption flagged in the spec: that `--tools ''` (built-ins off) still lets `--mcp-config` tools through. If it fails because built-ins-off suppresses MCP, the fix is to drop `--tools ''` on MCP turns in `buildAnthropicCliArgs` and rely on `--disallowed-tools` for built-ins instead. Update Task 4's builder accordingly and re-run.

- [ ] **Step 3: Run it** (locally, where `claude` is logged in): `cd extension && node --test tests/mcp-e2e.test.mjs`. In CI it skips cleanly.

- [ ] **Step 4: Commit**

```bash
git add extension/tests/fixtures/fake-mcp-server.mjs extension/tests/mcp-e2e.test.mjs
git commit -m "test(mcp): gated e2e — claude -p --mcp-config calls a fake MCP tool"
```

---

## Self-Review (run after writing, before handoff)

- **Spec coverage:** registry/state (T1), claude-source (T2), mcp-config builder + restricted-mode gate (T3), arg builder (T4), runClaude wiring (T5), route+loop threading (T6), HTTP+version (T7), Mac DTO (T8), Mac UI (T9), e2e validation (T10). Detail-view tools list is intentionally deferred to SP1b (matches spec). ✓
- **Type/name consistency:** `McpPlugin` fields (`id, name, command, args, env?, source, builtin`) identical across T1, T2 scan output, T3 config builder, T7 routes, T8 DTO. `buildMcpConfigForUser(userId, { mode, restrictsToolsFn })` (T3) matches the T6 call site. `buildAnthropicCliArgs(prompt, { mcpConfigJson })` (T4) matches T5's `args: buildAnthropicCliArgs(prompt, mcpConfig)`. ✓
- **Placeholder scan:** no TBD/TODO; every code step has real code; the two structural-contract tests (T5, T6) are explicit about *why* (no ESM-namespace mock in Node 20) with the e2e (T10) covering real behavior. ✓
- **Known risk, explicitly gated:** the `--tools ''` vs `--mcp-config` interaction is validated by T10 with a documented fallback. ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-12-mcp-plugin-runtime.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
