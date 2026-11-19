// The self-improvement folder's identity and inbox (plan 2026-11-19, phase 5): a folder copied in from another
// project is moved to the inbox before anything reads it, and its memory facts and Self-Heal notes are adopted or
// dismissed one by one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_si-inbox-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const memory = await import('../graphkit/memory.mjs');
const writer = await import('../graphkit/memory-writer.mjs');
const { ensureOwnFolder } = await import('../graphkit/self-improvement-folder.mjs');
const { readInbox, decideInboxItem } = await import('../graphkit/self-improvement-inbox.mjs');
const { stripFactStamp } = await import('../core/fact-key.mjs');

const roots = [];
after(() => { db.closeDb(); wipe(); for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
let n = 0;
const user = () => users.registerUser(db.getDb(), { email: `si-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 's' }).id;
function project(u, tag) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HERE, `_si-${tag}-`)));
  fs.mkdirSync(path.join(root, 'system'), { recursive: true });
  roots.push(root);
  if (u) db.addUserRepo(u, root);
  return root;
}
const si = (root, ...rest) => path.join(root, 'system', 'self-improvement', ...rest);
/** A self-improvement folder as another project left it, copied whole into `root`. */
function copyForeign(root, from = '/elsewhere/web-shop') {
  fs.mkdirSync(si(root), { recursive: true });
  fs.writeFileSync(si(root, 'manifest.json'), JSON.stringify({ format: 1, root: from, projectName: 'web-shop', createdAt: 'x' }));
  fs.writeFileSync(si(root, 'memory.md'), '# Chat memory\n- [convention] Tests run with pnpm test\n- Deploys go through Fly\n');
  fs.writeFileSync(si(root, 'self-heal.md'), '# Self-Heal notes\n\n## 2026-11-18 · fixed · server\n\n- error: Error: db is locked\n- fix: retry the write once\n');
  fs.writeFileSync(si(root, 'lessons.json'), JSON.stringify({ format: 1, lessons: [] }));
}

test('a folder made here gets its own manifest; a second check changes nothing', () => {
  const root = project(null, 'own');
  writer.appendChatMemory({ root, facts: ['Uses SQLite'] });
  const m = JSON.parse(fs.readFileSync(si(root, 'manifest.json'), 'utf8'));
  assert.equal(m.root, root);
  assert.deepEqual(ensureOwnFolder(root), { moved: null });
  assert.deepEqual(writer.readChatMemoryFacts(root).map(stripFactStamp), ['Uses SQLite']);
});

test('a folder copied from another project goes to the inbox before the prompt reads it', () => {
  const u = user();
  const root = project(u, 'foreign');
  copyForeign(root);
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: root, name: 'r' }] }, u, null, 'how do I test?');
  assert.doesNotMatch(out ?? '', /pnpm test/, 'another project\'s memory never reaches a prompt unreviewed');
  assert.ok(!fs.existsSync(si(root, 'memory.md')));
  const inbox = readInbox(root);
  assert.equal(inbox.sources.length, 1);
  const [src] = inbox.sources;
  assert.match(src.name, /^web-shop-\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual([src.projectName, src.memory, src.notes.length, src.lessons, src.changes], ['web-shop', ['[convention] Tests run with pnpm test', 'Deploys go through Fly'], 1, 0, 0]);
  assert.equal(JSON.parse(fs.readFileSync(si(root, 'manifest.json'), 'utf8')).root, root, 'the folder is now this project\'s');
});

test('adopt writes a fact or note into this project; dismiss only removes it; a decided item is gone', () => {
  const root = project(null, 'decide');
  copyForeign(root);
  const [src] = readInbox(root).sources;
  assert.equal(decideInboxItem(root, { source: src.name, kind: 'memory', key: 'Deploys go through Fly', action: 'adopt' }), true);
  assert.equal(decideInboxItem(root, { source: src.name, kind: 'memory', key: '[convention] Tests run with pnpm test', action: 'dismiss' }), true);
  assert.deepEqual(writer.readChatMemoryFacts(root).map(stripFactStamp), ['Deploys go through Fly']);
  assert.equal(decideInboxItem(root, { source: src.name, kind: 'note', key: src.notes[0], action: 'adopt' }), true);
  assert.match(fs.readFileSync(si(root, 'self-heal.md'), 'utf8'), /## 2026-11-18 · fixed · server\n\n- error: Error: db is locked\n- fix: retry the write once/);
  const after = readInbox(root).sources[0];
  assert.deepEqual([after.memory, after.notes], [[], []]);
  assert.equal(decideInboxItem(root, { source: src.name, kind: 'memory', key: 'Deploys go through Fly', action: 'adopt' }), false, 'already decided');
  assert.equal(decideInboxItem(root, { source: '../../etc', kind: 'memory', key: 'x', action: 'adopt' }), false, 'no path escape');
});

test('two copies from the same project on the same day get separate inbox folders', () => {
  const root = project(null, 'twice');
  copyForeign(root);
  readInbox(root);
  copyForeign(root);
  assert.deepEqual(readInbox(root).sources.map((s) => s.name.replace(/\d{4}-\d{2}-\d{2}/, 'D')), ['web-shop-D', 'web-shop-D-2']);
});

test('the inbox routes: the GET tidies and lists, the POST decides one item, unknown items and bad bodies are refused', async () => {
  const { Readable } = await import('node:stream');
  const { handleAgentRoutes } = await import('../routes/agent.mjs');
  const res = () => ({ statusCode: 0, body: null, headersSent: false, writeHead(c) { this.statusCode = c; this.headersSent = true; }, setHeader() {}, end(s) { this.body = s ? JSON.parse(s) : null; } });
  const req = (method, url, body) => { const r = new Readable({ read() {} }); r.method = method; r.url = url; if (body) r.push(Buffer.from(JSON.stringify(body))); r.push(null); return r; };
  const call = async (method, url, userId, body) => { const out = res(); await handleAgentRoutes(req(method, url, body), out, { userId, url }); return out; };
  const u = user();
  const root = project(u, 'route');
  copyForeign(root);
  const GET = `/kb/agent/self-improvement/inbox?repo=${encodeURIComponent(root)}`;
  let r = await call('GET', GET, u);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.repo, root);
  assert.match(r.body.moved, /^web-shop-/);
  const source = r.body.sources[0].name;
  r = await call('POST', '/kb/agent/self-improvement/inbox', u, { repo: root, source, kind: 'memory', key: 'Deploys go through Fly', action: 'adopt' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.sources[0].memory, ['[convention] Tests run with pnpm test']);
  r = await call('POST', '/kb/agent/self-improvement/inbox', u, { repo: root, source, kind: 'memory', key: 'Deploys go through Fly', action: 'adopt' });
  assert.deepEqual([r.statusCode, r.body.error.code], [404, 'INBOX_ITEM_NOT_FOUND']);
  r = await call('POST', '/kb/agent/self-improvement/inbox', u, { repo: root, source, kind: 'lesson', key: 'x', action: 'adopt' });
  assert.deepEqual([r.statusCode, r.body.error.code], [400, 'VALIDATION_FAILED']);
  r = await call('POST', '/kb/agent/self-improvement/inbox', user(), { repo: root, source, kind: 'memory', key: 'x', action: 'adopt' });
  assert.deepEqual([r.statusCode, r.body.error.code], [404, 'REPO_NOT_ALLOWED'], 'another user cannot reach this repo');
});
