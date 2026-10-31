// Workspace trust: per-user records, detection of project-scoped executable config, the turn gate, and what
// the Claude engine does with it. Fixtures only; no network, no SDK subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_workspace-trust-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fixture-'));
const mkRoot = (name, files = {}) => {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return fs.realpathSync(dir);
};

const main = await import('../kb/db.mjs');
const store = await import('../kb/workspace-trust.mjs');
const gate = await import('../llm_agent/extensions/workspace-trust.mjs');
const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const users = await import('../server/users.mjs');
const mk = (e) => users.registerUser(main.getDb(), { email: e, password: 'CorrectHorseBattery', displayName: e }).id;
const A = mk('wt-a@example.test');
const B = mk('wt-b@example.test');

test.after(() => {
  main.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

const STDIO = JSON.stringify({ mcpServers: { build: { command: 'node', args: ['x.js'], env: { TOKEN: 'secret-value' } }, web: { type: 'http', url: 'https://example.test/mcp' } } });

test('store: no row means untrusted; set, flip and list are per user', () => {
  const r = mkRoot('store');
  assert.equal(store.isWorkspaceTrusted(A, r), false);
  assert.deepEqual(store.listWorkspaceTrust(A), []);
  const set = store.setWorkspaceTrust(A, r, true);
  assert.equal(set.trusted, true);
  assert.equal(store.isWorkspaceTrusted(A, r), true);
  assert.equal(store.isWorkspaceTrusted(B, r), false, 'another user is unaffected');
  store.setWorkspaceTrust(A, r, false);
  assert.equal(store.isWorkspaceTrusted(A, r), false);
  assert.equal(store.listWorkspaceTrust(A).length, 1);
});

test('store: realFolder resolves symlinks and refuses files and missing paths', () => {
  const r = mkRoot('real');
  const link = path.join(base, 'link-to-real');
  fs.symlinkSync(r, link);
  assert.equal(store.realFolder(link), r);
  assert.equal(store.realFolder(path.join(r, 'nope')), null);
  fs.writeFileSync(path.join(r, 'f.txt'), 'x');
  assert.equal(store.realFolder(path.join(r, 'f.txt')), null);
  assert.equal(store.realFolder(''), null);
});

test('user delete cascades the trust and allowlist rows', () => {
  const U = mk('wt-del@example.test');
  const r = mkRoot('cascade');
  store.setWorkspaceTrust(U, r, true);
  main.getDb().prepare('DELETE FROM users WHERE id = ?').run(U);
  assert.equal(main.getDb().prepare('SELECT COUNT(*) AS n FROM workspace_trust WHERE user_id = ?').get(U).n, 0);
});

test('detect: stdio and http/sse MCP servers are both withheld and named, names only', () => {
  const r = mkRoot('detect', { '.mcp.json': STDIO });
  const d = gate.detectProjectExecutables(r);
  assert.deepEqual(d, [
    { kind: 'mcp-stdio', name: 'build', file: '.mcp.json', withheld: true },
    { kind: 'mcp-remote', name: 'web', file: '.mcp.json', withheld: true },
  ]);
  assert.ok(!JSON.stringify(d).includes('secret-value'), 'never a command line or env value');
});

test('detect: hooks, plugins and skill scripts are named but not withheld; plain skills are not executable', () => {
  const r = mkRoot('detect2', {
    '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [] } }),
    '.claude-plugin/plugin.json': '{"name":"p"}',
    '.claude/skills/plain/SKILL.md': '---\nname: plain\n---\n',
    '.claude/skills/runner/SKILL.md': '---\nname: runner\n---\n',
    '.claude/skills/runner/scripts/go.sh': 'echo hi',
  });
  const d = gate.detectProjectExecutables(r);
  assert.deepEqual(d.map((x) => x.kind).sort(), ['hooks', 'plugin', 'skill-scripts']);
  assert.ok(d.every((x) => x.withheld === false));
  assert.equal(d.find((x) => x.kind === 'skill-scripts').name, 'runner');
});

test('detect: an unparseable or oversized .mcp.json is treated as executable config ("could not be inspected")', () => {
  for (const [n, body] of [['bad', '{not json'], ['big', JSON.stringify({ mcpServers: {}, pad: 'x'.repeat(300_000) })]]) {
    const r = mkRoot(`detect3-${n}`, { '.mcp.json': body });
    assert.deepEqual(gate.detectProjectExecutables(r), [{ kind: 'mcp-uninspected', name: 'could not be inspected', file: '.mcp.json', withheld: true }], n);
  }
  const r = mkRoot('detect3-settings', { '.claude/settings.json': 'x'.repeat(300_000) });
  assert.deepEqual(gate.detectProjectExecutables(r), [], 'oversized settings are not executable gates');
  assert.deepEqual(gate.detectProjectExecutables(path.join(base, 'missing')), []);
});

test('detect: a UTF-8 BOM does not hide the servers; a PARENT .mcp.json is found', () => {
  const r = mkRoot('detect-bom', { '.mcp.json': `\uFEFF${STDIO}` });
  assert.equal(gate.detectProjectExecutables(r).filter((x) => x.kind === 'mcp-stdio').length, 1);
  const parent = mkRoot('detect-parent', { '.mcp.json': STDIO, 'sub/keep': 'x' });
  const d = gate.detectProjectExecutables(path.join(parent, 'sub'));
  assert.ok(d.some((x) => x.kind === 'mcp-stdio' && x.file === '../.mcp.json'));
});

test('gate: strict for EVERY untrusted folder (clean, oversized, BOM, parent, unresolvable); trusted and off are legacy', () => {
  const clean = mkRoot('strict-clean');
  assert.equal(gate.workspaceTrustForTurn(A, clean).strict, true);
  assert.equal(gate.workspaceTrustForTurn(A, clean).restricted, false);
  assert.equal(gate.workspaceTrustForTurn(A, path.join(base, 'does-not-exist')).strict, true);
  const big = mkRoot('strict-big', { '.mcp.json': JSON.stringify({ pad: 'x'.repeat(300_000) }) });
  const t = gate.workspaceTrustForTurn(A, big);
  assert.equal(t.strict, true);
  assert.equal(t.restricted, true);
  assert.match(gate.workspaceTrustNotice(t).text, /could not be inspected/);
  const trusted = mkRoot('strict-trusted');
  store.setWorkspaceTrust(A, trusted, true);
  assert.equal(gate.workspaceTrustForTurn(A, trusted).strict, false);
  process.env.LLMIDE_WORKSPACE_TRUST = 'off';
  try { assert.equal(gate.workspaceTrustForTurn(A, clean).strict, false); } finally { delete process.env.LLMIDE_WORKSPACE_TRUST; }
});

test('gate: untrusted + executable = restricted; trusted, nothing executable and the kill switch are not', () => {
  const r = mkRoot('gate', { '.mcp.json': STDIO });
  const t = gate.workspaceTrustForTurn(A, r);
  assert.equal(t.restricted, true);
  assert.equal(t.withheld.length, 2);
  store.setWorkspaceTrust(A, r, true);
  assert.equal(gate.workspaceTrustForTurn(A, r).restricted, false);
  assert.equal(gate.workspaceTrustForTurn(A, r).trusted, true);
  assert.equal(gate.workspaceTrustForTurn(B, r).restricted, true, 'trust is per user');
  const clean = mkRoot('gate-clean');
  assert.equal(gate.workspaceTrustForTurn(B, clean).restricted, false);
  process.env.LLMIDE_WORKSPACE_TRUST = 'off';
  try {
    assert.equal(gate.workspaceTrustForTurn(B, r).active, false);
    assert.equal(gate.workspaceTrustForTurn(B, r).restricted, false);
  } finally { delete process.env.LLMIDE_WORKSPACE_TRUST; }
});

test('gate: a symlinked spelling of a trusted folder is the same folder', () => {
  const r = mkRoot('gate-link', { '.mcp.json': STDIO });
  const link = path.join(base, 'gate-link-alias');
  fs.symlinkSync(r, link);
  store.setWorkspaceTrust(B, r, true);
  assert.equal(gate.workspaceTrustForTurn(B, link).trusted, true);
});

test('notice: names what was skipped and how to trust; info when nothing was withheld', () => {
  const r = mkRoot('notice', { '.mcp.json': STDIO, '.claude/settings.json': JSON.stringify({ hooks: { Stop: [] } }) });
  const n = gate.workspaceTrustNotice(gate.workspaceTrustForTurn(A, r));
  assert.equal(n.type, 'notice');
  assert.equal(n.kind, 'workspace_trust');
  assert.equal(n.level, 'warning');
  assert.match(n.text, /not trusted/);
  assert.match(n.text, /MCP server build/);
  assert.match(n.text, /remote \(http\/sse\) MCP server web/);
  assert.match(n.text, /workspace-trust/);
  assert.ok(n.text.length <= 300);
  assert.equal(n.data.skipped.length, 3);
  const h = mkRoot('notice2', { '.claude/settings.json': JSON.stringify({ hooks: { Stop: [] } }) });
  assert.equal(gate.workspaceTrustNotice(gate.workspaceTrustForTurn(A, h)).level, 'info');
  assert.equal(gate.workspaceTrustNotice(gate.workspaceTrustForTurn(A, mkRoot('notice3'))), null);
});

// --- the engine ---
const turnInjectable = { readSkill: () => null, roots: () => [], sessionMemory: () => [], persistMemory: async () => null };
async function turn(userId, root) {
  const script = { options: null };
  const events = [];
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-wt-test';
  try {
    await runAgentV2Turn({
      message: 'hi', userId, mode: 'execute', agentContext: { workspaceRoot: root }, allowAmbientAuth: true,
      onEvent: (e) => events.push(e),
      queryFactory: (_p, options) => { script.options = options; return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's1', tools: [], capabilities: [] };
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
      })(); },
    }, turnInjectable);
  } finally { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; }
  return { options: script.options, events };
}

test('engine: an untrusted folder with a stdio .mcp.json runs strict (project servers withheld) with a notice', async () => {
  const r = mkRoot('eng1', { '.mcp.json': STDIO });
  const { options, events } = await turn(mk('wt-e1@example.test'), r);
  assert.equal(options.strictMcpConfig, true);
  assert.ok(options.mcpServers.llmide, 'the in-process server and user servers are passed explicitly, so they stay');
  const n = events.find((e) => e.kind === 'workspace_trust');
  assert.equal(n.level, 'warning');
});

test('engine: an untrusted clean folder is strict with no notice; trusted or switch off is legacy', async () => {
  const clean = mkRoot('eng2');
  const u = mk('wt-e2@example.test');
  const a = await turn(u, clean);
  assert.equal(a.options.strictMcpConfig, true, 'an untrusted folder is ALWAYS strict, even when nothing was detected');
  assert.equal(a.events.some((e) => e.kind === 'workspace_trust'), false);

  const r = mkRoot('eng3', { '.mcp.json': STDIO });
  store.setWorkspaceTrust(u, r, true);
  const b = await turn(u, r);
  assert.equal('strictMcpConfig' in b.options, false);
  assert.equal(b.events.some((e) => e.kind === 'workspace_trust'), false);

  process.env.LLMIDE_WORKSPACE_TRUST = 'off';
  try {
    const c = await turn(mk('wt-e3@example.test'), r);
    assert.equal('strictMcpConfig' in c.options, false);
    assert.equal(c.events.some((e) => e.kind === 'workspace_trust'), false);
  } finally { delete process.env.LLMIDE_WORKSPACE_TRUST; }
});
