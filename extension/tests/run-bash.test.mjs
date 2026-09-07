import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBashCwd, handleRunBash, buildChildEnv } from '../llm_agent/runtime/handlers/run-bash.mjs';

// A model-supplied `cwd` relocates the command. Before containment existed,
// `{ cwd: "/Users/me/.aws", command: "cat credentials" }` ran a gate-approved
// command on a file the gate never saw.

let tmp;
let workspace;
let outside;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-bash-cwd-'));
  workspace = path.join(tmp, 'workspace');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET\n');
  fs.writeFileSync(path.join(workspace, 'sub', 'ok.txt'), 'OK\n');
  // A symlink inside the workspace that points outside it.
  fs.symlinkSync(outside, path.join(workspace, 'escape'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('no cwd arg: workspace root, else home', () => {
  assert.equal(resolveBashCwd({}, { workspaceRoot: workspace }).cwd, workspace);
  assert.equal(resolveBashCwd({ command: 'ls' }, {}).cwd, os.homedir());
});

test('a relative cwd resolves against the workspace, not the server process cwd', () => {
  const r = resolveBashCwd({ cwd: 'sub' }, { workspaceRoot: workspace });
  assert.equal(r.cwd, path.join(workspace, 'sub'));
});

test('a cwd that escapes the workspace is refused', () => {
  for (const cwd of ['..', '../outside', outside, path.join(workspace, '..', 'outside'), '/']) {
    const r = resolveBashCwd({ cwd }, { workspaceRoot: workspace });
    assert.ok(r.error, `expected error for cwd=${cwd}`);
    assert.equal(r.cwd, undefined);
  }
});

test('a symlink inside the workspace that points outside is refused (realpath containment)', () => {
  const r = resolveBashCwd({ cwd: 'escape' }, { workspaceRoot: workspace });
  assert.ok(r.error);
});

test('a non-existent cwd is refused rather than guessed', () => {
  const r = resolveBashCwd({ cwd: 'does-not-exist' }, { workspaceRoot: workspace });
  assert.ok(r.error);
});

test('a cwd that is a file, not a directory, is refused up front', () => {
  const r = resolveBashCwd({ cwd: 'sub/ok.txt' }, { workspaceRoot: workspace });
  assert.ok(r.error);
});

test('a model-supplied cwd with no workspace is refused — nothing to contain it in', () => {
  // Previously resolved against $HOME with no containment, so
  // `{ cwd: ".config/gh", command: "cat hosts.yml" }` ran in ~/.config/gh.
  for (const cwd of ['.', '.config/gh', 'Library/Keychains', outside]) {
    const r = resolveBashCwd({ cwd }, {});
    assert.ok(r.error, `expected error for cwd=${cwd}`);
  }
});

test('handleRunBash does not execute when the cwd is refused', async () => {
  const marker = path.join(tmp, 'ran.txt');
  const r = await handleRunBash(
    { command: `touch ${marker}`, cwd: outside },
    { workspaceRoot: workspace },
  );
  assert.ok(r.error);
  assert.equal(fs.existsSync(marker), false, 'command must not have run');
});

test('handleRunBash runs inside a contained cwd', async () => {
  const r = await handleRunBash({ command: 'cat ok.txt', cwd: 'sub' }, { workspaceRoot: workspace });
  assert.equal(r.error, undefined);
  assert.equal(r.stdout.trim(), 'OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// Environment scrubbing
//
// The handler used to hand every approved command the SERVER's whole
// `process.env`, ANTHROPIC_API_KEY included — so one approved `env` or
// `curl -d "$(env)"` exfiltrated the operator's credentials.
//
// SCOPE of what these tests prove: env-borne secrets are gone from the child's
// environment. They do NOT prove the credential-exfiltration class is closed —
// HOME is allowlisted of necessity, so an approved command still reads
// ~/.aws/credentials, ~/.npmrc, ~/.config/gh/hosts.yml and ~/.ssh/*. That
// channel is the approval gate's problem, not this allowlist's.
// ─────────────────────────────────────────────────────────────────────────────

test('buildChildEnv keeps only the allowlisted names — no credential-shaped var survives', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin', HOME: '/Users/x', LANG: 'ja_JP.UTF-8', TMPDIR: '/tmp/x',
    ANTHROPIC_API_KEY: 'sk-ant-leak',
    ANTHROPIC_BASE_URL: 'https://leak',
    OPENAI_API_KEY: 'sk-leak',
    AWS_SECRET_ACCESS_KEY: 'leak',
    AWS_SESSION_TOKEN: 'leak',
    GITHUB_TOKEN: 'ghp_leak',
    GITLAB_TOKEN: 'glpat_leak',
    LLMIDE_VAULT_KEY: 'leak',
    DATABASE_URL: 'postgres://u:p@h/db',
    NODE_OPTIONS: '--require /tmp/evil.js',
  });

  assert.deepEqual(
    Object.keys(env).sort(),
    ['HOME', 'LANG', 'PATH', 'TMPDIR'],
    'only allowlisted names may reach a child',
  );
  const serialized = JSON.stringify(env);
  for (const leak of ['sk-ant-leak', 'sk-leak', 'ghp_leak', 'glpat_leak', 'postgres://', 'evil.js']) {
    assert.ok(!serialized.includes(leak), `${leak} must not reach the child env`);
  }
});

test('the proxy + TLS-trust names survive the allowlist — CREDENTIAL_NAME_RE must not eat them', () => {
  // Regression: with none of these passed, every network command (`git fetch`,
  // `npm install`, `gh pr list`, `curl`) hung or failed with an opaque network
  // error on any proxied machine while working in the user's own terminal.
  // CREDENTIAL_NAME_RE is applied to the allowlist NAMES, so an added name
  // that matches it would be dropped silently — this pins that none do.
  const source = {
    HTTP_PROXY: 'http://proxy:8080', HTTPS_PROXY: 'http://proxy:8080',
    ALL_PROXY: 'socks5://proxy:1080', NO_PROXY: 'localhost,127.0.0.1',
    http_proxy: 'http://proxy:8080', https_proxy: 'http://proxy:8080',
    all_proxy: 'socks5://proxy:1080', no_proxy: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    SSL_CERT_FILE: '/etc/ssl/cert.pem', SSL_CERT_DIR: '/etc/ssl/certs',
    GIT_SSH_COMMAND: 'ssh -o ProxyCommand=nc-proxy',
    GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=basic'",
  };
  const env = buildChildEnv(source);
  assert.deepEqual(Object.keys(env).sort(), Object.keys(source).sort());
  for (const [name, value] of Object.entries(source)) {
    assert.equal(env[name], value, `${name} must reach the child verbatim`);
  }
});

test('a proxied network command sees the proxy vars the user\'s shell has', async () => {
  const saved = { p: process.env.HTTP_PROXY, g: process.env.GIT_SSH_COMMAND };
  process.env.HTTP_PROXY = 'http://proxy.test:8080';
  process.env.GIT_SSH_COMMAND = 'ssh -o ProxyCommand=nc-proxy';
  try {
    const r = await handleRunBash(
      { command: 'echo "[$HTTP_PROXY][$GIT_SSH_COMMAND]"' },
      { workspaceRoot: workspace },
    );
    assert.equal(r.error, undefined);
    assert.equal(r.stdout.trim(), '[http://proxy.test:8080][ssh -o ProxyCommand=nc-proxy]');
  } finally {
    if (saved.p === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = saved.p;
    if (saved.g === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = saved.g;
  }
});

test('no env-borne credential reaches the child (NOT: no credential at all — HOME still leads to ~/.aws)', async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, tok: process.env.GITHUB_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
  process.env.GITHUB_TOKEN = 'ghp-must-not-leak';
  try {
    const r = await handleRunBash(
      { command: 'echo "[$ANTHROPIC_API_KEY][$GITHUB_TOKEN]"; env' },
      { workspaceRoot: workspace },
    );
    assert.equal(r.error, undefined);
    assert.match(r.stdout, /^\[\]\[\]$/m, 'both credential vars must be empty in the child');
    assert.ok(!r.stdout.includes('must-not-leak'), `leaked via env: ${r.stdout}`);
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.tok === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.tok;
  }
});

test('the scrubbed env still carries what ordinary commands need', async () => {
  const r = await handleRunBash({ command: 'echo "$PATH"; cd "$HOME" && pwd' }, { workspaceRoot: workspace });
  assert.equal(r.error, undefined);
  const [pathLine, homeLine] = r.stdout.trim().split('\n');
  assert.ok(pathLine.includes('/bin'), `PATH must survive the allowlist: ${pathLine}`);
  assert.equal(homeLine, fs.realpathSync(os.homedir()));
});

// ─────────────────────────────────────────────────────────────────────────────
// Abort + process-group kill
//
// Before this, the caller's Stop cancelled only the client-side task: the
// command ran on for the rest of its timeout (up to 120 s), and SIGTERM landed
// on `/bin/sh` alone so every grandchild it had started survived as an orphan.
// ─────────────────────────────────────────────────────────────────────────────

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const settle = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('an already-aborted signal refuses to spawn anything', async () => {
  const marker = path.join(tmp, 'pre-abort.txt');
  const ac = new AbortController();
  ac.abort();
  const r = await handleRunBash(
    { command: `touch ${marker}` },
    { workspaceRoot: workspace, signal: ac.signal },
  );
  assert.match(r.error, /aborted before it started/);
  assert.equal(fs.existsSync(marker), false, 'nothing may run once the turn is aborted');
});

test('aborting the turn kills an in-flight command instead of waiting out its timeout', async () => {
  const ac = new AbortController();
  const started = Date.now();
  // 30 s command, 120 s timeout: without the signal this promise could not
  // settle for 30 s, so a fast settle IS the abort taking effect.
  const p = handleRunBash(
    { command: 'sleep 30', timeout: 120_000 },
    { workspaceRoot: workspace, signal: ac.signal },
  );
  await settle(150);
  ac.abort();
  const r = await p;
  assert.equal(r.error, 'Command aborted.');
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - started < 5_000, `abort must settle promptly, took ${Date.now() - started}ms`);
});

test('abort kills the whole process group, not just the shell — grandchildren die too', async () => {
  const pidFile = path.join(tmp, 'grandchild.pid');
  const ac = new AbortController();
  // `sleep 60 &` is a GRANDCHILD of the server: /bin/sh is the child, the
  // backgrounded sleep is its own process. Killing only `sh` (the old
  // behaviour) left this running.
  const p = handleRunBash(
    { command: `sleep 60 & echo $! > ${pidFile}; sleep 60`, timeout: 120_000 },
    { workspaceRoot: workspace, signal: ac.signal },
  );

  let grandchildPid = 0;
  for (let i = 0; i < 100 && !grandchildPid; i += 1) {
    await settle(50);
    if (fs.existsSync(pidFile)) grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  }
  assert.ok(grandchildPid > 0, 'test setup: never saw the grandchild pid');
  assert.ok(isAlive(grandchildPid), 'test setup: grandchild should be running before the abort');

  ac.abort();
  assert.equal((await p).error, 'Command aborted.');

  // The kill is a signal, not a synchronous reap — give the OS a moment.
  for (let i = 0; i < 40 && isAlive(grandchildPid); i += 1) await settle(50);
  assert.equal(isAlive(grandchildPid), false, `grandchild ${grandchildPid} survived the abort`);
});

test('a timed-out command also takes its grandchildren with it', async () => {
  const pidFile = path.join(tmp, 'timeout-grandchild.pid');
  const p = handleRunBash(
    { command: `sleep 60 & echo $! > ${pidFile}; sleep 60`, timeout: 400 },
    { workspaceRoot: workspace },
  );
  const r = await p;
  assert.match(r.error, /timed out after 0\.4s/);
  assert.equal(r.exitCode, null);

  const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(grandchildPid > 0);
  for (let i = 0; i < 40 && isAlive(grandchildPid); i += 1) await settle(50);
  assert.equal(isAlive(grandchildPid), false, `grandchild ${grandchildPid} survived the timeout`);
});

// ─────────────────────────────────────────────────────────────────────────────
// The output cap (MAX_BUFFER_CHARS)
//
// This branch shipped with no test at all, and it was the broken one: it had
// no `settled` guard, so after the cap tripped, EVERY further `data` event
// re-entered it — appending to strings nobody would read, re-sending SIGTERM,
// and overwriting `killTimer` while abandoning the previous 2 s timer. A
// TERM-ignoring flood measured 1,762 abandoned timers and 257 MB RSS, each
// timer later firing SIGKILL at a reaped (and reusable) pgid.
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors KILL_GRACE_MS in the handler (not exported).
const GRACE_MS = 2_000;
const FLOOD_LINE = 'x'.repeat(4096);

test('a command that floods stdout is stopped by the output cap', async () => {
  // ~6 MiB, comfortably past the 4 MiB cap.
  const r = await handleRunBash(
    {
      command: `i=0; while [ $i -lt 1500 ]; do printf '%s\\n' "${FLOOD_LINE}"; i=$((i+1)); done`,
      timeout: 60_000,
    },
    { workspaceRoot: workspace },
  );
  assert.match(r.error, /more than 4194304 characters of output and was stopped/);
  assert.equal(r.exitCode, null);
  assert.equal(r.stdout, undefined, 'an overflowed run returns no captured output');
});

test('a flooding TERM-trapping command is signalled exactly ONCE, and still gets SIGKILLed', async () => {
  const sigFile = path.join(tmp, 'term-count.txt');
  const pidFile = path.join(tmp, 'flood.pid');
  fs.writeFileSync(sigFile, '');

  // Two traps, both load-bearing:
  //  TERM — appends one byte per delivery. Node exposes no way to count live
  //         timers, so SIGTERM *deliveries* are the observable proxy for
  //         "killGroup ran once": the buggy version called it on every chunk,
  //         so this file filled with hundreds of bytes. An RSS assertion was
  //         the alternative and is far too machine-dependent to gate on.
  //  PIPE — the handler destroys the stdout pipe when it settles; a
  //         default-disposition sh would die of SIGPIPE before the SIGTERM it
  //         was already sent could be counted.
  const command = [
    `trap 'printf T >> ${sigFile}' TERM`,
    "trap '' PIPE",
    `echo $$ > ${pidFile}`,
    `while :; do printf '%s\\n' "${FLOOD_LINE}"; done`,
  ].join('; ');

  const r = await handleRunBash({ command, timeout: 60_000 }, { workspaceRoot: workspace });
  assert.match(r.error, /more than 4194304 characters/);

  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(pid > 0, 'test setup: never saw the flooding shell pid');

  // Past the escalation window: the deliberate property is that the SIGKILL
  // timer OUTLIVES `finish` (a TERM-trapping tree must still die once nobody
  // is waiting) — only its repetition was the bug.
  await settle(GRACE_MS + 1_500);
  const terms = fs.readFileSync(sigFile, 'utf8');
  assert.equal(terms, 'T', `expected exactly ONE SIGTERM, got ${terms.length}`);
  // Timing/pid-based, so not perfectly deterministic: a machine slow enough to
  // delay the trap by >3.5 s would read 0 bytes here rather than 2+.
  assert.equal(isAlive(pid), false, `flooding shell ${pid} survived the escalation`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Unchanged contract (the fix is hardening, not a redesign)
// ─────────────────────────────────────────────────────────────────────────────

test('the success and failure return shapes are unchanged', async () => {
  const ok = await handleRunBash({ command: 'echo hello' }, { workspaceRoot: workspace });
  assert.deepEqual(
    { stdout: ok.stdout, stderr: ok.stderr, output: ok.output, exitCode: ok.exitCode },
    { stdout: 'hello\n', stderr: '', output: 'hello', exitCode: 0 },
  );

  const quiet = await handleRunBash({ command: 'true' }, { workspaceRoot: workspace });
  assert.equal(quiet.output, '(no output)');

  const bad = await handleRunBash({ command: 'echo oops >&2; exit 42' }, { workspaceRoot: workspace });
  assert.equal(bad.exitCode, 42);
  assert.match(bad.error, /^Command failed \(exit 42\): oops$/);
  assert.equal(bad.stderr, 'oops\n');
});

test('missing command is still rejected before anything is spawned', async () => {
  assert.match((await handleRunBash({})).error, /Missing command/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Why the abort is hand-rolled rather than spawn's own `signal` option
//
// spawn genuinely READS `signal` (CommonSpawnOptions extends Abortable), which
// is what makes it a trap: it looks like the whole fix, and it aborts by
// calling `subprocess.kill()` — the direct child only. This test pins the
// difference so nobody "simplifies" the handler back into the leak. Same class
// of mistake as passing `signal` to the Agent SDK, whose Options only has
// `abortController` and silently drops it.
// ─────────────────────────────────────────────────────────────────────────────

test("spawn's built-in signal option kills only the shell — the handler must not rely on it", async () => {
  const { spawn } = await import('node:child_process');
  const pidFile = path.join(tmp, 'builtin-signal.pid');
  const ac = new AbortController();
  const child = spawn('/bin/sh', ['-c', `sleep 60 & echo $! > ${pidFile}; sleep 60`], {
    cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], signal: ac.signal,
  });
  const aborted = new Promise((r) => { child.on('error', r); });

  let gc = 0;
  for (let i = 0; i < 100 && !gc; i += 1) {
    await settle(50);
    if (fs.existsSync(pidFile)) gc = Number(fs.readFileSync(pidFile, 'utf8').trim());
  }
  assert.ok(gc > 0 && isAlive(gc));

  ac.abort();
  const err = await aborted;
  assert.equal(err.name, 'AbortError', 'spawn really does honour its own signal option');
  await settle(400);
  assert.ok(isAlive(gc), 'built-in signal leaves the GRANDCHILD alive — hence the group kill');

  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ok */ }
  for (let i = 0; i < 40 && isAlive(gc); i += 1) await settle(50);
});

// ─────────────────────────────────────────────────────────────────────────────
// The signal has to ARRIVE, not merely be accepted
//
// A handler that kills its child when handed a signal would have passed before
// this change too — nothing was passing one. These tests assert the plumbing:
// runAgentLoop / runNativeAgentLoop → the tool ctx → registry.mjs → the
// handler, and finally handleCodeAssist → loop → registry → handler.
// (The last hop, server/ai-routes.mjs's `signal: ac.signal`, is a one-line
// pass-through of the SSE route's existing client-disconnect controller and is
// NOT covered here: exercising it needs a live HTTP server plus a JWT, which
// this unit file has no harness for. It is verified by reading only.)
// ─────────────────────────────────────────────────────────────────────────────

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
// Own throwaway DB: the registry's legacy gate reads trusted roots and
// always-allow from it, and these tests register users — neither belongs in
// the developer's real kb.
const testDbPath = path.join(os.tmpdir(), `run-bash-signal-${process.pid}.db`);
process.env.LLMIDE_DB_PATH = testDbPath;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDbPath + s); } catch { /* ok */ } }
after(() => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDbPath + s); } catch { /* ok */ } }
});

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { runAgentLoop, runNativeAgentLoop } = await import('../llm_agent/runtime/loop.mjs');
const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');
const { loadSkills } = await import('../llm_agent/skills/loader.mjs');

test('runAgentLoop forwards the turn signal into every tool ctx', async () => {
  const { skills } = loadSkills(path.join(REPO_DIR, 'llm_agent', 'global'));
  const ac = new AbortController();
  const seen = [];
  const handlers = { 'read-file': async (_args, ctx) => { seen.push(ctx.signal); return { content: 'x' }; } };
  const replies = [
    '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"a.txt"}}\n<<<END_TOOL_CALL>>>',
    'All done.',
  ];
  await runAgentLoop({
    skills, userMessage: 'read it', history: [], agentContext: { base: '' },
    runClaude: async () => replies.shift(), kb: null, userId: 'u1', handlers,
    signal: ac.signal,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], ac.signal, 'the tool ctx must carry the turn signal itself');
});

test('runNativeAgentLoop forwards the turn signal into every tool ctx', async () => {
  const skills = new Map([
    ['run-bash', { name: 'run-bash', kind: 'read', schema: { command: { type: 'string', required: true } }, description: 'run', body: '' }],
  ]);
  const ac = new AbortController();
  const seen = [];
  const handlers = { 'run-bash': async (_args, ctx) => { seen.push(ctx.signal); return { output: 'ok', exitCode: 0 }; } };
  let turn = 0;
  await runNativeAgentLoop({
    systemPrompt: 'sys', userMessage: 'run it', skills, tools: [], userId: 'u1', handlers, kb: null,
    complete: async () => {
      turn += 1;
      return turn === 1
        ? { text: '', toolCalls: [{ id: 'c1', name: 'run-bash', arguments: { command: 'echo hi' } }] }
        : { text: 'done', toolCalls: [] };
    },
    signal: ac.signal,
  });
  assert.equal(seen[0], ac.signal);
});

test('registry.mjs hands the loop\'s signal to run-bash (legacy engine ctx shape)', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const { setAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const user = registerUser(getDb(), {
    email: `run-bash-signal-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery', displayName: 't',
  });
  // `sleep 30` is prompt-tier; always-allow is how a legacy turn reaches the
  // handler without a live approval channel in a unit test.
  setAlwaysAllow(user.id, 'run-bash');

  const ac = new AbortController();
  const started = Date.now();
  const p = get('run-bash').execute(
    { command: 'sleep 30', timeout: 120_000 },
    {
      userId: user.id,
      agentContext: { sessionId: 'sig-legacy-1', workspaceRoot: workspace },
      // Exactly the shape loop.mjs builds — buildDispatch nests it under loopCtx.
      loopCtx: { userId: user.id, depth: 1, emit: () => {}, signal: ac.signal },
    },
  );
  await settle(150);
  ac.abort();
  assert.equal((await p).error, 'Command aborted.');
  assert.ok(Date.now() - started < 5_000);
});

test('registry.mjs hands a v2-shaped ctx.signal to run-bash too', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const ac = new AbortController();
  // No loopCtx => the v2 branch, which skips the legacy gate entirely.
  const p = get('run-bash').execute(
    { command: 'sleep 30', timeout: 120_000 },
    { agentContext: { workspaceRoot: workspace }, signal: ac.signal },
  );
  await settle(150);
  ac.abort();
  assert.equal((await p).error, 'Command aborted.');
});

test('handleCodeAssist → loop → registry → handler: an aborted turn stops the command', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const user = registerUser(getDb(), {
    email: `run-bash-e2e-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery', displayName: 't',
  });
  const ac = new AbortController();

  const marker = path.join(tmp, 'e2e-abort-ran.txt');
  const prompts = [];
  const runClaude = async (prompt) => {
    prompts.push(prompt);
    // Abort MID-turn: after the model has asked for the tool, before the tool
    // is dispatched. Aborting up front no longer exercises this path at all —
    // runAgentLoop checks the signal at the top of each iteration, so a turn
    // that starts aborted returns before any tool is reached (and before any
    // model call, which is why the setup assertion below would fail). The
    // thing under test is a tool being dispatched ON an aborted turn.
    if (prompts.length === 1) {
      ac.abort();
      // `touch` is auto-tier like `cat`, so no approval is needed and the only
      // thing that can stop it is the signal arriving from the route. The
      // marker file is the side effect: if it exists, the command really ran.
      return `<<<TOOL_CALL>>>\n{"name":"run-bash","arguments":{"command":"touch ${marker}"}}\n<<<END_TOOL_CALL>>>`;
    }
    return 'I could not run that.';
  };

  await handleCodeAssist({
    message: 'show me ok.txt',
    history: [],
    agentContext: { sessionId: 'sig-e2e-1', workspaceRoot: workspace },
    runClaude,
    kb: { getUserPrefs: () => ({ language: 'en' }) },
    userId: user.id,
    mode: 'execute',
    maxIterations: 2,
    signal: ac.signal,
  });

  // The proof the signal travelled the whole way down is the missing side
  // effect: the model asked for a `touch`, the tool was dispatched, and no
  // file appeared.
  assert.ok(prompts.length >= 1, 'test setup: the model was never called');
  assert.equal(fs.existsSync(marker), false, 'the command ran despite an aborted turn');

  // And the turn stops there rather than calling the model again: the loop
  // returns an aborted reply at the top of the next iteration instead of
  // issuing a fresh, unabortable request. (This used to assert a SECOND
  // prompt carrying the refusal text, on the assumption that the loop always
  // feeds a tool result back to the model — which would now mean billing the
  // user for a turn they cancelled.)
  assert.equal(prompts.length, 1, 'an aborted turn must not issue another model call');
});
