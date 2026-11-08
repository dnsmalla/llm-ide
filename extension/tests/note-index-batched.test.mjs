// C4: the note rebuild must yield between batches; a 5,000-note library may not stop the event loop for 100 ms+.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-note-batch-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const kb = await import('../kb/db.mjs');
const ni = await import('../kb/note-index.mjs');

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 5,000-note rebuild yields: the longest event-loop block stays under 100 ms', async () => {
  const db = kb.getDb();
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u1','n@x.y','N','x','user','active')").run();
  const ins = db.prepare(`INSERT INTO note_index (user_id, note_key, kind, title, date, body_text, content_hash, mtime_ms)
    VALUES ('u1', ?, 'meeting', ?, '2026-11-08', ?, 'h', 0)`);
  db.transaction(() => { for (let i = 0; i < 5000; i += 1) ins.run(`n-${i}`, `Note ${i}`, `body ${i} needle`); })();

  let maxGap = 0;
  let last = process.hrtime.bigint();
  const hb = setInterval(() => {
    const now = process.hrtime.bigint();
    maxGap = Math.max(maxGap, Number(now - last) / 1e6);
    last = now;
  }, 5);
  try {
    const n = await ni.rebuildNoteIndexSearchBatched(db);
    assert.equal(n, 5000);
  } finally {
    clearInterval(hb);
  }
  assert.ok(maxGap < 100, `longest block ${maxGap.toFixed(1)} ms`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM search WHERE kind = 'note' AND user_id = 'u1'").get().n, 5000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note_index_search').get().n, 5000);
});
