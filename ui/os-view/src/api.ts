// The HTTP calls the System view makes. Inside the Mac app they go through the
// native bridge (native holds the token and the allowlist). In `npm run dev` they
// go straight to the server with a pasted token, which only ever travels in the
// Authorization header, never in a URL.
import type { OsRoutine, OsSkill } from '@dnsmalla/graph-kit-web';
import type { Cancel, OsState } from './types';

export type Connection = { baseURL: string; token: string };
export type Range = 'day' | 'week';
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The answer to one call: a status (0 = never reached the server) and a parsed body. */
export type Reply = { status: number; body?: unknown; error?: string };

/** One server call. Only the shapes the System view uses are expressible. */
export type Requester = (method: 'GET' | 'POST', path: string, body?: Record<string, string>) => Promise<Reply>;

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

/** Dev-browser requester: fetches the server directly with the pasted token. */
export function directRequester(
  conn: Connection,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Requester {
  return async (method, path, body) => {
    const init: RequestInit = {
      method,
      headers: { ...authHeaders(conn), Accept: 'application/json' },
    };
    if (body !== undefined) {
      init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetchImpl(endpoint(conn, path), init);
    } catch (err) {
      return { status: 0, error: err instanceof Error ? err.message : String(err) };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  };
}

function ensureOk(reply: Reply, what: string): void {
  if (reply.status === 0) throw new Error(reply.error ?? `${what} could not reach LLM-IDE`);
  if (reply.status < 200 || reply.status >= 300) {
    throw new HttpError(reply.status, `${what} failed (${reply.status})`);
  }
}

export async function fetchOsState(req: Requester, range: Range): Promise<OsState> {
  const reply = await req('GET', `/kb/os/state?window=${range}`);
  ensureOk(reply, 'GET /kb/os/state');
  return reply.body as OsState;
}

/**
 * Maps the server's skill library (`{ skills: [{ id, name, description, sourceName, ... }] }`)
 * to the page's OsSkill list. Entries without a string id and name are dropped; `path`
 * and `repo` never reach the page.
 */
export function toOsSkills(body: unknown): OsSkill[] {
  const list = body && typeof body === 'object' ? (body as { skills?: unknown }).skills : undefined;
  if (!Array.isArray(list)) return [];
  const skills: OsSkill[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string') continue;
    const skill: OsSkill = { id: e.id, name: e.name };
    if (typeof e.description === 'string') skill.description = e.description;
    if (typeof e.sourceName === 'string') skill.source = e.sourceName;
    skills.push(skill);
  }
  return skills;
}

/** The skills deck: GET /kb/agent/skill-library, mapped by toOsSkills. */
export async function fetchSkills(req: Requester): Promise<OsSkill[]> {
  const reply = await req('GET', '/kb/agent/skill-library');
  ensureOk(reply, 'GET /kb/agent/skill-library');
  return toOsSkills(reply.body);
}

/** Routines arrive as a JSON array from native; anything else is no routines. */
export function toOsRoutines(body: unknown): OsRoutine[] {
  return Array.isArray(body) ? (body as OsRoutine[]) : [];
}

/**
 * Sends a running item's declared cancel request exactly as the server gave
 * it: its method, its path and its JSON body. Anything other than a POST to an
 * absolute path is refused rather than guessed at.
 */
export async function sendCancel(req: Requester, cancel: NonNullable<Cancel>): Promise<void> {
  if (cancel.method !== 'POST' || typeof cancel.path !== 'string' || !cancel.path.startsWith('/')) {
    throw new Error('Unsupported cancel request');
  }
  const reply = await req('POST', cancel.path, cancel.body as Record<string, string> | undefined);
  ensureOk(reply, 'Stop');
}
