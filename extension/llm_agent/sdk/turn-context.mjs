// What this server has already put in front of the model in one SDK session.
//
// Why this exists: the Anthropic prompt cache is a prefix cache in the order
// tools → system → messages. The v2 engine resumes one SDK session per chat,
// so every turn re-sends the whole transcript after the system prompt — and a
// change ANYWHERE in the system prompt invalidates the cached transcript
// behind it, not just the block that changed. Session memory, the task list,
// the recent-issues list and attachments all used to live in the system
// prompt and change between turns, so a long chat re-wrote its entire history
// into the cache (billed at ~1.25× input) on most turns.
//
// Those blocks now ride in the user message instead (see buildEngineOptions),
// which the resumed transcript keeps. That makes re-sending them each turn a
// different cost — they would pile up in the history — so this module tracks,
// per SDK session, what was already delivered, and the engine sends only what
// is new or changed.
//
// In-process and best-effort by design: a server restart (or an evicted
// entry) forgets the state, and the next turn simply delivers everything
// once. A compaction (the SDK summarising the transcript) may drop earlier
// context blocks, so the engine forgets the session's state when it sees one.

import { createHash } from 'node:crypto';

// Bounded so a long-lived server can't grow without limit; oldest first out.
const MAX_SESSIONS = 500;
const delivered = new Map();

export function contentHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

export function emptyDelivered() {
  return { recentHash: null, taskHash: null, attachments: [], images: [] };
}

/** State already delivered in `sdkSessionId`, or null (fresh session / unknown). */
export function deliveredFor(sdkSessionId) {
  if (typeof sdkSessionId !== 'string' || !sdkSessionId) return null;
  const state = delivered.get(sdkSessionId);
  if (!state) return null;
  // Refresh recency so an active chat is not the one evicted.
  delivered.delete(sdkSessionId);
  delivered.set(sdkSessionId, state);
  return state;
}

export function commitDelivered(sdkSessionId, state, { previousSdkSessionId } = {}) {
  if (typeof sdkSessionId !== 'string' || !sdkSessionId || !state) return;
  if (previousSdkSessionId && previousSdkSessionId !== sdkSessionId) delivered.delete(previousSdkSessionId);
  delivered.delete(sdkSessionId);
  delivered.set(sdkSessionId, state);
  while (delivered.size > MAX_SESSIONS) delivered.delete(delivered.keys().next().value);
}

export function forgetDelivered(sdkSessionId) {
  if (typeof sdkSessionId === 'string') delivered.delete(sdkSessionId);
}

// Test-only: the map is module state shared across a test file.
export function __resetDeliveredForTest() {
  delivered.clear();
}
