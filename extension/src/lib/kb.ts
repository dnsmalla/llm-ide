// Phase 2 client — talks to /kb/* on the local server.  Kept dependency-free
// so it can be used from hooks, exporters, and (later) the connectors UI.

import type {
  GetKbIssuesResponse200,
  GetKbStatsResponse200,
  Issue,
  PostKbConflictQuestionsResponse200,
  PostKbConnectGitResponse200,
  PostKbConnectQaResponse200,
} from './api-types';
import { authFetch, getServerUrl, parseJsonResponse, REQUEST_TIMEOUT_MS } from './config';

/** The kinds the search filter offers. The server answers any kind in its list, so a hit's kind is typed as string. */
export type KBSearchKind = 'meeting' | 'action' | 'decision' | 'blocker';

export interface KBSearchHit {
  kind: string;
  /** null for hits that are not tied to a meeting (tickets, plans, outcomes). */
  meetingId: string | null;
  entityId: string | null;
  title: string;
  body: string;
  date?: string;
  meetingTitle?: string;
  durationSec?: number;
  rank?: number;
  meta?: Record<string, unknown>;
}

export interface ConnectorResult {
  ok: boolean;
  [k: string]: unknown;
}

export const OFFLINE_MESSAGE = 'Mac app not running. Open LLM-IDE to search your notes.';

/** The local server cannot be reached (connection refused, timeout, breaker open). Nothing is stored for this case. */
export class OfflineError extends Error {
  constructor() {
    super(OFFLINE_MESSAGE);
    this.name = 'OfflineError';
  }
}

async function postJSON<T>(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const serverUrl = await getServerUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await authFetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (r.status === 404) {
      throw new Error('This feature requires a newer server version. Please restart the server.');
    }
    return await parseJsonResponse<T>(r);
  } finally {
    clearTimeout(timeout);
  }
}

// Walk a local directory and ingest every text file as `code` rows.
// `path` must be an absolute path on the host machine.  Long-running.
export async function connectGitRepo(repoPath: string): Promise<PostKbConnectGitResponse200> {
  return postJSON<PostKbConnectGitResponse200>('/kb/connect-git', { path: repoPath }, 5 * 60_000);
}

export async function connectGithubIssues(opts: {
  repo: string;
  token?: string;
  state?: 'open' | 'closed' | 'all';
}): Promise<ConnectorResult> {
  return postJSON('/kb/connect-github-issues', opts, 5 * 60_000);
}

export async function connectQA(opts: { xml: string; source?: string }): Promise<PostKbConnectQaResponse200> {
  return postJSON<PostKbConnectQaResponse200>('/kb/connect-qa', opts, 60_000);
}

// ---- Plan stub (extension agent toggle bar only) -----------------------

import type { Plan } from './plan';

export async function savePlan(opts: {
  id?: string;
  title: string;
  goal?: string;
  language?: string;
  tasks?: unknown[];
  meetingId?: string;
}): Promise<Plan> {
  return postJSON('/kb/plan/save', opts, 10_000);
}

export async function searchKB(opts: { q?: string; kind?: KBSearchKind; limit?: number }): Promise<KBSearchHit[]> {
  const serverUrl = await getServerUrl();
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit) params.set('limit', String(opts.limit));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await authFetch(`${serverUrl}/kb/search?${params.toString()}`, {
        signal: controller.signal,
      });
    } catch {
      throw new OfflineError();
    }
    if (response.status === 503) throw new OfflineError(); // circuit breaker: server unreachable
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Search requires a newer server version. Please restart the server.');
      }
      throw new Error('Search is temporarily unavailable. Please try again.');
    }
    const data = await response.json();
    return Array.isArray(data?.results) ? data.results : [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function conflictQuestions(opts: {
  transcript?: string;
  fileContext?: string;
  language?: string;
}): Promise<string> {
  const data = await postJSON<PostKbConflictQuestionsResponse200>(
    '/kb/conflict-questions',
    { transcript: opts.transcript ?? '', fileContext: opts.fileContext ?? '', language: opts.language ?? 'en' },
    3 * 60_000,
  );
  if (typeof data?.questions !== 'string') throw new Error('Empty response from server');
  return data.questions;
}

export async function getKBStats(): Promise<GetKbStatsResponse200 | null> {
  try {
    const serverUrl = await getServerUrl();
    const r = await authFetch(`${serverUrl}/kb/stats`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function listIssues(opts?: {
  repo?: string;
  state?: 'open' | 'closed' | 'all';
  limit?: number;
  provider?: string;
}): Promise<Issue[]> {
  const serverUrl = await getServerUrl();
  const params = new URLSearchParams();
  if (opts?.repo) params.set('repo', opts.repo);
  if (opts?.state) params.set('state', opts.state);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.provider) params.set('provider', opts.provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await authFetch(`${serverUrl}/kb/issues?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Issues listing requires a newer server version. Please restart the server.');
      }
      throw new Error('Issues listing is temporarily unavailable. Please try again.');
    }
    const data: GetKbIssuesResponse200 = await response.json();
    return Array.isArray(data?.issues) ? data.issues : [];
  } finally {
    clearTimeout(timeout);
  }
}
