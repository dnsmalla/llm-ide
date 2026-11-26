import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_NOTES_TOUR } from '../src/sidepanel/help/tours.ts';
import { TABS } from '../src/sidepanel/tabs.ts';

test('the record-notes tour has at least two steps, each with a targetId and a real tab', () => {
  const tabIds = new Set(TABS.map((t) => t.id));
  assert.ok(RECORD_NOTES_TOUR.steps.length >= 2);
  for (const step of RECORD_NOTES_TOUR.steps) {
    assert.ok(step.targetId, `${step.id} needs a targetId`);
    if (step.screenId) assert.ok(tabIds.has(step.screenId), `${step.id}: unknown tab ${step.screenId}`);
  }
});

test('the tour starts on recording and ends on the generated result', () => {
  assert.equal(RECORD_NOTES_TOUR.steps[0].targetId, 'start-recording');
  assert.equal(RECORD_NOTES_TOUR.steps[RECORD_NOTES_TOUR.steps.length - 1].targetId, 'notes-result');
});
