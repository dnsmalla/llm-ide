// Phase 2 client — talks to /kb/* on the local server.  Kept dependency-free
// so it can be used from hooks, exporters, and (later) the connectors UI.

import { authFetch, getServerUrl, parseJsonResponse, REQUEST_TIMEOUT_MS } from './config';

export interface KBSearchHit {
  kind: 'meeting' | 'action' | 'decision' | 'blocker';
  meetingId: string;
  entityId: string | null;
  title: string;
  body: string;
  date?: string;
  meetingTitle?: string;
  durationSec?: number;
  rank?: number;
  meta?: Record<string, unknown>;
}

export interface KBStats {
  meetings: number;
  entities: number;
  sources?: {
    code: number;
    ticket: number;
    qa: number;
    lastIndexed?: Record<string, string>;
  };
}

export interface ConnectorResult {
  ok: boolean;
  [k: string]: unknown;
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
export async function connectGitRepo(repoPath: string): Promise<ConnectorResult> {
  return postJSON('/kb/connect-git', { path: repoPath }, 5 * 60_000);
}

export async function connectGithubIssues(opts: {
  repo: string;
  token?: string;
  state?: 'open' | 'closed' | 'all';
}): Promise<ConnectorResult> {
  return postJSON('/kb/connect-github-issues', opts, 5 * 60_000);
}

export async function connectQA(opts: { xml: string; source?: string }): Promise<ConnectorResult> {
  return postJSON('/kb/connect-qa', opts, 60_000);
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

export async function searchKB(opts: {
  q?: string;
  kind?: KBSearchHit['kind'];
  limit?: number;
}): Promise<KBSearchHit[]> {
  const serverUrl = await getServerUrl();
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit) params.set('limit', String(opts.limit));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await authFetch(`${serverUrl}/kb/search?${params.toString()}`, {
      signal: controller.signal,
    });
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
  const data = await postJSON<{ questions: string }>(
    '/kb/conflict-questions',
    { transcript: opts.transcript ?? '', fileContext: opts.fileContext ?? '', language: opts.language ?? 'en' },
    3 * 60_000,
  );
  if (typeof data?.questions !== 'string') throw new Error('Empty response from server');
  return data.questions;
}

export async function getKBStats(): Promise<KBStats | null> {
  try {
    const serverUrl = await getServerUrl();
    const r = await authFetch(`${serverUrl}/kb/stats`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export interface Issue {
  id: string;
  title: string;
  body: string;
  url: string;
  provider: string;
  repo?: string;
  number?: number;
  state?: string;
  labels?: string[];
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  isPR?: boolean;
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
    const data = await response.json();
    return Array.isArray(data?.issues) ? data.issues : [];
  } finally {
    clearTimeout(timeout);
  }
}
