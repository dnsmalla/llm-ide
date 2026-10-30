// scripts/plan-status.mjs: counting, dashboard drift check and --fix, plus a
// live check that the committed docs/superpowers/MASTER-PLAN.md is consistent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_FILE, checkDashboard, fixDashboard, formatTable, parseArgs, parseSections, totals,
} from '../../scripts/plan-status.mjs';

const SAMPLE = `# Plan

## Status dashboard

| Surface | Done | Partial | Not started | Total | State |
|---|---|---|---|---|---|
| Alpha | 1 | 1 | 1 | 3 | x |
| Beta | 0 | 0 | 1 | 1 | y |
| Total | 1 | 1 | 2 | 4 | |

## S1. Alpha

- [x] one
- [~] two
- [ ] three
\`\`\`
- [x] ignored in a fence
\`\`\`

## S2. Beta

- [ ] four
Text with - [x] not a list item.

## Notes

No boxes here.
`;

test('parseSections counts boxes per section and ignores fences and prose', () => {
  const s = parseSections(SAMPLE);
  assert.deepEqual(s.map((x) => [x.title, x.done, x.partial, x.todo, x.total]),
    [['Alpha', 1, 1, 1, 3], ['Beta', 0, 0, 1, 1]]);
  assert.deepEqual(totals(s), { title: 'Total', done: 1, partial: 1, todo: 2, total: 4 });
});

test('checkDashboard passes when numbers match', () => {
  assert.deepEqual(checkDashboard(SAMPLE), []);
});

test('checkDashboard reports drift, unknown rows and missing rows', () => {
  const drift = SAMPLE.replace('| Alpha | 1 | 1 | 1 | 3 |', '| Alpha | 2 | 0 | 1 | 3 |');
  assert.match(checkDashboard(drift)[0], /Alpha.*2\/0\/1\/3.*1\/1\/1\/3/);
  const unknown = SAMPLE.replace('| Beta |', '| Gamma |');
  const p = checkDashboard(unknown).join('\n');
  assert.match(p, /Gamma.*matches no checklist section/);
  assert.match(p, /Beta.*no dashboard row/);
});

test('fixDashboard makes a drifted dashboard consistent', () => {
  const drift = SAMPLE.replace('| Beta | 0 | 0 | 1 | 1 |', '| Beta | 9 | 9 | 9 | 9 |');
  assert.ok(checkDashboard(drift).length > 0);
  assert.deepEqual(checkDashboard(fixDashboard(drift)), []);
});

test('formatTable and parseArgs', () => {
  assert.match(formatTable(parseSections(SAMPLE)), /Total\s+1\s+1\s+2\s+4/);
  assert.deepEqual(parseArgs(['--json', '--check']).json, true);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('the committed MASTER-PLAN dashboard matches its checkboxes', () => {
  const md = fs.readFileSync(DEFAULT_FILE, 'utf8');
  assert.deepEqual(checkDashboard(md), []);
});
