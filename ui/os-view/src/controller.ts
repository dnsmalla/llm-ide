// The System view's state and behaviour, kept out of React so the same logic
// runs in the Mac web view, in `npm run dev` and in tests.
//
// Two transports, one behaviour:
//   native  (inside the Mac app) every call goes over the bridge; the change feed
//           is a subscribe/unsubscribe pair and its events arrive as llmideEvent.
//   dev     (`npm run dev`) calls and the change feed go straight to the server
//           with a pasted token.
import {
  HttpError,
  directRequester,
  fetchOsState,
  sendCancel,
  type Connection,
  type FetchLike,
  type Range,
  type Requester,
} from './api';
import type { NativeConfig, NativeEvent, NativeFeedStatus, ToNative, ViewTarget } from './bridge';
import { OsStream, type LiveStatus } from './stream';
import type { Cancel, OsState } from './types';

export const REFRESH_DEBOUNCE_MS = 300;

export type ViewState = {
  mode: 'native' | 'dev';
  /** True once native (or the dev form) has supplied the connection. */
  connected: boolean;
  /** Dev mode only: the server address and token the form supplied. */
  conn: Connection | null;
  projectName: string | null;
  range: Range;
  data: OsState | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  live: LiveStatus;
  /** The server refused the session (401) even after native tried to refresh it. */
  signedOut: boolean;
  /** Key of the running item whose Stop request is in flight, or null. */
  stopping: string | null;
};

export type ControllerDeps = {
  mode: 'native' | 'dev';
  /** Native mode: the bridge requester. Dev mode builds its own from the form. */
  requester?: Requester;
  /** Dev mode: the fetch used by the direct requester and the dev stream. */
  fetch: FetchLike;
  /** Posts to the native bridge; false when there is none. */
  post: (message: ToNative) => boolean;
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
  private readonly deps: ControllerDeps;
  private requester: Requester | null;
  /** Dev mode only: the direct change feed. */
  private devStream: OsStream | null = null;
  /** Native mode: whether the feed has been subscribed (one per view). */
  private subscribed = false;
  private refreshTimer: unknown = null;
  private requestSeq = 0;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.requester = deps.mode === 'native' ? (deps.requester ?? null) : null;
    this.state = {
      mode: deps.mode,
      connected: false,
      conn: null,
      projectName: null,
      range: 'day',
      data: null,
      loading: false,
      error: null,
      notice: null,
      live: 'idle',
      signedOut: false,
      stopping: null,
    };
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

  /**
   * Native configuration: theme and project only. The connection and the token
   * stay in native. The first call starts the view's fetch and change feed.
   */
  configure(cfg: NativeConfig): void {
    if (!cfg || typeof cfg !== 'object') return;
    this.deps.applyTheme(cfg.theme);
    const projectName = cfg.projectName ?? null;
    const first = !this.state.connected;
    const projectChanged = projectName !== this.state.projectName;
    this.set({ connected: true, projectName, error: null });
    if (first || projectChanged) void this.refresh();
    if (!this.subscribed) {
      this.subscribed = true;
      this.deps.post({ type: 'subscribe' });
    }
  }

  /** Dev form: connects straight to a server with a pasted token. */
  connectDev(cfg: { baseURL: string; token: string; theme?: string; projectName?: string | null }): void {
    if (typeof cfg.baseURL !== 'string' || cfg.baseURL === '' || typeof cfg.token !== 'string') {
      this.set({ error: 'The connection settings are missing the server address or the token.' });
      return;
    }
    this.deps.applyTheme(cfg.theme);
    const conn: Connection = { baseURL: cfg.baseURL, token: cfg.token };
    this.requester = directRequester(conn, this.deps.fetch);
    this.devStream?.stop();
    this.devStream = new OsStream({
      fetch: this.deps.fetch,
      setTimer: this.deps.setTimer,
      clearTimer: this.deps.clearTimer,
      onStatus: (live, detail) => this.set({ live, notice: detail ?? null }),
      onEvent: () => this.scheduleRefresh(),
      onAuthError: () => this.handleAuthError(),
    });
    this.set({ conn, connected: true, projectName: cfg.projectName ?? null, signedOut: false, error: null });
    void this.refresh();
    this.devStream.start(conn);
  }

  /** A change event from native's feed: state changed, re-fetch once the burst settles. */
  nativeEvent(event: NativeEvent): void {
    if (!event || typeof event.type !== 'string' || event.type === 'hello') return;
    this.scheduleRefresh();
  }

  /** The feed's state, as native reports it. */
  nativeStatus(status: NativeFeedStatus, detail?: string): void {
    const live: LiveStatus = status;
    this.set({ live, notice: detail ?? null });
  }

  setRange(range: Range): void {
    if (range === this.state.range) return;
    this.set({ range });
    void this.refresh();
  }

  /** Fetches GET /kb/os/state for the current range. Stale responses are dropped. */
  async refresh(): Promise<void> {
    const requester = this.requester;
    if (!requester) return;
    const seq = ++this.requestSeq;
    this.set({ loading: true });
    try {
      const data = await fetchOsState(requester, this.state.range);
      if (seq !== this.requestSeq) return;
      this.set({ data, loading: false, error: null, signedOut: false });
    } catch (err) {
      if (seq !== this.requestSeq) return;
      if (err instanceof HttpError && err.status === 401) {
        this.handleAuthError();
        return;
      }
      this.set({ loading: false, error: `Could not load the System view: ${describe(err)}` });
    }
  }

  /** Sends a running item's declared cancel request, then refreshes. */
  async stopItem(cancel: Cancel, key: string): Promise<void> {
    const requester = this.requester;
    if (!requester || !cancel || this.state.stopping !== null) return;
    this.set({ stopping: key, error: null });
    try {
      await sendCancel(requester, cancel);
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
    this.devStream?.stop();
    if (this.subscribed) {
      this.subscribed = false;
      this.deps.post({ type: 'unsubscribe' });
    }
    this.cancelRefresh();
  }

  private handleAuthError(): void {
    if (this.state.signedOut) return;
    this.devStream?.stop();
    this.cancelRefresh();
    this.set({
      signedOut: true,
      live: 'stopped',
      loading: false,
      error: null,
    });
  }

  /** Any change means "state changed": re-fetch once the burst settles. */
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
