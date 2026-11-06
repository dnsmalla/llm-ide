// Live caption stream — in-memory ring buffer of in-progress captures shared
// between authenticated clients of the same user. Used to mirror the Chrome
// extension's live transcript into the macOS desktop app while a meeting is
// still in progress.
//
// Crash recovery while live: every PERIODIC_FLUSH_MS the non-finalized capture is
// written to the `meetings` table (legacy; ingestMeeting is an upsert). Finalize
// (flag off, the default) deletes that row, as it always has. With
// LLMIDE_LIVE_ACK=1 a finalized capture is instead kept in live_crash_rows
// (kb/live-acks.mjs) and in memory until the Mac acks it (ackLiveSession). It is
// never a `meetings` row, so History, search and Library never see it early.
//
// Memory bounds:
//   - per-session cap of MAX_CAPTIONS_PER_SESSION rows
//   - live sessions older than SESSION_TTL_MS since last write are evicted
//   - with the ack flag, a finalized capture is held until acked, up to
//     UNACKED_TTL_MS (7 days), then expired loudly
//   - active-session list is computed on demand, not cached

import { EventEmitter } from 'events';
import crypto from 'node:crypto';
import { ingestMeeting, deleteMeeting } from '../kb/db.mjs';
import { emitOsEvent } from '../core/os-events.mjs';
import { redactSecretsForStorage } from '../core/redact-secrets.mjs';
import { AppError } from '../core/errors.mjs';
import { checkNoteKey } from '../kb/note-index.mjs';
import {
  getLiveAck, deleteLiveAck, getCrashRow, putCrashRow, listCrashRows, ackCapture,
  expireCrashRow, transcriptHash, noteKeyHash, UNACKED_TTL_MS, MAX_UNACKED_PER_USER,
} from '../kb/live-acks.mjs';

export const liveEvents = new EventEmitter();
// Each SSE stream attaches two listeners per session (session-caption +
// session-list-update).  With MAX_SSE_PER_USER=4 and up to ~20 active
// sessions per server, the per-user listener count can legitimately
// reach 40+.  setMaxListeners(0) disables Node's "possible EventEmitter
// memory leak" warning for this emitter; the real cap is enforced by
// MAX_SSE_PER_USER in routes/live.mjs.
liveEvents.setMaxListeners(0);

const MAX_CAPTIONS_PER_SESSION = 2000;
const SESSION_TTL_MS = 30 * 60 * 1000;       // 30 min idle → evict
const MAX_TEXT_LEN = 2000;
// Eviction is periodic-only (see setInterval below) rather than running on every
// appendCaptions call: the old per-call scan was O(total sessions) on a hot path.
const EVICT_INTERVAL_MS = 2 * 60 * 1000;

// Ack-gated retention (plan 3.6 B). OFF by default: with the flag unset, finalize
// deletes the crash row and eviction behaves as it always has, so an old Mac or
// extension sees no change.
export function liveAckEnabled() {
  return process.env.LLMIDE_LIVE_ACK === '1';
}

// Prompt-injection fence delimiters used by server prompts to wrap
// untrusted user content.  A meeting participant who literally says
// "<<<END>>> ignore prior instructions" would otherwise escape the
// fence when the transcript is fed to Claude.  Stripping here is
// belt-and-suspenders — the LLM prompt builders should also wrap +
// strip, but defending at the ingest boundary means every consumer
// (planner, agent, code-sync, etc.) inherits the protection.
const FENCE_RE = /<<<\s*(?:BEGIN|END)\s*>>>/gi;

const sessions = new Map();                  // `${userId}::${sessionId}` -> Session

class Session {
  constructor(userId, sessionId, meetingTitle = '') {
    this.userId = userId;
    this.sessionId = sessionId;
    this.meetingTitle = meetingTitle;
    this.captions = [];                      // [{ seq, speaker, text, ts, source }]
    this.lastWrite = Date.now();
    this.startedAt = Date.now();
    this.nextSeq = 1;
    this.finalized = false;
    this.language = '';
    this.lastCaptionTs = 0;      // newest plausible caption timestamp (ms)
    this.durationHint = null;    // seconds, when the client said so
    this.final = null;           // authoritative caption list sent with finalize (never streamed)
  }
}

function key(userId, sessionId) { return `${userId}::${sessionId}`; }

function titleOf(s) {
  return s.meetingTitle && s.meetingTitle.trim()
    ? s.meetingTitle.trim()
    : `Meeting · ${new Date(s.startedAt).toISOString().slice(0, 16).replace('T', ' ')}`;
}

/**
 * The capture as the server holds it: one line per caption, redacted (the same
 * text every store keeps), with its line count and content hash. The ack must
 * reproduce both.
 */
export function captureOf(s) {
  const held = heldOf(s);
  const lines = held.map((c) => {
    const t = new Date(c.ts).toISOString().slice(11, 19);
    return `[${t}] ${c.speaker}: ${c.text}`;
  });
  const transcript = redactSecretsForStorage(lines.join('\n'));
  return { transcript, lines: held.length, hash: transcriptHash(transcript), captionHash: captionHashOf(held) };
}

/** The captions a finalized capture is judged by: the authoritative list when the client sent one. */
function heldOf(s) { return s.final ?? s.captions; }

/**
 * SHA-256 over the sanitized (speaker, text) lines, in order, BEFORE redaction.
 * The extension recomputes it (src/lib/capture-store.ts captionHash) to prove the
 * server's copy equals what it sent. speaker and text carry no control chars
 * (sanitize), so NUL and newline are unambiguous separators.
 */
export function captionHashOf(captions) {
  return crypto.createHash('sha256')
    .update(captions.map((c) => `${c.speaker}\u0000${c.text}`).join('\n'), 'utf8')
    .digest('hex');
}

const MIN_PLAUSIBLE_TS = Date.UTC(2000, 0, 1);
const FUTURE_SLACK_MS = 5 * 60 * 1000;
export const plausibleTs = (n) => Number.isFinite(n) && n >= MIN_PLAUSIBLE_TS && n <= Date.now() + FUTURE_SLACK_MS;

/**
 * Optional capture metadata (additive API fields): startedAt (ms), language,
 * durationSec. A present but implausible value is a 400, never silently ignored,
 * so a client that wants it stored learns that it was not.
 */
export function validateCaptureMeta(body) {
  const out = {};
  if (body?.startedAt !== undefined && body.startedAt !== null) {
    if (!plausibleTs(body.startedAt)) {
      throw new AppError('VALIDATION_FAILED', 'startedAt must be a Unix ms timestamp after 2000 and not in the future', { status: 400 });
    }
    out.startedAt = body.startedAt;
  }
  if (body?.language !== undefined && body.language !== null && body.language !== '') {
    if (typeof body.language !== 'string' || !/^[A-Za-z0-9_-]{1,35}$/.test(body.language)) {
      throw new AppError('VALIDATION_FAILED', 'language must be a short language tag', { status: 400 });
    }
    out.language = body.language;
  }
  if (body?.durationSec !== undefined && body.durationSec !== null) {
    if (!Number.isFinite(body.durationSec) || body.durationSec < 0 || body.durationSec > 7 * 24 * 3600) {
      throw new AppError('VALIDATION_FAILED', 'durationSec must be between 0 and 7 days', { status: 400 });
    }
    out.durationSec = Math.round(body.durationSec);
  }
  return out;
}

function applyMeta(s, meta, acceptedCaptions = []) {
  if (meta.language) s.language = meta.language;
  if (meta.durationSec !== undefined) s.durationHint = meta.durationSec;
  if (meta.startedAt !== undefined) s.startedAt = meta.startedAt;
  else {
    // Without an explicit start the earliest plausible caption timestamp is it.
    for (const c of acceptedCaptions) {
      if (plausibleTs(c.ts) && c.ts < s.startedAt) s.startedAt = c.ts;
    }
  }
  for (const c of acceptedCaptions) {
    if (plausibleTs(c.ts) && c.ts > s.lastCaptionTs) s.lastCaptionTs = c.ts;
  }
}

function durationOf(s) {
  if (s.durationHint !== null) return s.durationHint;
  const end = s.lastCaptionTs > 0 ? s.lastCaptionTs : s.lastWrite;
  return Math.max(0, Math.round((end - s.startedAt) / 1000));
}

function evictOld() {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (s.finalized && liveAckEnabled()) {
      // Held until the Mac acks it, and expired (loudly) after UNACKED_TTL_MS.
      if (now - s.lastWrite > UNACKED_TTL_MS) {
        sessions.delete(k);
        try { expireCrashRow(s.userId, s.sessionId, { now }); } catch (err) {
          console.error(`[live] expire failed for ${s.sessionId}:`, err?.message || err);
        }
        console.error(`[live] EXPIRED unacked capture ${s.sessionId} (${s.captions.length} captions) after 7 days; the Mac never acked it`);
        emitOsEvent(s.userId, 'live-session');
      }
      continue;
    }
    if (now - s.lastWrite <= SESSION_TTL_MS) continue;
    sessions.delete(k);
    emitOsEvent(s.userId, 'live-session');
    // A session that never reached finalize (crashed tab, closed laptop)
    // can still have a periodic-flush row in `meetings` — without this,
    // finalized sessions would be the ONLY ones cleaned up and abandoned
    // sessions would be the ones that leak, the opposite of intent.
    try {
      deleteMeeting(s.userId, s.sessionId);
    } catch (err) {
      console.error(`[live-sessions] evict cleanup failed for ${s.sessionId}:`, err?.message || err);
    }
  }
}

function countMemoryFinalized(userId) {
  let n = 0;
  for (const s of sessions.values()) if (s.userId === userId && s.finalized) n += 1;
  return n;
}

function getOrCreate(userId, sessionId, meetingTitle) {
  const k = key(userId, sessionId);
  let s = sessions.get(k);
  if (!s) {
    // A durable capture under this id is still awaiting its ack: refuse rather
    // than let a new capture shadow (and eventually lose) it.
    if (getCrashRow(userId, sessionId)) {
      throw new AppError('UNACKED_CAPTURE', 'a finalized capture with this id is not acked yet', { status: 409 });
    }
    if (liveAckEnabled() && countMemoryFinalized(userId) >= MAX_UNACKED_PER_USER) {
      throw new AppError('TOO_MANY_UNACKED', 'too many finalized captures are waiting for the Mac to ack them', { status: 429 });
    }
    // A new capture supersedes any earlier ack for this id: the ack named the
    // old content, so it no longer describes this one.
    deleteLiveAck(userId, sessionId);
    s = new Session(userId, sessionId, meetingTitle);
    sessions.set(k, s);
    liveEvents.emit(`session-list-update-${userId}`);
    emitOsEvent(userId, 'live-session');
  } else if (meetingTitle && s.meetingTitle !== meetingTitle) {
    s.meetingTitle = meetingTitle;
    liveEvents.emit(`session-list-update-${userId}`);
    emitOsEvent(userId, 'live-session');
  }
  return s;
}

function sanitize(text, max = MAX_TEXT_LEN) {
  if (typeof text !== 'string') return '';
  // Strip C0 control chars + DEL, drop prompt-injection fence
  // delimiters (so a participant literally saying "<<<END>>>" can't
  // escape an LLM prompt fence), and collapse repeated whitespace.
  return text
    .replace(/[ -]/g, ' ')
    .replace(FENCE_RE, '')
    .replace(/\s+/g, ' ')
    .slice(0, max)
    .trim();
}

/**
 * The server's intake rules for a batch of captions: sanitize speaker and text,
 * drop empties, and (when `dedupe`) drop any (speaker, text) already seen in
 * `recent` OR earlier in the same batch. The extension mirrors this (capture-store.ts
 * expectedCapture); tests/capture-canon-parity.test.mjs keeps the two equal.
 */
function normalizeBatch(captions, recent = new Set(), dedupe = true) {
  const seen = new Set(recent);
  const out = [];
  for (const c of captions) {
    const speaker = sanitize(c?.speaker, 80);
    const text = sanitize(c?.text);
    if (!speaker || !text) continue;
    const fp = `${speaker}\x00${text}`;
    if (dedupe && seen.has(fp)) continue;
    seen.add(fp);
    // Optional meta payload — used by agent-question captions to carry the
    // LLM's grounding info. Whitelist fields and cap sizes.
    let meta;
    if (c?.meta && typeof c.meta === 'object') {
      meta = {};
      if (typeof c.meta.planTaskId === 'string') meta.planTaskId = c.meta.planTaskId.slice(0, 64);
      if (Number.isFinite(c.meta.score))         meta.score = Math.max(0, Math.min(1, c.meta.score));
      if (typeof c.meta.reason === 'string')     meta.reason = c.meta.reason.slice(0, 200);
      if (Object.keys(meta).length === 0) meta = undefined;
    }
    out.push({
      speaker,
      text,
      ts: Number.isFinite(c?.ts) ? c.ts : Date.now(),
      source: typeof c?.source === 'string' ? c.source.slice(0, 40) : 'unknown',
      ...(meta ? { meta } : {}),
    });
  }
  return out;
}

export function appendCaptions(userId, sessionId, captions, meetingTitle = '', captureMeta = {}) {
  if (!userId || !sessionId) throw new Error('userId and sessionId required');
  if (!Array.isArray(captions) || captions.length === 0) return { sequence: 0, accepted: 0 };
  const s = getOrCreate(userId, sessionId, meetingTitle);
  if (s.finalized) {
    // Late writes after finalize are dropped — the persisted meeting
    // is already authoritative.  Caller can detect this state via
    // the `finalized: true` field on a subsequent GET.
    return { sequence: s.nextSeq - 1, accepted: 0, finalized: true };
  }
  // Deduplication window — a fingerprint (speaker+text) of the last N captions,
  // so identical entries from a retry-storm or reconnect don't accumulate. We
  // compare against the tail only (not the full buffer) so a speaker repeating
  // the same phrase later still gets recorded.
  const DEDUP_WINDOW = 10;
  const recent = new Set(s.captions.slice(-DEDUP_WINDOW).map((c) => `${c.speaker}\x00${c.text}`));
  const fresh = normalizeBatch(captions, recent);
  for (const c of fresh) {
    s.captions.push({ seq: s.nextSeq++, ...c });
    if (s.captions.length > MAX_CAPTIONS_PER_SESSION) {
      s.captions.shift();                    // drop oldest, keep tail
    }
  }
  const accepted = fresh.length;
  applyMeta(s, captureMeta, fresh);
  s.lastWrite = Date.now();
  if (accepted > 0) {
    liveEvents.emit(`session-caption-${sessionId}`);
  }
  // Surface backpressure when the ring buffer is full enough that older
  // captions are about to be dropped on the next push.  Callers (bot-
  // worker caption pump, fast-typing speakers) can throttle their
  // producer side instead of silently losing the tail.
  const backpressure = s.captions.length >= Math.floor(MAX_CAPTIONS_PER_SESSION * 0.9);
  return { sequence: s.nextSeq - 1, accepted, backpressure };
}

export function getCaptionsSince(userId, sessionId, sinceSeq = 0) {
  const s = sessions.get(key(userId, sessionId));
  if (!s) return { captions: [], sequence: 0, finalized: false, exists: false };
  const since = Number.isFinite(sinceSeq) ? Math.max(0, sinceSeq) : 0;
  const captions = since > 0 ? s.captions.filter((c) => c.seq > since) : s.captions.slice();
  return {
    captions,
    sequence: s.nextSeq - 1,
    finalized: s.finalized,
    exists: true,
    meetingTitle: s.meetingTitle,
    startedAt: s.startedAt,
  };
}

export function listActiveSessions(userId) {
  // No evictOld() here — periodic eviction handles cleanup without the
  // O(total sessions) cost on every session-list query.
  const out = [];
  for (const s of sessions.values()) {
    if (s.userId !== userId) continue;
    if (s.finalized) continue;
    out.push({
      sessionId: s.sessionId,
      meetingTitle: s.meetingTitle,
      startedAt: s.startedAt,
      lastWrite: s.lastWrite,
      captionCount: s.captions.length,
      sequence: s.nextSeq - 1,
    });
  }
  // Most-recently-active first — the Mac app subscribes to the top.
  out.sort((a, b) => b.lastWrite - a.lastWrite);
  return out;
}

export const MAX_FINAL_CAPTIONS = MAX_CAPTIONS_PER_SESSION;

/**
 * Finalize. With `final.captions` the client sends its COMPLETE transcript: it
 * becomes the authoritative held copy (what the crash row, the unacked list and
 * the ack verify) without touching the streamed buffer the Mac mirror follows.
 * Without it, the streamed buffer is held as before. Optional startedAt,
 * language and durationSec describe the capture (validated by the caller).
 */
export function finalizeSession(userId, sessionId, final = null) {
  let s = sessions.get(key(userId, sessionId));
  const wantsReplace = Array.isArray(final?.captions);
  if (!s && !wantsReplace) return null;
  if (wantsReplace) {
    // Lossless: a transcript the client says is complete keeps its repeated lines
    // ("はい。" twice); only the live stream dedupes.
    const list = normalizeBatch(final.captions, new Set(), false);
    if (list.length > MAX_FINAL_CAPTIONS) {
      throw new AppError('CAPTURE_TOO_LARGE', `a capture holds at most ${MAX_FINAL_CAPTIONS} lines; this one has ${list.length}`, { status: 413 });
    }
    if (!s) {
      // A capture that never streamed (legacy import, crash re-send). A durable
      // unacked row under this id is REPLACED by the new finalize (putCrashRow
      // is INSERT OR REPLACE), and an earlier ack is superseded: the new content
      // is a new capture.
      if (liveAckEnabled() && countMemoryFinalized(userId) >= MAX_UNACKED_PER_USER) {
        throw new AppError('TOO_MANY_UNACKED', 'too many finalized captures are waiting for the Mac to ack them', { status: 429 });
      }
      deleteLiveAck(userId, sessionId);
      s = new Session(userId, sessionId, typeof final.meetingTitle === 'string' ? final.meetingTitle.slice(0, 300) : '');
      sessions.set(key(userId, sessionId), s);
      s.captions = list.map((c) => ({ seq: s.nextSeq++, ...c }));
    } else if (typeof final.meetingTitle === 'string' && final.meetingTitle) {
      s.meetingTitle = final.meetingTitle.slice(0, 300);
    }
    s.final = list;
    applyMeta(s, final, list);
  } else {
    applyMeta(s, final || {}, []);
  }
  s.finalized = true;
  s.lastWrite = Date.now();
  liveEvents.emit(`session-list-update-${userId}`);
  emitOsEvent(userId, 'live-session');

  if (liveAckEnabled()) return finalizeHeldForAck(s);

  // Drop any `meetings` row a periodic flush may have written while this
  // session was live — the DB copy only ever existed as crash-recovery
  // (see file header). Failures here don't fail finalize.
  let dbCleaned = false;
  let cleanupError = null;
  try {
    deleteMeeting(s.userId, s.sessionId);
    dbCleaned = true;
  } catch (err) {
    cleanupError = err?.message || String(err);
    console.error(`[live-sessions] post-finalize DB cleanup failed for ${sessionId}:`, cleanupError);
  }

  return {
    sessionId,
    finalized: true,
    captionCount: heldOf(s).length,
    captionHash: captionHashOf(heldOf(s)),
    dbCleaned,
    cleanupError,
  };
}

/** Flag-on finalize: the capture becomes a durable row (if the user is within bounds). */
function finalizeHeldForAck(s) {
  let durable = false;
  let reason = null;
  let expiresAt = null;
  let cleanupError = null;
  const held = heldOf(s);
  if (held.length > 0) {
    const cap = captureOf(s);
    try {
      const r = putCrashRow(s.userId, s.sessionId, {
        title: titleOf(s), startedAt: new Date(s.startedAt).toISOString(),
        durationSec: durationOf(s),
        transcript: cap.transcript, lines: cap.lines, captionHash: cap.captionHash, language: s.language,
      });
      durable = r.durable;
      reason = r.reason ?? null;
      expiresAt = r.expiresAt ?? null;
    } catch (err) {
      cleanupError = err?.message || String(err);
      console.error(`[live-sessions] finalized capture write failed for ${s.sessionId}:`, cleanupError);
    }
    if (!durable) {
      console.error(`[live-sessions] NOT DURABLE: ${s.sessionId} is held in memory only (${reason || 'write failed'}); it is lost if the server restarts before the Mac acks it`);
    }
  }
  // The periodic `meetings` copy of a live capture is removed only once the
  // durable copy exists; otherwise it is the last copy and stays.
  if (durable) {
    try { deleteMeeting(s.userId, s.sessionId); } catch (err) {
      console.error(`[live-sessions] periodic row cleanup failed for ${s.sessionId}:`, err?.message || err);
    }
  }
  return {
    sessionId: s.sessionId,
    finalized: true,
    captionCount: held.length,
    captionHash: captionHashOf(held),
    dbCleaned: durable,
    cleanupError,
    ackRequired: true,
    durable,
    reason,
    expiresAt,
  };
}

/// Build a meeting transcript string + participants list from the
/// in-memory captions and write a single row to the meetings table.
/// Only called by the periodic crash-recovery flush below, while a
/// session is still live — never by finalizeSession(), which deletes
/// the row instead of writing it. Entity rows are not produced here.
function persistCapturedMeeting(s) {
  if (!s.userId || !s.sessionId) return;
  const captions = s.captions || [];
  if (captions.length === 0) return;     // nothing to save

  // Transcript: "[HH:MM:SS] Speaker: text" lines, time-ordered.
  // Mirrors what the extension's "Save" .txt download produces.
  const lines = captions.map((c) => {
    const t = new Date(c.ts).toISOString().slice(11, 19);
    return `[${t}] ${c.speaker}: ${c.text}`;
  });
  const transcript = lines.join('\n');

  // Participants: unique speakers, in first-seen order.
  const seen = new Set();
  const participants = [];
  for (const c of captions) {
    if (!seen.has(c.speaker)) {
      seen.add(c.speaker);
      participants.push(c.speaker);
    }
  }

  const durationSec = Math.max(0, Math.round((s.lastWrite - s.startedAt) / 1000));
  ingestMeeting(s.userId, {
    id: s.sessionId,
    title: titleOf(s),
    date: new Date(s.startedAt).toISOString(),
    duration: durationSec,
    language: null,
    participants,
    transcript,
    entities: [],     // entity extraction happens later via Actions tab
  });
}

// Periodic SQLite flush — persist every active non-finalized session
// once per minute so a server crash can't lose more than ~60 seconds
// of captions.  `persistCapturedMeeting` calls `ingestMeeting` which
// is an upsert, so repeated calls for the same session are safe.
// `.unref()` means this timer won't prevent a clean process exit.
const PERIODIC_FLUSH_MS = 60_000;
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.finalized && s.captions.length > 0) {
      try { persistCapturedMeeting(s); } catch (err) {
        // Log instead of silently swallowing — a persistent failure here
        // means captions are being lost between flushes and the operator
        // needs to know.
        console.error(`[live-sessions] periodic persist failed for ${s.sessionId}:`, err?.message || err);
      }
    }
  }
}, PERIODIC_FLUSH_MS).unref();

// Periodic TTL eviction — runs every 2 minutes instead of on every
// appendCaptions call.
setInterval(evictOld, EVICT_INTERVAL_MS).unref();

/**
 * Acknowledge a finalized capture the Mac has written and verified. The server
 * recomputes the capture's line count and hash and accepts the ack only when
 * both match (409 ACK_MISMATCH otherwise, nothing deleted). An ack for a capture
 * that is still live, or unknown, returns null (404). Repeating the same ack is
 * idempotent; a different ack for an acked id is 409.
 */
export function ackLiveSession(userId, sessionId, { noteKey, hash, lines }) {
  if (!userId || !sessionId) throw new Error('userId and sessionId required');
  const key0 = checkNoteKey(noteKey);
  const s = sessions.get(key(userId, sessionId));
  if (s && !s.finalized) return null;

  const existing = getLiveAck(userId, sessionId);
  if (existing) {
    if (existing.outcome === 'acked' && existing.note_key_hash === noteKeyHash(key0)
      && existing.content_hash === hash && existing.lines === lines) {
      return { sessionId, state: 'acked', ackedAt: existing.acked_at, idempotent: true };
    }
    throw new AppError('ACK_MISMATCH', 'this capture was already acked with different content; nothing was deleted', { status: 409 });
  }

  let current = null;
  if (s && s.finalized) current = { ...captureOf(s), language: s.language, startedAt: new Date(s.startedAt).toISOString() };
  else {
    const row = getCrashRow(userId, sessionId);
    if (row) current = { transcript: row.transcript, lines: row.lines, hash: row.content_hash, captionHash: row.caption_hash, language: row.language, startedAt: row.started_at };
  }
  if (!current) return null;
  if (current.lines !== lines || current.hash !== hash) {
    throw new AppError('ACK_MISMATCH', 'the acked line count or hash does not match the capture the server holds; nothing was deleted', {
      status: 409,
      details: { serverLines: current.lines, serverHash: current.hash },
    });
  }
  // One transaction: the ack is recorded and the durable copy deleted, or neither.
  const row = ackCapture(userId, sessionId, {
    noteKey: key0, hash, lines,
    captionHash: current.captionHash || '', language: current.language || '', startedAt: current.startedAt || '',
  });
  if (s) {
    sessions.delete(key(userId, sessionId));
    liveEvents.emit(`session-list-update-${userId}`);
    emitOsEvent(userId, 'live-session');
  }
  return { sessionId, state: 'acked', ackedAt: row.acked_at, idempotent: false };
}

/**
 * Where a capture stands. A live session wins over any ack (a late append
 * supersedes the old ack). State is 'live', 'finalized', 'acked', 'expired' or
 * 'unknown'; `durable` says whether a restart would keep the capture.
 */
export function liveSessionStatus(userId, sessionId) {
  const s = sessions.get(key(userId, sessionId));
  if (s && !s.finalized) return { state: 'live', durable: false, expiresAt: null };
  const ack = getLiveAck(userId, sessionId);
  if (ack) {
    if (ack.outcome === 'expired') return { state: 'expired', durable: false, expiresAt: null };
    return {
      state: 'acked', durable: false, expiresAt: null,
      lines: ack.lines, hash: ack.content_hash, captionHash: ack.caption_hash || null,
      language: ack.language, startedAt: ack.started_at ? Date.parse(ack.started_at) : null,
    };
  }
  const row = getCrashRow(userId, sessionId);
  if (s && s.finalized) {
    const cap = captureOf(s);
    return {
      state: 'finalized', durable: !!row, expiresAt: row?.expires_at ?? null,
      lines: cap.lines, hash: cap.hash, captionHash: cap.captionHash,
      language: s.language, startedAt: s.startedAt,
    };
  }
  if (row) {
    return {
      state: 'finalized', durable: true, expiresAt: row.expires_at,
      lines: row.lines, hash: row.content_hash, captionHash: row.caption_hash || null,
      language: row.language, startedAt: Date.parse(row.started_at),
    };
  }
  return { state: 'unknown', durable: false, expiresAt: null };
}

/**
 * Finalized captures not yet acked, with the line count and hash the Mac must
 * echo in its ack: the in-memory ones and the durable rows (which survive a
 * restart; their transcript is read from the row).
 */
export function listUnackedLiveSessions(userId) {
  const out = [];
  const seen = new Set();
  for (const s of sessions.values()) {
    if (s.userId !== userId || !s.finalized) continue;
    seen.add(s.sessionId);
    const cap = captureOf(s);
    out.push({
      sessionId: s.sessionId,
      meetingTitle: s.meetingTitle,
      startedAt: s.startedAt,
      captionCount: heldOf(s).length,
      lines: cap.lines,
      language: s.language,
      hash: cap.hash,
      durable: !!getCrashRow(userId, s.sessionId),
      source: 'memory',
    });
  }
  for (const r of listCrashRows(userId)) {
    if (seen.has(r.session_id)) continue;
    out.push({
      sessionId: r.session_id,
      meetingTitle: r.title,
      startedAt: r.started_at,
      captionCount: null,
      lines: r.lines,
      hash: r.content_hash,
      durationSec: r.duration_sec,
      language: r.language,
      durable: true,
      expiresAt: r.expires_at,
      source: 'database',
    });
  }
  return out;
}

const HELD_LINE = /^\[(\d{2}:\d{2}:\d{2})\] (.+?): (.*)$/;

/**
 * Rows of a held transcript ("[HH:MM:SS] Speaker: text", UTC times, as captureOf builds it). A line that does not
 * parse is dropped, so a caller compares rows.length with the capture's line count and refuses a mismatch.
 * shortcut: a speaker name that itself contains ": " splits early (the text keeps the rest, nothing is lost);
 * store structured rows in live_crash_rows if that ever shows up.
 */
export function rowsOfTranscript(transcript) {
  const out = [];
  for (const line of String(transcript || '').split('\n')) {
    const m = HELD_LINE.exec(line);
    if (m) out.push({ time: m[1], speaker: m[2], text: m[3] });
  }
  return out;
}

/**
 * The held (redacted) copy of a finalized capture nobody has acked yet, for the desktop archivist
 * (GET /kb/live/:id/capture). Null while it is live, once acked or expired (expires_at passed), or when unknown to
 * this user.
 * `lines` and `hash` are exactly what the ack must echo.
 */
export function liveCaptureOf(userId, sessionId) {
  if (!userId || !sessionId) throw new Error('userId and sessionId required');
  const s = sessions.get(key(userId, sessionId));
  if (s && !s.finalized) return null;
  if (getLiveAck(userId, sessionId)) return null;
  if (s) {
    const cap = captureOf(s);
    return {
      sessionId, title: titleOf(s), startedAt: s.startedAt, durationSec: durationOf(s), language: s.language || '',
      lines: cap.lines, hash: cap.hash, rows: rowsOfTranscript(cap.transcript),
    };
  }
  const row = getCrashRow(userId, sessionId);
  // Past its TTL it is expired (expireCrashRows may not have run yet): never handed out for archiving.
  if (!row || !(Date.parse(row.expires_at) > Date.now())) return null;
  const startedAt = Date.parse(row.started_at);
  return {
    sessionId, title: row.title, startedAt: Number.isFinite(startedAt) ? startedAt : null, durationSec: row.duration_sec,
    language: row.language || '', lines: row.lines, hash: row.content_hash, rows: rowsOfTranscript(row.transcript),
  };
}

// For the test runner — never called from production code.
export function _resetForTests() { sessions.clear(); }

// Forces an eviction sweep synchronously so evictOld()'s paths are
// exercisable without waiting for the real periodic timer.
export function _evictNowForTests() { evictOld(); }

// Backdates a session's lastWrite so the next _evictNowForTests() call
// treats it as idle past its TTL.
export function _backdateForTests(userId, sessionId, ageMs) {
  const s = sessions.get(key(userId, sessionId));
  if (s) s.lastWrite = Date.now() - ageMs;
}
