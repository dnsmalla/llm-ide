// The extension keeps NOTHING of its own (live-then-archive plan 0.1 rule 5,
// Q18). The one exception is a meeting CAPTURE DRAFT: `transcriptDraft:<id>`
// holds a capture until the server proves it holds an identical copy that the
// Mac app acked. Everything here is pure logic over injected dependencies (a
// chrome.storage-like area and a live API), so it runs under the Node test
// runner with no browser.
//
// Data-loss rules (each has a behavioural test):
//  - A draft is deleted ONLY when the server answers `acked` for a capture this
//    extension finalized AND the server's line count, caption hash, language and
//    start equal what this draft would send. A short, truncated, merged or
//    unverifiable copy keeps the draft.
//  - Unreachable, unknown, expired, an old server, a flag-off server and every
//    error keep the draft. Nothing is ever dropped to make room.
//  - Draft writes, stage changes and the release run under one lock; the release
//    is compare-and-set against the draft it verified.
//
// This file must never import runtime code (tests load it directly under
// --experimental-strip-types); types only.

import type { TranscriptSegment } from '../sidepanel/hooks/useTranscript';

// ─── Types ────────────────────────────────────────────────────────────

/** Minimal chrome.storage.local surface (so tests can inject a fake). */
export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface Draft {
  id: string; // the live session id (the server and the Mac key the capture by it)
  meetingTitle: string;
  date: string;
  duration: number;
  language?: string;
  transcript: string;
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  updatedAt: number;
  /** The panel that records it; only that panel (or anyone, once stale) re-sends it. */
  owner?: string;
}

/**
 * recording: still capturing (or the panel died before Stop).
 * finalizing: Stop pressed, the server may not hold a verified copy yet.
 * awaiting-ack: the server holds a verified copy and requires the Mac's ack.
 * no-ack: the server has no ack protocol (flag off): the local copy is KEPT.
 * released: acked and verified; the draft is gone (the marker stops a late write).
 */
export type DraftStage = 'recording' | 'finalizing' | 'awaiting-ack' | 'no-ack' | 'released';
const STAGE_RANK: Record<DraftStage, number> = {
  recording: 0,
  finalizing: 1,
  'awaiting-ack': 2,
  'no-ack': 2,
  released: 3,
};

export type LiveState = 'live' | 'finalized' | 'acked' | 'expired' | 'unknown';
export type StatusResult =
  | {
      ok: true;
      state: LiveState;
      durable: boolean;
      /** Present for finalized and acked captures (API v86+). */
      lines?: number;
      captionHash?: string | null;
      language?: string;
      startedAt?: number | null;
    }
  | { ok: false };

export interface CaptureCaption {
  speaker: string;
  text: string;
  ts: number;
  source: string;
}
export interface FinalizePayload {
  captions: CaptureCaption[];
  meetingTitle: string;
  startedAt?: number;
  language?: string;
  durationSec?: number;
}
export interface FinalizeResult {
  ok: boolean;
  /** true only when the server said so: the ack protocol is on (flag on). */
  ackRequired: boolean;
  captionCount: number;
  captionHash?: string;
  durable: boolean;
}
export interface LiveApi {
  status(id: string): Promise<StatusResult>;
  /** With a payload: the complete transcript (server holds exactly it). Without: finalize the streamed buffer. */
  finalize(id: string, payload?: FinalizePayload): Promise<FinalizeResult>;
}

export const DRAFT_PREFIX = 'transcriptDraft:';
export const STAGE_PREFIX = 'draftStage:';
// A live panel rewrites its draft every few seconds; one untouched this long
// belongs to a panel that is gone and is safe to recover.
export const DRAFT_STALE_MS = 2 * 60 * 1000;
/** Flag-off (no-ack) local copies kept. At the cap NOTHING is dropped: finalizing is refused until the user exports or deletes one. */
export const MAX_RETAINED = 50;
/** A 'released' marker is only a guard against a late write; drop it after a week. */
export const RELEASED_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The server's per-capture line limit. */
export const SERVER_MAX_CAPTIONS = 2000;
/** The server's finalize body limit is 4 MB; stay well under it. */
export const MAX_BODY_BYTES = 3 * 1024 * 1024;
/** An automatic re-send of the same draft is attempted at most this often. */
export const RESEND_BACKOFF_MS = 5 * 60 * 1000;

interface StageRecord {
  stage: DraftStage;
  at: number;
  resentAt?: number;
}

// ─── The lock ─────────────────────────────────────────────────────────

type LockRunner = <T>(fn: () => Promise<T>) => Promise<T>;
let crossContextLock: LockRunner | null = null;
let tail: Promise<unknown> = Promise.resolve();

/** Installed by capture-live.ts: navigator.locks, so two panels/tabs serialise too. */
export function setDraftLock(run: LockRunner | null): void {
  crossContextLock = run;
}

/** Every draft/stage mutation runs here: in-process FIFO plus the cross-context lock. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = () => (crossContextLock ? crossContextLock(fn) : fn());
  const next = tail.then(run, run) as Promise<T>;
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ─── Canonical capture (mirrors the server) ───────────────────────────

// Mirrors agents/live-sessions.mjs sanitize() + normalizeBatch(dedupe=false):
// control chars to space, fence markers dropped, whitespace collapsed, speaker
// 80 / text 2000 chars, empties dropped, repeated lines KEPT.
// tests/capture-canon-parity.test.mjs runs both against the same inputs.
const FENCE_RE = /<<<\s*(?:BEGIN|END)\s*>>>/gi;
function serverSanitize(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  return (
    text
      // eslint-disable-next-line no-control-regex -- mirrors the server's sanitize()
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(FENCE_RE, '')
      .replace(/\s+/g, ' ')
      .slice(0, max)
      .trim()
  );
}

export function toCaptions(segments: TranscriptSegment[], speakerNames: Record<string, string> = {}): CaptureCaption[] {
  const out: CaptureCaption[] = [];
  for (const s of segments) {
    if (!s?.speaker || !s?.text) continue;
    // A rename made in the panel travels with the capture: the local copy is
    // deleted after the ack, so the server's copy must hold the display names.
    out.push({ speaker: speakerNames[s.speaker] || s.speaker, text: s.text, ts: s.timestamp, source: 'extension-cc' });
  }
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 over the sanitized (speaker, text) lines: the server's captionHashOf(). */
export async function captionHash(captions: CaptureCaption[]): Promise<string> {
  const lines: string[] = [];
  for (const c of captions) {
    const speaker = serverSanitize(c.speaker, 80);
    const text = serverSanitize(c.text, 2000);
    if (!speaker || !text) continue;
    lines.push(`${speaker}\u0000${text}`);
  }
  return sha256Hex(lines.join('\n'));
}

export function countLines(captions: CaptureCaption[]): number {
  let n = 0;
  for (const c of captions) if (serverSanitize(c.speaker, 80) && serverSanitize(c.text, 2000)) n += 1;
  return n;
}

const MIN_TS = Date.UTC(2000, 0, 1);
const LANG_RE = /^[A-Za-z0-9_-]{1,35}$/;

/** What would be sent for a capture, and what the server must then hold. */
export interface Expected {
  payload: FinalizePayload;
  lines: number;
  captionHash: string;
  /** More lines than the server can hold, or a body over the request limit. */
  tooLarge: boolean;
}

export interface CaptureLike {
  meetingTitle: string;
  language?: string;
  duration: number;
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
}

export async function expectedOf(c: CaptureLike, now = Date.now()): Promise<Expected> {
  const captions = toCaptions(c.segments, c.speakerNames ?? {});
  const payload: FinalizePayload = { captions, meetingTitle: c.meetingTitle || 'Untitled meeting' };
  const stamps = captions.map((x) => x.ts).filter((t) => Number.isFinite(t) && t >= MIN_TS && t <= now + 5 * 60_000);
  if (stamps.length > 0) payload.startedAt = Math.min(...stamps);
  if (c.language && LANG_RE.test(c.language)) payload.language = c.language;
  if (Number.isFinite(c.duration) && c.duration >= 0 && c.duration <= 7 * 24 * 3600)
    payload.durationSec = Math.round(c.duration);
  const lines = countLines(captions);
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  return {
    payload,
    lines,
    captionHash: await captionHash(captions),
    tooLarge: lines > SERVER_MAX_CAPTIONS || bytes > MAX_BODY_BYTES,
  };
}

/** The server's copy equals what we would send (lines, hash, language, start). */
export function serverHoldsExpected(st: Extract<StatusResult, { ok: true }>, exp: Expected): boolean {
  if (typeof st.lines !== 'number' || st.lines !== exp.lines) return false;
  if (typeof st.captionHash !== 'string' || st.captionHash === '' || st.captionHash !== exp.captionHash) return false;
  if ((st.language ?? '') !== (exp.payload.language ?? '')) return false;
  if (exp.payload.startedAt !== undefined && st.startedAt !== exp.payload.startedAt) return false;
  return true;
}

// ─── Draft storage ───────────────────────────────────────────────────

function readStage(all: Record<string, unknown>, id: string): StageRecord | null {
  const rec = all[STAGE_PREFIX + id] as Partial<StageRecord> | undefined;
  return rec && typeof rec.stage === 'string' && rec.stage in STAGE_RANK
    ? { stage: rec.stage as DraftStage, at: typeof rec.at === 'number' ? rec.at : 0, resentAt: rec.resentAt }
    : null;
}

export async function getDraftStage(area: StorageArea, id: string): Promise<DraftStage | null> {
  const r = await area.get(STAGE_PREFIX + id);
  return readStage(r ?? {}, id)?.stage ?? null;
}

/** Forward-only compare-and-set under the lock (a stage never moves back; equal rank: first decision wins). */
export function setDraftStage(area: StorageArea, id: string, stage: DraftStage, now = Date.now()): Promise<void> {
  return locked(async () => {
    const cur = readStage((await area.get(STAGE_PREFIX + id)) ?? {}, id);
    if (cur && STAGE_RANK[cur.stage] > STAGE_RANK[stage]) return;
    if (cur && STAGE_RANK[cur.stage] === STAGE_RANK[stage]) return;
    await area.set({ [STAGE_PREFIX + id]: { stage, at: now, resentAt: cur?.resentAt } satisfies StageRecord });
  });
}

function markResent(area: StorageArea, id: string, now: number): Promise<void> {
  return locked(async () => {
    const cur = readStage((await area.get(STAGE_PREFIX + id)) ?? {}, id);
    await area.set({
      [STAGE_PREFIX + id]: {
        stage: cur?.stage ?? 'recording',
        at: cur?.at ?? now,
        resentAt: now,
      } satisfies StageRecord,
    });
  });
}

/** Writes (or refreshes) the draft. A no-op once the capture was released. Rejects on a storage error. */
export function saveTranscriptDraft(
  area: StorageArea,
  input: Omit<Draft, 'updatedAt'>,
  now = Date.now(),
): Promise<void> {
  return locked(async () => {
    const stageRec = readStage((await area.get(STAGE_PREFIX + input.id)) ?? {}, input.id);
    if (stageRec?.stage === 'released') return;
    await area.set({ [DRAFT_PREFIX + input.id]: { ...input, updatedAt: now } satisfies Draft });
  });
}

/** Explicit user delete of a retained local copy. */
export function deleteDraft(area: StorageArea, id: string): Promise<void> {
  return locked(async () => {
    await area.remove([DRAFT_PREFIX + id, STAGE_PREFIX + id]);
  });
}

export interface DraftEntry {
  draft: Draft;
  stage: DraftStage;
}

function isDraft(v: unknown): v is Draft {
  const d = v as Partial<Draft> | null;
  return !!d && typeof d.id === 'string' && Array.isArray(d.segments);
}

export async function listDrafts(area: StorageArea): Promise<DraftEntry[]> {
  const all = await area.get(null);
  const out: DraftEntry[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(DRAFT_PREFIX) || !isDraft(value)) continue;
    const stage = readStage(all, value.id)?.stage ?? 'recording';
    out.push({ draft: { ...value, updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0 }, stage });
  }
  return out.sort((a, b) => a.draft.updatedAt - b.draft.updatedAt);
}

async function retainedCount(area: StorageArea): Promise<number> {
  return (await listDrafts(area)).filter((e) => e.stage === 'no-ack').length;
}

/**
 * Release = the verified end. Compare-and-set: only if the draft is byte-for-byte
 * the one whose copy the server verified (same updatedAt) and its stage still
 * allows a release. The marker is written before the draft is removed.
 */
function releaseIfUnchanged(area: StorageArea, entry: DraftEntry, now: number): Promise<boolean> {
  return locked(async () => {
    const all = await area.get(null);
    const cur = all[DRAFT_PREFIX + entry.draft.id];
    if (!isDraft(cur)) return true; // already gone
    if (cur.updatedAt !== entry.draft.updatedAt) return false; // changed since it was verified
    const rec = readStage(all, entry.draft.id);
    const stage = rec?.stage ?? 'recording';
    if (stage !== 'finalizing' && stage !== 'awaiting-ack' && stage !== 'released') return false;
    await area.set({ [STAGE_PREFIX + entry.draft.id]: { stage: 'released', at: now } satisfies StageRecord });
    await area.remove(DRAFT_PREFIX + entry.draft.id);
    return true;
  });
}

// ─── Stop / finalize / resend ─────────────────────────────────────────

export type SendOutcome =
  | 'sent' // the server holds a verified copy
  | 'partial' // the server answered, but its copy differs from ours
  | 'failed' // no usable answer
  | 'unreachable'
  | 'refused' // not safe to send (see resendDraft)
  | 'blocked-full' // retained store full
  | 'too-large'
  | 'empty';

/** Applies a finalize response to the stage. Only a VERIFIED copy moves the stage on. */
async function recordFinalize(
  area: StorageArea,
  id: string,
  exp: Expected,
  r: FinalizeResult,
  now: number,
): Promise<SendOutcome> {
  if (!r.ok || r.captionCount === 0) return 'failed'; // stays 'finalizing': the loop re-sends
  if (r.ackRequired) {
    if (r.captionCount !== exp.lines || r.captionHash !== exp.captionHash) return 'partial';
    await setDraftStage(area, id, 'awaiting-ack', now);
    return 'sent';
  }
  // No ack protocol: the copy can never be proven, so it is retained for good.
  await setDraftStage(area, id, 'no-ack', now);
  return 'sent';
}

// Captures whose storage writes failed: kept in memory so the capture is still
// sent and the user sees a persistent error until it is stored.
interface MemoryCapture {
  draft: Omit<Draft, 'updatedAt'>;
  stage: DraftStage;
}
const memoryCaptures = new Map<string, MemoryCapture>();
export const memoryCaptureIds = () => [...memoryCaptures.keys()];
export function _clearMemoryCapturesForTests(): void {
  memoryCaptures.clear();
}

export interface StopResult {
  /** The draft write or a stage write failed: the user must see this. */
  storageError: boolean;
  send: SendOutcome;
}

/**
 * Stop: persist the final snapshot, then send the COMPLETE transcript so the
 * server's copy is exactly it. Every step is independent: a failed storage write
 * never prevents the finalize, and a failed finalize never loses the draft.
 */
export async function stopCapture(
  area: StorageArea,
  api: LiveApi,
  snap: Omit<Draft, 'updatedAt'>,
  now = Date.now(),
): Promise<StopResult> {
  let storageError = false;
  try {
    await saveTranscriptDraft(area, snap, now);
  } catch {
    storageError = true;
  }
  const exp = await expectedOf(snap, now);
  if (exp.lines === 0) {
    return { storageError, send: 'empty' };
  }
  let blocked = false;
  try {
    blocked = (await retainedCount(area)) >= MAX_RETAINED;
  } catch {
    /* unknown: do not block */
  }
  if (blocked) {
    // Finalizing on a flag-off server deletes its copy and leaves only ours, and
    // we have no room to keep ours: do not finalize; the capture stays recording.
    return { storageError, send: 'blocked-full' };
  }
  try {
    await setDraftStage(area, snap.id, 'finalizing', now);
  } catch {
    storageError = true;
  }
  let send: SendOutcome;
  try {
    const r = await api.finalize(snap.id, exp.tooLarge ? undefined : exp.payload);
    if (exp.tooLarge) {
      send = 'too-large'; // the streamed buffer was finalized for the Mac; our copy can never be proven
    } else {
      try {
        send = await recordFinalize(area, snap.id, exp, r, now);
      } catch {
        storageError = true;
        send = r.ok ? 'sent' : 'failed';
      }
    }
  } catch {
    send = 'failed';
  }
  if (storageError)
    memoryCaptures.set(snap.id, { draft: snap, stage: send === 'sent' ? 'awaiting-ack' : 'finalizing' });
  return { storageError, send };
}

export interface ResendOptions {
  now?: number;
  panelId?: string;
}

/** Re-send the WHOLE draft (idempotent: same id, the server replaces its copy). Never deletes. */
export async function resendDraft(
  area: StorageArea,
  api: LiveApi,
  entry: DraftEntry,
  opts: ResendOptions = {},
): Promise<SendOutcome> {
  const now = opts.now ?? Date.now();
  const { draft, stage } = entry;
  if (stage === 'released') return 'refused';
  const exp = await expectedOf(draft, now);
  if (exp.lines === 0) return 'empty';
  if (exp.tooLarge) return 'too-large';
  const st = await api.status(draft.id);
  if (!st.ok) return 'unreachable';
  // A stale draft must not be promoted by an ack that is not for this capture.
  if (stage === 'recording' && st.state === 'acked') return 'refused';
  // Someone may still be recording it.
  if (stage === 'recording' && st.state === 'live' && now - draft.updatedAt < DRAFT_STALE_MS) return 'refused';
  if ((stage === 'recording' || stage === 'finalizing') && (await retainedCount(area)) >= MAX_RETAINED)
    return 'blocked-full';
  await setDraftStage(area, draft.id, 'finalizing', now);
  await markResent(area, draft.id, now);
  const r = await api.finalize(draft.id, exp.payload);
  return recordFinalize(area, draft.id, exp, r, now);
}

// ─── Reconcile ────────────────────────────────────────────────────────

export type DraftOutcome =
  | 'released' // acked and verified: draft deleted
  | 'waiting' // the server holds a verified copy, the Mac has not acked yet
  | 'not-durable' // held in server memory only; keep
  | 'unreachable' // status unknown: keep
  | 'not-confirmed' // server has no record / expired: keep, needs a resend
  | 'partial' // the server's copy differs from ours: keep (re-sent when allowed)
  | 'partial-acked' // the Mac acked a copy that differs from ours: keep, manual Resend
  | 'too-large' // cannot be held by the server: kept here, export or delete
  | 'blocked-full' // retained store full: nothing finalized
  | 'storage-error' // a write failed: the capture is only in memory
  | 'retained' // flag-off copy: kept, no ack exists
  | 'active' // a live panel is recording it
  | 'resent'
  | 'resend-failed';

export interface DraftReport {
  id: string;
  title: string;
  stage: DraftStage;
  outcome: DraftOutcome;
}

export interface ReconcileOptions {
  now?: number;
  /** Ids a panel is recording right now (never touched). */
  activeIds?: ReadonlySet<string>;
  /** This panel's id: other panels' fresh drafts are not re-sent. */
  panelId?: string;
  /** Re-push unverified drafts automatically (default true). */
  autoResend?: boolean;
}

function mayAutoResend(draft: Draft, rec: StageRecord | null, opts: ReconcileOptions, now: number): boolean {
  if (opts.autoResend === false) return false;
  if (rec?.resentAt && now - rec.resentAt < RESEND_BACKOFF_MS) return false;
  if (draft.owner && opts.panelId && draft.owner !== opts.panelId && now - draft.updatedAt < DRAFT_STALE_MS)
    return false;
  return true;
}

/** Memory-only captures: try to store them, and keep sending until the server has a verified copy. */
async function flushMemory(area: StorageArea, api: LiveApi, now: number, reports: DraftReport[]): Promise<void> {
  for (const [id, m] of [...memoryCaptures]) {
    try {
      await saveTranscriptDraft(area, m.draft, now);
      await setDraftStage(area, id, m.stage, now);
      memoryCaptures.delete(id);
      continue;
    } catch {
      /* still failing */
    }
    if (m.stage === 'finalizing') {
      try {
        const exp = await expectedOf(m.draft, now);
        const r = await api.finalize(id, exp.tooLarge ? undefined : exp.payload);
        if (r.ok && !exp.tooLarge && r.captionCount === exp.lines && r.captionHash === exp.captionHash)
          m.stage = r.ackRequired ? 'awaiting-ack' : 'no-ack';
      } catch {
        /* retry next pass */
      }
    }
    reports.push({ id, title: m.draft.meetingTitle, stage: m.stage, outcome: 'storage-error' });
  }
}

/**
 * One pass over every draft. The only deletion is the verified-`acked` branch.
 */
export async function reconcileDrafts(
  area: StorageArea,
  api: LiveApi,
  opts: ReconcileOptions = {},
): Promise<DraftReport[]> {
  const now = opts.now ?? Date.now();
  const reports: DraftReport[] = [];
  await flushMemory(area, api, now, reports);
  const all = await area.get(null);
  for (const entry of await listDrafts(area)) {
    const { draft, stage } = entry;
    const rec = readStage(all, draft.id);
    const base = { id: draft.id, title: draft.meetingTitle, stage };
    const push = (outcome: DraftOutcome) => reports.push({ ...base, outcome });
    if (opts.activeIds?.has(draft.id)) {
      push('active');
      continue;
    }
    if (stage === 'no-ack') {
      push('retained');
      continue;
    }
    if (stage === 'recording' && now - draft.updatedAt < DRAFT_STALE_MS) {
      push('active'); // a live panel is still checkpointing it
      continue;
    }
    const exp = await expectedOf(draft, now);
    if (exp.lines === 0) {
      push('not-confirmed');
      continue;
    }
    if (exp.tooLarge) {
      push('too-large'); // the server cannot hold it: never verified, never released
      continue;
    }
    let st: StatusResult;
    try {
      st = await api.status(draft.id);
    } catch {
      st = { ok: false };
    }
    if (!st.ok) {
      push('unreachable');
      continue;
    }
    const verified = serverHoldsExpected(st, exp);

    if (st.state === 'acked') {
      if (stage === 'recording') {
        push('not-confirmed'); // an ack for an id this panel never finalized: not trusted
        continue;
      }
      if (!verified) {
        push('partial-acked'); // the Mac acked a different copy: keep, the user can Resend
        continue;
      }
      let done = false;
      try {
        done = await releaseIfUnchanged(area, entry, now);
      } catch {
        done = false; // storage error: the draft stays
      }
      push(done ? 'released' : 'waiting');
      continue;
    }

    if (st.state === 'finalized' && verified && (stage === 'awaiting-ack' || stage === 'finalizing')) {
      if (stage === 'finalizing') {
        try {
          await setDraftStage(area, draft.id, 'awaiting-ack', now);
        } catch {
          /* the next pass retries */
        }
      }
      push(st.durable ? 'waiting' : 'not-durable');
      continue;
    }

    // A recording the server still receives (live): its panel may merely have a
    // failing checkpoint. Never finalize someone else's live capture.
    if (stage === 'recording' && st.state === 'live') {
      push('active');
      continue;
    }
    if (st.state === 'expired' || (st.state === 'unknown' && stage === 'awaiting-ack')) {
      push('not-confirmed'); // manual Resend
      continue;
    }
    // Remaining: finalized-but-different, live (stage finalizing), unknown (recording/finalizing).
    if (!mayAutoResend(draft, rec, opts, now)) {
      push(st.state === 'finalized' ? 'partial' : 'not-confirmed');
      continue;
    }
    let outcome: SendOutcome = 'failed';
    try {
      outcome = await resendDraft(area, api, entry, { now, panelId: opts.panelId });
    } catch {
      outcome = 'failed';
    }
    push(
      outcome === 'sent'
        ? 'resent'
        : outcome === 'blocked-full'
          ? 'blocked-full'
          : outcome === 'partial'
            ? 'partial'
            : outcome === 'too-large'
              ? 'too-large'
              : 'resend-failed',
    );
  }
  await pruneMarkers(area, now);
  return reports;
}

/** Housekeeping on MARKERS only. A draft is never dropped here. */
async function pruneMarkers(area: StorageArea, now: number): Promise<void> {
  try {
    const all = await area.get(null);
    const drop: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(STAGE_PREFIX)) continue;
      const rec = value as Partial<StageRecord>;
      const old = now - (rec?.at ?? 0) > RELEASED_MARKER_TTL_MS;
      const orphan = !(DRAFT_PREFIX + key.slice(STAGE_PREFIX.length) in all);
      if (old && (rec?.stage === 'released' || orphan)) drop.push(key);
    }
    if (drop.length) await locked(() => area.remove(drop));
  } catch {
    /* housekeeping only */
  }
}

/** A downloadable JSON copy of a retained draft (the user's way out when the store is full). */
export function exportDraftJson(draft: Draft): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      id: draft.id,
      meetingTitle: draft.meetingTitle,
      date: draft.date,
      duration: draft.duration,
      language: draft.language,
      speakerNames: draft.speakerNames,
      transcript: draft.transcript,
      segments: draft.segments,
    },
    null,
    2,
  );
}

// ─── Legacy `transcripts` (read-only view + verified copy to the Mac) ───

export const LEGACY_KEY = 'transcripts';

export interface LegacyTranscript {
  id: string;
  meetingTitle: string;
  date: string;
  duration: number;
  language?: string;
  transcript: string;
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
}

/** Read-only. Never writes. */
export async function readLegacyTranscripts(area: StorageArea): Promise<LegacyTranscript[]> {
  const r = await area.get(LEGACY_KEY);
  const list = r?.[LEGACY_KEY];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (t): t is LegacyTranscript => !!t && typeof t.id === 'string' && Array.isArray((t as LegacyTranscript).segments),
  );
}

export async function legacyCaptureId(t: LegacyTranscript): Promise<string> {
  // Content-addressed: an `acked` answer for this id can only be this content,
  // so a re-run (or an id collision) can never delete a different transcript.
  const hex = await sha256Hex(`${t.id}\n${t.meetingTitle}\n${t.transcript}`);
  return `legacy-${t.id}-${hex.slice(0, 12)}`;
}

export type LegacyOutcome =
  | 'copied' // acked and verified, local copy deleted
  | 'waiting' // sent, the Mac has not acked yet; run again later
  | 'skipped-large' // too big for a verified copy: local copy kept
  | 'skipped-empty'
  | 'no-ack-protocol' // server has no ack: nothing deleted
  | 'unreachable'
  | 'mismatch' // the server's copy differs from ours: nothing deleted
  | 'busy' // another import is running
  | 'error';

export interface LegacyReport {
  id: string;
  title: string;
  outcome: LegacyOutcome;
  detail?: string;
}

export interface LegacyOptions {
  now?: number;
  /** Poll the ack this many times (pollMs apart) before reporting 'waiting'. */
  polls?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Single-flight guard (navigator.locks in the browser). Return null when busy. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T | null>;
}

function deleteLegacyLocal(area: StorageArea, id: string): Promise<boolean> {
  return locked(async () => {
    const r = await area.get(LEGACY_KEY);
    const list = Array.isArray(r?.[LEGACY_KEY]) ? (r[LEGACY_KEY] as Array<{ id?: string }>) : [];
    const next = list.filter((t) => t?.id !== id);
    if (next.length === list.length) return true; // already gone
    if (next.length === 0) await area.remove(LEGACY_KEY);
    else await area.set({ [LEGACY_KEY]: next });
    const verify = await area.get(LEGACY_KEY);
    const after = Array.isArray(verify?.[LEGACY_KEY]) ? (verify[LEGACY_KEY] as Array<{ id?: string }>) : [];
    return !after.some((t) => t?.id === id);
  });
}

/**
 * Copy ONE legacy transcript to the Mac and delete the local copy only after the
 * server holds a copy identical to it (lines, hash, language, start) AND the Mac
 * acked it. Idempotent and resumable (the capture id is content-addressed).
 * Never deletes on any error.
 */
export async function importLegacyTranscript(
  area: StorageArea,
  api: LiveApi,
  t: LegacyTranscript,
  opts: LegacyOptions = {},
): Promise<LegacyReport> {
  const base = { id: t.id, title: t.meetingTitle || 'Untitled meeting' };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exp = await expectedOf(t, opts.now);
  if (exp.lines === 0) return { ...base, outcome: 'skipped-empty' };
  if (exp.tooLarge) {
    return {
      ...base,
      outcome: 'skipped-large',
      detail: `more than ${SERVER_MAX_CAPTIONS} lines or over the request size limit`,
    };
  }
  const captureId = await legacyCaptureId(t);

  const run = async (): Promise<LegacyReport> => {
    try {
      let st = await api.status(captureId);
      if (!st.ok) return { ...base, outcome: 'unreachable' };

      const needsSend = !(st.state === 'acked' || (st.state === 'finalized' && serverHoldsExpected(st, exp)));
      if (needsSend) {
        const f = await api.finalize(captureId, exp.payload);
        if (!f.ok) return { ...base, outcome: 'error', detail: 'finalize failed' };
        if (!f.ackRequired) return { ...base, outcome: 'no-ack-protocol' };
        if (f.captionCount !== exp.lines || f.captionHash !== exp.captionHash) {
          return {
            ...base,
            outcome: 'mismatch',
            detail: `server holds ${f.captionCount} lines, expected ${exp.lines}`,
          };
        }
      }

      const polls = opts.polls ?? 15;
      for (let i = 0; i <= polls; i += 1) {
        st = await api.status(captureId);
        if (!st.ok) return { ...base, outcome: 'unreachable' };
        if (st.state === 'acked') {
          if (!serverHoldsExpected(st, exp)) {
            return {
              ...base,
              outcome: 'mismatch',
              detail: 'the acked copy differs from the local one; local copy kept',
            };
          }
          const gone = await deleteLegacyLocal(area, t.id);
          return gone
            ? { ...base, outcome: 'copied' }
            : { ...base, outcome: 'error', detail: 'local delete could not be verified' };
        }
        if (st.state === 'expired') return { ...base, outcome: 'error', detail: 'the Mac did not confirm in time' };
        if (i < polls) await sleep(opts.pollMs ?? 2000);
      }
      return { ...base, outcome: 'waiting' };
    } catch (err) {
      return { ...base, outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  };

  if (!opts.withLock) return run();
  const r = await opts.withLock(run);
  return r ?? { ...base, outcome: 'busy' };
}

/** Run the verified copy over a user-selected list, sequentially. */
export async function importLegacyTranscripts(
  area: StorageArea,
  api: LiveApi,
  items: LegacyTranscript[],
  opts: LegacyOptions & { onProgress?: (r: LegacyReport) => void } = {},
): Promise<LegacyReport[]> {
  const out: LegacyReport[] = [];
  for (const t of items) {
    const r = await importLegacyTranscript(area, api, t, opts);
    out.push(r);
    opts.onProgress?.(r);
    // Stop the batch the moment the server is unreachable or lacks the protocol.
    if (r.outcome === 'unreachable' || r.outcome === 'no-ack-protocol' || r.outcome === 'busy') break;
  }
  return out;
}
