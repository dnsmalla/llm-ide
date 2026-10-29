// Capture drafts are released only on the Mac's ack (live-then-archive T5.2),
// the legacy `transcripts` copy to the Mac is verified and resumable, and the
// extension stores no chat. Pure logic: no browser, no server.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveTranscriptDraft,
  setDraftStage,
  getDraftStage,
  recordFinalize,
  reconcileDrafts,
  resendDraft,
  listDrafts,
  importLegacyTranscript,
  importLegacyTranscripts,
  legacyCaptureId,
  readLegacyTranscripts,
  DRAFT_STALE_MS,
  MAX_NO_ACK_DRAFTS,
  type LiveApi,
  type LiveState,
  type StorageArea,
  type StatusResult,
  type LegacyTranscript,
} from '../src/lib/capture-store.ts';

const T0 = 1_800_000_000_000;

function fakeArea(opts: { failSet?: () => boolean } = {}) {
  const store = new Map<string, unknown>();
  const area: StorageArea = {
    async get(keys) {
      if (keys == null) return Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)]));
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
    },
    async set(items) {
      if (opts.failSet?.()) throw new Error('QUOTA_BYTES quota exceeded');
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
  return { store, area };
}

interface FakeServer {
  api: LiveApi;
  calls: string[];
  states: Map<string, LiveState>;
  captions: Map<string, number>;
  reachable: boolean;
  ackRequired: boolean;
  /** when set, finalize reports this captionCount instead of the held count */
  finalizeCount?: number;
  /** server-side dedupe like the real one: drop in-batch repeats */
  dedupe: boolean;
}

function fakeServer(over: Partial<FakeServer> = {}): FakeServer {
  const srv: FakeServer = {
    calls: [],
    states: new Map(),
    captions: new Map(),
    reachable: true,
    ackRequired: true,
    dedupe: true,
    ...over,
    api: undefined as unknown as LiveApi,
  };
  srv.api = {
    async status(id): Promise<StatusResult> {
      srv.calls.push(`status:${id}`);
      if (!srv.reachable) return { ok: false };
      return { ok: true, state: srv.states.get(id) ?? 'unknown', durable: true };
    },
    async append(id, _t, caps) {
      srv.calls.push(`append:${id}`);
      if (!srv.reachable) return { ok: false, accepted: 0, finalized: false };
      const seen = new Set<string>();
      for (const c of caps) seen.add(`${c.speaker}\0${c.text.replace(/\s+/g, ' ').trim()}`);
      const n = srv.dedupe ? seen.size : caps.length;
      srv.captions.set(id, n);
      srv.states.set(id, 'live');
      return { ok: true, accepted: n, finalized: false };
    },
    async finalize(id) {
      srv.calls.push(`finalize:${id}`);
      if (!srv.reachable) return { ok: false, ackRequired: false, captionCount: 0, durable: false };
      const held = srv.captions.get(id) ?? 0;
      if (held > 0) srv.states.set(id, 'finalized');
      return { ok: true, ackRequired: srv.ackRequired && held > 0, captionCount: srv.finalizeCount ?? held, durable: true };
    },
  };
  return srv;
}

function draft(id: string, n = 2, title = 'Standup') {
  const segments = Array.from({ length: n }, (_, i) => ({
    text: `line ${i}`,
    timestamp: T0 + i,
    isFinal: true,
    speaker: 'A',
  }));
  return {
    id,
    meetingTitle: title,
    date: new Date(T0).toISOString(),
    duration: 60,
    language: 'ja',
    transcript: segments.map((s) => `[A] ${s.text}`).join('\n'),
    segments,
    speakerNames: {},
  };
}

let fx = fakeArea();
beforeEach(() => {
  fx = fakeArea();
});

// ─── Drafts ───────────────────────────────────────────────────────────

test('draft is kept while the server has not acked (finalized, waiting)', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('d1'), T0);
  await setDraftStage(fx.area, 'd1', 'awaiting-ack');
  srv.states.set('d1', 'finalized');
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + 5000 });
  assert.equal(r[0].outcome, 'waiting');
  assert.ok(fx.store.has('transcriptDraft:d1'));
});

test('draft is kept when the status is unreachable, however often we ask', async () => {
  const srv = fakeServer({ reachable: false });
  await saveTranscriptDraft(fx.area, draft('d2'), T0);
  await setDraftStage(fx.area, 'd2', 'awaiting-ack');
  for (let i = 0; i < 3; i += 1) {
    const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + 10_000 });
    assert.equal(r[0].outcome, 'unreachable');
  }
  assert.ok(fx.store.has('transcriptDraft:d2'));
  assert.ok(!srv.calls.some((c) => c.startsWith('append') || c.startsWith('finalize')));
});

test('a throwing status call keeps the draft', async () => {
  const srv = fakeServer();
  srv.api.status = async () => {
    throw new Error('boom');
  };
  await saveTranscriptDraft(fx.area, draft('d3'), T0);
  await setDraftStage(fx.area, 'd3', 'awaiting-ack');
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 });
  assert.equal(r[0].outcome, 'unreachable');
  assert.ok(fx.store.has('transcriptDraft:d3'));
});

test('draft is deleted only after acked, and a late checkpoint cannot resurrect it', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('d4'), T0);
  await setDraftStage(fx.area, 'd4', 'awaiting-ack');
  srv.states.set('d4', 'acked');
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + 1 });
  assert.equal(r[0].outcome, 'released');
  assert.ok(!fx.store.has('transcriptDraft:d4'));
  await saveTranscriptDraft(fx.area, draft('d4'), T0 + 2); // late write from a closing panel
  assert.ok(!fx.store.has('transcriptDraft:d4'));
});

test('an ack for an id this panel never finalized is not trusted (id reuse)', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('d5'), T0);
  srv.states.set('d5', 'acked');
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS + 1 });
  assert.equal(r[0].outcome, 'not-confirmed');
  assert.ok(fx.store.has('transcriptDraft:d5'));
});

test('expired, unknown after awaiting-ack, and non-durable all keep the draft', async () => {
  const srv = fakeServer();
  for (const [id, state] of [['e1', 'expired'], ['e2', 'unknown']] as const) {
    await saveTranscriptDraft(fx.area, draft(id), T0);
    await setDraftStage(fx.area, id, 'awaiting-ack');
    srv.states.set(id, state);
  }
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + 1 });
  assert.deepEqual(r.map((x) => x.outcome), ['not-confirmed', 'not-confirmed']);
  assert.equal((await listDrafts(fx.area)).length, 2);
  assert.ok(!srv.calls.some((c) => c.startsWith('append')), 'never auto-resends an awaiting capture');
});

test('flag off (no ackRequired): the draft is retained and never deleted or polled', async () => {
  const srv = fakeServer({ ackRequired: false });
  await saveTranscriptDraft(fx.area, draft('f1'), T0);
  srv.captions.set('f1', 2);
  const f = await srv.api.finalize('f1');
  await recordFinalize(fx.area, 'f1', f);
  assert.equal(await getDraftStage(fx.area, 'f1'), 'no-ack');
  srv.calls.length = 0;
  srv.states.set('f1', 'acked'); // even a surprising ack answer is not consulted
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS * 100 });
  assert.equal(r[0].outcome, 'retained');
  assert.ok(fx.store.has('transcriptDraft:f1'));
  assert.deepEqual(srv.calls, []);
});

test('flag-off copies are capped, oldest first', async () => {
  const srv = fakeServer();
  for (let i = 0; i < MAX_NO_ACK_DRAFTS + 3; i += 1) {
    await saveTranscriptDraft(fx.area, draft(`n${i}`), T0 + i);
    await setDraftStage(fx.area, `n${i}`, 'no-ack');
  }
  await reconcileDrafts(fx.area, srv.api, { now: T0 + 1000 });
  const left = (await listDrafts(fx.area)).map((e) => e.draft.id);
  assert.equal(left.length, MAX_NO_ACK_DRAFTS);
  assert.ok(!left.includes('n0') && left.includes(`n${MAX_NO_ACK_DRAFTS + 2}`));
});

test('finalize that captured nothing leaves the draft finalizing (so it is re-sent, not parked)', async () => {
  await saveTranscriptDraft(fx.area, draft('z1'), T0);
  await setDraftStage(fx.area, 'z1', 'finalizing');
  await recordFinalize(fx.area, 'z1', { ok: true, ackRequired: false, captionCount: 0, durable: false });
  assert.equal(await getDraftStage(fx.area, 'z1'), 'finalizing');
  await recordFinalize(fx.area, 'z1', { ok: false, ackRequired: true, captionCount: 5, durable: true });
  assert.equal(await getDraftStage(fx.area, 'z1'), 'finalizing');
});

test('stage never moves backwards (two panels, late writes)', async () => {
  await setDraftStage(fx.area, 'm1', 'awaiting-ack');
  await setDraftStage(fx.area, 'm1', 'finalizing');
  await setDraftStage(fx.area, 'm1', 'recording');
  assert.equal(await getDraftStage(fx.area, 'm1'), 'awaiting-ack');
  await setDraftStage(fx.area, 'm1', 'no-ack'); // same rank, first decision wins
  assert.equal(await getDraftStage(fx.area, 'm1'), 'awaiting-ack');
});

test('a live panel\'s draft and an actively recording id are left alone', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('r1'), T0);
  await saveTranscriptDraft(fx.area, draft('r2'), T0 - DRAFT_STALE_MS * 2);
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + 1, activeIds: new Set(['r2']) });
  assert.deepEqual(r.map((x) => x.outcome), ['active', 'active']);
  assert.deepEqual(srv.calls, []);
});

test('crash recovery: a stale unfinalized draft is re-pushed once and finalized, then waits for the ack', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('c1', 3), T0);
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS + 1 });
  assert.equal(r[0].outcome, 'resent');
  assert.equal(await getDraftStage(fx.area, 'c1'), 'awaiting-ack');
  assert.ok(fx.store.has('transcriptDraft:c1'), 'still kept until acked');
  assert.equal(srv.calls.filter((c) => c.startsWith('append')).length, 1);
  // second pass (another panel / next poll) does not push again
  const r2 = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS + 2 });
  assert.equal(r2[0].outcome, 'waiting');
  assert.equal(srv.calls.filter((c) => c.startsWith('append')).length, 1);
  srv.states.set('c1', 'acked');
  const r3 = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS + 3 });
  assert.equal(r3[0].outcome, 'released');
});

test('server restart between finalize and ack (non-durable): kept, and a manual resend repairs it', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('s1'), T0);
  await setDraftStage(fx.area, 's1', 'awaiting-ack');
  srv.states.clear(); // restarted: unknown
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + 1 });
  assert.equal(r[0].outcome, 'not-confirmed');
  const [entry] = await listDrafts(fx.area);
  assert.equal(await resendDraft(fx.area, srv.api, entry), true);
  assert.equal(srv.states.get('s1'), 'finalized');
  assert.ok(fx.store.has('transcriptDraft:s1'));
});

test('resend into a live server session only finalizes (no duplicate lines)', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('l1', 4), T0);
  srv.states.set('l1', 'live');
  srv.captions.set('l1', 3);
  const [entry] = await listDrafts(fx.area);
  await resendDraft(fx.area, srv.api, entry);
  assert.ok(!srv.calls.includes('append:l1'));
  assert.ok(srv.calls.includes('finalize:l1'));
});

test('a quota error while releasing keeps the draft', async () => {
  let fail = false;
  const f = fakeArea({ failSet: () => fail });
  const srv = fakeServer();
  await saveTranscriptDraft(f.area, draft('q1'), T0);
  await setDraftStage(f.area, 'q1', 'awaiting-ack');
  srv.states.set('q1', 'acked');
  fail = true;
  const r = await reconcileDrafts(f.area, srv.api, { now: T0 });
  assert.notEqual(r[0].outcome, 'released');
  assert.ok(f.store.has('transcriptDraft:q1'));
});

test('a draft write over quota rejects (callers surface it) and leaves the old draft', async () => {
  let fail = false;
  const f = fakeArea({ failSet: () => fail });
  await saveTranscriptDraft(f.area, draft('w1', 1), T0);
  fail = true;
  await assert.rejects(saveTranscriptDraft(f.area, draft('w1', 5), T0 + 1));
  assert.equal((await listDrafts(f.area))[0].draft.segments.length, 1);
});

// ─── Legacy import ────────────────────────────────────────────────────

function legacy(id: string, n = 3, text = (i: number) => `line ${i}`): LegacyTranscript {
  const segments = Array.from({ length: n }, (_, i) => ({ text: text(i), timestamp: T0 + i, isFinal: true, speaker: 'A' }));
  return {
    id,
    meetingTitle: `M ${id}`,
    date: new Date(T0).toISOString(),
    duration: 10,
    transcript: segments.map((s) => `[A] ${s.text}`).join('\n'),
    segments,
    speakerNames: {},
  };
}
const seedLegacy = (list: LegacyTranscript[]) => fx.store.set('transcripts', structuredClone(list));
const legacyIds = () => ((fx.store.get('transcripts') as { id: string }[] | undefined) ?? []).map((t) => t.id);
const noSleep = async () => {};
const opts = { polls: 2, sleep: noSleep };

test('legacy: read-only view never writes', async () => {
  seedLegacy([legacy('a'), legacy('b')]);
  const before = JSON.stringify([...fx.store]);
  assert.equal((await readLegacyTranscripts(fx.area)).length, 2);
  assert.equal(JSON.stringify([...fx.store]), before);
});

test('legacy: local copy deleted only after the Mac acks', async () => {
  const srv = fakeServer();
  const t = legacy('a');
  seedLegacy([t, legacy('b')]);
  const id = await legacyCaptureId(t);
  // Not acked yet: stays, reports waiting.
  const r1 = await importLegacyTranscript(fx.area, srv.api, t, opts);
  assert.equal(r1.outcome, 'waiting');
  assert.deepEqual(legacyIds(), ['a', 'b']);
  // Mac acks later; re-running (resume) deletes exactly that item and sends nothing new.
  srv.calls.length = 0;
  srv.states.set(id, 'acked');
  const r2 = await importLegacyTranscript(fx.area, srv.api, t, opts);
  assert.equal(r2.outcome, 'copied');
  assert.deepEqual(legacyIds(), ['b']);
  assert.ok(!srv.calls.some((c) => c.startsWith('append') || c.startsWith('finalize')));
});

test('legacy: running twice (double click / two tabs) sends once', async () => {
  const srv = fakeServer();
  const t = legacy('a');
  seedLegacy([t]);
  await importLegacyTranscript(fx.area, srv.api, t, opts);
  await importLegacyTranscript(fx.area, srv.api, t, opts);
  assert.equal(srv.calls.filter((c) => c.startsWith('append')).length, 1);
  assert.equal(srv.calls.filter((c) => c.startsWith('finalize')).length, 1);
  assert.deepEqual(legacyIds(), ['a']);
});

test('legacy: the single-flight lock reports busy and does nothing', async () => {
  const srv = fakeServer();
  const t = legacy('a');
  seedLegacy([t]);
  const r = await importLegacyTranscript(fx.area, srv.api, t, { ...opts, withLock: async () => null });
  assert.equal(r.outcome, 'busy');
  assert.deepEqual(srv.calls, []);
});

test('legacy: server unreachable deletes nothing and stops the batch', async () => {
  const srv = fakeServer({ reachable: false });
  seedLegacy([legacy('a'), legacy('b')]);
  const items = await readLegacyTranscripts(fx.area);
  const rs = await importLegacyTranscripts(fx.area, srv.api, items, opts);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].outcome, 'unreachable');
  assert.deepEqual(legacyIds(), ['a', 'b']);
});

test('legacy: flag off (no ack protocol) deletes nothing', async () => {
  const srv = fakeServer({ ackRequired: false });
  seedLegacy([legacy('a')]);
  const r = await importLegacyTranscript(fx.area, srv.api, legacy('a'), opts);
  assert.equal(r.outcome, 'no-ack-protocol');
  assert.deepEqual(legacyIds(), ['a']);
});

test('legacy: a server that holds a different line count deletes nothing', async () => {
  const srv = fakeServer({ finalizeCount: 1 });
  seedLegacy([legacy('a')]);
  const r = await importLegacyTranscript(fx.area, srv.api, legacy('a'), opts);
  assert.equal(r.outcome, 'mismatch');
  assert.deepEqual(legacyIds(), ['a']);
});

test('legacy: an acked capture with merged repeat lines keeps the local copy', async () => {
  const srv = fakeServer();
  const t = legacy('a', 4, (i) => (i % 2 ? 'Yes.' : 'Yes.'));
  seedLegacy([t]);
  const id = await legacyCaptureId(t);
  await importLegacyTranscript(fx.area, srv.api, t, opts);
  srv.states.set(id, 'acked');
  const r = await importLegacyTranscript(fx.area, srv.api, t, opts);
  assert.equal(r.outcome, 'kept-merged');
  assert.deepEqual(legacyIds(), ['a']);
});

test('legacy: a capture over the server buffer is skipped, never sent', async () => {
  const srv = fakeServer();
  const t = legacy('big', 2100, (i) => `unique line ${i}`);
  seedLegacy([t]);
  const r = await importLegacyTranscript(fx.area, srv.api, t, opts);
  assert.equal(r.outcome, 'skipped-large');
  assert.deepEqual(srv.calls, []);
  assert.deepEqual(legacyIds(), ['big']);
});

test('legacy: capture id is content-addressed, so an ack for different content with the same id is not trusted', async () => {
  const srv = fakeServer();
  const original = legacy('same');
  const other = { ...legacy('same'), transcript: '[A] totally different', segments: [{ text: 'different', timestamp: T0, isFinal: true, speaker: 'A' }] };
  assert.notEqual(await legacyCaptureId(original), await legacyCaptureId(other));
  seedLegacy([other]);
  srv.states.set(await legacyCaptureId(original), 'acked'); // ack belongs to the OTHER content
  const r = await importLegacyTranscript(fx.area, srv.api, other, opts);
  assert.notEqual(r.outcome, 'copied');
  assert.deepEqual(legacyIds(), ['same']);
});

test('legacy: crash mid-copy (append done, never finalized) resumes with a finalize, no second append', async () => {
  const srv = fakeServer();
  const t = legacy('a');
  seedLegacy([t]);
  const id = await legacyCaptureId(t);
  await srv.api.append(id, 'x', [
    { speaker: 'A', text: 'line 0', ts: 1, source: 's' },
    { speaker: 'A', text: 'line 1', ts: 2, source: 's' },
    { speaker: 'A', text: 'line 2', ts: 3, source: 's' },
  ]);
  srv.calls.length = 0;
  const r = await importLegacyTranscript(fx.area, srv.api, t, opts);
  assert.equal(r.outcome, 'waiting');
  assert.ok(!srv.calls.some((c) => c.startsWith('append')));
  assert.ok(srv.calls.some((c) => c.startsWith('finalize')));
  assert.deepEqual(legacyIds(), ['a']);
});

test('legacy: a failed local delete (quota) is reported and the item is not lost', async () => {
  let fail = false;
  const f = fakeArea({ failSet: () => fail });
  const srv = fakeServer();
  const t = legacy('a');
  f.store.set('transcripts', [structuredClone(t), structuredClone(legacy('b'))]);
  srv.states.set(await legacyCaptureId(t), 'acked');
  fail = true;
  const r = await importLegacyTranscript(f.area, srv.api, t, opts);
  assert.equal(r.outcome, 'error');
  assert.equal((f.store.get('transcripts') as unknown[]).length, 2);
});

test('legacy: the other items are untouched when one is copied', async () => {
  const srv = fakeServer();
  const a = legacy('a');
  seedLegacy([a, legacy('b'), legacy('c')]);
  srv.states.set(await legacyCaptureId(a), 'acked');
  await importLegacyTranscript(fx.area, srv.api, a, opts);
  assert.deepEqual(legacyIds(), ['b', 'c']);
});

test('a stale recording draft whose server session is still live is not finalized behind its panel', async () => {
  const srv = fakeServer();
  await saveTranscriptDraft(fx.area, draft('k1'), T0);
  srv.states.set('k1', 'live');
  const r = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS * 3 });
  assert.equal(r[0].outcome, 'active');
  assert.ok(!srv.calls.some((c) => c.startsWith('finalize') || c.startsWith('append')));
});

test('orphan stage markers older than a week are pruned, young ones are not', async () => {
  const srv = fakeServer();
  fx.store.set('draftStage:old', { stage: 'finalizing', at: T0 });
  fx.store.set('draftStage:new', { stage: 'finalizing', at: T0 + 8 * 24 * 3600 * 1000 });
  await reconcileDrafts(fx.area, srv.api, { now: T0 + 8 * 24 * 3600 * 1000 + 1 });
  assert.ok(!fx.store.has('draftStage:old'));
  assert.ok(fx.store.has('draftStage:new'));
});
