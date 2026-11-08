// C5: a Host API device token is valid for at most 90 days from PAIRING, even if it stays active.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-dev-lifetime-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const kb = await import('../kb/db.mjs');
const devices = await import('../kb/host-api-devices.mjs');

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 3600 * 1000;

test('a device paired 91 days ago is refused and removed; 89 days is still valid', () => {
  const db = kb.getDb();
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u1','d@e.f','D','x','user','active')").run();
  const old = devices.issueDeviceToken('u1', 'Phone');
  // Active yesterday, but paired 91 days ago: the LIFETIME, not the idle window, is what expires it.
  db.prepare('UPDATE host_api_devices SET paired_at = ?, last_seen_at = ? WHERE device_id = ?')
    .run(Date.now() - 91 * DAY, Date.now() - DAY, old.deviceId);
  assert.equal(devices.authenticateDeviceToken(old.token), null, 'past 90 days the token is expired');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_api_devices WHERE device_id = ?').get(old.deviceId).n, 0, 'the row is gone');

  const fresh = devices.issueDeviceToken('u1', 'Phone 2');
  db.prepare('UPDATE host_api_devices SET paired_at = ? WHERE device_id = ?').run(Date.now() - 89 * DAY, fresh.deviceId);
  const ok = devices.authenticateDeviceToken(fresh.token);
  assert.equal(ok?.userId, 'u1', 'within 90 days it still works');
});
