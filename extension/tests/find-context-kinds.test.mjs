import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_find-context-kinds-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const U = users.registerUser(db.getDb(), {
  email: `fck-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'f',
}).id;
db.ingestSources(U, [{
  kind: 'code', ref: '/r/app/src/zebra.ts', chunkIdx: 0, title: 'src/zebra.ts:1-3',
  body: 'export function zebraStripes() {}', meta: { repo: '/r/app', relPath: 'src/zebra.ts' },
}]);

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('findContext returns the code slice by default', () => {
  assert.ok(db.findContext(U, 'zebraStripes', 5).code.length > 0);
});

test('findContext skips slices not in kinds', () => {
  const ctx = db.findContext(U, 'zebraStripes', 5, { kinds: ['meetings', 'tasks'] });
  assert.deepEqual(ctx.code, []);
  assert.deepEqual(ctx.tickets, []);
});
