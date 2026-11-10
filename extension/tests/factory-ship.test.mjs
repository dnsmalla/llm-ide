// Factory Ship: agents/factory-ship.mjs (commit, secret scan, push, PR/MR lookup and create)
// and POST /kb/loop/ship (routes/loop-agent.mjs).
//
// Hermetic: scratch DB, a temp project with a bare `origin`, a Factory worktree under
// <project>/system/loop-worktrees/<run id>, an EMPTY global git config (the user's signing,
// hooksPath and identity never apply), and a fake provider transport (_setPinnedFetchForTests).
// No network, no real token.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_factory-ship-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ship-')));
after(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ } });
const EMPTY_GITCONFIG = path.join(SANDBOX, 'empty.gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;

const { registerUser } = await import('../server/users.mjs');
const { getDb, addUserRepo } = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
const { busHostProof } = await import('../core/host-approval.mjs');
const { commitAndPush, createDraftMr, findOpenRequest, originMatchesRepo, neutraliseMentions, stagedAddArgs, stagedDiffArgs, stagedPatchId } = await import('../agents/factory-ship.mjs');
const { handleLoopAgentRoutes } = await import('../routes/loop-agent.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env } }).trim();
}

// <project>/code/repo with a bare origin; the Factory worktree <project>/system/loop-worktrees/run1.
const REMOTE = path.join(SANDBOX, 'remote.git');
const PROJECT = path.join(SANDBOX, 'proj');
const REPO = path.join(PROJECT, 'code', 'repo');
const WT = path.join(PROJECT, 'system', 'loop-worktrees', 'run1');
const BRANCH = 'factory/run1';
git(['init', '-q', '--bare', REMOTE], SANDBOX);
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'a.txt'), 'a\n');
git(['init', '-q', '-b', 'main'], REPO);
git(['config', 'user.name', 'Factory Test'], REPO);
git(['config', 'user.email', 'factory@example.com'], REPO);
git(['add', '.'], REPO);
git(['commit', '-q', '-m', 'init'], REPO);
git(['remote', 'add', 'origin', REMOTE], REPO);
git(['push', '-q', 'origin', 'main'], REPO);
fs.mkdirSync(path.dirname(WT), { recursive: true });
git(['worktree', 'add', '-q', '-b', BRANCH, WT, 'HEAD'], REPO);
const remoteHead = (ref) => git(['--git-dir', REMOTE, 'rev-parse', ref], SANDBOX);
// The run's base: the commit the worktree was cut from (HEAD moves after the first Ship).
const BASE = git(['rev-parse', 'HEAD'], WT);

const user = registerUser(getDb(), { email: 'factory-ship@example.com', password: 'CorrectHorseBattery', displayName: 't' });
grant(getDb(), user.id, { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
addUserRepo(user.id, REPO);
const GH_TOKEN = 'ghp_test_value_123456';
const GL_TOKEN = 'glpat_test_value_12345';
setSecret(getDb(), user.id, 'github.token', GH_TOKEN);
setSecret(getDb(), user.id, 'gitlab.token', GL_TOKEN);

const PROOF = busHostProof();
function makeReq(body, { proof = PROOF } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const req = {
    method: 'POST', url: '/kb/loop/ship', user,
    headers: proof ? { 'x-llmide-host-nonce': proof } : {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    on() { return this; },
    statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
  };
}
// The temp repo's origin is a local bare folder, so the origin-vs-repo check is stubbed for most tests; the
// tests named "origin" pass `{ deps: {} }` to run the real check.
const STUB_ORIGIN = { originMatchesRepo: async () => true };
async function ship(body, opts) {
  const withId = !opts?.rawBody && body.patchId === undefined
    ? { ...body, patchId: body.worktree === WT ? await stagedPatchId(WT, BASE) : '0'.repeat(64) }
    : body;
  const res = makeRes();
  const handled = await handleLoopAgentRoutes(makeReq(withId, opts), res, { userId: user.id }, opts?.deps ?? STUB_ORIGIN);
  assert.equal(handled, true);
  return { status: res.statusCode, body: JSON.parse(res._body), raw: res._body };
}
function fakeProvider(answer) {
  const seen = [];
  _setPinnedFetchForTests(async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return answer(String(url), init);
  });
  return seen;
}
const json = (status, data) => new Response(JSON.stringify(data), { status });
const shipBody = (over = {}) => ({
  worktree: WT, branch: BRANCH, provider: 'github', repo: 'o/r', base: 'main', title: 'Fix the widget', body: 'Closes #12', ...over,
});

test('ship commits worktree changes excluding .factory and pushes the branch', async () => {
  fs.mkdirSync(path.join(WT, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(WT, '.factory', 'TASK.md'), '# task\n');
  fs.writeFileSync(path.join(WT, 'src', 'b.txt'), 'b\n');
  const before = git(['rev-parse', 'HEAD'], WT);
  const patchId = await stagedPatchId(WT, BASE);
  const out = await commitAndPush({ worktree: WT, branch: BRANCH, message: 'Add b', author: { name: 'Ship Bot', email: 'ship@example.com' }, patchId });
  assert.equal(out.pushed, true);
  assert.notEqual(out.commit, before);
  assert.equal(out.commit, git(['rev-parse', 'HEAD'], WT));
  assert.equal(remoteHead(`refs/heads/${BRANCH}`), out.commit, 'the branch reached origin');
  assert.deepEqual(git(['show', '--name-only', '--format=', out.commit], WT).split('\n').filter(Boolean), ['src/b.txt']);
  assert.equal(git(['log', '-1', '--format=%s|%an', out.commit], WT), 'Add b|Ship Bot');
  assert.equal(fs.existsSync(path.join(WT, '.factory', 'TASK.md')), true, '.factory stays on disk');
  assert.match(git(['status', '--porcelain'], WT), /\?\? \.factory\//, '.factory stays untracked');
  assert.equal(git(['rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`], WT), `origin/${BRANCH}`, 'push -u set the upstream');
  assert.equal(git(['config', '--get', `factory.patchid-${out.commit}`], WT), patchId, 'the shipped diff id is recorded for that commit');
});

test('staged patch git args match the shared host fixture', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('../../schema/factory/staged-patch.json', import.meta.url), 'utf8'));
  assert.deepEqual(stagedAddArgs(), fx.add);
  const want = fx.diff.map((a) => (a === '{base}' ? 'BASE' : a));
  assert.deepEqual(stagedDiffArgs('BASE', true), want);
  assert.deepEqual(stagedDiffArgs('BASE', false), want.filter((a) => a !== '--binary'));
});

test('ship refuses a file edited after the review with 409 diff_changed and commits nothing', async () => {
  const file = path.join(WT, 'src', 'reviewed.txt');
  fs.writeFileSync(file, 'the reviewed change\n');
  const reviewed = await stagedPatchId(WT, BASE);
  fs.writeFileSync(file, 'edited after the review\n');
  const before = git(['rev-parse', 'HEAD'], WT);
  const remoteBefore = remoteHead(`refs/heads/${BRANCH}`);
  const seen = fakeProvider(() => json(201, {}));
  try {
    const r = await ship(shipBody({ patchId: reviewed }));
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error.code, 'diff_changed');
    assert.equal(r.raw.includes('edited after the review'), false, 'the diff text is never echoed');
    assert.equal(git(['rev-parse', 'HEAD'], WT), before, 'nothing committed');
    assert.equal(git(['diff', '--cached', '--name-only'], WT), '', 'the index is reset');
    assert.equal(remoteHead(`refs/heads/${BRANCH}`), remoteBefore, 'nothing pushed');
    assert.equal(seen.length, 0, 'no provider call');
  } finally {
    _setPinnedFetchForTests(null);
    fs.rmSync(file);
  }
});

test('ship requires a 64-hex patchId', async () => {
  for (const patchId of ['', 'short', 'A'.repeat(64), `${'a'.repeat(63)}z`]) {
    const r = await ship(shipBody({ patchId }), { rawBody: true });
    assert.equal(r.status, 400, JSON.stringify(patchId));
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  }
  const missing = await ship(shipBody({ patchId: undefined }), { rawBody: true });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'VALIDATION_FAILED');
});

test('ship refuses a planted fake token and creates no commit', async () => {
  // Built at run time so this file itself holds no token-shaped literal.
  const fake = `ghp_${'Ab1'.repeat(12)}`;
  fs.writeFileSync(path.join(WT, 'src', 'leak.txt'), `token = "${fake}"\n`);
  const before = git(['rev-parse', 'HEAD'], WT);
  const remoteBefore = remoteHead(`refs/heads/${BRANCH}`);
  const seen = fakeProvider(() => json(500, {}));
  try {
    const r = await ship(shipBody());
    assert.equal(r.status, 422, r.raw);
    assert.equal(r.body.error.code, 'secret_detected');
    assert.equal(r.raw.includes(fake), false, 'the secret is never echoed');
    assert.equal(git(['rev-parse', 'HEAD'], WT), before, 'no commit');
    assert.equal(remoteHead(`refs/heads/${BRANCH}`), remoteBefore, 'nothing pushed');
    assert.equal(git(['diff', '--cached', '--name-only'], WT), '', 'the index is left clean');
    assert.equal(seen.length, 0, 'no provider call');
  } finally {
    _setPinnedFetchForTests(null);
    fs.rmSync(path.join(WT, 'src', 'leak.txt'));
  }
});

test('ship opens a GitHub draft PR with draft true', async () => {
  fs.writeFileSync(path.join(WT, 'src', 'c.txt'), 'c\n');
  const seen = fakeProvider((url, init) => (init.method === 'GET'
    ? json(200, [])
    : json(201, { html_url: 'https://github.com/o/r/pull/5', number: 5, draft: true })));
  try {
    const r = await ship(shipBody());
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { url: 'https://github.com/o/r/pull/5', commit: git(['rev-parse', 'HEAD'], WT), reused: false });
    assert.equal(remoteHead(`refs/heads/${BRANCH}`), r.body.commit);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, 'https://api.github.com/repos/o/r/pulls?state=open&head=o%3Afactory%2Frun1');
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].url, 'https://api.github.com/repos/o/r/pulls');
    assert.equal(seen[1].headers.Authorization, `Bearer ${GH_TOKEN}`);
    assert.deepEqual(seen[1].body, { title: 'Fix the widget', head: BRANCH, base: 'main', body: 'Closes #12', draft: true });
    assert.equal(r.raw.includes(GH_TOKEN), false);
  } finally { _setPinnedFetchForTests(null); }
});

test('re-ship returns the existing PR URL with reused true and pushes the new commit', async () => {
  const first = git(['rev-parse', 'HEAD'], WT);
  fs.writeFileSync(path.join(WT, 'src', 'd.txt'), 'repair\n');
  const seen = fakeProvider((url, init) => (init.method === 'GET'
    ? json(200, [{ html_url: 'https://github.com/o/r/pull/5', number: 5 }])
    : json(500, {})));
  try {
    const r = await ship(shipBody());
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.reused, true);
    assert.equal(r.body.url, 'https://github.com/o/r/pull/5');
    assert.notEqual(r.body.commit, first, 'the repair is a new commit');
    assert.equal(remoteHead(`refs/heads/${BRANCH}`), r.body.commit, 'the new commit was pushed');
    assert.deepEqual(seen.map((s) => s.method), ['GET'], 'no second PR is created');
  } finally { _setPinnedFetchForTests(null); }
});

test('ship opens a GitLab draft MR with draft true at gitlab.com', async () => {
  fs.writeFileSync(path.join(WT, 'src', 'e.txt'), 'e\n');
  const seen = fakeProvider((url, init) => (init.method === 'GET'
    ? json(200, [])
    : json(201, { web_url: 'https://gitlab.com/g/p/-/merge_requests/7', iid: 7 })));
  try {
    const r = await ship(shipBody({ provider: 'gitlab', repo: 'g/p' }));
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { url: 'https://gitlab.com/g/p/-/merge_requests/7', commit: git(['rev-parse', 'HEAD'], WT), reused: false });
    assert.equal(seen[0].url, 'https://gitlab.com/api/v4/projects/g%2Fp/merge_requests?state=opened&source_branch=factory%2Frun1');
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].url, 'https://gitlab.com/api/v4/projects/g%2Fp/merge_requests');
    assert.equal(seen[1].headers['PRIVATE-TOKEN'], GL_TOKEN);
    assert.equal(seen[1].body.draft, true);
    assert.equal(seen[1].body.source_branch, BRANCH);
    assert.equal(seen[1].body.target_branch, 'main');
    assert.equal(seen[1].body.title, 'Draft: Fix the widget');
    assert.equal(seen[1].body.description, 'Closes #12');
  } finally { _setPinnedFetchForTests(null); }
});

test('createDraftMr and findOpenRequest never echo a provider answer and refuse redirects', async () => {
  fakeProvider(() => json(401, { message: `bad token ${GL_TOKEN}` }));
  try {
    await assert.rejects(
      createDraftMr({ glProject: 'g/p', glToken: GL_TOKEN, title: 'T', source: BRANCH, target: 'main', body: '' }),
      (err) => err.code === 'provider_error' && err.message === 'GitLab answered 401.',
    );
    await assert.rejects(findOpenRequest('github', 'o/r', BRANCH, GH_TOKEN),
      (err) => err.code === 'provider_error' && err.message === 'GitHub answered 401.');
    fakeProvider(() => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
    await assert.rejects(findOpenRequest('gitlab', 'g/p', BRANCH, GL_TOKEN), (err) => err.code === 'provider_error');
  } finally { _setPinnedFetchForTests(null); }
});

test('rejected push opens no PR/MR', async () => {
  const hook = path.join(REMOTE, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(WT, 'src', 'f.txt'), 'f\n');
  const remoteBefore = remoteHead(`refs/heads/${BRANCH}`);
  const seen = fakeProvider(() => json(201, { html_url: 'https://github.com/o/r/pull/99' }));
  try {
    const r = await ship(shipBody());
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error.code, 'push_rejected');
    assert.equal(remoteHead(`refs/heads/${BRANCH}`), remoteBefore, 'origin did not move');
    assert.equal(seen.length, 0, 'no PR/MR call after a rejected push');
    // The commit stays; removing the hook and shipping the same tree again pushes it (re-ship after push_rejected).
    fs.rmSync(hook);
    const again = await ship(shipBody());
    assert.equal(again.status, 200, again.raw);
    assert.equal(remoteHead(`refs/heads/${BRANCH}`), again.body.commit, 'the re-ship pushed the kept commit');
    assert.equal(again.body.commit, git(['rev-parse', 'HEAD'], WT));
  } finally {
    _setPinnedFetchForTests(null);
    try { fs.rmSync(hook); } catch { /* removed already */ }
  }
});

test('ship rejects a worktree outside system/loop-worktrees with invalid_worktree', async () => {
  // A real Loop worktree of the allow-listed repo, but in the old sibling layout.
  const stray = path.join(SANDBOX, '.llmide-loop-worktrees', 'run9');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  git(['worktree', 'add', '-q', '-b', 'factory/run9', stray, 'HEAD'], REPO);
  fs.writeFileSync(path.join(stray, 'x.txt'), 'x\n');
  const strayHead = git(['rev-parse', 'HEAD'], stray);
  const seen = fakeProvider(() => json(201, {}));
  try {
    for (const body of [
      shipBody({ worktree: stray, branch: 'factory/run9' }),
      shipBody({ worktree: REPO }),
      shipBody({ worktree: path.join(SANDBOX, 'nowhere') }),
      shipBody({ branch: 'factory/run2' }),
    ]) {
      const r = await ship(body);
      assert.equal(r.status, 400, `${body.worktree} ${body.branch}: ${r.raw}`);
      assert.equal(r.body.error.code, 'invalid_worktree');
    }
    assert.equal(git(['rev-parse', 'HEAD'], stray), strayHead, 'no commit in the stray worktree');
    assert.equal(seen.length, 0);
  } finally { _setPinnedFetchForTests(null); }
});

test('ship validates the body and needs the desktop host proof', async () => {
  for (const over of [{ provider: 'bitbucket' }, { repo: 'o/r/x' }, { repo: '../r' }, { branch: 'main' }, { title: '   ' }, { base: '-x' }]) {
    const r = await ship(shipBody(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  }
  const r = await ship(shipBody(), { proof: null });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'HOST_PROOF_REQUIRED');
});

test('originMatchesRepo accepts only the provider host and the same slug', async () => {
  const dir = path.join(SANDBOX, 'origin-probe');
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  const cases = [
    ['https://github.com/o/r.git', 'github', 'o/r', true],
    ['git@github.com:O/R.git', 'github', 'o/r', true],
    ['ssh://git@gitlab.com/g/p', 'gitlab', 'g/p', true],
    ['https://github.com/o/other.git', 'github', 'o/r', false],
    ['https://evil.example/o/r.git', 'github', 'o/r', false],
    ['https://github.com/o/r.git', 'gitlab', 'o/r', false],
    [REMOTE, 'github', 'o/r', false],
  ];
  for (const [url, provider, repo, want] of cases) {
    try { git(['remote', 'remove', 'origin'], dir); } catch { /* none yet */ }
    git(['remote', 'add', 'origin', url], dir);
    assert.equal(await originMatchesRepo(dir, provider, repo), want, `${url} ${provider} ${repo}`);
  }
});

test('originMatchesRepo reads the PUSH url: a different pushurl is refused', async () => {
  const dir = path.join(SANDBOX, 'origin-pushurl');
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['remote', 'add', 'origin', 'https://github.com/o/r.git'], dir);
  assert.equal(await originMatchesRepo(dir, 'github', 'o/r'), true);
  git(['remote', 'set-url', '--push', 'origin', 'https://evil.example/o/r.git'], dir);
  assert.equal(await originMatchesRepo(dir, 'github', 'o/r'), false, 'fetch url matches but the push goes elsewhere');
});

test('ship refuses a secret in the PR title or body (400 secret_detected, never echoed, no provider call) and neutralises @ mentions', async () => {
  const fake = `ghp_${'Ab1'.repeat(12)}`;
  const seen = fakeProvider(() => json(201, {}));
  try {
    for (const over of [{ body: `see ${fake} here` }, { title: `Fix ${fake}` }]) {
      const r = await ship(shipBody(over));
      assert.equal(r.status, 400, r.raw);
      assert.equal(r.body.error.code, 'secret_detected');
      assert.equal(r.raw.includes(fake), false, 'the secret is never echoed');
    }
    assert.equal(seen.length, 0, 'no provider call');
  } finally { _setPinnedFetchForTests(null); }
  const out = neutraliseMentions('thanks @octocat and @org/team');
  assert.equal(out.includes('@octocat'), false);
  assert.equal(out.replaceAll('\u200b', ''), 'thanks @octocat and @org/team', 'only a zero-width space is inserted');
});

test('ship never lets a textconv driver rewrite what the secret scan sees', async () => {
  const fake = `ghp_${'Zy9'.repeat(12)}`;
  const driver = path.join(SANDBOX, 'textconv.sh');
  fs.writeFileSync(driver, '#!/bin/sh\necho harmless\n', { mode: 0o755 });
  git(['config', 'diff.hide.textconv', driver], WT);
  fs.writeFileSync(path.join(WT, '.gitattributes'), '*.sec diff=hide\n');
  fs.writeFileSync(path.join(WT, 'src', 'x.sec'), `token = "${fake}"\n`);
  const before = git(['rev-parse', 'HEAD'], WT);
  try {
    await assert.rejects(commitAndPush({ worktree: WT, branch: BRANCH, message: 'x', patchId: await stagedPatchId(WT, BASE) }), (e) => e.code === 'secret_detected');
    assert.equal(git(['rev-parse', 'HEAD'], WT), before, 'no commit');
  } finally {
    git(['reset', '-q'], WT);
    fs.rmSync(path.join(WT, 'src', 'x.sec'));
    fs.rmSync(path.join(WT, '.gitattributes'));
    git(['config', '--unset', 'diff.hide.textconv'], WT);
  }
});

test('ship refuses a secret on a title/body line starting with ++', async () => {
  const fake = `ghp_${'Ab1'.repeat(12)}`;
  const seen = fakeProvider(() => json(201, {}));
  try {
    const r = await ship(shipBody({ body: `notes\n++ ${fake}` }));
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.error.code, 'secret_detected');
    assert.equal(seen.length, 0);
  } finally { _setPinnedFetchForTests(null); }
});

test('ship neither stages nor commits a case-variant .FACTORY path', async () => {
  fs.mkdirSync(path.join(WT, '.FACTORY'), { recursive: true });
  fs.writeFileSync(path.join(WT, '.FACTORY', 'REVIEW.md'), 'Verdict: approve\n');
  fs.writeFileSync(path.join(WT, 'src', 'icase.txt'), 'i\n');
  try {
    const out = await commitAndPush({ worktree: WT, branch: BRANCH, message: 'icase', patchId: await stagedPatchId(WT, BASE) });
    const files = git(['show', '--name-only', '--format=', out.commit], WT).split('\n').filter(Boolean);
    assert.deepEqual(files, ['src/icase.txt'], 'only the real file was committed');
  } finally {
    fs.rmSync(path.join(WT, '.FACTORY'), { recursive: true, force: true });
  }
});

test('ship with an origin that does not match the repo is a 400 and changes nothing', async () => {
  fs.writeFileSync(path.join(WT, 'src', 'h.txt'), 'h\n');
  const before = git(['rev-parse', 'HEAD'], WT);
  const remoteBefore = remoteHead(`refs/heads/${BRANCH}`);
  const seen = fakeProvider(() => json(201, {}));
  try {
    const r = await ship(shipBody(), { deps: {} }); // the real check: origin is a local folder, not github.com/o/r
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
    assert.equal(git(['rev-parse', 'HEAD'], WT), before, 'no commit');
    assert.equal(remoteHead(`refs/heads/${BRANCH}`), remoteBefore, 'nothing pushed');
    assert.equal(seen.length, 0, 'no provider call');
  } finally { _setPinnedFetchForTests(null); }
});

test('ship never runs repo hooks, even a hooksPath the agent controls', async () => {
  const hooks = path.join(SANDBOX, 'planted-hooks');
  const marker = path.join(SANDBOX, 'hook-ran');
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    const file = path.join(hooks, hook);
    fs.writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker}"\nexit 0\n`);
    fs.chmodSync(file, 0o755);
  }
  git(['config', 'core.hooksPath', hooks], WT);
  fs.writeFileSync(path.join(WT, 'src', 'g.txt'), 'g\n');
  try {
    const out = await commitAndPush({ worktree: WT, branch: BRANCH, message: 'No hooks', patchId: await stagedPatchId(WT, BASE) });
    assert.equal(out.pushed, true);
    assert.equal(fs.existsSync(marker), false, 'no hook ran');
  } finally {
    git(['config', '--unset', 'core.hooksPath'], WT);
  }
});
