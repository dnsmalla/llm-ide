import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORD_NOTES_TOUR } from '../src/sidepanel/help/tours.ts';
import { TABS } from '../src/sidepanel/tabs.ts';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

function tsxFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

test('the record-notes tour has at least two steps, each with a targetId and a real tab', () => {
  const tabIds = new Set(TABS.map((t) => t.id));
  assert.ok(RECORD_NOTES_TOUR.steps.length >= 2);
  for (const step of RECORD_NOTES_TOUR.steps) {
    assert.ok(step.targetId, `${step.id} needs a targetId`);
    if (step.screenId) assert.ok(tabIds.has(step.screenId), `${step.id}: unknown tab ${step.screenId}`);
  }
});

test("every step's targetId matches a data-tour-id that exists in the JSX", () => {
  const live = new Set();
  for (const file of tsxFiles(SRC_DIR)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/data-tour-id="([^"]+)"/g)) live.add(m[1]);
  }
  for (const step of RECORD_NOTES_TOUR.steps) {
    assert.ok(live.has(step.targetId), `${step.id}: targetId "${step.targetId}" matches no data-tour-id in the JSX`);
  }
});

test('the tour starts on recording and ends on the generated result', () => {
  assert.equal(RECORD_NOTES_TOUR.steps[0].targetId, 'start-recording');
  assert.equal(RECORD_NOTES_TOUR.steps[RECORD_NOTES_TOUR.steps.length - 1].targetId, 'notes-result');
});
