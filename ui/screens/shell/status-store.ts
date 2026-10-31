// Core status polling as an external store. Only a real change notifies subscribers, so a
// 1 s poll does not re-render the app; components read through `useStoreSelector` (hooks.ts).
import type { CoreStatus } from "./host";

export interface StatusState {
  status: CoreStatus | null;
  /** Set when the host could not be asked (no status at all, or the last poll failed). */
  pollError: string | null;
  /** True once the core was `ready` at least once: afterwards the UI keeps screens mounted. */
  everReady: boolean;
}

export const INITIAL_STATUS_STATE: StatusState = Object.freeze({ status: null, pollError: null, everReady: false });

export function statusEqual(a: CoreStatus | null, b: CoreStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of Object.keys(a) as (keyof CoreStatus)[]) {
    if (a[k] === b[k]) continue;
    // Object/array fields are rebuilt on every poll: compare by value so an unchanged status stays equal.
    if (typeof a[k] === "object" && a[k] !== null && JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    return false;
  }
  return true;
}

export interface PollIntervals {
  /** While the core is not ready or the host call fails. Default 1000. */
  fast: number;
  /** While ready (to notice a crash/restart). Default 4000. */
  slow: number;
  /** While the window is hidden. Default 15000. */
  hidden: number;
}

export interface StatusStoreOptions {
  fetchStatus: () => Promise<CoreStatus>;
  intervals?: Partial<PollIntervals>;
  isHidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface StatusStore {
  getSnapshot(): StatusState;
  subscribe(listener: () => void): () => void;
  /** Start polling (idempotent); the first poll runs immediately. */
  start(): void;
  stop(): void;
  /** Poll now (used by the "Check again" button); resolves when the poll finished. */
  refreshNow(): Promise<void>;
}

/** Delay before the next poll for a state (exported for tests). */
export function nextDelay(state: StatusState, iv: PollIntervals, hidden: boolean): number {
  if (state.pollError !== null || state.status?.state !== "ready") return iv.fast;
  return hidden ? iv.hidden : iv.slow;
}

export function createStatusStore(opts: StatusStoreOptions): StatusStore {
  const iv: PollIntervals = { fast: 1000, slow: 4000, hidden: 15000, ...opts.intervals };
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const isHidden = opts.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const listeners = new Set<() => void>();
  let state = INITIAL_STATUS_STATE;
  let timer: unknown = null;
  let running = false;
  let inflight: Promise<void> | null = null;

  const set = (next: StatusState) => {
    if (next.pollError === state.pollError && next.everReady === state.everReady && statusEqual(next.status, state.status)) return;
    // Keep the previous status object when equal, so selectors comparing by identity stay stable.
    state = { ...next, status: statusEqual(next.status, state.status) ? state.status : next.status };
    for (const l of [...listeners]) l();
  };

  const poll = (): Promise<void> => {
    inflight ??= (async () => {
      try {
        const status = await opts.fetchStatus();
        set({ status, pollError: null, everReady: state.everReady || status.state === "ready" });
      } catch (e) {
        set({ ...state, pollError: e instanceof Error ? e.message : String(e) });
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const loop = () => {
    if (!running) return;
    void poll().then(() => {
      if (!running) return;
      timer = setTimer(loop, nextDelay(state, iv, isHidden()));
    });
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
      loop();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    refreshNow: poll,
  };
}
