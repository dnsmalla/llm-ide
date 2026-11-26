import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tourReducer, currentStep, isLastStep } from '../src/sidepanel/help/tour-model.ts';

const flow = {
  id: 'demo',
  title: 'Demo tour',
  steps: [
    { id: 'a', title: 'A', body: 'first' },
    { id: 'b', title: 'B', body: 'second' },
  ],
};

test('start sets the flow at step 0', () => {
  const s = tourReducer(null, { type: 'start', flow });
  assert.equal(s.flow, flow);
  assert.equal(s.index, 0);
});

test('next advances and clamps at the last step', () => {
  let s = tourReducer(null, { type: 'start', flow });
  s = tourReducer(s, { type: 'next' });
  s = tourReducer(s, { type: 'next' });
  s = tourReducer(s, { type: 'next' });
  assert.equal(s.index, 1, 'clamped at the last step, not past it');
});

test('back retreats and clamps at the first step', () => {
  let s = tourReducer(null, { type: 'start', flow });
  s = tourReducer(s, { type: 'back' });
  assert.equal(s.index, 0);
});

test('skip ends the tour from any state, and is a no-op from null', () => {
  let s = tourReducer(null, { type: 'start', flow });
  assert.equal(tourReducer(s, { type: 'skip' }), null);
  assert.equal(tourReducer(null, { type: 'skip' }), null);
});

test('currentStep and isLastStep read the active step', () => {
  assert.equal(currentStep(null), null);
  assert.equal(isLastStep(null), false);
  let s = tourReducer(null, { type: 'start', flow });
  assert.equal(currentStep(s), flow.steps[0]);
  s = tourReducer(s, { type: 'next' });
  assert.equal(isLastStep(s), true);
});
