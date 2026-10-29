// Shared setup for the provider catalog tests: env first, then a fresh temp DB
// and registered users. Import this module BEFORE anything from ../kb or ../server.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provcat-'));
const tmpDb = path.join(tmpDir, 'data.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const dbmod = await import('../kb/db.mjs');
const { closeAgentDb } = await import('../kb/agent-db.mjs');
const { config } = await import('../core/config.mjs');
const { registerUser } = await import('../server/users.mjs');

let n = 0;
/** Reset the temp DB and register `count` users. Returns { db, users: [id, ...] }. */
export function freshDb(count = 2) {
  dbmod.closeDb();
  closeAgentDb();
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ }
    try { fs.unlinkSync(config.agentDbPath + s); } catch { /* ok */ }
  }
  const db = dbmod.getDb();
  const users = [];
  for (let i = 0; i < count; i += 1) {
    n += 1;
    users.push(registerUser(db, { email: `u${n}-${process.pid}@ex.com`, password: 'pw-12345678' }).id);
  }
  return { db, users };
}

/** A fetch stand-in that records calls and answers from `handler(url, init)`. */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
