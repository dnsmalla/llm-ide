// C4: the FTS table is shared, but the result window must be per user. Before 0072 a member's own row could sit
// beyond the 10,000-row shared window behind another member's rows and never be returned.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-search-user-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const kb = await import('../kb/db.mjs');

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a user finds their own hit even when another user fills the shared window', () => {
  const db = kb.getDb();
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('uA','a@x.y','A','x','user','active'), ('uB','b@x.y','B','x','user','active')").run();
  const ins = db.prepare("INSERT INTO meetings (id, user_id, title, date, transcript) VALUES (?, ?, 'needle', '2026-11-08', 'needle needle')");
  db.transaction(() => { for (let i = 0; i < 12_000; i += 1) ins.run(`a-${i}`, 'uA'); })();
  db.prepare("INSERT INTO meetings (id, user_id, title, date, transcript) VALUES ('b-1', 'uB', 'needle', '2026-11-08', 'the rare one')").run();

  const rows = kb.search('uB', { q: 'needle', limit: 5 });
  assert.equal(rows.length, 1, 'uB sees only their own hit');
  assert.equal(rows[0].meetingId, 'b-1');
  assert.deepEqual(kb.search('uA', { q: 'needle', limit: 3 }).map((r) => r.meetingId).sort(), ['a-0', 'a-1', 'a-2']);
});
