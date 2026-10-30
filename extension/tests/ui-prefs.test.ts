import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuestionPrefs,
  serializeQuestionPrefs,
  purgeLegacyMeetingKeys,
  DEFAULT_QUESTION_TYPES,
} from '../src/lib/ui-prefs.ts';

test('serialize persists only the question types', () => {
  const raw = serializeQuestionPrefs(['explain']);
  assert.deepEqual(JSON.parse(raw), { types: ['explain'] });
});

test('an old blob with participant names parses to types only and is flagged dirty', () => {
  const r = parseQuestionPrefs(JSON.stringify({ participants: ['Alice', 'Bob'], types: ['confirm'] }));
  assert.deepEqual(r.types, ['confirm']);
  assert.equal(r.dirty, true);
});

test('clean, empty, invalid and corrupt blobs', () => {
  assert.deepEqual(parseQuestionPrefs(serializeQuestionPrefs(['conflict'])), { types: ['conflict'], dirty: false });
  assert.deepEqual(parseQuestionPrefs(null), { types: DEFAULT_QUESTION_TYPES, dirty: false });
  assert.deepEqual(parseQuestionPrefs('{"types":["bogus"]}').types, DEFAULT_QUESTION_TYPES);
  assert.equal(parseQuestionPrefs('{nope').dirty, true);
});

test('purge removes the legacy speakerNames key and never throws', async () => {
  const removed: string[][] = [];
  await purgeLegacyMeetingKeys({ remove: async (k) => void removed.push([k].flat()) });
  assert.deepEqual(removed, [['speakerNames']]);
  await purgeLegacyMeetingKeys({ remove: async () => { throw new Error('x'); } });
  await purgeLegacyMeetingKeys(undefined);
});
