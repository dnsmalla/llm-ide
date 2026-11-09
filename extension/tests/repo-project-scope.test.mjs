// R-034 #2: the repo allow-list must never widen a hub caller past the project grants.
// An engineer on project A can add /srv/B to their allow-list row; reads, writes, connect-git,
// SCIP, the code graph and review approval must all ignore it unless they have a grant on B.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_HUB = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-repo-scope-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');

const kb = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { addUserRepo } = await import('../kb/db.mjs');
const {
  registerProject, setProjectMember, filteredRepoAllowlist, repoRootRefusal,
} = await import('../kb/projects.mjs');
const { buildReadableRoots, buildTrustedRoots, resolveReadablePath, handleReadFile } = await import('../llm_agent/tools/handlers/repo-files.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { handleReviewRoutes } = await import('../routes/review.mjs');

const db = kb.getDb();
let seq = 0;
function user(teamRole, maxMode) {
  const id = `rs-${++seq}`;
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')")
    .run(id, `${id}@example.com`, id);
  grant(db, id, { teamRole, maxMode, usdCapMonth: 0 });
  return id;
}

const owner = user('owner', 'execute');
const engineer = user('member', 'execute');

const ROOT = path.join(dir, 'srv');
const A = path.join(ROOT, 'A');
const B = path.join(ROOT, 'B');
fs.mkdirSync(path.join(A, 'src'), { recursive: true });
fs.mkdirSync(path.join(B, 'src'), { recursive: true });
fs.writeFileSync(path.join(A, 'src', 'a.ts'), 'export const A_MARK = 1;\n');
fs.writeFileSync(path.join(B, 'src', 'b.ts'), 'export const B_SECRET_MARK = 2;\n');

registerProject(db, owner, { id: 'p-a', root: A, name: 'A' });
registerProject(db, owner, { id: 'p-b', root: B, name: 'B' });
setProjectMember(db, owner, 'p-a', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
// Simulate a row added before the fix (or by a local install, then moved to a hub).
addUserRepo(engineer, A, 'A');
addUserRepo(engineer, B, 'B');

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R-034 #2: the filtered allow-list drops a root inside an ungranted project', () => {
  assert.deepEqual(filteredRepoAllowlist(db, engineer), [A], 'B is not on the usable list');
  assert.deepEqual(repoRootRefusal(db, engineer, B), { projectId: 'p-b' });
  assert.equal(repoRootRefusal(db, engineer, path.join(B, 'src', 'b.ts')).projectId, 'p-b');
  assert.equal(repoRootRefusal(db, engineer, A), null, 'the granted project stays');
  // An ancestor of B would expose B too; it is refused as well.
  assert.equal(repoRootRefusal(db, engineer, ROOT).projectId, 'p-b');
  // A team owner overrides every project (team management is theirs).
  assert.equal(repoRootRefusal(db, owner, B), null);
});

test('R-034 #2: chat read roots and Bash-trusted roots exclude B', () => {
  const real = (p) => fs.realpathSync(p);
  const readable = buildReadableRoots({ userId: engineer });
  assert.ok(readable.includes(real(A)), 'A is readable');
  assert.ok(!readable.includes(real(B)), 'B must not become a readable root');
  const trusted = buildTrustedRoots(engineer);
  assert.ok(trusted.includes(real(A)));
  assert.ok(!trusted.includes(real(B)), 'B must not become a writable/trusted root');
  // And the read-file handler refuses B through the same root set.
  assert.equal(resolveReadablePath(path.join(B, 'src', 'b.ts'), readable), null);
  assert.equal(handleReadFile({ path: path.join(B, 'src', 'b.ts') }, { roots: readable }).content, undefined);
});

function makeReq({ method = 'POST', url, body, userId }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId }, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    on(e, cb) { if (e === 'data') chunks.forEach((c) => cb(c)); else if (e === 'end' || e === 'close') cb(); return req; },
    once() { return req; },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', writableEnded: false,
    writeHead(c) { this.statusCode = c; }, setHeader() {}, write(c) { this._body += c; },
    end(c) { if (c) this._body += c; this.writableEnded = true; },
    json() { try { return JSON.parse(this._body); } catch { return null; } },
  };
}
async function call(handler, args) {
  const res = makeRes();
  await handler(makeReq(args), res);
  return { status: res.statusCode, body: res.json() };
}

test('R-034 #2: connect-git refuses B (the raw row still exists, the filtered list does not)', async () => {
  const r = await call(handleKB, { url: '/kb/connect-git', body: { path: B }, userId: engineer });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PATH_NOT_APPROVED');
});

test('R-034 #2: review submit pins allowedRepos to the filtered list and approve refuses B', async () => {
  const submitRes = makeRes();
  await handleReviewRoutes(makeReq({
    url: '/kb/review/submit', userId: engineer,
    body: {
      kind: 'codegen-apply', title: 'apply B',
      payload: { repoPath: B, taskId: 't1', files: [{ path: 'src/b.ts', kind: 'modify', content: 'x' }] },
    },
  }), submitRes, { userId: engineer, url: '/kb/review/submit' });
  assert.equal(submitRes.statusCode, 200, submitRes._body);
  const item = JSON.parse(submitRes._body);
  assert.ok(!item.payload.allowedRepos.includes(B), 'B is not part of the authoritative list');
  assert.ok(item.payload.allowedRepos.includes(A), 'A stays usable');
  assert.ok((item.guardrails.findings || []).some((f) => f.ruleId === 'codegen.allowlist' && f.severity === 'blocking'));

  const approveRes = makeRes();
  await handleReviewRoutes(makeReq({
    url: '/kb/review/approve', userId: engineer, body: { id: item.id },
  }), approveRes, { userId: engineer, url: '/kb/review/approve' });
  assert.equal(approveRes.statusCode, 422, approveRes._body);
  assert.equal(JSON.parse(approveRes._body).error.code, 'GUARDRAILS_FAILED');
});

test('R-034 #2: POST /auth/me/repos is still refused for a hub member (and the path check refuses B)', async () => {
  const { handleAuth } = await import('../server/auth-routes.mjs');
  const res = makeRes();
  await handleAuth(makeReq({
    url: '/auth/me/repos', userId: engineer, body: { path: B },
  }), res, { db, logger: null, requestId: 'r-1' });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res._body).error.code, 'ROLE_DENIED', 'a hub member has no fs.write at all');
  // The path rule itself is the second line of defence (and the only one once execute for members
  // returns, or on a local install that later points at a hub DB).
  assert.equal(repoRootRefusal(db, engineer, B).projectId, 'p-b');
});
