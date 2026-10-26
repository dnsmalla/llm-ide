// The System view's state and behaviour, kept out of React so the same logic
// runs in the Mac web view, in `npm run dev` and in tests.
import { HttpError, fetchOsState, sendCancel, type Connection, type FetchLike, type Range } from './api';
import type { NativeConfig, ToNative, ViewTarget } from './bridge';
import { OsStream, type LiveStatus } from './stream';
import type { Cancel, OsState } from './types';

export const REFRESH_DEBOUNCE_MS = 300;

export type ViewState = {
  mode: 'native' | 'dev';
  conn: Connection | null;
  projectName: string | null;
  range: Range;
  data: OsState | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  live: LiveStatus;
  needToken: boolean;
  /** Key of the running item whose Stop request is in flight, or null. */
  stopping: string | null;
};

export type ControllerDeps = {
  fetch: FetchLike;
  /** Posts to the native bridge; false when there is none. */
  post: (message: ToNative) => boolean;
  mode: 'native' | 'dev';
  applyTheme: (theme: string | undefined) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class OsController {
  private state: ViewState;
  private readonly listeners = new Set<() => void>();
  private readonly stream: OsStream;
  private readonly deps: ControllerDeps;
  private refreshTimer: unknown = null;
  private requestSeq = 0;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.state = {
      mode: deps.mode,
      conn: null,
      projectName: null,
      range: 'day',
      data: null,
      loading: false,
      error: null,
      notice: null,
      live: 'idle',
      needToken: false,
      stopping: null,
    };
    this.stream = new OsStream({
      fetch: deps.fetch,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      onStatus: (live, detail) => this.set({ live, notice: detail ?? null }),
      onEvent: () => this.scheduleRefresh(),
      onAuthError: () => this.handleAuthError(),
    });
  }

  // Arrow properties so React's useSyncExternalStore can take them unbound.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ViewState => this.state;

  /** Called once at boot, after llmideConfigure is installed: tells native we are ready. */
  start(): void {
    if (this.deps.mode === 'native') this.deps.post({ type: 'ready' });
  }

  /** Applies a native (or dev form) configuration. Each call applies; a new token restarts the stream. */
  configure(cfg: NativeConfig): void {
    if (!cfg || typeof cfg.baseURL !== 'string' || cfg.baseURL === '' || typeof cfg.token !== 'string') {
      this.set({ error: 'The connection settings are missing the server address or the token.' });
      return;
    }
    this.deps.applyTheme(cfg.theme);
    const conn: Connection = { baseURL: cfg.baseURL, token: cfg.token };
    this.set({ conn, projectName: cfg.projectName ?? null, needToken: false, error: null });
    void this.refresh();
    this.stream.start(conn);
  }

  setRange(range: Range): void {
    if (range === this.state.range) return;
    this.set({ range });
    void this.refresh();
  }

  /** Fetches GET /kb/os/state for the current range. Stale responses are dropped. */
  async refresh(): Promise<void> {
    const conn = this.state.conn;
    if (!conn) return;
    const seq = ++this.requestSeq;
    this.set({ loading: true });
    try {
      const data = await fetchOsState(conn, this.state.range, this.deps.fetch);
      if (seq !== this.requestSeq || this.state.conn !== conn) return;
      this.set({ data, loading: false, error: null });
    } catch (err) {
      if (seq !== this.requestSeq || this.state.conn !== conn) return;
      if (err instanceof HttpError && err.status === 401) {
        this.handleAuthError();
        return;
      }
      this.set({ loading: false, error: `Could not load the System view: ${describe(err)}` });
    }
  }

  /** Sends a running item's declared cancel request, then refreshes. */
  async stopItem(cancel: Cancel, key: string): Promise<void> {
    const conn = this.state.conn;
    if (!conn || !cancel || this.state.stopping !== null) return;
    this.set({ stopping: key, error: null });
    try {
      await sendCancel(conn, cancel, this.deps.fetch);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        this.handleAuthError();
        return;
      }
      this.set({ error: `Could not stop it: ${describe(err)}` });
    } finally {
      this.set({ stopping: null });
    }
    await this.refresh();
  }

  /** Asks native to navigate to one of its screens. Outside the app there is nowhere to go. */
  open(target: ViewTarget): void {
    if (!this.deps.post({ type: 'open', target })) {
      this.set({ notice: 'Open this in the LLM-IDE app.' });
    }
  }

  dispose(): void {
    this.stream.stop();
    this.cancelRefresh();
  }

  private handleAuthError(): void {
    if (this.state.needToken) return;
    this.stream.stop();
    this.cancelRefresh();
    this.set({
      needToken: true,
      live: 'stopped',
      loading: false,
      error: 'The access token was refused. LLM-IDE will send a new one.',
    });
    this.deps.post({ type: 'needToken' });
  }

  /** Any stream event means "state changed": re-fetch once the burst settles. */
  private scheduleRefresh(): void {
    this.cancelRefresh();
    this.refreshTimer = this.deps.setTimer(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== null) {
      this.deps.clearTimer(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private set(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
