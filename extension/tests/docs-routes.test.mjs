// HTTP-level tests for the docs-kit K1 routes (/kb/docs/*, /kb/projects/register)
// in the doc_gen group: tenancy, folder and path confinement, body caps, the
// feature gate, and the auth gate. Same req/res double as connector-routes.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(here, '_docs-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleDocsRoutes } = await import('../routes/docs-routes.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { featureDisabledFor, FEATURE_ROUTE_GROUPS } = await import('../routes/feature-routes.mjs');
const { GOLDEN_VISUAL_TEMPLATE } = await import('./fixtures/docgen/golden.mjs');

function makeReq({ method, url, rawBody, body, user }) {
  const chunks = rawBody != null ? [rawBody] : body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, headers: {}, user, socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
    destroy() {},
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}

async function call(user, method, url, body, rawBody) {
  const req = makeReq({ method, url, body, rawBody, user: user ? { id: user } : undefined });
  const res = makeRes();
  await handleDocsRoutes(req, res, { userId: user, url });
  return res;
}

function reset() {
  kb.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  kb.getDb();
}

function mkUser(tag) {
  return users.registerUser(kb.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

/** A marked project folder under the OS temp dir, realpath. */
function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-route-')));
  fs.mkdirSync(path.join(root, 'system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 'project.json'), '{}');
  return root;
}

async function registered(user, root, id = 'proj-1') {
  const res = await call(user, 'POST', '/kb/projects/register', { id, root });
  assert.equal(res.statusCode, 200, res._body);
  return id;
}

test('register: a marked project is stored and its root is the realpath', async () => {
  reset();
  const u = mkUser('reg');
  const root = makeProject();
  const res = await call(u, 'POST', '/kb/projects/register', { id: 'proj-a', root });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().root, root);
});

test('register: refuses an over-broad root, a missing marker, a bad id and a relative root', async () => {
  reset();
  const u = mkUser('bad');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-bare-'));
  try {
    assert.equal((await call(u, 'POST', '/kb/projects/register', { id: 'x', root: '/' })).statusCode, 400);
    assert.equal((await call(u, 'POST', '/kb/projects/register', { id: 'x', root: bare })).json().error.code, 'INVALID_ROOT');
    assert.equal((await call(u, 'POST', '/kb/projects/register', { id: '../x', root: makeProject() })).json().error.code, 'INVALID_PROJECT_ID');
    assert.equal((await call(u, 'POST', '/kb/projects/register', { id: 'x', root: 'relative' })).statusCode, 400);
    assert.equal((await call(u, 'POST', '/kb/projects/register', { id: 'x', root: os.homedir() })).statusCode, 400);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('tenancy: another user cannot read, write or delete through the same project id', async () => {
  reset();
  const owner = mkUser('owner');
  const other = mkUser('other');
  const root = makeProject();
  try {
    const id = await registered(owner, root, 'shared-id');
    assert.equal((await call(owner, 'PUT', `/kb/docs/templates/retro?project=${id}`, { name: 'Retro', sections: ['A'] })).statusCode, 200);
    const read = await call(other, 'GET', `/kb/docs/templates?project=${id}`);
    assert.equal(read.statusCode, 404);
    assert.equal(read.json().error.code, 'PROJECT_NOT_REGISTERED');
    assert.equal((await call(other, 'PUT', `/kb/docs/templates/evil?project=${id}`, { name: 'E' })).statusCode, 404);
    assert.equal((await call(other, 'DELETE', `/kb/docs/templates/retro?project=${id}`)).statusCode, 404);
    assert.ok(fs.existsSync(path.join(root, 'templates', 'retro', 'template.md')), 'the other user deleted the owner\'s file');
    assert.ok(!fs.existsSync(path.join(root, 'templates', 'evil')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('templates: PUT writes the golden bytes, GET lists them, DELETE removes them', async () => {
  reset();
  const u = mkUser('tpl');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    const put = await call(u, 'PUT', `/kb/docs/templates/sprint-review?project=${id}`,
      { name: 'Sprint Review', sections: ['Summary', 'Decisions'], surface: 'visual' });
    assert.equal(put.statusCode, 200, put._body);
    assert.equal(put.json().template.surface, 'visual');
    assert.equal(fs.readFileSync(path.join(root, 'templates', 'sprint-review', 'template.md'), 'utf8'), GOLDEN_VISUAL_TEMPLATE);
    const list = await call(u, 'GET', `/kb/docs/templates?project=${id}`);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().templates.map((t) => t.folderName), ['sprint-review']);
    assert.equal((await call(u, 'DELETE', `/kb/docs/templates/sprint-review?project=${id}`)).statusCode, 200);
    assert.equal((await call(u, 'DELETE', `/kb/docs/templates/sprint-review?project=${id}`)).statusCode, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commands: PUT, GET and DELETE round-trip', async () => {
  reset();
  const u = mkUser('cmd');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    const put = await call(u, 'PUT', `/kb/docs/commands/visual-brief?project=${id}`,
      { name: 'Visual Brief', instruction: 'Describe the frame.', surface: 'visual' });
    assert.equal(put.statusCode, 200, put._body);
    const list = await call(u, 'GET', `/kb/docs/commands?project=${id}`);
    assert.equal(list.json().commands[0].instruction, 'Describe the frame.');
    assert.equal(list.json().commands[0].surface, 'visual');
    assert.equal((await call(u, 'DELETE', `/kb/docs/commands/visual-brief?project=${id}`)).statusCode, 200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('seed: writes the README files and answers with what it wrote', async () => {
  reset();
  const u = mkUser('seed');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    const res = await call(u, 'POST', `/kb/docs/seed?project=${id}`);
    assert.equal(res.statusCode, 200, res._body);
    assert.ok(res.json().written.includes('templates/README.md'));
    assert.ok(fs.existsSync(path.join(root, 'commands', 'README.md')));
    assert.equal((await call(u, 'POST', `/kb/docs/seed?project=${id}`)).json().count, 0, 'second seed writes nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path confinement: traversal, separators, reserved and encoded names are refused', async () => {
  reset();
  const u = mkUser('trav');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    for (const folder of ['..%2Fevil', 'a%2Fb', '.hidden', 'auto_task', '%00x']) {
      const res = await call(u, 'PUT', `/kb/docs/templates/${folder}?project=${id}`, { name: 'X' });
      assert.equal(res.statusCode, 400, `${folder} -> ${res.statusCode}`);
    }
    assert.ok(!fs.existsSync(path.join(root, 'templates', 'auto_task')));
    assert.deepEqual(fs.readdirSync(root).sort(), ['system'], 'something was written outside templates/');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlink: a template folder that points outside the project is never read or deleted', async () => {
  reset();
  const u = mkUser('sym');
  const root = makeProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-outside-'));
  try {
    const id = await registered(u, root);
    fs.writeFileSync(path.join(outside, 'template.md'), '# Out\n\n## X\n');
    fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'templates', 'evil'));
    assert.deepEqual((await call(u, 'GET', `/kb/docs/templates?project=${id}`)).json().templates, []);
    const del = await call(u, 'DELETE', `/kb/docs/templates/evil?project=${id}`);
    assert.equal(del.statusCode, 400, 'a symlinked folder must be refused, not followed');
    assert.ok(fs.existsSync(path.join(outside, 'template.md')), 'the symlink target was deleted');
    assert.equal((await call(u, 'PUT', `/kb/docs/templates/evil?project=${id}`, { name: 'E' })).statusCode, 400);
    assert.equal(fs.readFileSync(path.join(outside, 'template.md'), 'utf8'), '# Out\n\n## X\n', 'wrote through the symlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('limits: an oversize body is refused with 413, a bad field with 400', async () => {
  reset();
  const u = mkUser('lim');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    const big = Buffer.from(JSON.stringify({ name: 'X', rawContent: 'x'.repeat(600 * 1024) }));
    const res = await call(u, 'PUT', `/kb/docs/templates/big?project=${id}`, undefined, big);
    assert.equal(res.statusCode, 413);
    assert.equal((await call(u, 'PUT', `/kb/docs/templates/ok?project=${id}`, { name: 'X', surface: 'nope' })).statusCode, 400);
    assert.equal((await call(u, 'PUT', `/kb/docs/templates/ok?project=${id}`, { name: 'X', sections: 'A' })).statusCode, 400);
    assert.equal((await call(u, 'PUT', `/kb/docs/templates/ok?project=${id}`, undefined, Buffer.from('not json'))).statusCode, 400);
    assert.ok(!fs.existsSync(path.join(root, 'templates', 'big')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('routing: a missing project query is 400, an unknown method is 405, an unknown path is not ours', async () => {
  reset();
  const u = mkUser('route');
  assert.equal((await call(u, 'GET', '/kb/docs/templates')).statusCode, 400);
  assert.equal((await call(u, 'PATCH', '/kb/docs/templates?project=x')).statusCode, 405);
  const res = await call(u, 'GET', '/kb/docs/nonsense?project=x');
  assert.equal(res.statusCode, 200, 'not ours returns false, so the caller answers');
});

test('auth: the /kb tree answers 401 with no user, before any docs route runs', async () => {
  reset();
  const req = makeReq({ method: 'GET', url: '/kb/docs/templates?project=x', user: undefined });
  const res = makeRes();
  await handleKB(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');
});

test('feature gate: every docs-kit path is owned by doc_gen and answers feature_disabled when it is off', () => {
  const off = new Set(['gantt_issues', 'code_graph_3d', 'auto_tasks']);
  for (const p of ['/kb/docs/templates?project=x', '/kb/docs/commands', '/kb/docs/seed', '/kb/projects/register', '/kb/docs/templates/a']) {
    assert.equal(featureDisabledFor(p, off), 'doc_gen', p);
  }
  assert.equal(featureDisabledFor('/kb/projects/registered', off), null, 'a sibling path is not the register route');
  assert.equal(featureDisabledFor('/kb/docs/templates?project=x', null), null, 'all features on: served');
  assert.ok(FEATURE_ROUTE_GROUPS.doc_gen.prefixes.includes('/kb/docs/'));
});

test('latency: a list call through the route (200 templates) answers in under 200 ms', async (t) => {
  reset();
  const u = mkUser('lat');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    for (let i = 0; i < 200; i++) {
      fs.mkdirSync(path.join(root, 'templates', `t-${i}`), { recursive: true });
      fs.writeFileSync(path.join(root, 'templates', `t-${i}`, 'template.md'), `# T ${i}\n\n## A\n`);
    }
    await call(u, 'GET', `/kb/docs/templates?project=${id}`);
    const started = performance.now();
    const res = await call(u, 'GET', `/kb/docs/templates?project=${id}`);
    const ms = performance.now() - started;
    t.diagnostic(`GET /kb/docs/templates (200) took ${ms.toFixed(1)} ms`);
    assert.equal(res.json().count, 200);
    assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('register oracle: a missing folder, a folder with no marker and an over-broad root answer one code and one message', async () => {
  reset();
  const u = mkUser('oracle');
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-bare-')));
  try {
    const answers = [
      path.join(bare, 'missing'),
      bare,
      os.homedir(),
      '/private',
    ].map(async (root) => {
      const res = await call(u, 'POST', '/kb/projects/register', { id: 'probe', root });
      return { status: res.statusCode, error: res.json().error };
    });
    const got = await Promise.all(answers);
    for (const g of got) {
      assert.equal(g.status, 400);
      assert.equal(g.error.code, 'INVALID_ROOT');
      assert.equal(g.error.message, got[0].error.message);
    }
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('register cap: 200 projects per user, a re-registration does not count, the 201st new id is 409', async () => {
  reset();
  const u = mkUser('cap');
  const root = makeProject();
  try {
    const db = kb.getDb();
    const insert = db.prepare('INSERT INTO doc_project_roots (user_id, project_id, root) VALUES (?, ?, ?)');
    for (let i = 0; i < 199; i++) insert.run(u, `filler-${i}`, `/nonexistent/${i}`);
    await registered(u, root, 'real-200');
    const over = await call(u, 'POST', '/kb/projects/register', { id: 'real-201', root });
    assert.equal(over.statusCode, 409);
    assert.equal(over.json().error.code, 'TOO_MANY_PROJECTS');
    const again = await call(u, 'POST', '/kb/projects/register', { id: 'real-200', root });
    assert.equal(again.statusCode, 200, 're-registering an existing id was refused at the cap');
    const count = db.prepare('SELECT COUNT(*) AS n FROM doc_project_roots WHERE user_id = ?').get(u).n;
    assert.equal(count, 200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest layouts over HTTP: the reserved names are 400, an ingest file in another folder is 409, and the delete result says what was removed', async () => {
  reset();
  const u = mkUser('ingest');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    assert.equal((await call(u, 'PUT', `/kb/docs/templates/meeting-note?project=${id}`, { name: 'M' })).json().error.code, 'RESERVED_FOLDER');
    assert.equal((await call(u, 'DELETE', `/kb/docs/templates/email-note?project=${id}`)).json().error.code, 'RESERVED_FOLDER');
    const dir = path.join(root, 'templates', 'house-meeting');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'template.md'), '<!-- llmide:ingest-template source=meeting -->\n# {{title}}\n');
    const del = await call(u, 'DELETE', `/kb/docs/templates/house-meeting?project=${id}`);
    assert.equal(del.statusCode, 409);
    assert.equal(del.json().error.code, 'RESERVED_FOLDER');
    const put = await call(u, 'PUT', `/kb/docs/templates/house-meeting?project=${id}`, { name: 'X', sections: ['A'] });
    assert.equal(put.statusCode, 409);
    assert.ok(fs.readFileSync(path.join(dir, 'template.md'), 'utf8').includes('{{title}}'), 'the ingest layout was overwritten');
    await call(u, 'PUT', `/kb/docs/templates/retro?project=${id}`, { name: 'Retro', sections: ['A'] });
    fs.writeFileSync(path.join(root, 'templates', 'retro', 'extra.txt'), 'keep');
    const d2 = await call(u, 'DELETE', `/kb/docs/templates/retro?project=${id}`);
    assert.deepEqual(d2.json(), { deleted: true, folderName: 'retro', folderRemoved: false });
    assert.ok(fs.existsSync(path.join(root, 'templates', 'retro', 'extra.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('list: the response carries truncated and scannedFolders; a PUT answers the true folder name', async () => {
  reset();
  const u = mkUser('list');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    await call(u, 'PUT', `/kb/docs/templates/Case-Two?project=${id}`, { name: 'C', sections: ['A'] });
    const list = (await call(u, 'GET', `/kb/docs/templates?project=${id}`)).json();
    assert.equal(list.truncated, false);
    assert.equal(list.scannedFolders, 1);
    const put = await call(u, 'PUT', `/kb/docs/templates/case-two?project=${id}`, { name: 'C2', sections: ['B'] });
    assert.equal(put.json().template.folderName, 'Case-Two');
    const cmds = (await call(u, 'GET', `/kb/docs/commands?project=${id}`)).json();
    assert.equal(cmds.truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.after(() => {
  kb.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

test('delete: a folder with no template.md deletes the file the list shows (its first .md), not a 404', async () => {
  reset();
  const u = mkUser('stray');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    const dir = path.join(root, 'templates', 'stray');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Stray\n\n## A\n');
    const list = await call(u, 'GET', `/kb/docs/templates?project=${id}`);
    assert.deepEqual(list.json().templates.map((t) => t.folderName), ['stray']);
    const del = await call(u, 'DELETE', `/kb/docs/templates/stray?project=${id}`);
    assert.equal(del.statusCode, 200, del._body);
    assert.equal(del.json().folderRemoved, true);
    assert.ok(!fs.existsSync(dir), 'the stray entry and its empty folder should be gone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('delete: other .md files beside template.md are kept; the folder then lists the next .md (documented, docs-kit §8)', async () => {
  reset();
  const u = mkUser('extra');
  const root = makeProject();
  try {
    const id = await registered(u, root);
    assert.equal((await call(u, 'PUT', `/kb/docs/templates/retro?project=${id}`, { name: 'Retro', sections: ['A'] })).statusCode, 200);
    const dir = path.join(root, 'templates', 'retro');
    fs.writeFileSync(path.join(dir, 'README.md'), 'my notes\n');
    const del = await call(u, 'DELETE', `/kb/docs/templates/retro?project=${id}`);
    assert.equal(del.statusCode, 200, del._body);
    assert.equal(del.json().folderRemoved, false);
    assert.ok(!fs.existsSync(path.join(dir, 'template.md')));
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'my notes\n', 'the user file must survive');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
