// scripts/user-needs.mjs: per-section counting, the Open count line check and
// --fix, plus a live check that the committed USER-NEEDS.md is consistent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_FILE, checkCount, fixCount, formatTable, parseArgs, parseSections, totals,
} from '../../scripts/user-needs.mjs';

const SAMPLE = `# Needs

Open count: 2 open, 1 done, 3 total

## A. Now

- [ ] **UN-001** one
  - How: \`- [ ] not an item\`
- [x] **UN-002** two

\`\`\`
- [ ] fenced, ignored
\`\`\`

## B. Later

- [ ] **UN-003** three

## Empty

nothing
`;

test('counts per section, ignores fences, sub-bullets and empty sections', () => {
  const s = parseSections(SAMPLE);
  assert.deepEqual(s.map((x) => [x.title, x.open, x.done]), [['A. Now', 1, 1], ['B. Later', 1, 0]]);
  assert.deepEqual(totals(s), { open: 2, done: 1, total: 3 });
  assert.match(formatTable(s), /Total\s+2\s+1\s+3/);
});

test('checkCount passes, detects drift and a missing line; fixCount repairs', () => {
  assert.equal(checkCount(SAMPLE).ok, true);
  const drift = SAMPLE.replace('2 open, 1 done', '5 open, 0 done');
  assert.equal(checkCount(drift).ok, false);
  assert.equal(checkCount(fixCount(drift)).ok, true);
  assert.equal(checkCount('# none\n- [ ] x\n').ok, false);
});

test('CLI --check exits 1 on drift, --fix repairs and then --check exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-needs-'));
  const file = path.join(dir, 'n.md');
  fs.writeFileSync(file, SAMPLE.replace('2 open', '9 open'));
  const script = path.resolve('..', 'scripts/user-needs.mjs');
  const run = (...a) => spawnSync(process.execPath, [script, '--file', file, ...a], { encoding: 'utf8' });
  assert.equal(run('--check').status, 1);
  assert.equal(run('--fix', '--check').status, 0);
  assert.equal(checkCount(fs.readFileSync(file, 'utf8')).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--nope']));
  assert.equal(parseArgs(['--check']).check, true);
});

test('committed USER-NEEDS.md has a correct Open count line', () => {
  const r = checkCount(fs.readFileSync(DEFAULT_FILE, 'utf8'));
  assert.equal(r.ok, true, r.message);
});
