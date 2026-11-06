// scripts/plan-status.mjs: counting, dashboard drift check and --fix, plus a
// live check that the committed docs/superpowers/MASTER-PLAN.md is consistent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_FILE, checkDashboard, fixDashboard, fixOwnerLists, formatTable, itemTitle, ownerGroup, parseArgs, parseSections, renderOwnerLists, totals,
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

test('owner groups: you, partial work waiting on you, wait, and everything else to execute', () => {
  assert.equal(ownerGroup(' ', 'Decide X (you)'), 'you');
  assert.equal(ownerGroup('~', 'Built; open: your device check (me, you)'), 'you', 'built work that waits for your check');
  assert.equal(ownerGroup(' ', 'Build Y, then you check it (me, you)'), 'execute', 'not built yet: execution comes first');
  assert.equal(ownerGroup(' ', 'Two weeks of use (wait)'), 'wait');
  assert.equal(ownerGroup(' ', 'Untagged item'), 'execute');
  assert.equal(ownerGroup(' ', 'Earlier (you) then the owner (me)'), 'execute', 'the last tag decides');
  assert.equal(itemTitle('Sync SP5, own-server adapter: built (`abc`) (me)'), 'Sync SP5, own-server adapter');
  assert.equal(itemTitle('Phase 0 open: one Windows run (graph) (you)'), 'Phase 0 open: one Windows run');
});

test('owner lists are generated between markers, never as checkboxes, and --check sees drift', () => {
  const md = '# P\n\n## Status dashboard\n\n<!-- owner-lists:start -->\n<!-- owner-lists:end -->\n\n## S1. A\n\n- [ ] Build it (me)\n- [~] Built: check it (me, you)\n- [x] Done (me)\n';
  const fixed = fixOwnerLists(md);
  assert.match(fixed, /### To execute \(1\)[\s\S]*- \*\*A\*\*\n {2}- Build it/);
  assert.match(fixed, /### Needs you \(1\)[\s\S]*- ~ Built/);
  assert.equal(parseSections(fixed).find((x) => x.title === 'A').total, 3, 'the generated list adds no counted boxes');
  assert.equal(fixOwnerLists(fixed), fixed, 'stable');
  assert.ok(renderOwnerLists(fixed).startsWith('<!-- owner-lists:start -->'));
});
