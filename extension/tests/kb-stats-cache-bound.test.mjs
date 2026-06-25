// The per-user stats() cache must be a HARD ceiling, not a soft one.
//
// Regression for the burst case the original "bound the cache" commit missed:
// the eviction loop only dropped *expired* entries before inserting, so a
// burst of >MAX distinct users within the 2s TTL window left nothing to sweep
// and the map grew past its cap. This pins that the cap holds even when every
// cached entry is still live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-stats-cache-test.db');
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.LLMIDE_DB_PATH = tmpDb;

await import('../kb/db.mjs'); // initialise schema on the temp DB
const { stats, _statsCacheStateForTests } = await import('../kb/meetings.mjs');

test('stats() cache never exceeds its cap, even under a same-window burst', () => {
  const { max } = _statsCacheStateForTests();
  // requireUser only validates the id shape, so synthetic users compute zeros
  // against the empty DB — no seeding needed. Fire 2x the cap back-to-back so
  // none of them can expire (TTL is 2s; this loop is sub-second).
  for (let i = 0; i < max * 2; i++) stats(`burst-user-${i}`);

  const { size } = _statsCacheStateForTests();
  assert.ok(
    size <= max,
    `cache size ${size} exceeded cap ${max} — bound is soft, not a ceiling`,
  );
});

test('cache cleanup', () => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});
