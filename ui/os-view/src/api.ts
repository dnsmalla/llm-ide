// HTTP calls the System view makes. The token travels only in the
// Authorization header, never in a URL.
import type { Cancel, OsState } from './types';

export type Connection = { baseURL: string; token: string };
export type Range = 'day' | 'week';
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function endpoint(conn: Connection, path: string): string {
  return conn.baseURL.replace(/\/+$/, '') + path;
}

export function authHeaders(conn: Connection): Record<string, string> {
  return { Authorization: `Bearer ${conn.token}` };
}

export async function fetchOsState(
  conn: Connection,
  range: Range,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<OsState> {
  const url = `${endpoint(conn, '/kb/os/state')}?window=${range}`;
  const res = await fetchImpl(url, {
    headers: { ...authHeaders(conn), Accept: 'application/json' },
  });
  if (!res.ok) throw new HttpError(res.status, `GET /kb/os/state failed (${res.status})`);
  return (await res.json()) as OsState;
}

/**
 * Sends a running item's declared cancel request exactly as the server gave
 * it: its method, its path and its JSON body. Anything other than a POST to an
 * absolute path is refused rather than guessed at.
 */
export async function sendCancel(
  conn: Connection,
  cancel: NonNullable<Cancel>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<void> {
  if (cancel.method !== 'POST' || typeof cancel.path !== 'string' || !cancel.path.startsWith('/')) {
    throw new Error('Unsupported cancel request');
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { ...authHeaders(conn), 'Content-Type': 'application/json' },
  };
  if (cancel.body !== undefined) init.body = JSON.stringify(cancel.body);
  const res = await fetchImpl(endpoint(conn, cancel.path), init);
  if (!res.ok) throw new HttpError(res.status, `Stop failed (${res.status})`);
}
