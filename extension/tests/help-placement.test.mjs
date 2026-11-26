import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCard } from '../src/sidepanel/help/placement.ts';

test('places the card below the target when there is room', () => {
  const rect = { top: 100, left: 20, right: 220, bottom: 140, width: 200, height: 40 };
  const p = placeCard(rect, { width: 240, height: 120 }, 320, 800);
  assert.equal(p.side, 'below');
  assert.ok(p.top > rect.bottom);
});

test('flips above when there is no room below', () => {
  const rect = { top: 700, left: 20, right: 220, bottom: 740, width: 200, height: 40 };
  const p = placeCard(rect, { width: 240, height: 120 }, 320, 800);
  assert.equal(p.side, 'above');
  assert.ok(p.top + 120 <= rect.top);
});

test('clamps horizontally inside the panel width', () => {
  const rect = { top: 100, left: 280, right: 340, bottom: 140, width: 60, height: 40 };
  const p = placeCard(rect, { width: 240, height: 120 }, 320, 800);
  assert.ok(p.left >= 0);
  assert.ok(p.left + 240 <= 320);
});
