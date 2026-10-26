// GET /kb/os/stream as a reconnecting change feed for the dev-browser mode only.
// Inside the Mac app native holds this stream and forwards its events over the
// bridge. Each event only says "the state changed, re-fetch"; the payload is
// never used here.
import { HttpError, authHeaders, endpoint, type Connection, type FetchLike } from './api';
import { createSseParser } from './sse';
import type { OsEventsEvent } from './types';

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped';

/**
 * Reconnect delay. Ordinary drops back off 1 s -> 30 s. A 429 (too many open
 * views) backs off much longer: 60 s, doubling, capped at 5 min.
 */
export function backoffDelay(attempt: number, rateLimited: boolean): number {
  if (rateLimited) return Math.min(60_000 * 2 ** Math.min(attempt, 3), 300_000);
  return Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);
}

export type OsStreamDeps = {
  fetch: FetchLike;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onStatus: (status: LiveStatus, detail?: string) => void;
  onEvent: (event: OsEventsEvent) => void;
  onAuthError: () => void;
};

export class OsStream {
  private conn: Connection | null = null;
  private abort: AbortController | null = null;
  private timer: unknown = null;
  private attempt = 0;

  constructor(private readonly deps: OsStreamDeps) {}

  /** (Re)starts the stream with these credentials, dropping any previous one. */
  start(conn: Connection): void {
    this.stop();
    this.conn = conn;
    this.attempt = 0;
    void this.connect();
  }

  /** Aborts the stream and cancels any pending reconnect. */
  stop(): void {
    this.conn = null;
    this.abort?.abort();
    this.abort = null;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async connect(): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const ctl = new AbortController();
    this.abort = ctl;
    this.deps.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let rateLimited = false;
    try {
      const res = await this.deps.fetch(endpoint(conn, '/kb/os/stream'), {
        headers: { ...authHeaders(conn), Accept: 'text/event-stream' },
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      if (res.status === 401) {
        this.deps.onAuthError();
        return;
      }
      if (res.status === 429) {
        rateLimited = true;
        throw new HttpError(429, 'too many System streams');
      }
      if (!res.ok || !res.body) throw new HttpError(res.status, `stream failed (${res.status})`);
      this.attempt = 0;
      this.deps.onStatus('live');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser((message) => this.handleMessage(message.data));
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Network drop, abort or a bad status: fall through to the reconnect below.
      if (ctl.signal.aborted) return;
    }
    if (ctl.signal.aborted || this.abort !== ctl) return;
    this.abort = null;
    const delay = backoffDelay(this.attempt, rateLimited);
    this.attempt += 1;
    this.deps.onStatus(
      'reconnecting',
      rateLimited ? 'Too many System views are open; retrying later' : undefined,
    );
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private handleMessage(data: string): void {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!event || typeof (event as { type?: unknown }).type !== 'string') return;
    // The hello event only confirms the stream is open; the view fetches on connect anyway.
    if ((event as { type: string }).type === 'hello') return;
    this.deps.onEvent(event as OsEventsEvent);
  }
}
