// Caption validation invariants — mirrors docs/explanation/invariants.md checklist.
//
// Run: npm test -- tests/caption-validation.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_ICON_RE,
  isActiveMeetingPage,
  isValidCaption,
  sanitizeSpeaker,
} from '../src/content/caption-validation.ts';

test('sanitizeSpeaker strips combined-speaker suffixes and normalizes whitespace', () => {
  assert.equal(sanitizeSpeaker('Tanaka & 2 others'), 'Tanaka');
  assert.equal(sanitizeSpeaker('山田 他2名'), '山田');
  assert.equal(sanitizeSpeaker('  Bob  '), 'Bob');
});

test('GROUP_ICON_RE strips groups prefix before sanitizeSpeaker (Meet reader path)', () => {
  const raw = 'groups Alice';
  assert.equal(raw.replace(GROUP_ICON_RE, ''), 'Alice');
  assert.equal(sanitizeSpeaker(raw), 'groups Alice');
});

test('sanitizeSpeaker caps length at 50 chars', () => {
  const long = 'A'.repeat(80);
  assert.equal(sanitizeSpeaker(long).length, 50);
});

test('isValidCaption accepts short Japanese captions', () => {
  assert.equal(isValidCaption('田中', 'はい。'), true);
});

test('isValidCaption rejects UI toolbar text as speaker', () => {
  assert.equal(isValidCaption('closed_caption', 'hello'), false);
  assert.equal(isValidCaption('Alice', 'Turn off captions'), false);
});

test('isValidCaption rejects meeting IDs and clocks as speaker', () => {
  assert.equal(isValidCaption('abc-defg-hij', 'hello'), false);
  assert.equal(isValidCaption('10:30', 'hello'), false);
});

test('isValidCaption rejects icon-only text blocks', () => {
  assert.equal(isValidCaption('Alice', 'chevron_right chevron_right'), false);
});

test('isValidCaption rejects empty and overlong text', () => {
  assert.equal(isValidCaption('Alice', ''), false);
  assert.equal(isValidCaption('Alice', 'x'.repeat(2001)), false);
});

test('GROUP_ICON_RE strips groups prefix only at start', () => {
  assert.equal('groups Alice'.replace(GROUP_ICON_RE, ''), 'Alice');
});

test('isActiveMeetingPage guards Meet landing pages', () => {
  assert.equal(isActiveMeetingPage('meet', '/abc-defg-hij'), true);
  assert.equal(isActiveMeetingPage('meet', '/lookup/foo'), true);
  assert.equal(isActiveMeetingPage('meet', '/landing'), false);
  assert.equal(isActiveMeetingPage('meet', '/'), false);
  assert.equal(isActiveMeetingPage('teams', '/landing'), true);
  assert.equal(isActiveMeetingPage(null, '/anything'), true);
});
