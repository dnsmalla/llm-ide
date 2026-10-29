// The extension keeps NOTHING of its own (live-then-archive plan 0.1 rule 5,
// Q18). The one exception is a meeting CAPTURE DRAFT: `transcriptDraft:<id>`
// holds a capture until the server reports it acked (the Mac app wrote the
// note and verified it). Everything here is pure logic over injected
// dependencies (a chrome.storage-like area and a live API), so it runs under
// the Node test runner with no browser.
//
// Data-loss rule: a draft is deleted ONLY when the server answers
// `state: 'acked'` for a capture this panel finalized. An unreachable server,
// an unknown state, an expired state, a missing ack feature and every error all
// KEEP the draft. This file must never import runtime code (tests load it
// directly under --experimental-strip-types); types only.

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
}

/**
 * recording: still capturing (or the panel died before Stop).
 * finalizing: Stop pressed, the server may not have confirmed finalize.
 * awaiting-ack: the server holds it and requires the Mac's ack (flag on).
 * no-ack: the server has no ack protocol (flag off): the local copy is KEPT, it
 *   can never be proven copied, so it is never deleted on a guess.
 * released: acked; the draft is gone (this marker stops a late checkpoint write
 *   from resurrecting it).
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
export type StatusResult = { ok: true; state: LiveState; durable: boolean } | { ok: false };
export interface FinalizeResult {
  ok: boolean;
  /** true only when the server said so: the ack protocol is on (flag on). */
  ackRequired: boolean;
  captionCount: number;
  durable: boolean;
}
export interface AppendResult {
  ok: boolean;
  accepted: number;
  /** The server already finalized this id; late writes are dropped. */
  finalized: boolean;
}
export interface CaptionInput {
  speaker: string;
  text: string;
  ts: number;
  source: string;
}
export interface LiveApi {
  status(id: string): Promise<StatusResult>;
  append(id: string, meetingTitle: string, captions: CaptionInput[]): Promise<AppendResult>;
  finalize(id: string): Promise<FinalizeResult>;
}

export const DRAFT_PREFIX = 'transcriptDraft:';
export const STAGE_PREFIX = 'draftStage:';
// A live panel rewrites its draft every few seconds; one untouched this long
// belongs to a panel that is gone and is safe to recover.
export const DRAFT_STALE_MS = 2 * 60 * 1000;
/** How many flag-off (no-ack) local copies are kept; the oldest beyond this go. */
export const MAX_NO_ACK_DRAFTS = 50;
/** A 'released' marker is only a guard against a late write; drop it after a week. */
export const RELEASED_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The server's per-session ring buffer; a longer capture would be truncated there. */
export const SERVER_MAX_CAPTIONS = 2000;
/** The server's append body limit is 4 MB; stay well under it. */
export const MAX_APPEND_BODY_BYTES = 3 * 1024 * 1024;

interface StageRecord {
  stage: DraftStage;
  at: number;
}

// ─── Draft storage ───────────────────────────────────────────────────

export async function getDraftStage(area: StorageArea, id: string): Promise<DraftStage | null> {
  const r = await area.get(STAGE_PREFIX + id);
  const rec = r?.[STAGE_PREFIX + id] as Partial<StageRecord> | undefined;
  return rec && typeof rec.stage === 'string' && rec.stage in STAGE_RANK ? (rec.stage as DraftStage) : null;
}

/** Monotonic: a stage never moves backwards (two panels, retries, late writes). */
export async function setDraftStage(area: StorageArea, id: string, stage: DraftStage, now = Date.now()): Promise<void> {
  const current = await getDraftStage(area, id);
  if (current && STAGE_RANK[current] > STAGE_RANK[stage]) return;
  // no-ack and awaiting-ack are the same rank: the first decision wins, since
  // both come from the same finalize response.
  if (current && STAGE_RANK[current] === STAGE_RANK[stage] && current !== stage) return;
  await area.set({ [STAGE_PREFIX + id]: { stage, at: now } satisfies StageRecord });
}

/** Writes (or refreshes) the draft. A no-op once the capture was released. */
export async function saveTranscriptDraft(
  area: StorageArea,
  input: Omit<Draft, 'updatedAt'>,
  now = Date.now(),
): Promise<void> {
  if ((await getDraftStage(area, input.id)) === 'released') return;
  const draft: Draft = { ...input, updatedAt: now };
  await area.set({ [DRAFT_PREFIX + input.id]: draft });
}

/** Release: the draft is gone, a marker remains so a late checkpoint cannot recreate it. */
async function releaseDraft(area: StorageArea, id: string, now: number): Promise<void> {
  await area.set({ [STAGE_PREFIX + id]: { stage: 'released', at: now } satisfies StageRecord });
  await area.remove(DRAFT_PREFIX + id);
}

/** Explicit user delete of a retained local copy. */
export async function deleteDraft(area: StorageArea, id: string): Promise<void> {
  await area.remove([DRAFT_PREFIX + id, STAGE_PREFIX + id]);
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
    const rec = all[STAGE_PREFIX + value.id] as Partial<StageRecord> | undefined;
    const stage: DraftStage = rec && typeof rec.stage === 'string' && rec.stage in STAGE_RANK ? rec.stage : 'recording';
    out.push({ draft: { ...value, updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0 }, stage });
  }
  return out.sort((a, b) => a.draft.updatedAt - b.draft.updatedAt);
}

// ─── Release ──────────────────────────────────────────────────────────

export type DraftOutcome =
  | 'released' // acked: draft deleted
  | 'waiting' // the server holds it, the Mac has not acked yet
  | 'not-durable' // held in server memory only; keep
  | 'unreachable' // status unknown: keep
  | 'not-confirmed' // server has no record / expired: keep, needs a resend
  | 'retained' // flag-off copy: kept, no ack exists
  | 'active' // a live panel is recording it
  | 'resent' // re-pushed and finalized
  | 'resend-failed';

export interface DraftReport {
  id: string;
  title: string;
  stage: DraftStage;
  outcome: DraftOutcome;
}

export function toCaptions(segments: TranscriptSegment[]): CaptionInput[] {
  const out: CaptionInput[] = [];
  for (const s of segments) {
    if (!s?.speaker || !s?.text) continue;
    out.push({ speaker: s.speaker, text: s.text, ts: s.timestamp, source: 'extension-cc' });
  }
  return out;
}

/** Applies a finalize response to the stage. captionCount 0 means the server had nothing: keep 'finalizing'. */
export async function recordFinalize(area: StorageArea, id: string, r: FinalizeResult, now = Date.now()): Promise<void> {
  if (!r.ok || r.captionCount === 0) return; // stays 'finalizing': the release loop re-sends
  await setDraftStage(area, id, r.ackRequired ? 'awaiting-ack' : 'no-ack', now);
}

/** Re-push a whole draft and finalize it (crash recovery, or a manual resend). Never deletes. */
export async function resendDraft(area: StorageArea, api: LiveApi, entry: DraftEntry, now = Date.now()): Promise<boolean> {
  const { draft } = entry;
  const captions = toCaptions(draft.segments);
  if (captions.length === 0) return false;
  await setDraftStage(area, draft.id, 'finalizing', now);
  const st = await api.status(draft.id);
  if (!st.ok) return false;
  if (st.state === 'live' || st.state === 'finalized') {
    // The server already has (part of) this capture. Re-appending the whole
    // draft would duplicate lines, so only (re)finalize it.
    const f = await api.finalize(draft.id);
    await recordFinalize(area, draft.id, f, now);
    return f.ok;
  }
  if (st.state === 'acked') return true; // the next pass releases it
  // unknown / expired: the server has nothing: push the whole draft once.
  const a = await api.append(draft.id, draft.meetingTitle, captions);
  if (!a.ok) return false;
  const f = await api.finalize(draft.id);
  await recordFinalize(area, draft.id, f, now);
  return f.ok && f.captionCount > 0;
}

export interface ReconcileOptions {
  now?: number;
  /** Ids a panel is recording right now (never touched). */
  activeIds?: ReadonlySet<string>;
  /** Re-push stale/unfinalized drafts automatically (default true). */
  autoResend?: boolean;
}

/**
 * One pass over every draft. The only deletion is the `acked` branch, and only
 * for a capture this extension finalized (stage finalizing / awaiting-ack).
 */
export async function reconcileDrafts(
  area: StorageArea,
  api: LiveApi,
  opts: ReconcileOptions = {},
): Promise<DraftReport[]> {
  const now = opts.now ?? Date.now();
  const reports: DraftReport[] = [];
  for (const entry of await listDrafts(area)) {
    const { draft, stage } = entry;
    const base = { id: draft.id, title: draft.meetingTitle, stage };
    if (opts.activeIds?.has(draft.id)) {
      reports.push({ ...base, outcome: 'active' });
      continue;
    }
    if (stage === 'no-ack') {
      reports.push({ ...base, outcome: 'retained' });
      continue;
    }
    if (stage === 'recording' && now - draft.updatedAt < DRAFT_STALE_MS) {
      reports.push({ ...base, outcome: 'active' }); // a live panel is still checkpointing it
      continue;
    }
    let st: StatusResult;
    try {
      st = await api.status(draft.id);
    } catch {
      st = { ok: false };
    }
    if (!st.ok) {
      reports.push({ ...base, outcome: 'unreachable' });
      continue;
    }
    if (st.state === 'acked') {
      if (stage === 'finalizing' || stage === 'awaiting-ack') {
        try {
          await releaseDraft(area, draft.id, now);
          reports.push({ ...base, outcome: 'released' });
        } catch {
          reports.push({ ...base, outcome: 'waiting' }); // storage error: the draft stays
        }
      } else {
        // A stale draft that never finalized but whose id is acked: not this
        // capture (id reuse). Keep it, never trust the ack.
        reports.push({ ...base, outcome: 'not-confirmed' });
      }
      continue;
    }
    if (st.state === 'finalized' && stage === 'awaiting-ack') {
      reports.push({ ...base, outcome: st.durable ? 'waiting' : 'not-durable' });
      continue;
    }
    // A recording the server still receives (live): its panel may merely have a
    // failing checkpoint. Never finalize someone else's live capture; the
    // server's idle TTL turns it unknown if the panel is really gone.
    if (stage === 'recording' && st.state === 'live') {
      reports.push({ ...base, outcome: 'active' });
      continue;
    }
    // live / finalized (stage not yet awaiting) / unknown / expired.
    if (stage === 'awaiting-ack' || st.state === 'expired') {
      reports.push({ ...base, outcome: 'not-confirmed' });
      continue;
    }
    if (opts.autoResend === false) {
      reports.push({ ...base, outcome: 'not-confirmed' });
      continue;
    }
    // stage recording (stale) or finalizing, state live/unknown: re-push.
    let ok = false;
    try {
      ok = await resendDraft(area, api, entry, now);
    } catch {
      ok = false;
    }
    reports.push({ ...base, outcome: ok ? 'resent' : 'resend-failed' });
  }
  await pruneMarkers(area, now);
  return reports;
}

/** Drop the oldest flag-off copies beyond the cap and stale 'released' markers. */
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
    const noAck = (await listDrafts(area)).filter((e) => e.stage === 'no-ack');
    for (const e of noAck.slice(0, Math.max(0, noAck.length - MAX_NO_ACK_DRAFTS))) {
      drop.push(DRAFT_PREFIX + e.draft.id, STAGE_PREFIX + e.draft.id);
    }
    if (drop.length) await area.remove(drop);
  } catch {
    /* housekeeping only */
  }
}

// ─── Legacy `transcripts` (read-only view + verified copy to the Mac) ───

export const LEGACY_KEY = 'transcripts';
/** Keep a copy of a legacy item the Mac cannot take losslessly. */
export const LEGACY_IMPORT_PREFIX = 'legacyImport:';

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

// Mirrors the server's sanitize() + append dedupe (agents/live-sessions.mjs):
// control chars to space, fence markers dropped, whitespace collapsed, 2000
// chars; within ONE append call any repeat of (speaker, text) is dropped.
const FENCE_RE = /<<<\s*(?:BEGIN|END)\s*>>>/gi;
function serverSanitize(text: unknown, max = 2000): string {
  if (typeof text !== 'string') return '';
  return text
    // eslint-disable-next-line no-control-regex -- mirrors the server's sanitize()
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(FENCE_RE, '')
    .replace(/\s+/g, ' ')
    .slice(0, max)
    .trim();
}

export interface ExpectedCapture {
  /** What the server will hold after one append: sanitized, in-batch duplicates dropped. */
  lines: number;
  /** Captions that carry a speaker and text. */
  valid: number;
  /** valid - lines: lines the server merges away. >0 means the copy is not line-for-line. */
  merged: number;
}

export function expectedCapture(captions: CaptionInput[]): ExpectedCapture {
  const seen = new Set<string>();
  let valid = 0;
  for (const c of captions) {
    const speaker = serverSanitize(c.speaker, 80);
    const text = serverSanitize(c.text);
    if (!speaker || !text) continue;
    valid += 1;
    seen.add(`${speaker}\x00${text}`);
  }
  return { lines: seen.size, valid, merged: valid - seen.size };
}

export async function legacyCaptureId(t: LegacyTranscript): Promise<string> {
  // Content-addressed: an `acked` answer for this id can only be this content,
  // so a re-run (or an id collision) can never delete a different transcript.
  const data = new TextEncoder().encode(`${t.id}\n${t.meetingTitle}\n${t.transcript}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `legacy-${t.id}-${hex.slice(0, 12)}`;
}

export type LegacyOutcome =
  | 'copied' // acked, local copy deleted
  | 'waiting' // sent, the Mac has not acked yet; run again later
  | 'kept-merged' // acked but some lines were merged by the server: local copy KEPT
  | 'skipped-large' // too big for a verified copy: local copy kept
  | 'skipped-empty'
  | 'no-ack-protocol' // server has no ack: nothing sent, nothing deleted
  | 'unreachable'
  | 'mismatch' // server holds a different line count: nothing deleted
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

async function deleteLegacyLocal(area: StorageArea, id: string): Promise<boolean> {
  const r = await area.get(LEGACY_KEY);
  const list = Array.isArray(r?.[LEGACY_KEY]) ? (r[LEGACY_KEY] as Array<{ id?: string }>) : [];
  const next = list.filter((t) => t?.id !== id);
  if (next.length === list.length) return true; // already gone
  if (next.length === 0) await area.remove(LEGACY_KEY);
  else await area.set({ [LEGACY_KEY]: next });
  const verify = await area.get(LEGACY_KEY);
  const after = Array.isArray(verify?.[LEGACY_KEY]) ? (verify[LEGACY_KEY] as Array<{ id?: string }>) : [];
  return !after.some((t) => t?.id === id);
}

/**
 * Copy ONE legacy transcript to the Mac and delete the local copy only after
 * the server reports the capture acked. Idempotent and resumable: the capture
 * id is content-addressed, every step re-reads the server's status, and an
 * interrupted run just continues. Never deletes on any error.
 */
export async function importLegacyTranscript(
  area: StorageArea,
  api: LiveApi,
  t: LegacyTranscript,
  opts: LegacyOptions = {},
): Promise<LegacyReport> {
  const base = { id: t.id, title: t.meetingTitle || 'Untitled meeting' };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const captions = toCaptions(t.segments);
  const exp = expectedCapture(captions);
  if (exp.valid === 0) return { ...base, outcome: 'skipped-empty' };
  if (exp.lines > SERVER_MAX_CAPTIONS) {
    return { ...base, outcome: 'skipped-large', detail: `${exp.lines} lines exceed the server's ${SERVER_MAX_CAPTIONS}-line capture buffer` };
  }
  if (new TextEncoder().encode(JSON.stringify(captions)).length > MAX_APPEND_BODY_BYTES) {
    return { ...base, outcome: 'skipped-large', detail: 'too large to send in one request' };
  }
  const captureId = await legacyCaptureId(t);

  const run = async (): Promise<LegacyReport> => {
    try {
      let st = await api.status(captureId);
      if (!st.ok) return { ...base, outcome: 'unreachable' };

      if (st.state === 'unknown' || st.state === 'expired') {
        const a = await api.append(captureId, base.title, captions);
        if (!a.ok) return { ...base, outcome: 'error', detail: 'append failed' };
        if (a.accepted !== exp.lines && !a.finalized) {
          return { ...base, outcome: 'mismatch', detail: `server accepted ${a.accepted} of ${exp.lines} lines` };
        }
      } else if (st.state === 'live') {
        // A crashed earlier attempt (append is one atomic call, so the server
        // holds all of it or none): finalize what is there, verified below.
      }

      if (st.state !== 'finalized' && st.state !== 'acked') {
        const f = await api.finalize(captureId);
        if (!f.ok) return { ...base, outcome: 'error', detail: 'finalize failed' };
        if (!f.ackRequired) return { ...base, outcome: 'no-ack-protocol' };
        if (f.captionCount !== exp.lines) {
          return { ...base, outcome: 'mismatch', detail: `server holds ${f.captionCount} lines, expected ${exp.lines}` };
        }
      }

      const polls = opts.polls ?? 15;
      for (let i = 0; i <= polls; i += 1) {
        st = await api.status(captureId);
        if (!st.ok) return { ...base, outcome: 'unreachable' };
        if (st.state === 'acked') {
          if (exp.merged > 0) {
            return { ...base, outcome: 'kept-merged', detail: `${exp.merged} repeated line(s) were merged on the Mac; local copy kept` };
          }
          const gone = await deleteLegacyLocal(area, t.id);
          return gone ? { ...base, outcome: 'copied' } : { ...base, outcome: 'error', detail: 'local delete could not be verified' };
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
