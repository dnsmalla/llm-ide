import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// NOTE: env vars (incl. LLMIDE_DB_PATH) MUST be set before any static or
// dynamic import of a module that transitively imports kb/db.mjs — its
// DB_PATH is captured at module-load time from core/config.mjs. box.mjs
// imports kb/db.mjs, so it is imported dynamically below, after the env
// vars are set, rather than via a top-level `import` (which ESM hoists
// ahead of these assignments and would silently point at the real
// kb/data.db instead of an isolated test file).
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_box-connector-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { buildTokenForm, parseFolderItems, toSourceRows } = await import('../connectors/box.mjs');

test('buildTokenForm encodes a CCG request', () => {
  const form = buildTokenForm({ clientId: 'cid', clientSecret: 'sec', subjectType: 'enterprise', subjectId: '123' });
  const p = new URLSearchParams(form);
  assert.equal(p.get('grant_type'), 'client_credentials');
  assert.equal(p.get('client_id'), 'cid');
  assert.equal(p.get('client_secret'), 'sec');
  assert.equal(p.get('box_subject_type'), 'enterprise');
  assert.equal(p.get('box_subject_id'), '123');
});

test('parseFolderItems splits files and subfolders', () => {
  const json = { entries: [
    { type: 'file', id: '1', name: 'a.txt', modified_at: '2026-01-01T00:00:00Z' },
    { type: 'folder', id: '9', name: 'sub' },
    { type: 'web_link', id: '5', name: 'link' },
  ], total_count: 3 };
  const { files, folders } = parseFolderItems(json);
  assert.deepEqual(files.map(f => f.id), ['1']);
  assert.deepEqual(folders.map(f => f.id), ['9']);
  assert.equal(files[0].name, 'a.txt');
});

test('toSourceRows chunks text into doc rows with a folder-scoped ref', () => {
  const rows = toSourceRows({ folderId: 'F', fileId: '42', name: 'notes.md', modifiedAt: 'T', path: 'sub/notes.md', text: 'line1\nline2' });
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].kind, 'doc');
  assert.equal(rows[0].ref, 'box:F:42');
  assert.equal(rows[0].chunkIdx, 0);
  assert.equal(rows[0].title, 'notes.md');
  assert.equal(rows[0].meta.fileId, '42');
  assert.equal(rows[0].meta.folderId, 'F');
  assert.equal(rows[0].meta.path, 'sub/notes.md');
});

test('indexBoxFolder fetches, chunks, and ingests doc rows (skips no-text files)', async () => {
  const dbmod = await import('../kb/db.mjs');
  dbmod.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const db = getDb();
  const userId = registerUser(db, { email: `box-${Math.floor(performance.now()*1000)}@ex.com`, password: 'pw-12345678' }).id;
  const { indexBoxFolder } = await import('../connectors/box.mjs');

  const orig = global.fetch;
  global.fetch = async (urlStr, _init) => {
    const url = String(urlStr);
    const json = (o, ok = true) => ({ ok, json: async () => o, text: async () => '' });
    if (url === 'https://api.box.com/oauth2/token') return json({ access_token: 'tok' });
    if (url.includes('/folders/F/items')) return json({ total_count: 2, entries: [
      { type: 'file', id: '1', name: 'a.md', modified_at: 'T' },
      { type: 'file', id: '2', name: 'binary.png', modified_at: 'T' },
    ]});
    if (url.includes('/files/1?')) return json({ representations: { entries: [
      { representation: 'extracted_text', status: { state: 'success' }, content: { url_template: 'https://dl.box.com/1/text{+asset_path}' } },
    ]}});
    if (url.includes('/files/2?')) return json({ representations: { entries: [] } }); // no text rep → skipped
    if (url === 'https://dl.box.com/1/text') return { ok: true, json: async () => ({}), text: async () => 'hello\nworld' };
    return json({}, false);
  };
  try {
    const r = await indexBoxFolder(userId, { clientId: 'c', clientSecret: 's', subjectType: 'enterprise', subjectId: 'e', folderId: 'F' }, { pollDelayMs: 0 });
    assert.equal(r.indexed, 1, 'one chunk from a.md');
    assert.equal(r.skipped, 1, 'binary.png skipped');
    const row = db.prepare("SELECT ref, title, kind FROM sources WHERE user_id=? AND kind='doc'").get(userId);
    assert.equal(row.ref, 'box:F:1');
    assert.equal(row.title, 'a.md');
  } finally {
    global.fetch = orig;
    dbmod.closeDb();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  }
});

// B4: a full first page followed by a partial page, with NO total_count in the
// response. The old break-on-`total_count || 0` stopped after page 1 → silent
// data loss. The page-length break condition must fetch page 2.
test('indexBoxFolder paginates past a full page even when total_count is absent', async () => {
  const dbmod = await import('../kb/db.mjs');
  dbmod.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const db = getDb();
  const userId = registerUser(db, { email: `boxpage-${Math.floor(performance.now()*1000)}@ex.com`, password: 'pw-12345678' }).id;
  const { indexBoxFolder } = await import('../connectors/box.mjs');

  const page0 = Array.from({ length: 1000 }, (_, i) => ({ type: 'file', id: `a${i}`, name: `f${i}.md`, modified_at: 'T' }));
  const page1 = [{ type: 'file', id: 'b0', name: 'last.md', modified_at: 'T' }];
  const orig = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    const json = (o, ok = true) => ({ ok, json: async () => o, text: async () => '' });
    if (url === 'https://api.box.com/oauth2/token') return json({ access_token: 'tok' });
    if (url.includes('/folders/F/items') && url.includes('offset=0')) return json({ entries: page0 }); // note: no total_count
    if (url.includes('/folders/F/items') && url.includes('offset=1000')) return json({ entries: page1 });
    if (url.includes('/files/') && url.includes('?')) return json({ representations: { entries: [
      { representation: 'extracted_text', status: { state: 'success' }, content: { url_template: 'https://dl.box.com/rep{+asset_path}' } },
    ]}});
    if (url === 'https://dl.box.com/rep') return { ok: true, json: async () => ({}), text: async () => 'x' };
    return json({}, false);
  };
  try {
    const r = await indexBoxFolder(userId, { clientId: 'c', clientSecret: 's', subjectType: 'enterprise', subjectId: 'e', folderId: 'F' }, { pollDelayMs: 0 });
    assert.equal(r.files, 1001, 'both pages indexed (1000 + 1), not just page 1');
    assert.equal(r.indexed, 1001, 'one chunk per single-line file across both pages');
    assert.equal(r.truncated, false, 'below MAX_FILES cap → not truncated');
  } finally {
    global.fetch = orig;
    dbmod.closeDb();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  }
});
