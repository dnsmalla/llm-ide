// Capture drafts are released only when the server provably holds an identical
// copy that the Mac acked (live-then-archive T5.2 + review fixes). Pure logic over
// a fake chrome.storage and a fake server: no browser, no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  saveTranscriptDraft,
  setDraftStage,
  getDraftStage,
  stopCapture,
  reconcileDrafts,
  resendDraft,
  listDrafts,
  deleteDraft,
  expectedOf,
  toCaptions,
  importLegacyTranscript,
  importLegacyTranscripts,
  legacyCaptureId,
  readLegacyTranscripts,
  setDraftLock,
  memoryCaptureIds,
  _clearMemoryCapturesForTests,
  DRAFT_STALE_MS,
  MAX_RETAINED,
  type LiveApi,
  type LiveState,
  type StorageArea,
  type StatusResult,
  type FinalizePayload,
  type LegacyTranscript,
  type Draft,
} from '../src/lib/capture-store.ts';

const T0 = Date.UTC(2026, 9, 29, 3, 0, 0); // plausible capture start
const DAY = 24 * 3600 * 1000;

// ─── fakes ─────────────────────────────────────────────────────────────

function fakeArea(opts: { failSet?: (items: Record<string, unknown>) => boolean; delayMs?: number } = {}) {
  const store = new Map<string, unknown>();
  const wait = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const area: StorageArea = {
    async get(keys) {
      await wait();
      if (keys == null) return Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)]));
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
    },
    async set(items) {
      await wait();
      if (opts.failSet?.(items)) throw new Error('QUOTA_BYTES quota exceeded');
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(keys) {
      await wait();
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
  return { store, area };
}

type Cap = { speaker: string; text: string; ts: number };
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const hashOf = (list: Cap[]) =>
  createHash('sha256').update(list.map((c) => `${clean(c.speaker)}\0${clean(c.text)}`).join('\n'), 'utf8').digest('hex');

interface Held {
  lines: number;
  hash: string;
  language: string;
  startedAt: number | null;
}
class FakeServer {
  api: LiveApi;
  calls: string[] = [];
  states = new Map<string, LiveState>();
  held = new Map<string, Held>();
  /** the streamed (live) buffer per id, used when finalize has no payload */
  stream = new Map<string, Cap[]>();
  reachable = true;
  ackRequired = true;
  /** simulate an old/short server: transform what it keeps */
  mangle: ((list: Cap[]) => Cap[]) | null = null;
  /** simulate a server that does not store language/start */
  ignoreMeta = false;
  failFinalize = false;
  lastPayload: FinalizePayload | undefined;
  constructor() {
    this.api = {
      status: async (id): Promise<StatusResult> => {
        this.calls.push(`status:${id}`);
        if (!this.reachable) return { ok: false };
        const state = this.states.get(id) ?? 'unknown';
        const h = this.held.get(id);
        if (h && (state === 'finalized' || state === 'acked')) {
          return { ok: true, state, durable: true, lines: h.lines, captionHash: h.hash, language: h.language, startedAt: h.startedAt };
        }
        return { ok: true, state, durable: true };
      },
      finalize: async (id, payload) => {
        this.calls.push(`finalize:${id}${payload ? ':payload' : ':plain'}`);
        this.lastPayload = payload;
        if (!this.reachable || this.failFinalize) return { ok: false, ackRequired: false, captionCount: 0, durable: false };
        let list: Cap[] = payload ? payload.captions.filter((c) => clean(c.speaker) && clean(c.text)) : (this.stream.get(id) ?? []);
        if (this.mangle) list = this.mangle(list);
        const h: Held = {
          lines: list.length,
          hash: hashOf(list),
          language: this.ignoreMeta ? '' : (payload?.language ?? ''),
          startedAt: this.ignoreMeta ? null : (payload?.startedAt ?? (list.length ? Math.min(...list.map((c) => c.ts)) : null)),
        };
        this.held.set(id, h);
        if (list.length > 0) this.states.set(id, 'finalized');
        return { ok: true, ackRequired: this.ackRequired && list.length > 0, captionCount: list.length, captionHash: h.hash, durable: true };
      },
    };
  }
  ack(id: string) {
    this.states.set(id, 'acked');
  }
  count(prefix: string) {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

function draft(id: string, n = 3, over: Partial<Draft> = {}): Omit<Draft, 'updatedAt'> {
  const segments = Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, timestamp: T0 + i * 1000, isFinal: true, speaker: 'A' }));
  return {
    id,
    meetingTitle: 'Standup',
    date: new Date(T0).toISOString(),
    duration: 60,
    language: 'ja',
    transcript: segments.map((s) => `[A] ${s.text}`).join('\n'),
    segments,
    speakerNames: {},
    ...over,
  };
}

let fx = fakeArea();
beforeEach(() => {
  fx = fakeArea();
  _clearMemoryCapturesForTests();
  setDraftLock(null);
});

const stored = (id: string) => fx.store.has(`transcriptDraft:${id}`);
const NOW = T0 + 10 * 60_000;

// ─── release rules ────────────────────────────────────────────────────

test('Stop sends the complete transcript; the draft is kept until the Mac acks', async () => {
  const srv = new FakeServer();
  const r = await stopCapture(fx.area, srv.api, draft('d1', 5), NOW);
  assert.equal(r.send, 'sent');
  assert.equal(srv.lastPayload?.captions.length, 5);
  assert.equal(srv.lastPayload?.language, 'ja');
  assert.equal(srv.lastPayload?.startedAt, T0);
  assert.equal(srv.lastPayload?.durationSec, 60);
  assert.equal(await getDraftStage(fx.area, 'd1'), 'awaiting-ack');
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 });
  assert.equal(rep[0].outcome, 'waiting');
  assert.ok(stored('d1'));
});

test('released only after an ack of a verified-identical copy; a late checkpoint cannot resurrect it', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('d2', 5), NOW);
  srv.ack('d2');
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 });
  assert.equal(rep[0].outcome, 'released');
  assert.ok(!stored('d2'));
  await saveTranscriptDraft(fx.area, draft('d2', 5), NOW + 2000); // closing panel's late write
  assert.ok(!stored('d2'));
});

test('unreachable or throwing status keeps the draft, every time', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('u1'), NOW);
  srv.reachable = false;
  for (let i = 0; i < 3; i += 1) assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 }))[0].outcome, 'unreachable');
  srv.reachable = true;
  srv.api.status = async () => {
    throw new Error('boom');
  };
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 }))[0].outcome, 'unreachable');
  assert.ok(stored('u1'));
});

test('Scenario A: the server ends up with a SHORT copy (lost pushes): not released even after an ack', async () => {
  const srv = new FakeServer();
  srv.mangle = (l) => l.slice(0, 2); // only 2 of 5 lines survive
  const r = await stopCapture(fx.area, srv.api, draft('a1', 5), NOW);
  assert.equal(r.send, 'partial');
  assert.equal(await getDraftStage(fx.area, 'a1'), 'finalizing', 'never marked awaiting-ack');
  srv.ack('a1');
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000, autoResend: false });
  assert.equal(rep[0].outcome, 'partial-acked');
  assert.ok(stored('a1'));
});

test('Scenario B: more than 2000 lines is never sent as complete and never released', async () => {
  const srv = new FakeServer();
  const r = await stopCapture(fx.area, srv.api, draft('b1', 2100), NOW);
  assert.equal(r.send, 'too-large');
  assert.deepEqual(srv.calls.filter((c) => c.startsWith('finalize')), ['finalize:b1:plain']);
  srv.ack('b1'); // the Mac acked the truncated streamed copy
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 });
  assert.equal(rep[0].outcome, 'too-large');
  assert.ok(stored('b1'));
});

test('Scenario C: a server that merges repeated lines (old behaviour) holds a short copy: kept', async () => {
  const srv = new FakeServer();
  srv.mangle = (l) => {
    const seen = new Set<string>();
    return l.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)));
  };
  const same = draft('c1', 4, { segments: Array.from({ length: 4 }, (_, i) => ({ text: 'はい。', timestamp: T0 + i, isFinal: true, speaker: 'A' })) });
  const r = await stopCapture(fx.area, srv.api, same, NOW);
  assert.equal(r.send, 'partial');
  srv.ack('c1');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000, autoResend: false }))[0].outcome, 'partial-acked');
  assert.ok(stored('c1'));
});

test('repeated lines are kept by the lossless copy and the draft is released', async () => {
  const srv = new FakeServer();
  const same = draft('c2', 4, { segments: Array.from({ length: 4 }, (_, i) => ({ text: 'はい。', timestamp: T0 + i, isFinal: true, speaker: 'A' })) });
  assert.equal((await stopCapture(fx.area, srv.api, same, NOW)).send, 'sent');
  srv.ack('c2');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1 }))[0].outcome, 'released');
});

test('wrong-hash ack (same line count, different content) keeps the draft', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('h1', 3), NOW);
  const h = srv.held.get('h1')!;
  srv.held.set('h1', { ...h, hash: 'f'.repeat(64) });
  srv.ack('h1');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1, autoResend: false }))[0].outcome, 'partial-acked');
  assert.ok(stored('h1'));
});

test('a server that does not store language/start (old) keeps the draft', async () => {
  const srv = new FakeServer();
  srv.ignoreMeta = true;
  await stopCapture(fx.area, srv.api, draft('m1', 3), NOW);
  srv.ack('m1');
  assert.notEqual((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1, autoResend: false }))[0].outcome, 'released');
  assert.ok(stored('m1'));
});

test('an old status with no lines/hash (API < 86) never releases', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('o1', 3), NOW);
  srv.api.status = async () => ({ ok: true, state: 'acked', durable: false });
  assert.notEqual((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1, autoResend: false }))[0].outcome, 'released');
  assert.ok(stored('o1'));
});

test('a partial finalized copy is repaired by an automatic whole-draft re-send, then verified', async () => {
  const srv = new FakeServer();
  srv.mangle = (l) => l.slice(0, 1);
  await stopCapture(fx.area, srv.api, draft('p1', 4), NOW);
  srv.mangle = null; // the server is fine now
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 });
  assert.equal(rep[0].outcome, 'resent');
  assert.equal(await getDraftStage(fx.area, 'p1'), 'awaiting-ack');
  srv.ack('p1');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 2000 }))[0].outcome, 'released');
});

test('the automatic re-send backs off (no 15-second hammering of a server that stays short)', async () => {
  const srv = new FakeServer();
  srv.mangle = (l) => l.slice(0, 1);
  await stopCapture(fx.area, srv.api, draft('p2', 4), NOW);
  await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 });
  const before = srv.count('finalize');
  await reconcileDrafts(fx.area, srv.api, { now: NOW + 16_000 });
  assert.equal(srv.count('finalize'), before);
  assert.ok(stored('p2'));
});

test('server restarted between finalize and ack: kept, and a manual resend repairs it', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('r1', 3), NOW);
  srv.states.clear();
  srv.held.clear(); // restarted, non-durable
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1 }))[0].outcome, 'not-confirmed');
  const [entry] = await listDrafts(fx.area);
  assert.equal(await resendDraft(fx.area, srv.api, entry, { now: NOW + 2 }), 'sent');
  srv.ack('r1');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 3 }))[0].outcome, 'released');
});

test('resend refuses a stale recording draft whose id is acked (it must not be promoted)', async () => {
  const srv = new FakeServer();
  await saveTranscriptDraft(fx.area, draft('s1'), T0);
  srv.ack('s1');
  const [entry] = await listDrafts(fx.area);
  assert.equal(await resendDraft(fx.area, srv.api, entry, { now: T0 + DRAFT_STALE_MS * 2 }), 'refused');
  assert.equal(srv.count('finalize'), 0);
  assert.equal(await getDraftStage(fx.area, 's1'), null);
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS * 2 }))[0].outcome, 'not-confirmed');
  assert.ok(stored('s1'));
});

test('a stale recording draft whose server session is still live is never finalized behind its panel', async () => {
  const srv = new FakeServer();
  await saveTranscriptDraft(fx.area, draft('k1'), T0);
  srv.states.set('k1', 'live');
  const rep = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS * 3 });
  assert.equal(rep[0].outcome, 'active');
  assert.equal(srv.count('finalize'), 0);
});

test('crash recovery: a stale unfinalized draft is sent once, verified, released after the ack', async () => {
  const srv = new FakeServer();
  await saveTranscriptDraft(fx.area, draft('c9', 3), T0);
  const rep = await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS + 1 });
  assert.equal(rep[0].outcome, 'resent');
  assert.equal(srv.count('finalize'), 1);
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS + 2 }))[0].outcome, 'waiting');
  srv.ack('c9');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: T0 + DRAFT_STALE_MS + 3 }))[0].outcome, 'released');
});

test('speaker renames travel with the capture and are part of the verified hash', async () => {
  const srv = new FakeServer();
  const d = draft('n1', 2, { speakerNames: { A: 'Alice' } });
  await stopCapture(fx.area, srv.api, d, NOW);
  assert.ok(srv.lastPayload!.captions.every((c) => c.speaker === 'Alice'));
  const exp = await expectedOf(d);
  assert.equal(srv.held.get('n1')!.hash, exp.captionHash);
  srv.ack('n1');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 1 }))[0].outcome, 'released');
});

// ─── flag off, the cap, and "never drop" ──────────────────────────────

test('flag off: retained, never polled, never deleted', async () => {
  const srv = new FakeServer();
  srv.ackRequired = false;
  assert.equal((await stopCapture(fx.area, srv.api, draft('f1'), NOW)).send, 'sent');
  assert.equal(await getDraftStage(fx.area, 'f1'), 'no-ack');
  srv.calls.length = 0;
  srv.ack('f1');
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + DAY * 30 }))[0].outcome, 'retained');
  assert.ok(stored('f1'));
  assert.deepEqual(srv.calls, []);
});

test('the 51st retained draft: nothing is dropped, finalize is refused, the capture stays; deleting one unblocks', async () => {
  const srv = new FakeServer();
  srv.ackRequired = false;
  for (let i = 0; i < MAX_RETAINED; i += 1) {
    assert.equal((await stopCapture(fx.area, srv.api, draft(`n${i}`), NOW + i)).send, 'sent');
  }
  const finalizesBefore = srv.count('finalize');
  const r = await stopCapture(fx.area, srv.api, draft('n-extra'), NOW + 999);
  assert.equal(r.send, 'blocked-full');
  assert.equal(srv.count('finalize'), finalizesBefore, 'no finalize: the server must not drop its copy while we have no room');
  assert.ok(stored('n-extra'), 'the 51st capture itself is kept');
  const drafts = await listDrafts(fx.area);
  assert.equal(drafts.length, MAX_RETAINED + 1);
  for (let i = 0; i < MAX_RETAINED; i += 1) assert.ok(stored(`n${i}`), `n${i} still there`);
  // reconcile (even much later) drops nothing
  await reconcileDrafts(fx.area, srv.api, { now: NOW + 400 * DAY });
  assert.equal((await listDrafts(fx.area)).length, MAX_RETAINED + 1);
  // the user deletes one: the next Stop works
  await deleteDraft(fx.area, 'n0');
  assert.equal((await stopCapture(fx.area, srv.api, draft('n-after'), NOW + 1000)).send, 'sent');
});

test('a stale unsent draft is not auto-finalized while the retained store is full', async () => {
  const srv = new FakeServer();
  srv.ackRequired = false;
  for (let i = 0; i < MAX_RETAINED; i += 1) await stopCapture(fx.area, srv.api, draft(`n${i}`), NOW);
  await saveTranscriptDraft(fx.area, draft('late'), T0);
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + DAY });
  assert.equal(rep.find((r) => r.id === 'late')!.outcome, 'blocked-full');
  assert.equal(srv.calls.filter((c) => c === 'finalize:late:payload').length, 0);
});

// ─── storage failures ─────────────────────────────────────────────────

test('a failing stage write does not stop the finalize; the failure is reported and the capture is held in memory', async () => {
  let failStage = true;
  const f = fakeArea({ failSet: (items) => failStage && Object.keys(items).some((k) => k.startsWith('draftStage:')) });
  const srv = new FakeServer();
  const r = await stopCapture(f.area, srv.api, draft('q1', 3), NOW);
  assert.equal(srv.count('finalize'), 1, 'finalize ran regardless of the stage write');
  assert.equal(r.storageError, true);
  assert.ok(f.store.has('transcriptDraft:q1'), 'the draft itself was saved');
  assert.deepEqual(memoryCaptureIds(), ['q1']);
  const rep = await reconcileDrafts(f.area, srv.api, { now: NOW + 1 });
  assert.ok(rep.some((x) => x.id === 'q1' && x.outcome === 'storage-error'), 'persistent error while storage fails');
  failStage = false; // space is back
  const rep2 = await reconcileDrafts(f.area, srv.api, { now: NOW + 2 });
  assert.deepEqual(memoryCaptureIds(), []);
  assert.ok(!rep2.some((x) => x.outcome === 'storage-error'));
  assert.equal(await getDraftStage(f.area, 'q1'), 'awaiting-ack');
});

test('a throwing storage (every write fails) still sends the capture and keeps it in memory', async () => {
  const f = fakeArea({ failSet: () => true });
  const srv = new FakeServer();
  const r = await stopCapture(f.area, srv.api, draft('q2', 3), NOW);
  assert.equal(r.storageError, true);
  assert.equal(srv.count('finalize'), 1);
  assert.deepEqual(memoryCaptureIds(), ['q2']);
  assert.equal(f.store.size, 0);
});

test('a failed release (storage error at the end) keeps the draft', async () => {
  let fail = false;
  const f = fakeArea({ failSet: () => fail });
  const srv = new FakeServer();
  await stopCapture(f.area, srv.api, draft('q3'), NOW);
  srv.ack('q3');
  fail = true;
  const rep = await reconcileDrafts(f.area, srv.api, { now: NOW + 1 });
  assert.notEqual(rep[0].outcome, 'released');
  assert.ok(f.store.has('transcriptDraft:q3'));
});

test('a draft write over quota rejects (callers surface it) and leaves the old draft', async () => {
  let fail = false;
  const f = fakeArea({ failSet: () => fail });
  await saveTranscriptDraft(f.area, draft('w1', 1), T0);
  fail = true;
  await assert.rejects(saveTranscriptDraft(f.area, draft('w1', 5), T0 + 1));
  assert.equal((await listDrafts(f.area))[0].draft.segments.length, 1);
});

// ─── races ────────────────────────────────────────────────────────────

test('save racing the release (slow storage): the released draft is not re-created and no banner remains', async () => {
  const f = fakeArea({ delayMs: 2 });
  fx = f;
  const srv = new FakeServer();
  await stopCapture(f.area, srv.api, draft('x1'), NOW);
  srv.ack('x1');
  const [rep] = await Promise.all([
    reconcileDrafts(f.area, srv.api, { now: NOW + 1 }),
    saveTranscriptDraft(f.area, draft('x1'), NOW + 2), // the closing panel's last checkpoint
  ]);
  assert.ok(rep.length === 1);
  // Either the release won (the late save is then ignored) or the save won (the
  // release is refused as stale and the next pass releases the identical copy):
  // both end with no draft and nothing left to show.
  await reconcileDrafts(f.area, srv.api, { now: NOW + 3 });
  const settled = await reconcileDrafts(f.area, srv.api, { now: NOW + 4 });
  assert.deepEqual(settled.filter((r) => r.id === 'x1'), [], 'no draft, so no banner');
  assert.ok(!f.store.has('transcriptDraft:x1'));
});

test('a draft changed after its copy was verified is NOT released (compare-and-set)', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('x2', 3), NOW);
  srv.ack('x2');
  const realStatus = srv.api.status;
  srv.api.status = async (id) => {
    const st = await realStatus(id);
    // the panel checkpoints a newer version while we were asking the server
    await saveTranscriptDraft(fx.area, draft('x2', 4), NOW + 500);
    return st;
  };
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1 });
  assert.notEqual(rep[0].outcome, 'released');
  assert.equal((await listDrafts(fx.area))[0].draft.segments.length, 4, 'the newer content survives');
});

test('an orphan draft with a released marker is cleared only when the server copy matches it', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('x3', 3), NOW);
  srv.ack('x3');
  await setDraftStage(fx.area, 'x3', 'released', NOW);
  // a DIFFERENT local content than what the server acked
  fx.store.set('transcriptDraft:x3', { ...draft('x3', 5), updatedAt: NOW });
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1 });
  assert.equal(rep[0].outcome, 'partial-acked');
  assert.ok(stored('x3'), 'kept + banner, not silently deleted');
  // matching content: cleared
  fx.store.set('transcriptDraft:x3', { ...draft('x3', 3), updatedAt: NOW });
  assert.equal((await reconcileDrafts(fx.area, srv.api, { now: NOW + 2 }))[0].outcome, 'released');
  assert.ok(!stored('x3'));
});

test('stage is forward-only and first decision wins at equal rank', async () => {
  await setDraftStage(fx.area, 'm1', 'awaiting-ack');
  await setDraftStage(fx.area, 'm1', 'finalizing');
  await setDraftStage(fx.area, 'm1', 'recording');
  await setDraftStage(fx.area, 'm1', 'no-ack');
  assert.equal(await getDraftStage(fx.area, 'm1'), 'awaiting-ack');
});

test('every mutation goes through the installed lock', async () => {
  let held = 0;
  let maxHeld = 0;
  const order: string[] = [];
  setDraftLock(async (fn) => {
    held += 1;
    maxHeld = Math.max(maxHeld, held);
    order.push('in');
    try {
      return await fn();
    } finally {
      held -= 1;
    }
  });
  const f = fakeArea({ delayMs: 1 });
  await Promise.all([
    saveTranscriptDraft(f.area, draft('l1'), T0),
    setDraftStage(f.area, 'l1', 'finalizing'),
    saveTranscriptDraft(f.area, draft('l2'), T0),
    deleteDraft(f.area, 'l2'),
  ]);
  assert.equal(maxHeld, 1, 'never two holders at once');
  assert.ok(order.length >= 4);
});

test('owner token: another panel does not re-send a fresh draft it does not own; its owner and stale drafts are re-sent', async () => {
  const srv = new FakeServer();
  await saveTranscriptDraft(fx.area, draft('o1', 3, { owner: 'panel-A' }), NOW);
  await setDraftStage(fx.area, 'o1', 'finalizing');
  const other = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000, panelId: 'panel-B' });
  assert.equal(other[0].outcome, 'not-confirmed');
  assert.equal(srv.count('finalize'), 0);
  const owner = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000, panelId: 'panel-A' });
  assert.equal(owner[0].outcome, 'resent');
  // stale: the owner is gone, anyone may
  const srv2 = new FakeServer();
  const f2 = fakeArea();
  await saveTranscriptDraft(f2.area, draft('o2', 3, { owner: 'panel-A' }), NOW);
  await setDraftStage(f2.area, 'o2', 'finalizing');
  const rep = await reconcileDrafts(f2.area, srv2.api, { now: NOW + DRAFT_STALE_MS + 1, panelId: 'panel-B' });
  assert.equal(rep[0].outcome, 'resent');
});

// ─── legacy import ────────────────────────────────────────────────────

function legacy(id: string, n = 3, over: Partial<LegacyTranscript> = {}): LegacyTranscript {
  const segments = Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, timestamp: T0 + i * 1000, isFinal: true, speaker: 'A' }));
  return {
    id,
    meetingTitle: `M ${id}`,
    date: new Date(T0).toISOString(),
    duration: 90,
    language: 'en-US',
    transcript: segments.map((s) => `[A] ${s.text}`).join('\n'),
    segments,
    speakerNames: {},
    ...over,
  };
}
const seedLegacy = (list: LegacyTranscript[]) => fx.store.set('transcripts', structuredClone(list));
const legacyIds = () => ((fx.store.get('transcripts') as { id: string }[] | undefined) ?? []).map((t) => t.id);
const lopts = { polls: 2, sleep: async () => {} };

test('legacy: read-only view never writes', async () => {
  seedLegacy([legacy('a'), legacy('b')]);
  const before = JSON.stringify([...fx.store]);
  assert.equal((await readLegacyTranscripts(fx.area)).length, 2);
  assert.equal(JSON.stringify([...fx.store]), before);
});

test('legacy: sends date, language, duration and renames; deletes only after ack of the identical copy', async () => {
  const srv = new FakeServer();
  const t = legacy('a', 3, { speakerNames: { A: 'Alice' } });
  seedLegacy([t, legacy('b')]);
  const r1 = await importLegacyTranscript(fx.area, srv.api, t, lopts);
  assert.equal(r1.outcome, 'waiting');
  assert.equal(srv.lastPayload?.startedAt, T0);
  assert.equal(srv.lastPayload?.language, 'en-US');
  assert.equal(srv.lastPayload?.durationSec, 90);
  assert.ok(srv.lastPayload?.captions.every((c) => c.speaker === 'Alice'));
  assert.deepEqual(legacyIds(), ['a', 'b']);
  srv.ack(await legacyCaptureId(t));
  srv.calls.length = 0;
  assert.equal((await importLegacyTranscript(fx.area, srv.api, t, lopts)).outcome, 'copied');
  assert.deepEqual(legacyIds(), ['b']);
  assert.equal(srv.count('finalize'), 0);
});

test('legacy: a short server copy / wrong hash / lost metadata deletes nothing', async () => {
  for (const setup of [
    (s: FakeServer) => (s.mangle = (l) => l.slice(0, 1)),
    (s: FakeServer) => (s.ignoreMeta = true),
  ]) {
    const f = fakeArea();
    fx = f;
    const srv = new FakeServer();
    setup(srv);
    const t = legacy('a', 3);
    seedLegacy([t]);
    const id = await legacyCaptureId(t);
    const r = await importLegacyTranscript(f.area, srv.api, t, lopts);
    srv.ack(id);
    const r2 = await importLegacyTranscript(f.area, srv.api, t, lopts);
    assert.notEqual(r.outcome, 'copied');
    assert.notEqual(r2.outcome, 'copied');
    assert.deepEqual(legacyIds(), ['a']);
  }
  // acked with a different hash
  const srv = new FakeServer();
  const t = legacy('w', 3);
  seedLegacy([t]);
  await importLegacyTranscript(fx.area, srv.api, t, lopts);
  const id = await legacyCaptureId(t);
  srv.held.set(id, { ...srv.held.get(id)!, hash: '0'.repeat(64) });
  srv.ack(id);
  assert.notEqual((await importLegacyTranscript(fx.area, srv.api, t, lopts)).outcome, 'copied');
  assert.ok(legacyIds().includes('w'));
});

test('legacy: running twice (double click / two tabs) sends once', async () => {
  const srv = new FakeServer();
  const t = legacy('a');
  seedLegacy([t]);
  await importLegacyTranscript(fx.area, srv.api, t, lopts);
  await importLegacyTranscript(fx.area, srv.api, t, lopts);
  assert.equal(srv.count('finalize'), 1);
  assert.deepEqual(legacyIds(), ['a']);
});

test('legacy: the single-flight lock reports busy and does nothing', async () => {
  const srv = new FakeServer();
  const t = legacy('a');
  seedLegacy([t]);
  const r = await importLegacyTranscript(fx.area, srv.api, t, { ...lopts, withLock: async () => null });
  assert.equal(r.outcome, 'busy');
  assert.deepEqual(srv.calls, []);
});

test('legacy: unreachable deletes nothing and stops the batch; flag off deletes nothing', async () => {
  const srv = new FakeServer();
  srv.reachable = false;
  seedLegacy([legacy('a'), legacy('b')]);
  const rs = await importLegacyTranscripts(fx.area, srv.api, await readLegacyTranscripts(fx.area), lopts);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].outcome, 'unreachable');
  const srv2 = new FakeServer();
  srv2.ackRequired = false;
  assert.equal((await importLegacyTranscript(fx.area, srv2.api, legacy('a'), lopts)).outcome, 'no-ack-protocol');
  assert.deepEqual(legacyIds(), ['a', 'b']);
});

test('legacy: over 2000 lines is skipped and never sent', async () => {
  const srv = new FakeServer();
  const t = legacy('big', 2100);
  seedLegacy([t]);
  assert.equal((await importLegacyTranscript(fx.area, srv.api, t, lopts)).outcome, 'skipped-large');
  assert.deepEqual(srv.calls, []);
});

test('legacy: capture id is content-addressed (an ack for other content with the same id is not trusted)', async () => {
  const srv = new FakeServer();
  const original = legacy('same');
  const other = legacy('same', 2, { transcript: '[A] different' });
  assert.notEqual(await legacyCaptureId(original), await legacyCaptureId(other));
  seedLegacy([other]);
  srv.ack(await legacyCaptureId(original));
  const r = await importLegacyTranscript(fx.area, srv.api, other, lopts);
  assert.notEqual(r.outcome, 'copied');
  assert.deepEqual(legacyIds(), ['same']);
});

test('legacy: a failed local delete (quota) is reported and the item is not lost', async () => {
  let fail = false;
  const f = fakeArea({ failSet: () => fail });
  fx = f;
  const srv = new FakeServer();
  const t = legacy('a');
  f.store.set('transcripts', [structuredClone(t), structuredClone(legacy('b'))]);
  await importLegacyTranscript(f.area, srv.api, t, lopts);
  srv.ack(await legacyCaptureId(t));
  fail = true;
  assert.equal((await importLegacyTranscript(f.area, srv.api, t, lopts)).outcome, 'error');
  assert.equal((f.store.get('transcripts') as unknown[]).length, 2);
});

test('toCaptions applies renames and drops empty lines', () => {
  const caps = toCaptions(
    [
      { text: 'hi', timestamp: 1, isFinal: true, speaker: 'S1' },
      { text: '', timestamp: 2, isFinal: true, speaker: 'S1' },
    ],
    { S1: 'Bob' },
  );
  assert.deepEqual(caps.map((c) => c.speaker), ['Bob']);
});

test('a finalized capture from before migration 0051 (no caption hash) cannot be verified: it is re-sent, never released', async () => {
  const srv = new FakeServer();
  await stopCapture(fx.area, srv.api, draft('z9', 3), NOW);
  const real = srv.api.status;
  let first = true;
  srv.api.status = async (id) => {
    const st = await real(id);
    if (first && st.ok) {
      first = false;
      return { ...st, captionHash: null };
    }
    return st;
  };
  const rep = await reconcileDrafts(fx.area, srv.api, { now: NOW + 1000 });
  assert.equal(rep[0].outcome, 'resent');
  assert.ok(stored('z9'));
});
