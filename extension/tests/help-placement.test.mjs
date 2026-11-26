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

test('keeps the card inside the panel when a tall scrolled target spans past the bottom', () => {
  const rect = { top: -1200, left: 20, right: 220, bottom: 590, width: 200, height: 1790 };
  const p = placeCard(rect, { width: 240, height: 120 }, 320, 600);
  assert.ok(p.top >= 8);
  assert.ok(p.top + 120 <= 600 - 8);
});

test('pins a card taller than the panel to the top margin', () => {
  const rect = { top: 100, left: 20, right: 220, bottom: 140, width: 200, height: 40 };
  const p = placeCard(rect, { width: 240, height: 900 }, 320, 600);
  assert.equal(p.top, 8);
});
