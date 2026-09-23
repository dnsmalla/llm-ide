// Caption validation invariants — mirrors docs/explanation/invariants.md checklist.
//
// Run: npm test -- tests/caption-validation.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_ICON_RE,
  isActiveMeetingPage,
  isHumanTranscriptSource,
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

test('isHumanTranscriptSource excludes agent commentary', () => {
  assert.equal(isHumanTranscriptSource('extension-cc'), true);
  assert.equal(isHumanTranscriptSource(undefined), true);
  assert.equal(isHumanTranscriptSource('agent-system'), false);
  assert.equal(isHumanTranscriptSource('agent-question'), false);
});

// Regression (2026-09 review): UI_PATTERNS was an unbounded `^(call|share|…)`
// prefix and ICON_PATTERN matched bare words like `chat` anywhere, so real
// speech and names were silently dropped from transcripts.
test('isValidCaption keeps speakers whose names start with a UI word', () => {
  for (const name of ['Callum Smith', 'Moreno', 'Hostetler', 'Sharon', 'Leavitt', 'Opal', 'Chatterjee', 'Micah']) {
    assert.equal(isValidCaption(name, 'Hello everyone.'), true, name);
  }
});

test('isValidCaption keeps real speech that starts with or contains a UI word', () => {
  for (const text of [
    'Share your screen, please.',
    'Call me later.',
    'Meeting moved to Friday.',
    'More or less, yes.',
    'Video looks good now.',
    'Open the PR when you are ready.',
    "Let's chat about it tomorrow.",
    'Can you raise that with the team?',
    'Moreover the build is green',
    'Meetings on Mondays are too long for everyone here',
    'I will turn off my camera for a bit.',
    'More info is in the doc.',
  ]) {
    assert.equal(isValidCaption('Alice', text), true, text);
  }
});

test('isValidCaption still rejects every UI label from the invariants table', () => {
  for (const text of [
    'Turn off microphone',
    'Turn on captions',
    'Open caption settings',
    'Live captions',
    'Font size',
    'Reframe',
    'Backgrounds and effects',
    'Portrait',
    'Blur',
    'Dial-in',
    'PIN: 123 456',
    "Your meeting's ready",
    'close Close',
    'More options',
    'Share screen',
    'Leave call',
    'Raise hand',
    'chat',
    'mic',
    'Settings',
    'Connect, collaborate, and celebrate from anywhere with Google Meet.',
    'Tap to open more_vert settings.',
  ]) {
    assert.equal(isValidCaption('Alice', text), false, text);
  }
  for (const speaker of ['Present now', 'Meeting details', 'Chat', 'People', 'frame_person', 'ume-xkgs-oqf']) {
    assert.equal(isValidCaption(speaker, 'Hello everyone.'), false, speaker);
  }
});
