// In-process change bus for the System view's live channel (GET /kb/os/stream).
//
// Producers call emitOsEvent(userId, type) at the moment a row or registry
// entry changes; the stream route turns each notification into a `{ type, at }`
// SSE event and the client re-fetches GET /kb/os/state. The bus carries no
// payload data: an `extra` object is accepted for future producers, but the
// route only ever sends `type` and `at`.
//
// Layer L0: Node built-ins only. Emitting never throws into the caller and
// costs one listener-count check + one emit (O(1) in the number of events).
import { EventEmitter } from 'events';

export const OS_EVENT_TYPES = Object.freeze([
  'activity',
  'usage',
  'turn-start',
  'turn-end',
  'agent-run',
  'live-session',
]);

const bus = new EventEmitter();
// One listener per open stream; the per-user cap in the route bounds them.
bus.setMaxListeners(0);

const channel = (userId) => `os:${userId}`;

/** Notify this user's subscribers that `type` changed. Never throws. */
export function emitOsEvent(userId, type, extra) {
  try {
    if (!userId || !OS_EVENT_TYPES.includes(type)) return;
    if (bus.listenerCount(channel(userId)) === 0) return;
    bus.emit(channel(userId), { type, at: Date.now(), ...(extra && typeof extra === 'object' ? extra : {}) });
  } catch {
    // A notification must never break the operation that triggered it.
  }
}

/** Subscribe to this user's events. Returns an idempotent unsubscribe function. */
export function onOsEvent(userId, fn) {
  const name = channel(userId);
  bus.on(name, fn);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    bus.off(name, fn);
  };
}

/** Test seam: how many subscribers a user has (0 after every cleanup). */
export function osEventListenerCount(userId) {
  return bus.listenerCount(channel(userId));
}
