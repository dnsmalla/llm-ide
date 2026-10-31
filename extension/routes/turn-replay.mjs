// In-memory replay buffer for running /agent/v2/stream turns, so a client that lost its stream (a webview
// reload) can list its running turns and re-attach. Nothing here is ever written to disk: a turn's events
// live in a bounded ring while it runs and for a short TTL after it ends, then are dropped.
//
// Tenancy: every buffer carries its owner's user id; every read compares it (never parses the key).
// Bounds: MAX_EVENTS events and MAX_BYTES serialized bytes per turn (oldest dropped first, `dropped` counts
// them), MAX_TURNS buffers in total, END_TTL_MS after a turn ends, MAX_SUBSCRIBERS attached readers per turn.
// Event sequence numbers are 1-based and count every event the turn emitted (a dropped event keeps its number),
// so `after=<n>` always means "everything after the n-th event".

export const MAX_EVENTS = 2000;
export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_TURNS = 64;
export const END_TTL_MS = 60_000;
export const MAX_SUBSCRIBERS = 4;
const MAX_EVENT_BYTES = 256 * 1024;   // one oversized event is replaced by a marker, never stored whole

const buffers = new Map();   // `${userId}\0${chatSessionId}` -> buffer
const keyOf = (userId, chatSessionId) => `${userId}\0${chatSessionId}`;

function sweep(now = Date.now()) {
  for (const [k, b] of buffers) if (b.endedAt !== null && now - b.endedAt > END_TTL_MS) buffers.delete(k);
}

/** Starts (replacing any ended predecessor) the buffer of a turn. Returns its recorder. */
export function openTurnReplay({ userId, chatSessionId, mode = null, startedAt = Date.now() }) {
  sweep();
  const key = keyOf(userId, chatSessionId);
  if (!buffers.has(key) && buffers.size >= MAX_TURNS) {
    // Evict the oldest ENDED buffer; running turns are never evicted (the in-flight lock bounds them).
    for (const [k, b] of buffers) if (b.endedAt !== null) { buffers.delete(k); break; }
  }
  const b = { userId, chatSessionId, mode, startedAt, endedAt: null, seq: 0, events: [], bytes: 0, dropped: 0, subs: new Set() };
  buffers.set(key, b);
  return {
    push(obj) {
      let line;
      try { line = JSON.stringify(obj); } catch { return; }
      if (line.length > MAX_EVENT_BYTES) line = JSON.stringify({ type: 'replay_truncated', originalType: typeof obj?.type === 'string' ? obj.type.slice(0, 40) : null });
      b.seq += 1;
      b.events.push({ seq: b.seq, line });
      b.bytes += line.length;
      while (b.events.length > MAX_EVENTS || b.bytes > MAX_BYTES) {
        const old = b.events.shift();
        b.bytes -= old.line.length;
        b.dropped += 1;
      }
      for (const sub of b.subs) { try { sub(b.seq, line); } catch { /* a dead reader never breaks the turn */ } }
    },
    end() {
      b.endedAt = Date.now();
      for (const sub of b.subs) { try { sub(null, null); } catch { /* ignore */ } }
      b.subs.clear();
    },
  };
}

/** This user's turns that are still running, oldest first. Nothing of other users is visible. */
export function listRunningTurns(userId) {
  const out = [];
  for (const b of buffers.values()) {
    if (b.userId !== userId || b.endedAt !== null) continue;
    out.push({ sessionId: b.chatSessionId, startedAt: new Date(b.startedAt).toISOString(), mode: b.mode });
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

/**
 * Attaches a reader: `onEvent(seq, jsonLine)` for each event after `after` (replayed first, then live),
 * `onEvent(null, null)` once when the turn ends; `onInfo({gap,dropped,ended})` runs first when events the reader asked for were dropped. Returns `{ detach, info }`, or null when there is no such turn
 * for this user or too many readers are attached (`{ full: true }`).
 */
export function attachTurnReplay(userId, chatSessionId, after, onEvent, onInfo = null) {
  sweep();
  const b = buffers.get(keyOf(userId, chatSessionId));
  if (!b || b.userId !== userId) return null;
  if (b.endedAt === null && b.subs.size >= MAX_SUBSCRIBERS) return { full: true };
  const from = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
  const firstKept = b.events.length ? b.events[0].seq : b.seq + 1;
  const info = { gap: from + 1 < firstKept ? firstKept - 1 - from : 0, dropped: b.dropped, ended: b.endedAt !== null };
  if (info.gap > 0 && onInfo) onInfo(info);
  for (const e of b.events) if (e.seq > from) onEvent(e.seq, e.line);
  if (b.endedAt !== null) { onEvent(null, null); return { detach() {}, info }; }
  b.subs.add(onEvent);
  return { detach() { b.subs.delete(onEvent); }, info };
}

/** Test seam. */
export function __resetTurnReplayForTest() { buffers.clear(); }
