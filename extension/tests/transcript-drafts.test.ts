// Crash-safe transcript drafts (src/lib/storage.ts).
//
// Regression (2026-09 review): the side panel saved a transcript only on
// Stop, so closing the panel / a crash / quitting the browser mid-meeting
// lost the whole recording. useTranscript now checkpoints a per-session
// draft while recording; the next panel to open recovers abandoned drafts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, unknown>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(keys: string | null) {
        if (keys === null) return Object.fromEntries(store);
        return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
      },
      async remove(key: string) {
        store.delete(key);
      },
    },
  },
};

const { saveTranscript, saveTranscriptDraft, clearTranscriptDraft, recoverTranscriptDrafts, DRAFT_STALE_MS } =
  await import('../src/lib/storage.ts');

const T0 = 1_800_000_000_000;
function session(id: string, text = 'hello') {
  return {
    id,
    meetingTitle: 'Standup',
    date: new Date(T0).toISOString(),
    duration: 60,
    language: 'ja',
    transcript: `[A] ${text}`,
    segments: [{ text, timestamp: T0, isFinal: true, speaker: 'A' }],
    speakerNames: {},
  };
}
const saved = () => (store.get('transcripts') as { id: string; transcript: string }[] | undefined) ?? [];

beforeEach(() => store.clear());

test('an abandoned draft is recovered into the saved list and removed', async () => {
  await saveTranscriptDraft(session('s1', '議事録'), T0);
  const recovered = await recoverTranscriptDrafts(T0 + DRAFT_STALE_MS + 1);
  assert.deepEqual(
    recovered.map((r) => r.id),
    ['s1'],
  );
  assert.deepEqual(
    saved().map((t) => t.transcript),
    ['[A] 議事録'],
  );
  assert.equal(store.has('transcriptDraft:s1'), false);
});

test('a draft a live panel is still writing is left alone', async () => {
  await saveTranscriptDraft(session('live'), T0);
  assert.deepEqual(await recoverTranscriptDrafts(T0 + DRAFT_STALE_MS - 1), []);
  assert.equal(store.has('transcriptDraft:live'), true);
  assert.deepEqual(saved(), []);
});

test('a session whose final save landed but whose draft was not cleared is not duplicated', async () => {
  await saveTranscript(session('s2', 'final'));
  await saveTranscriptDraft(session('s2', 'final'), T0);
  await recoverTranscriptDrafts(T0 + DRAFT_STALE_MS + 1);
  assert.deepEqual(
    saved().map((t) => t.id),
    ['s2'],
  );
});

test('Stop path: save then clear leaves nothing to recover', async () => {
  await saveTranscriptDraft(session('s3'), T0);
  await saveTranscript(session('s3'));
  await clearTranscriptDraft('s3');
  assert.deepEqual(await recoverTranscriptDrafts(T0 + DRAFT_STALE_MS + 1), []);
  assert.equal(saved().length, 1);
});

test('an empty or malformed draft is discarded, not saved', async () => {
  store.set('transcriptDraft:empty', { ...session('empty'), segments: [], updatedAt: T0 });
  store.set('transcriptDraft:junk', 'not an object');
  assert.deepEqual(await recoverTranscriptDrafts(T0 + DRAFT_STALE_MS + 1), []);
  assert.equal(store.has('transcriptDraft:empty'), false);
  assert.equal(store.has('transcriptDraft:junk'), false);
  assert.deepEqual(saved(), []);
});

test('several abandoned drafts come back oldest first', async () => {
  await saveTranscriptDraft({ ...session('late'), date: new Date(T0 + 5000).toISOString() }, T0);
  await saveTranscriptDraft({ ...session('early'), date: new Date(T0).toISOString() }, T0);
  const recovered = await recoverTranscriptDrafts(T0 + DRAFT_STALE_MS + 1);
  assert.deepEqual(
    recovered.map((r) => r.id),
    ['early', 'late'],
  );
});

test('unrelated storage keys are untouched', async () => {
  store.set('primaryLang', 'ja');
  await recoverTranscriptDrafts(T0 + DRAFT_STALE_MS + 1);
  assert.equal(store.get('primaryLang'), 'ja');
});
