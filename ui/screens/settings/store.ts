// A tiny observable store: models keep immutable snapshots and notify subscribers, so
// components read them with React's useSyncExternalStore and tests need no DOM.

export type Listener = () => void;

export class Store<S> {
  private snapshot: S;
  private readonly listeners = new Set<Listener>();

  constructor(initial: S) {
    this.snapshot = initial;
  }

  /** The current immutable snapshot (stable identity until the next change). */
  getState = (): S => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected set(patch: Partial<S>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
