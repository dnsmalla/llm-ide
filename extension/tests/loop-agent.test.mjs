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
// The older tests read systemPrompt.append (the preset arm); a shell export must not flip them.
delete process.env.LLMIDE_LOOP_CUSTOM_PROMPT;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_loop-agent-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, addUserRepo, writeCodeGraph } = await import('../kb/db.mjs');
const {
  runLoopAgent, validateLoopRepoRoot, loopToolRefusal, LOOP_AGENT_TOOLS,
  LOOP_FIND_CODE_TOOL, loopFindCode, graphScopeRoot,
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
  for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'AskUserQuestion', 'mcp__llmide__run-bash',
    'mcp__llmide__read-file', 'mcp__other__find-code']) {
    assert.ok(loopToolRefusal(t, { command: 'ls' }, REPO), `${t} must be refused`);
  }
  // The one MCP tool a Loop run has: read-only code search over the user's own graph.
  assert.equal(loopToolRefusal(LOOP_FIND_CODE_TOOL, { query: 'old' }, REPO), null);
});

test('runLoopAgent: offers file tools + find-code only — no shell, no network, no user MCP, nothing pre-approved', () => withKey(async () => {
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
  assert.deepEqual(o.allowedTools, []);
  // Only the in-process code-search server — never a user MCP server.
  assert.deepEqual(Object.keys(o.mcpServers), ['llmide']);
  assert.equal(o.strictMcpConfig, true, 'no .mcp.json / user / plugin MCP server can join');
  assert.equal(o.mcpServers.llmide.type, 'sdk');
  assert.match(o.systemPrompt.append, /mcp__llmide__find-code/);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.cwd, REPO);
  assert.deepEqual(o.additionalDirectories, []);
  assert.equal(o.persistSession, false);
  assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.match(o.systemPrompt.append, /no shell/);
  assert.equal(o.env.LLMIDE_JWT_SECRET, undefined, 'the server\'s own secrets never reach the subprocess');
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

// --- extra roots (split project layout: <project>/llm-doc beside code/<repo>) ---

const { validateLoopExtraRoots, patternTargetsSecret, LOOP_GREP_SECRET_EXCLUSIONS } = await import('../llm_agent/sdk/loop-agent.mjs');

function splitProject(name) {
  const project = path.join(SANDBOX, name);
  const repo = path.join(project, 'code', 'app');
  fs.mkdirSync(path.join(project, 'system'), { recursive: true });
  fs.writeFileSync(path.join(project, 'system', 'project.json'), '{}');
  fs.mkdirSync(path.join(project, 'llm-doc', 'plans'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  return { project, repo, llmDoc: path.join(project, 'llm-doc') };
}

test('validateLoopExtraRoots: the project llm-doc of a split layout (and of a Loop worktree) is accepted', () => {
  const { project, repo, llmDoc } = splitProject('split-ok');
  assert.deepEqual(validateLoopExtraRoots([llmDoc], repo), { ok: true, roots: [llmDoc] });
  assert.deepEqual(validateLoopExtraRoots(undefined, repo), { ok: true, roots: [] });
  // The project root itself as the repo (depth 0), and a worktree 3 levels down.
  assert.equal(validateLoopExtraRoots([llmDoc], project).ok, true);
  const wt = path.join(project, 'system', 'loop-worktrees', 'w1');
  fs.mkdirSync(wt, { recursive: true });
  assert.equal(validateLoopExtraRoots([llmDoc], wt).ok, true);
});

test('validateLoopExtraRoots: wrong name, no project.json, too deep, another project, symlinks out, too many — refused', () => {
  const { project, repo, llmDoc } = splitProject('split-bad');
  const other = splitProject('split-other');
  const notNamed = path.join(project, 'docs');
  fs.mkdirSync(notNamed);
  assert.equal(validateLoopExtraRoots([notNamed], repo).ok, false, 'must be named llm-doc');
  const bare = path.join(SANDBOX, 'bare', 'llm-doc');
  fs.mkdirSync(bare, { recursive: true });
  assert.equal(validateLoopExtraRoots([bare], path.join(SANDBOX, 'bare')).ok, false, 'parent must be a project');
  const deep = path.join(project, 'code', 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(validateLoopExtraRoots([llmDoc], deep).ok, false, 'more than 3 levels up');
  assert.equal(validateLoopExtraRoots([other.llmDoc], repo).ok, false, "another project's llm-doc");
  const linkDir = path.join(project, 'links');
  fs.mkdirSync(linkDir);
  fs.symlinkSync(OUTSIDE, path.join(linkDir, 'llm-doc'));
  assert.equal(validateLoopExtraRoots([path.join(linkDir, 'llm-doc')], repo).ok, false, 'judged by where the link lands');
  assert.equal(validateLoopExtraRoots(['llm-doc'], repo).ok, false, 'relative');
  assert.equal(validateLoopExtraRoots([path.join(SANDBOX, 'missing', 'llm-doc')], repo).ok, false);
  assert.equal(validateLoopExtraRoots(llmDoc, repo).ok, false, 'not an array');
  assert.equal(validateLoopExtraRoots([llmDoc, llmDoc, llmDoc, llmDoc, llmDoc], repo).ok, false, 'at most 4');
});

test('route: a refused extra root answers 400 EXTRA_ROOT_NOT_ALLOWED before anything runs', async () => {
  const { repo } = splitProject('split-route');
  addUserRepo(user.id, repo);
  let ran = false;
  const res = makeRes();
  await handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: repo, extraRoots: [OUTSIDE] }, user }), res, { userId: user.id },
    { runAgent: async () => { ran = true; } },
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'EXTRA_ROOT_NOT_ALLOWED');
  assert.equal(ran, false);
});

test('route: an accepted extra root reaches the engine', async () => {
  const { repo, llmDoc } = splitProject('split-route-ok');
  addUserRepo(user.id, repo);
  let seen = null;
  const res = makeRes();
  await handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: repo, extraRoots: [llmDoc] }, user }), res, { userId: user.id },
    { runAgent: async (args) => { seen = args; return { reply: '', changedPaths: [], changedExtraPaths: [path.join(llmDoc, 'p.md')], usage: {}, resolvedSkills: [], unresolvedSkills: [], truncatedSkills: [], ran: true, resultSubtype: 'success', denied: [], byModel: [] }; } },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.extraRoots, [llmDoc]);
  assert.deepEqual(res.json().changedExtraPaths, [path.join(llmDoc, 'p.md')]);
});

test('runLoopAgent: a write into an accepted extra root lands; outside both stays refused', () => withKey(async () => {
  const { repo, llmDoc } = splitProject('split-run');
  const capture = {};
  const plan = path.join(llmDoc, 'plans', 'PLAN.md');
  const out = await runLoopAgent({
    message: 'plan', root: repo, extraRoots: [llmDoc], userId: user.id,
    queryFactory: toolPlayingQuery(capture, [
      { tool: 'Write', input: { file_path: plan, content: '# plan\n' }, run: write },
      { tool: 'Write', input: { file_path: path.join(OUTSIDE, 'p.md'), content: 'x' }, run: write },
      { tool: 'Write', input: { file_path: path.join(repo, 'x.txt'), content: 'y\n' }, run: write },
    ]),
  }, noSkill);
  assert.equal(fs.readFileSync(plan, 'utf8'), '# plan\n');
  assert.equal(fs.existsSync(path.join(OUTSIDE, 'p.md')), false);
  assert.deepEqual(out.changedPaths, ['x.txt']);
  assert.deepEqual(out.changedExtraPaths, [plan]);
  assert.deepEqual(capture.options.additionalDirectories, [llmDoc]);
  assert.ok(capture.options.systemPrompt.append.includes(llmDoc), 'the system prompt names the extra root');
  assert.equal(out.denied.length, 1);
}));

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
  // A run cut off before any result never reported a turn count: unknown, not zero,
  // and the reason it stopped is recorded so it can be told from hitting the cap.
  const stop = db.prepare('SELECT turns, stop_reason FROM usage_ledger WHERE user_id = ?').all(u.id);
  assert.deepEqual(stop.map((r) => ({ ...r })), [{ turns: null, stop_reason: 'timeout' }]);
});

// --- round trips and stop reason on the ledger (migration 0039) ----------------------

function resultQuery(result) {
  return () => (async function* () {
    yield { type: 'system', subtype: 'init', model: 'main-model' };
    yield { type: 'assistant', message: { id: 'm1', model: 'main-model', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } };
    yield { type: 'result', ...result };
  })();
}

test('route: a finished run records its turn count and why it stopped, once per run', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  const res = makeRes();
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user: u }), res, { userId: u.id },
    {
      runAgent: (args) => runLoopAgent({
        ...args,
        queryFactory: resultQuery({
          subtype: 'error_max_turns', num_turns: 60, total_cost_usd: 0.5, duration_ms: 1234,
          // The run used a big model AND a small helper: two ledger rows, one run.
          modelUsage: {
            'helper-model': { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 10, cacheCreationInputTokens: 2 },
            'main-model': { inputTokens: 40, outputTokens: 7, cacheReadInputTokens: 900, cacheCreationInputTokens: 30 },
          },
        }),
      }, noSkill),
    },
  ));
  assert.equal(res.statusCode, 200, res._body);
  const rows = db.prepare('SELECT model, turns, stop_reason FROM usage_ledger WHERE user_id = ? ORDER BY model').all(u.id)
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { model: 'helper-model', turns: null, stop_reason: null },
    { model: 'main-model', turns: 60, stop_reason: 'error_max_turns' },
  ], 'the 60 turns are on the PRIMARY model\'s row only — repeating them would double the run');
});

test('route: the turns land on the MAIN model even when its name differs by a suffix from the init name', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user: u }), makeRes(), { userId: u.id },
    { runAgent: (args) => runLoopAgent({ ...args, queryFactory: () => (async function* () {
      // The init reports the 1M-context variant; the per-model totals are keyed without it,
      // and the small helper is listed FIRST — exactly the case an exact match misses.
      yield { type: 'system', subtype: 'init', model: 'main-model[1m]' };
      yield { type: 'result', subtype: 'success', num_turns: 11, modelUsage: {
        'helper-model': { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 },
        'main-model': { inputTokens: 9, outputTokens: 40, cacheReadInputTokens: 800, cacheCreationInputTokens: 20 },
      } };
    })() }, noSkill) },
  ));
  const rows = db.prepare('SELECT model, turns FROM usage_ledger WHERE user_id = ? ORDER BY model').all(u.id).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ model: 'helper-model', turns: null }, { model: 'main-model', turns: 11 }],
    'a run counted against its helper would be reported as a tiny, capped run');
});

test('route: a run whose stream simply ENDS after the timeout is still named a timeout', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  const res = makeRes();
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO, timeoutMs: 1_000 }, user: u }), res, { userId: u.id },
    { runAgent: (args) => runLoopAgent({ ...args, queryFactory: (prompt, options) => (async function* () {
      yield { type: 'system', subtype: 'init', model: 'quiet-model' };
      yield { type: 'assistant', message: { id: 'q1', model: 'quiet-model', content: [{ type: 'text', text: 'w' }], usage: { input_tokens: 3, output_tokens: 1 } } };
      // Ends quietly on abort instead of throwing.
      await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve));
    })() }, noSkill) },
  ));
  assert.equal(res.statusCode, 504);
  const rows = db.prepare('SELECT stop_reason FROM usage_ledger WHERE user_id = ?').all(u.id).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ stop_reason: 'timeout' }]);
});

test('route: a run with no reported turn count leaves turns unknown, not zero', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user: u }), makeRes(), { userId: u.id },
    { runAgent: (args) => runLoopAgent({ ...args, queryFactory: resultQuery({
      subtype: 'success', modelUsage: { 'main-model': { inputTokens: 3, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }) }, noSkill) },
  ));
  const rows = db.prepare('SELECT turns, stop_reason FROM usage_ledger WHERE user_id = ?').all(u.id).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ turns: null, stop_reason: 'success' }]);
});

test('runLoopAgent: createdPaths lists only the files a Write created, not ones it overwrote', () => withKey(async () => {
  const capture = {};
  const fresh = path.join(REPO, 'src', 'created-by-agent.txt');
  const out = await runLoopAgent({
    message: 'x', root: REPO, userId: user.id,
    queryFactory: toolPlayingQuery(capture, [
      { tool: 'Write', input: { file_path: fresh, content: 'n\n' }, run: write },
      { tool: 'Write', input: { file_path: path.join(REPO, 'src', 'a.txt'), content: 'z\n' }, run: write },
    ]),
  }, noSkill);
  assert.deepEqual(out.changedPaths, ['src/a.txt', 'src/created-by-agent.txt']);
  assert.deepEqual(out.createdPaths, ['src/created-by-agent.txt']);
  fs.rmSync(fresh);
  git(['checkout', '--', 'src/a.txt'], REPO);
}));

// --- tool accounting (turn_tool_events, engine 'loop') ------------------------------

// A stream shaped like the SDK's: assistant tool_use blocks, then user
// tool_result blocks (string or text-block content; a denial is is_error).
function toolStreamQuery() {
  return () => (async function* () {
    yield { type: 'system', subtype: 'init', model: 'main-model' };
    yield { type: 'assistant', message: { id: 'a1', model: 'main-model', content: [
      { type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'x' } },
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/r/a' } },
    ] } };
    yield { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'abc' },
      { type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: '12345' }] },
    ] } };
    yield { type: 'assistant', message: { id: 'a2', model: 'main-model', content: [
      { type: 'tool_use', id: 'tu3', name: 'Edit', input: { file_path: '/outside' } },
    ] } };
    yield { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu3', content: 'refused', is_error: true },
    ] } };
    yield { type: 'result', subtype: 'success', num_turns: 3, modelUsage: {
      'main-model': { inputTokens: 3, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } };
  })();
}

test('runLoopAgent: reports every tool call in order — name, result size, denial — never the text', () => withKey(async () => {
  const out = await runLoopAgent({ message: 'x', root: REPO, userId: user.id, queryFactory: toolStreamQuery() }, noSkill);
  assert.deepEqual(out.toolEvents, [
    { tool: 'Grep', resultChars: 3, truncated: false, isError: false },
    { tool: 'Read', resultChars: 5, truncated: false, isError: false },
    { tool: 'Edit', resultChars: 7, truncated: false, isError: true },
  ]);
}));

test('route: a run\'s tool calls land in turn_tool_events under engine loop, keyed to its ledger rows', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user: u }), makeRes(), { userId: u.id },
    { runAgent: (args) => runLoopAgent({ ...args, queryFactory: toolStreamQuery() }, noSkill) },
  ));
  const events = db.prepare('SELECT turn_id, engine, seq, tool, is_error FROM turn_tool_events WHERE user_id = ? ORDER BY seq')
    .all(u.id).map((r) => ({ ...r }));
  assert.deepEqual(events.map(({ turn_id: _t, ...rest }) => rest), [
    { engine: 'loop', seq: 0, tool: 'Grep', is_error: 0 },
    { engine: 'loop', seq: 1, tool: 'Read', is_error: 0 },
    { engine: 'loop', seq: 2, tool: 'Edit', is_error: 1 },
  ]);
  const ledger = db.prepare('SELECT request_id FROM usage_ledger WHERE user_id = ?').all(u.id);
  assert.equal(ledger.length, 1);
  assert.ok(events[0].turn_id, 'a turn id is generated');
  assert.equal(ledger[0].request_id, events[0].turn_id, 'the ledger row joins to its tool events');
});

test('route: a run that fails mid-stream still records the tool calls it made', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  const res = makeRes();
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user: u }), res, { userId: u.id },
    { runAgent: (args) => runLoopAgent({ ...args, queryFactory: () => (async function* () {
      yield { type: 'system', subtype: 'init', model: 'main-model' };
      yield { type: 'assistant', message: { id: 'a1', model: 'main-model',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Glob', input: { pattern: '*' } }],
        usage: { input_tokens: 2, output_tokens: 1 } } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a\nb' }] } };
      throw new Error('engine died');
    })() }, noSkill) },
  ));
  assert.equal(res.statusCode, 502);
  const events = db.prepare('SELECT turn_id, tool FROM turn_tool_events WHERE user_id = ?').all(u.id);
  assert.deepEqual(events.map((e) => e.tool), ['Glob']);
  const ledger = db.prepare('SELECT request_id FROM usage_ledger WHERE user_id = ?').all(u.id);
  assert.equal(ledger[0].request_id, events[0].turn_id);
});

// --- no-progress stop ------------------------------------------------------------

// Plays the SDK side: each call runs the PreToolUse hooks; a denied call is
// answered with an error tool_result, as the CLI does. Once the step's
// controller is aborted the stream throws, like the SDK's abort.
function repeatingQuery(calls, { onAbort, afterCall } = {}) {
  return (prompt, options) => (async function* () {
    yield { type: 'system', subtype: 'init', model: 'main-model' };
    let n = 0;
    for (const { tool, input, isError = false } of calls) {
      n += 1;
      const id = `r${n}`;
      yield { type: 'assistant', message: { id: `m${n}`, model: 'main-model',
        content: [{ type: 'tool_use', id, name: tool, input }], usage: { input_tokens: 100, output_tokens: 5 } } };
      let denied = false;
      for (const m of options.hooks?.PreToolUse ?? []) {
        for (const h of m.hooks) {
          const out = await h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, id, {});
          if (out?.hookSpecificOutput?.permissionDecision === 'deny') denied = true;
        }
      }
      if (options.abortController?.signal.aborted) {
        onAbort?.();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      if (!denied && !isError) {
        for (const m of options.hooks?.PostToolUse ?? []) {
          if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(tool)) continue;
          for (const h of m.hooks) await h({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input }, id, {});
        }
      }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: denied || isError }] } };
      afterCall?.(n);
    }
    yield { type: 'result', subtype: 'success', num_turns: n, modelUsage: {
      'main-model': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } };
  })();
}

test('runLoopAgent: a repeated Read is warned on the 3rd call and stops the step on the 4th as no_progress', () => withKey(async () => {
  const read = { tool: 'Read', input: { file_path: path.join(REPO, 'src', 'a.txt') } };
  let aborted = 0;
  const out = await runLoopAgent({
    message: 'x', root: REPO, userId: user.id,
    queryFactory: repeatingQuery([read, read, read, read, read, read], { onAbort: () => { aborted += 1; } }),
  }, noSkill);
  assert.equal(aborted, 1, 'the SDK run was cut off at the 4th repeat, not run to maxTurns');
  assert.equal(out.ran, true);
  assert.equal(out.resultSubtype, 'no_progress');
  assert.match(out.noProgressReason, /same Read call/);
  assert.match(out.reply, /stopped this step/);
  assert.equal(out.usage.inputTokens, 400, 'what the cut-off step spent is still metered');
  assert.equal(out.toolEvents.filter((e) => e.isError).length, 1, 'the 3rd call came back as the warning');
}));

test('runLoopAgent: a successful Edit between re-reads resets the count through the real hooks', () => withKey(async () => {
  const fp = path.join(REPO, 'src', 'a.txt');
  const read = { tool: 'Read', input: { file_path: fp } };
  const edit = (i) => ({ tool: 'Edit', input: { file_path: fp, old_string: `v${i}`, new_string: `v${i + 1}` } });
  const out = await runLoopAgent({
    message: 'x', root: REPO, userId: user.id,
    queryFactory: repeatingQuery([read, read, edit(0), read, read, edit(1), read, read]),
  }, noSkill);
  assert.equal(out.resultSubtype, 'success', out.noProgressReason);
}));

test('runLoopAgent: a refused call never counts as a repeat (only on the error streak)', () => withKey(async () => {
  const outside = { tool: 'Read', input: { file_path: path.join(OUTSIDE, 'secret.txt') } };
  const ok = { tool: 'Grep', input: { pattern: 'z' } };
  const out = await runLoopAgent({
    message: 'x', root: REPO, userId: user.id,
    queryFactory: repeatingQuery([outside, outside, outside, outside, ok]),
  }, noSkill);
  assert.equal(out.resultSubtype, 'success', out.noProgressReason);
  assert.equal(out.denied.length, 4);
}));

test('runLoopAgent: five failed tool calls in a row stop the step', () => withKey(async () => {
  const fail = (i) => ({ tool: 'Read', input: { file_path: path.join(REPO, 'src', `missing-${i}.txt`) }, isError: true });
  const out = await runLoopAgent({
    message: 'x', root: REPO, userId: user.id,
    queryFactory: repeatingQuery([0, 1, 2, 3, 4, 5, 6].map(fail)),
  }, noSkill);
  assert.equal(out.resultSubtype, 'no_progress');
  assert.match(out.noProgressReason, /in a row failed/);
}));

test('runLoopAgent: an ordinary step that keeps finding new things is not stopped', () => withKey(async () => {
  const reads = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ tool: 'Grep', input: { pattern: `p${i}` } }));
  const out = await runLoopAgent({ message: 'x', root: REPO, userId: user.id, queryFactory: repeatingQuery(reads) }, noSkill);
  assert.equal(out.resultSubtype, 'success');
  assert.equal(out.noProgressReason, undefined);
}));

test('route: a caller timeout during a no-progress stop is still a timeout (504, metered as timeout)', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  const read = { tool: 'Read', input: { file_path: path.join(REPO, 'src', 'a.txt') } };
  const res = makeRes();
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO, timeoutMs: 1_000 }, user: u }), res, { userId: u.id },
    { runAgent: (args) => runLoopAgent({ ...args, queryFactory: (prompt, options) => (async function* () {
      yield { type: 'system', subtype: 'init', model: 'main-model' };
      const call = async (i) => {
        for (const m of options.hooks.PreToolUse) {
          for (const h of m.hooks) await h({ hook_event_name: 'PreToolUse', tool_name: read.tool, tool_input: read.input }, `t${i}`, {});
        }
      };
      await call(1); await call(2);
      // The caller's timeout lands first; the 3rd (warn) and 4th (stop) repeats
      // after it set noProgressReason, and the stream then ends QUIETLY.
      await new Promise((resolve) => args.abortController.signal.addEventListener('abort', resolve));
      await call(3); await call(4);
    })() }, noSkill) },
  ));
  assert.equal(res.statusCode, 504, res._body);
  const rows = db.prepare('SELECT stop_reason FROM usage_ledger WHERE user_id = ?').all(u.id).map((r) => r.stop_reason);
  assert.deepEqual(rows, ['timeout']);
});

test('route: a no_progress step answers 200 with the reason and is metered as no_progress', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  const read = { tool: 'Read', input: { file_path: path.join(REPO, 'src', 'a.txt') } };
  const res = makeRes();
  await withKey(() => handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user: u }), res, { userId: u.id },
    { runAgent: (args) => runLoopAgent({ ...args, queryFactory: repeatingQuery([read, read, read, read, read]) }, noSkill) },
  ));
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  assert.equal(body.resultSubtype, 'no_progress');
  assert.match(body.noProgressReason, /same Read call/);
  const rows = db.prepare('SELECT stop_reason FROM usage_ledger WHERE user_id = ?').all(u.id).map((r) => r.stop_reason);
  assert.deepEqual(rows, ['no_progress']);
});

// --- find-code in a Loop run -----------------------------------------------------

test('graphScopeRoot: a Loop worktree scopes to the repo it was cut from; a plain repo to itself', () => {
  const wt = path.join(SANDBOX, '.llmide-loop-worktrees', 'repo', 'scope1');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(['worktree', 'add', '-q', '-b', 'llmide/loop/scope1', wt, 'HEAD'], REPO);
  assert.equal(graphScopeRoot(fs.realpathSync(wt)), REPO);
  assert.equal(graphScopeRoot(REPO), REPO);
  assert.equal(graphScopeRoot(OUTSIDE), OUTSIDE, 'not a git repo: itself');
});

test('loopFindCode: returns repo-relative hits and a hint naming only tools a Loop run has', () => {
  const u = newUser();
  addUserRepo(u.id, REPO);
  getDb(); // ensure migrations ran
  const cg = { nodes: [
    { id: 'f:src/a.txt', title: 'a.txt', kind: 'file', metadata: { source_file: 'src/a.txt' } },
    { id: 's:oldValue', title: 'oldValue', kind: 'function', metadata: { source_file: 'src/a.txt', line: 'L1' } },
  ], edges: [{ fromId: 'f:src/a.txt', toId: 's:oldValue', kind: 'contains' }] };
  writeCodeGraph(u.id, REPO, cg, { source: 'structure' });
  const out = loopFindCode({ query: 'oldValue' }, { userId: u.id, roots: [REPO], scopeRoot: REPO });
  assert.ok(out.symbols.some((s) => s.name === 'oldValue' && s.path === 'src/a.txt' && s.line === 1), JSON.stringify(out));
  assert.match(out.hint, /Read/);
  assert.doesNotMatch(out.hint, /run-bash|read-file|ask the user/);
  const miss = loopFindCode({ query: 'zzNoSuchSymbolzz' }, { userId: u.id, roots: [REPO], scopeRoot: REPO });
  assert.match(miss.hint, /Grep/);
  assert.doesNotMatch(miss.hint, /run-bash|read-file|ask the user/);
});

test('loopFindCode: an ungraphed repo gets "no match", never another repo\'s hits; another user\'s graph never shows', () => {
  const u = newUser();
  addUserRepo(u.id, REPO);
  addUserRepo(u.id, OUTSIDE);
  // u graphed OUTSIDE only. A Loop on REPO must not be told OUTSIDE's paths,
  // even where the same relative path happens to exist in REPO.
  writeCodeGraph(u.id, OUTSIDE, { nodes: [
    { id: 's:uniqueOutsideFn', title: 'uniqueOutsideFn', kind: 'function', metadata: { source_file: 'src/a.txt', line: 'L9' } },
  ], edges: [] }, { source: 'structure' });
  const out = loopFindCode({ query: 'uniqueOutsideFn' }, { userId: u.id, roots: [REPO], scopeRoot: REPO });
  assert.deepEqual([out.symbols, out.related, out.files], [[], [], []]);
  assert.match(out.hint, /Grep/);

  // A second user with their OWN graph of the same repo (so the scope check
  // passes): they see their symbol, never another user's.
  const owner = newUser();
  addUserRepo(owner.id, REPO);
  writeCodeGraph(owner.id, REPO, { nodes: [
    { id: 's:ownersOnlyFn', title: 'ownersOnlyFn', kind: 'function', metadata: { source_file: 'src/a.txt', line: 'L1' } },
  ], edges: [] }, { source: 'structure' });
  const other = newUser();
  addUserRepo(other.id, REPO);
  writeCodeGraph(other.id, REPO, { nodes: [
    { id: 's:othersFn', title: 'othersFn', kind: 'function', metadata: { source_file: 'src/a.txt', line: 'L1' } },
  ], edges: [] }, { source: 'structure' });
  const theirs = loopFindCode({ query: 'ownersOnlyFn' }, { userId: other.id, roots: [REPO], scopeRoot: REPO });
  assert.ok(!theirs.symbols.some((s) => s.name === 'ownersOnlyFn'), 'another user\'s graph never shows');
  const own = loopFindCode({ query: 'othersFn' }, { userId: other.id, roots: [REPO], scopeRoot: REPO });
  assert.ok(own.symbols.some((s) => s.name === 'othersFn'), JSON.stringify(own));
});

// --- too-broad roots are never registered / trusted --------------------------------

test('addUserRepo refuses too-broad roots; buildTrustedRoots drops stored ones', async () => {
  const { buildTrustedRoots } = await import('../llm_agent/runtime/handlers/repo-files.mjs');
  const uid = newUser().id;
  for (const p of [os.homedir(), '/Users', '/']) {
    assert.throws(() => addUserRepo(uid, p), /too-broad|allow-list root/);
  }
  // A row stored before the rule (direct insert) is filtered on read.
  getDb().prepare('INSERT INTO user_repos (user_id, path) VALUES (?, ?)').run(uid, os.homedir());
  addUserRepo(uid, SANDBOX);
  assert.deepEqual(buildTrustedRoots(uid), [SANDBOX]);
});

// --- system prompt: preset vs LLM-IDE's own (LLMIDE_LOOP_CUSTOM_PROMPT) -------

const { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import('@anthropic-ai/claude-agent-sdk');
const { LOOP_BASE_PROMPT } = await import('../llm_agent/sdk/compact-system-prompt.mjs');

async function withLoopPromptEnv(value, fn) {
  const prev = process.env.LLMIDE_LOOP_CUSTOM_PROMPT;
  if (value === undefined) delete process.env.LLMIDE_LOOP_CUSTOM_PROMPT;
  else process.env.LLMIDE_LOOP_CUSTOM_PROMPT = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LLMIDE_LOOP_CUSTOM_PROMPT;
    else process.env.LLMIDE_LOOP_CUSTOM_PROMPT = prev;
  }
}

test('runLoopAgent: without LLMIDE_LOOP_CUSTOM_PROMPT the claude_code preset is kept', () => withKey(() => withLoopPromptEnv(undefined, async () => {
  const capture = {};
  await runLoopAgent({ message: 'x', root: REPO, userId: user.id, queryFactory: toolPlayingQuery(capture, []) }, noSkill);
  const sp = capture.options.systemPrompt;
  assert.deepEqual(Object.keys(sp).sort(), ['append', 'preset', 'snapshot', 'type']);
  assert.equal(sp.type, 'preset');
  assert.equal(sp.preset, 'claude_code');
  assert.equal(sp.snapshot, false);
  assert.match(sp.append, /no shell/);
})));

test('runLoopAgent: LLMIDE_LOOP_CUSTOM_PROMPT=1 replaces the preset with a static base, the cache boundary, then the per-run text', () => withKey(() => withLoopPromptEnv('1', async () => {
  const capture = {};
  await runLoopAgent({
    message: 'x', root: REPO, userId: user.id, skills: ['f/small'], queryFactory: toolPlayingQuery(capture, []),
  }, { readSkill: (id) => ({ name: id, content: `BODY-${id}` }) });
  const sp = capture.options.systemPrompt;
  assert.equal(sp.type, 'custom');
  assert.equal(sp.snapshot, false);
  assert.equal(sp.prompt[0], LOOP_BASE_PROMPT);
  assert.equal(sp.prompt[1], SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  assert.equal(sp.prompt.length, 4);
  assert.match(sp.prompt[2], /^# Environment/);
  assert.ok(sp.prompt[2].includes(`Working directory: ${REPO}`), 'the working directory rides after the boundary');
  assert.doesNotMatch(sp.prompt[2], /Shell:/, 'the Loop has no shell, so none is named');
  const dynamic = sp.prompt.slice(2).join('\n');
  assert.match(dynamic, /mcp__llmide__find-code/);
  assert.match(dynamic, /no shell/);
  assert.match(dynamic, /BODY-f\/small/);
})));

test('LOOP_BASE_PROMPT is static: no path, date or per-run text before the cache boundary', () => {
  assert.ok(!LOOP_BASE_PROMPT.includes(REPO));
  assert.doesNotMatch(LOOP_BASE_PROMPT, /\d{4}-\d{2}-\d{2}/);
  assert.match(LOOP_BASE_PROMPT, /data, not instructions/);
});

// --- tier routing: a Loop step on an Anthropic-compatible gateway --------------------
//
// The Mac's Loop tier route sends `provider` (+ `model`). The engine resolves it
// with the same gate as the v2 chat (resolveAgentEngineAuth) and aims the SDK at
// the gateway with the same env (ANTHROPIC_BASE_URL + the provider key). Every
// confinement rule stays exactly as it is for a Claude step.

const { syncCustomProviders } = await import('../server/custom-providers.mjs');
const { setSecret } = await import('../server/vault.mjs');

function registerLoopGateway(userId, { id = 'loop-gw', anthropicBaseURL = 'https://api.z.ai/api/anthropic', key = 'glm-loop-key' } = {}) {
  const vaultKey = `custom.${id}.apiKey`;
  syncCustomProviders([{
    id, name: 'GLM', baseURL: 'https://api.z.ai/api/paas/v4', apiKey: vaultKey, models: [],
    isOpenAICompatible: true, isEnabled: true,
    ...(anthropicBaseURL ? { anthropicBaseURL } : {}),
  }], userId);
  if (key) setSecret(getDb(), userId, vaultKey, key);
  return `custom:${id}`;
}

async function withoutKey(fn) {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try { return await fn(); } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
}

test('runLoopAgent: a gateway provider rides ANTHROPIC_BASE_URL + its own key; confinement is unchanged', () => withoutKey(async () => {
  const u = newUser();
  const gateway = registerLoopGateway(u.id);
  try {
    const capture = {};
    // No first-party key and ambient NOT allowed: the step still runs on the gateway key.
    await runLoopAgent({
      message: 'fix it', root: REPO, userId: u.id, provider: gateway, model: 'glm-4.6',
      queryFactory: toolPlayingQuery(capture, []),
    }, noSkill);
    const o = capture.options;
    assert.equal(o.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
    assert.equal(o.env.ANTHROPIC_AUTH_TOKEN, 'glm-loop-key');
    assert.equal(o.env.ANTHROPIC_API_KEY, 'glm-loop-key');
    assert.equal(o.model, 'glm-4.6', 'the model id goes verbatim');
    assert.equal(o.effort, undefined, 'no effort on a gateway');
    assert.equal(o.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR,
      'a user with no first-party key keeps the operator home, as in chat');
    // Confinement — identical to a Claude step.
    assert.deepEqual([...o.tools].sort(), [...LOOP_AGENT_TOOLS].sort());
    assert.deepEqual(o.allowedTools, []);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(Object.keys(o.mcpServers), ['llmide']);
    assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(o.env.LLMIDE_JWT_SECRET, undefined, 'the server\'s own secrets never reach the subprocess');
    assert.equal(o.env.LLMIDE_VAULT_KEY, undefined);
  } finally { syncCustomProviders([], u.id); }
}));

test('runLoopAgent: no provider (or "anthropic") keeps the first-party env — no gateway is injected', () => withKey(async () => {
  for (const provider of [undefined, 'anthropic']) {
    const capture = {};
    await runLoopAgent({
      message: 'x', root: REPO, userId: user.id, provider, queryFactory: toolPlayingQuery(capture, []),
    }, noSkill);
    assert.equal(capture.options.env.ANTHROPIC_API_KEY, 'sk-ant-loop-test');
    assert.equal(capture.options.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
    assert.equal(capture.options.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_AUTH_TOKEN);
  }
}));

test('runLoopAgent: a provider the Agent engine cannot run is refused before the SDK spawns', () => withKey(async () => {
  const u = newUser();
  const plain = registerLoopGateway(u.id, { id: 'loop-plain', anthropicBaseURL: null });
  let spawned = false;
  const factory = () => { spawned = true; return (async function* () {})(); };
  try {
    for (const [provider, code] of [[plain, 'PROVIDER_NOT_AGENT_CAPABLE'], ['openai', 'PROVIDER_NOT_AGENT_CAPABLE'],
      ['custom:never-registered', 'PROVIDER_UNAVAILABLE']]) {
      await assert.rejects(
        () => runLoopAgent({ message: 'x', root: REPO, userId: u.id, provider, allowAmbientAuth: true, queryFactory: factory }, noSkill),
        (e) => e.code === code, provider,
      );
    }
    assert.equal(spawned, false);
  } finally { syncCustomProviders([], u.id); }
}));

test('route: provider reaches the engine; a non-string provider is a 400', async () => {
  let seen = null;
  const res = makeRes();
  await handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO, provider: 'custom:abc', model: 'glm-4.6' }, user }), res, { userId: user.id },
    { runAgent: async (args) => { seen = args; return { reply: '', changedPaths: [], usage: {}, ran: false, denied: [] }; } },
  );
  assert.equal(res.statusCode, 200, res._body);
  assert.equal(seen.provider, 'custom:abc');
  assert.equal(seen.model, 'glm-4.6');

  const none = makeRes();
  await handleLoopAgentRoutes(
    makeReq({ body: { message: 'fix', repoRoot: REPO }, user }), none, { userId: user.id },
    { runAgent: async (args) => { seen = args; return { reply: '', changedPaths: [], usage: {}, ran: false, denied: [] }; } },
  );
  assert.equal(seen.provider, undefined, 'an old client sends no provider — exactly today\'s path');

  for (const provider of [42, { id: 'x' }, 'x'.repeat(200)]) {
    const bad = makeRes();
    await handleLoopAgentRoutes(
      makeReq({ body: { message: 'fix', repoRoot: REPO, provider }, user }), bad, { userId: user.id },
      { runAgent: async () => { throw new Error('must not run'); } },
    );
    assert.equal(bad.statusCode, 400, JSON.stringify(provider));
    assert.equal(bad.json().error.code, 'VALIDATION_FAILED');
  }
});

test('route: a provider refusal answers 400 with its own code', async () => {
  for (const code of ['PROVIDER_UNAVAILABLE', 'PROVIDER_NOT_AGENT_CAPABLE']) {
    const res = makeRes();
    await handleLoopAgentRoutes(
      makeReq({ body: { message: 'fix', repoRoot: REPO, provider: 'custom:gone' }, user }), res, { userId: user.id },
      { runAgent: async () => { throw Object.assign(new Error('provider says no'), { code }); } },
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, code);
    assert.equal(res.json().error.message, 'provider says no');
  }
});

test('route: a gateway step is metered under the provider that ran, not anthropic', async () => {
  const db = getDb();
  const u = newUser();
  addUserRepo(u.id, REPO);
  const gateway = registerLoopGateway(u.id);
  try {
    const res = makeRes();
    await withoutKey(() => handleLoopAgentRoutes(
      makeReq({ body: { message: 'fix', repoRoot: REPO, provider: gateway, model: 'glm-4.6' }, user: u }), res, { userId: u.id },
      {
        runAgent: (args) => runLoopAgent({
          ...args,
          queryFactory: resultQuery({
            subtype: 'success', num_turns: 2, duration_ms: 5,
            modelUsage: { 'glm-4.6': { inputTokens: 9, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
          }),
        }, noSkill),
      },
    ));
    assert.equal(res.statusCode, 200, res._body);
    const rows = db.prepare('SELECT provider, model FROM usage_ledger WHERE user_id = ?').all(u.id).map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ provider: gateway, model: 'glm-4.6' }]);
  } finally { syncCustomProviders([], u.id); }
});
