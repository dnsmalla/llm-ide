// The Loop's headless, confined agent run: POST /kb/loop/agent-run
// (routes/loop-agent.mjs) and its engine (llm_agent/sdk/loop-agent.mjs).
//
// Hermetic: scratch DB, a temp git repo registered on the user's allow-list,
// and a fake SDK query factory that plays the SDK's side of the tool
// protocol (PreToolUse hook → canUseTool → execute → PostToolUse hook), so
// the confinement rule is exercised exactly where the real SDK would consult
// it — no subprocess, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_loop-agent-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, addUserRepo } = await import('../kb/db.mjs');
const {
  runLoopAgent, validateLoopRepoRoot, loopToolRefusal, LOOP_AGENT_TOOLS,
} = await import('../llm_agent/sdk/loop-agent.mjs');
const { handleLoopAgentRoutes, resolveTimeoutMs } = await import('../routes/loop-agent.mjs');

// --- fixtures -----------------------------------------------------------------

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-agent-')));
after(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ } });

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
  });
}

const REPO = path.join(SANDBOX, 'repo');
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'a.txt'), 'old\n');
git(['init', '-q'], REPO);
git(['add', '.'], REPO);
git(['commit', '-q', '-m', 'init'], REPO);

const OUTSIDE = path.join(SANDBOX, 'outside');
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'nope\n');
// A symlink INSIDE the repo pointing OUT of it.
fs.symlinkSync(OUTSIDE, path.join(REPO, 'escape'));

let seq = 0;
function newUser() {
  seq += 1;
  return registerUser(getDb(), {
    email: `loop-agent-${seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
}

const user = newUser();
addUserRepo(user.id, REPO);

// --- req/res doubles (same shape as agent-v2-routes.test.mjs) ----------------

function makeReq({ body, user: u, url = '/kb/loop/agent-run' }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method: 'POST', url, user: u ?? { id: null }, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      else if (event === 'close') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  const closeCbs = [];
  return {
    on(event, cb) { if (event === 'close') closeCbs.push(cb); return this; },
    fireClose() { closeCbs.forEach((cb) => cb()); },
    statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; this.writableFinished = true; },
    json() { return JSON.parse(this._body); },
  };
}

// --- a fake SDK that runs the tool protocol -----------------------------------

/**
 * Returns a query factory that, for each planned tool call, does what the SDK
 * does: PreToolUse hooks, then canUseTool, then (if allowed) the tool itself,
 * then PostToolUse hooks. Records every verdict on `capture`.
 */
function toolPlayingQuery(capture, calls) {
  return (prompt, options) => {
    capture.prompt = prompt;
    capture.options = options;
    capture.verdicts = [];
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1', model: 'test-model', tools: options.tools };
      for (const { tool, input, run } of calls) {
        let denied = null;
        for (const m of options.hooks?.PreToolUse ?? []) {
          for (const h of m.hooks) {
            const out = await h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, 'id', {});
            if (out?.hookSpecificOutput?.permissionDecision === 'deny') denied = out.hookSpecificOutput.permissionDecisionReason;
          }
        }
        const perm = denied ? null : await options.canUseTool(tool, input, {});
        const allowed = !denied && perm?.behavior === 'allow';
        capture.verdicts.push({ tool, allowed, hookDenied: Boolean(denied), perm });
        if (!allowed) continue;
        run?.(input);
        for (const m of options.hooks?.PostToolUse ?? []) {
          if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(tool)) continue;
          for (const h of m.hooks) await h({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input }, 'id', {});
        }
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Changed src/a.txt.' }] } };
      yield {
        type: 'result', subtype: 'success', result: 'Changed src/a.txt.', num_turns: 2, duration_ms: 5,
        total_cost_usd: 0.01,
        modelUsage: { 'test-model': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2, costUSD: 0.01 } },
      };
    })();
  };
}

const write = (input) => fs.writeFileSync(input.file_path, input.content);
const noSkill = { readSkill: () => null };

async function withKey(fn) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-loop-test';
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
}

// --- repoRoot validation ------------------------------------------------------

test('validateLoopRepoRoot: an allow-listed repo and a folder inside it are accepted', () => {
  assert.deepEqual(validateLoopRepoRoot(user.id, REPO), { ok: true, root: REPO });
  assert.equal(validateLoopRepoRoot(user.id, path.join(REPO, 'src')).ok, true);
});

test('validateLoopRepoRoot: outside the allow-list, relative, "..", missing and symlinked-out roots are refused', () => {
  assert.equal(validateLoopRepoRoot(user.id, OUTSIDE).ok, false);
  assert.equal(validateLoopRepoRoot(user.id, 'repo').ok, false);
  assert.equal(validateLoopRepoRoot(user.id, `${REPO}/../outside`).ok, false);
  assert.equal(validateLoopRepoRoot(user.id, path.join(SANDBOX, 'missing')).ok, false);
  assert.equal(validateLoopRepoRoot(user.id, path.join(REPO, 'escape')).ok, false,
    'a symlink inside the repo is judged by where it lands');
  assert.equal(validateLoopRepoRoot(user.id, undefined).ok, false);
  assert.equal(validateLoopRepoRoot(newUser().id, REPO).ok, false, "another user's allow-list does not count");
});

test('validateLoopRepoRoot: a Loop worktree of an allowed repo is accepted; a forged .git file is not', () => {
  const wtParent = path.join(SANDBOX, '.llmide-loop-worktrees', 'repo');
  fs.mkdirSync(wtParent, { recursive: true });
  const wt = path.join(wtParent, 'abc123');
  git(['worktree', 'add', '-q', '-b', 'llmide/loop/abc123', wt, 'HEAD'], REPO);
  assert.deepEqual(validateLoopRepoRoot(user.id, wt), { ok: true, root: fs.realpathSync(wt) });

  // Same parent, a `.git` file claiming the same worktree entry — but git's
  // back-reference names the real worktree, not this one.
  const forged = path.join(wtParent, 'forged');
  fs.mkdirSync(forged);
  fs.writeFileSync(path.join(forged, '.git'), fs.readFileSync(path.join(wt, '.git'), 'utf8'));
  assert.equal(validateLoopRepoRoot(user.id, forged).ok, false);

  // A worktree of a repo NOT on the allow-list is refused.
  const other = path.join(SANDBOX, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'x'), 'x');
  git(['init', '-q'], other); git(['add', '.'], other); git(['commit', '-q', '-m', 'i'], other);
  const otherWt = path.join(SANDBOX, '.llmide-loop-worktrees', 'other', 'w1');
  fs.mkdirSync(path.dirname(otherWt), { recursive: true });
  git(['worktree', 'add', '-q', '-b', 'llmide/loop/w1', otherWt, 'HEAD'], other);
  assert.equal(validateLoopRepoRoot(user.id, otherWt).ok, false);
});

// --- confinement ----------------------------------------------------------------

test('loopToolRefusal: file tools inside the root pass; outside, symlink escapes, secrets and shells are refused', () => {
  assert.equal(loopToolRefusal('Edit', { file_path: path.join(REPO, 'src', 'a.txt') }, REPO), null);
  assert.equal(loopToolRefusal('Write', { file_path: path.join(REPO, 'src', 'new.txt') }, REPO), null);
  assert.equal(loopToolRefusal('Read', { file_path: 'src/a.txt' }, REPO), null);
  assert.equal(loopToolRefusal('Grep', { pattern: 'old' }, REPO), null);
  assert.equal(loopToolRefusal('Glob', { pattern: 'src/**/*.txt', path: REPO }, REPO), null);

  assert.ok(loopToolRefusal('Write', { file_path: path.join(OUTSIDE, 'x.txt') }, REPO));
  assert.ok(loopToolRefusal('Read', { file_path: path.join(OUTSIDE, 'secret.txt') }, REPO));
  assert.ok(loopToolRefusal('Edit', { file_path: path.join(REPO, 'escape', 'secret.txt') }, REPO), 'symlink escape');
  assert.ok(loopToolRefusal('Write', { file_path: path.join(REPO, '..', 'outside', 'y') }, REPO));
  assert.ok(loopToolRefusal('Write', { file_path: path.join(REPO, '.env') }, REPO), 'secret path');
  assert.ok(loopToolRefusal('Write', { file_path: path.join(REPO, '.git', 'hooks', 'pre-commit') }, REPO));
  assert.ok(loopToolRefusal('Glob', { pattern: '/etc/**' }, REPO));
  assert.ok(loopToolRefusal('Grep', { pattern: 'x', glob: '../**' }, REPO));
  assert.ok(loopToolRefusal('Grep', { pattern: 'x', path: OUTSIDE }, REPO));
  for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'AskUserQuestion', 'mcp__llmide__run-bash']) {
    assert.ok(loopToolRefusal(t, { command: 'ls' }, REPO), `${t} must be refused`);
  }
});

test('runLoopAgent: offers file tools only — no shell, no network, no MCP, nothing pre-approved', () => withKey(async () => {
  const capture = {};
  await runLoopAgent({
    message: 'fix it', root: REPO, userId: user.id, queryFactory: toolPlayingQuery(capture, []),
  }, noSkill);
  const o = capture.options;
  assert.deepEqual([...o.tools].sort(), [...LOOP_AGENT_TOOLS].sort());
  for (const t of ['Bash', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Agent']) {
    assert.ok(!o.tools.includes(t), `${t} must not be offered`);
  }
  assert.ok(o.disallowedTools.includes('Bash'));
  assert.ok(o.disallowedTools.includes('mcp__*'));
  assert.deepEqual(o.allowedTools, []);
  assert.deepEqual(o.mcpServers, {});
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.cwd, REPO);
  assert.deepEqual(o.additionalDirectories, []);
  assert.equal(o.persistSession, false);
  assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.match(o.systemPrompt.append, /no shell/);
}));

test('runLoopAgent: an edit inside repoRoot lands and is reported repo-relative; outside edits are refused and do not land', () => withKey(async () => {
  const capture = {};
  const outsideTarget = path.join(OUTSIDE, 'written.txt');
  const out = await runLoopAgent({
    message: 'fix it', root: REPO, userId: user.id,
    queryFactory: toolPlayingQuery(capture, [
      { tool: 'Write', input: { file_path: path.join(REPO, 'src', 'a.txt'), content: 'new\n' }, run: write },
      { tool: 'Write', input: { file_path: outsideTarget, content: 'x' }, run: write },
      { tool: 'Write', input: { file_path: path.join(REPO, 'escape', 'via-link.txt'), content: 'x' }, run: write },
      { tool: 'Bash', input: { command: 'rm -rf /' }, run: () => { throw new Error('Bash must never run'); } },
    ]),
  }, noSkill);
  assert.equal(fs.readFileSync(path.join(REPO, 'src', 'a.txt'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(outsideTarget), false);
  assert.equal(fs.existsSync(path.join(OUTSIDE, 'via-link.txt')), false);
  assert.deepEqual(out.changedPaths, ['src/a.txt']);
  assert.deepEqual(capture.verdicts.map((v) => v.allowed), [true, false, false, false]);
  assert.equal(out.denied.length, 3);
  assert.equal(out.reply, 'Changed src/a.txt.');
  assert.equal(out.ran, true);
  assert.equal(out.usage.inputTokens, 10);
  assert.equal(out.usage.outputTokens, 5);
  git(['checkout', '--', 'src/a.txt'], REPO);
}));

test('runLoopAgent: canUseTool decides immediately — nothing is ever parked', () => withKey(async () => {
  const capture = {};
  await runLoopAgent({ message: 'x', root: REPO, userId: user.id, queryFactory: toolPlayingQuery(capture, []) }, noSkill);
  const PARKED = Symbol('parked');
  for (const [tool, input] of [['Bash', { command: 'echo hi' }], ['Write', { file_path: path.join(OUTSIDE, 'z') }], ['Edit', { file_path: path.join(REPO, 'src', 'a.txt') }]]) {
    const v = await Promise.race([capture.options.canUseTool(tool, input, {}), new Promise((r) => setImmediate(() => r(PARKED)))]);
    assert.notEqual(v, PARKED, `${tool} must not park`);
  }
}));

test('runLoopAgent: an unknown skill id is reported in unresolvedSkills and the agent does not run', () => withKey(async () => {
  let called = false;
  const out = await runLoopAgent({
    message: 'x', root: REPO, userId: user.id, skills: ['family/known', 'family/missing'],
    queryFactory: () => { called = true; return (async function* () {})(); },
  }, { readSkill: (id) => (id === 'family/known' ? { name: 'known', content: 'do it' } : null) });
  assert.deepEqual(out.resolvedSkills, ['family/known']);
  assert.deepEqual(out.unresolvedSkills, ['family/missing']);
  assert.equal(out.ran, false);
  assert.equal(called, false, 'a missing skill must not run a skill-less edit');
  assert.deepEqual(out.changedPaths, []);
}));

test('runLoopAgent: resolved skills ride in the system prompt; a cut-off skill is reported truncated', () => withKey(async () => {
  const capture = {};
  const out = await runLoopAgent({
    message: 'x', root: REPO, userId: user.id, skills: ['f/big', 'f/small'], queryFactory: toolPlayingQuery(capture, []),
  }, { readSkill: (id) => ({ name: id, content: `BODY-${id}`, truncated: id === 'f/big' }) });
  assert.deepEqual(out.resolvedSkills, ['f/big', 'f/small']);
  assert.deepEqual(out.truncatedSkills, ['f/big']);
  assert.deepEqual(out.unresolvedSkills, []);
  assert.match(capture.options.systemPrompt.append, /BODY-f\/big/);
  assert.match(capture.options.systemPrompt.append, /BODY-f\/small/);
}));

// --- route ------------------------------------------------------------------------

test('route: a repoRoot outside the allow-list is rejected with 400 before anything runs', async () => {
  let ran = false;
  const res = makeRes();
  const handled = await handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: OUTSIDE }, user }), res, { userId: user.id },
    { runAgent: async () => { ran = true; } },
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'REPO_ROOT_NOT_ALLOWED');
  assert.equal(ran, false);
});

test('route: validation — message, skills and timeoutMs', async () => {
  for (const body of [
    { repoRoot: REPO },
    { message: '   ', repoRoot: REPO },
    { message: 'x', repoRoot: REPO, skills: 'a' },
    { message: 'x', repoRoot: REPO, skills: [1] },
    { message: 'x', repoRoot: REPO, timeoutMs: -5 },
  ]) {
    const res = makeRes();
    await handleLoopAgentRoutes(makeReq({ body, user }), res, { userId: user.id }, { runAgent: async () => ({}) });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(resolveTimeoutMs(10), 1_000);
  assert.equal(resolveTimeoutMs(undefined), 30 * 60 * 1000);
});

test('route: other paths fall through', async () => {
  assert.equal(await handleLoopAgentRoutes(makeReq({ body: {}, url: '/kb/other' }), makeRes(), { userId: user.id }), false);
});

test('route: 200 carries the contract fields and the validated root reaches the engine', async () => {
  let seen = null;
  const res = makeRes();
  await handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO, skills: ['a/b'], model: 'm1', timeoutMs: 60_000 }, user }),
    res, { userId: user.id },
    {
      runAgent: async (args) => {
        seen = args;
        return {
          reply: 'done', changedPaths: ['src/a.txt'], usage: { inputTokens: 1, outputTokens: 2 },
          resolvedSkills: ['a/b'], unresolvedSkills: [], truncatedSkills: [], ran: true,
          resultSubtype: 'success', denied: [], model: 'm1', byModel: [],
        };
      },
    },
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  for (const k of ['reply', 'changedPaths', 'usage', 'resolvedSkills', 'unresolvedSkills', 'truncatedSkills']) {
    assert.ok(k in body, `${k} in response`);
  }
  assert.equal(seen.root, REPO);
  assert.equal(seen.model, 'm1');
  assert.deepEqual(seen.skills, ['a/b']);
  assert.ok(seen.abortController instanceof AbortController);
});

test('route: timeoutMs aborts the run and answers 504', async () => {
  const res = makeRes();
  let aborted = false;
  await handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO, timeoutMs: 1_000 }, user }), res, { userId: user.id },
    {
      runAgent: ({ abortController }) => new Promise((_, reject) => {
        abortController.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      }),
    },
  );
  assert.equal(aborted, true);
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().error.code, 'AGENT_RUN_TIMEOUT');
});

test('route: a client disconnect aborts the run', async () => {
  const res = makeRes();
  let aborted = false;
  const p = handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user }), res, { userId: user.id },
    {
      runAgent: ({ abortController }) => new Promise((_, reject) => {
        abortController.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
        setImmediate(() => res.fireClose());
      }),
    },
  );
  await p;
  assert.equal(aborted, true);
  assert.equal(res.headersSent, false, 'nobody left to answer');
});

const { patternTargetsSecret, LOOP_GREP_SECRET_EXCLUSIONS } = await import('../llm_agent/sdk/loop-agent.mjs');

// --- secret paths through Grep / Glob ----------------------------------------------

test('loopToolRefusal: Grep/Glob aimed at .pem, .env* or id_rsa are refused; ordinary searches pass', () => {
  for (const [tool, input] of [
    ['Glob', { pattern: '**/*.pem' }],
    ['Glob', { pattern: '**/.env*' }],
    ['Glob', { pattern: '**/id_rsa' }],
    ['Glob', { pattern: 'certs/*.{pem,crt}' }],
    ['Glob', { pattern: '**/*.PEM' }],
    ['Grep', { pattern: 'KEY', glob: '*.pem' }],
    ['Grep', { pattern: 'TOKEN', glob: '.env.local' }],
    ['Grep', { pattern: 'x', glob: '**/id_rsa*' }],
    ['Grep', { pattern: 'x', path: path.join(REPO, '.env') }],
    ['Glob', { pattern: '*', path: path.join(REPO, '.ssh') }],
  ]) {
    assert.ok(loopToolRefusal(tool, input, REPO), `${tool} ${JSON.stringify(input)} must be refused`);
  }
  for (const [tool, input] of [
    ['Glob', { pattern: '**/*.swift' }],
    ['Grep', { pattern: 'process.env', glob: '*.{ts,mjs}' }],
    ['Grep', { pattern: 'x', glob: '!**/*.pem' }],
    ['Glob', { pattern: 'src/**/*.keyboard.ts' }],
  ]) {
    assert.equal(loopToolRefusal(tool, input, REPO), null, `${tool} ${JSON.stringify(input)} must pass`);
  }
  assert.equal(patternTargetsSecret(undefined), false);
});

test('runLoopAgent: every allowed Grep carries the secret exclusions as negative globs', () => withKey(async () => {
  const capture = {};
  await runLoopAgent({ message: 'x', root: REPO, userId: user.id, queryFactory: toolPlayingQuery(capture, []) }, noSkill);
  const hook = capture.options.hooks.PreToolUse[0].hooks[0];
  const out = await hook({ tool_name: 'Grep', tool_input: { pattern: 'secret', output_mode: 'content', glob: '*.ts' } });
  const glob = out.hookSpecificOutput.updatedInput.glob;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(glob.startsWith('*.ts '), 'the caller glob is kept first');
  for (const g of LOOP_GREP_SECRET_EXCLUSIONS) assert.ok(glob.split(' ').includes(g));
  assert.ok(LOOP_GREP_SECRET_EXCLUSIONS.some((g) => /pP\]\[eE\]\[mM/.test(g)), '.pem, any case');
  assert.ok(LOOP_GREP_SECRET_EXCLUSIONS.some((g) => g.includes('[iI][dD]_[rR][sS][aA]')), 'id_rsa');
  assert.ok(LOOP_GREP_SECRET_EXCLUSIONS.some((g) => g.endsWith('[eE][nN][vV].*')), '.env.*');
  const perm = await capture.options.canUseTool('Grep', { pattern: 'x' }, {});
  assert.ok(perm.updatedInput.glob.includes('!**/'), 'canUseTool adds them too');
  // Non-Grep tools are passed through untouched.
  assert.deepEqual(await hook({ tool_name: 'Read', tool_input: { file_path: path.join(REPO, 'src', 'a.txt') } }), {});
}));

// --- metering a cut-off run ----------------------------------------------------------

test('route: a run that times out after reporting usage is still metered before the 504', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  const res = makeRes();
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO, timeoutMs: 1_000 }, user: u }), res, { userId: u.id },
    {
      runAgent: (args) => runLoopAgent({
        ...args,
        queryFactory: (prompt, options) => (async function* () {
          yield { type: 'system', subtype: 'init', model: 'test-model' };
          const m = { id: 'msg_1', model: 'test-model', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 3 } };
          yield { type: 'assistant', message: m };
          yield { type: 'assistant', message: m }; // same API call, split — counted once
          await new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        })(),
      }, noSkill),
    },
  ));
  assert.equal(res.statusCode, 504);
  const rows = db.prepare('SELECT model, input_tokens, output_tokens, cache_read_tokens FROM usage_ledger WHERE user_id = ?').all(u.id);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ model: 'test-model', input_tokens: 40, output_tokens: 7, cache_read_tokens: 3 }]);
});
