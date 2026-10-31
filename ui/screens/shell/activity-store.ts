// Activity feed polling as an external store (Mac polls `GET /kb/activity` about every 25 s). Only a real change
// notifies; polling runs only while started (the bell is mounted and the user is signed in), pauses while the window
// is hidden, and every request is cancellable. A failure keeps the last feed and says so; it never throws.
import { EMPTY_FEED, decodeFeed, type ActivityFeed } from "./activity-model";

export interface ActivityState {
  feed: ActivityFeed;
  /** `unavailable` after a failed poll (the old feed stays); null while fine. */
  error: string | null;
  loaded: boolean;
}

export const INITIAL_ACTIVITY: ActivityState = Object.freeze({ feed: EMPTY_FEED, error: null, loaded: false }) as ActivityState;

export interface ActivityApi {
  get(path: string, signal: AbortSignal): Promise<unknown>;
  post(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface ActivityStoreOptions {
  api: ActivityApi;
  intervalMs?: number;
  isHidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface ActivityStore {
  getSnapshot(): ActivityState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
  /** The popover opened: tell the server everything up to the newest row is seen (the badge clears at once). */
  markSeen(): Promise<void>;
}

export const POLL_MS = 25_000;
const LIMIT = 50;

export function createActivityStore(opts: ActivityStoreOptions): ActivityStore {
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let state: ActivityState = INITIAL_ACTIVITY;
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let running = false;
  let ac: AbortController | null = null;
  const set = (next: ActivityState) => {
    if (next.error === state.error && next.loaded === state.loaded && next.feed.unread === state.feed.unread && next.feed.lastId === state.feed.lastId && next.feed.items.length === state.feed.items.length) return;
    state = next;
    for (const l of [...listeners]) l();
  };
  const schedule = () => {
    if (!running) return;
    timer = setT(() => void poll(), opts.intervalMs ?? POLL_MS);
  };
  const poll = async () => {
    timer = null;
    if (!running) return;
    if (opts.isHidden?.()) return schedule();
    await refresh();
    schedule();
  };
  const refresh = async () => {
    ac?.abort();
    const mine = (ac = new AbortController());
    try {
      const raw = await opts.api.get(`/kb/activity?limit=${LIMIT}`, mine.signal);
      if (mine.signal.aborted) return;
      set({ feed: decodeFeed(raw), error: null, loaded: true });
    } catch {
      if (mine.signal.aborted) return;
      set({ feed: state.feed, error: "unavailable", loaded: true });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start() {
      if (running) return;
      running = true;
      void poll();
    },
    stop() {
      running = false;
      if (timer !== null) clearT(timer);
      timer = null;
      ac?.abort();
      ac = null;
    },
    refreshNow: refresh,
    async markSeen() {
      const upto = state.feed.lastId;
      if (upto <= 0) return;
      // Optimistic: the badge clears now; the next poll reports the server's truth.
      set({ ...state, feed: { ...state.feed, unread: 0 } });
      try {
        await opts.api.post("/kb/activity/seen", { uptoId: upto }, new AbortController().signal);
      } catch {
        /* the next poll shows the real count */
      }
    },
  };
}
