// Guard for the "fixed date vs real clock" time bomb (see tests/README.md).
// extensions-index once failed when the real clock passed its hard-coded `now` + the 6 h TTL, because
// searchCatalog() derived freshness from Date.now() while the fixture was written at a fixed instant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

test('catalog freshness is computed from the injected clock', async () => {
  const src = fs.readFileSync(path.join(dir, '../llm_agent/extensions/indexes.mjs'), 'utf8');
  assert.match(src, /searchCatalog\(userId, \{[^}]*now = Date\.now\(\)/, 'searchCatalog takes an injectable now');
  assert.match(src, /sources: sourceStatuses\(now\)/, 'searchCatalog passes it to sourceStatuses');
});

test('extensions-index tests that read statuses pass their fixed clock', () => {
  const text = fs.readFileSync(path.join(dir, 'extensions-index.test.mjs'), 'utf8');
  assert.match(text, /Date\.parse\('20\d\d-/, 'this guard targets a fixed-clock test file');
  for (const [i, line] of text.split('\n').entries()) {
    if (/searchCatalog\(/.test(line) && /\.sources\b/.test(line) && /status/.test(line)) {
      assert.match(line, /now/, `line ${i + 1}: a fixed-clock test must pass \`now\` when it reads source freshness`);
    }
  }
});

test('the clock-shift preload moves Date.now() and new Date() but not explicit dates', async () => {
  const { spawnSync } = await import('node:child_process');
  const code = 'const a=Date.now(),b=new Date().getTime(),c=new Date("2026-01-01T00:00:00Z").getTime();console.log(JSON.stringify([a,b,c]))';
  const r = spawnSync(process.execPath, ['--import', path.join(dir, 'support/clock-shift.mjs'), '-e', code], {
    env: { ...process.env, LLMIDE_TEST_CLOCK_SHIFT_DAYS: '10', NODE_OPTIONS: '' }, encoding: 'utf8',
  });
  const [a, b, c] = JSON.parse(r.stdout);
  const ahead = 10 * 86_400_000;
  assert.ok(Math.abs(a - (Date.now() + ahead)) < 5000);
  assert.ok(Math.abs(b - a) < 5000);
  assert.equal(c, Date.parse('2026-01-01T00:00:00Z'));
});
