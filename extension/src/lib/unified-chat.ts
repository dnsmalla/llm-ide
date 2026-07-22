import { getServerUrl, authFetch } from './config';

export type UnifiedChatRole = 'user' | 'assistant' | 'system';

export interface UnifiedChatMessage {
  role: UnifiedChatRole;
  content: string;
  timestamp: number;
  seq?: number;
}

export interface UnifiedChatSession {
  id: string;
  title: string;
  surface: string;
  mode: string;
  projectId?: string | null;
  createdAt: number;
  updatedAt: number;
  messages?: UnifiedChatMessage[];
}

const SESSION_STORAGE_KEY = 'unifiedChatSessionId';

function toClientMessage(m: { role: string; content: string; createdAt: number; seq?: number }): UnifiedChatMessage {
  return {
    role: m.role as UnifiedChatRole,
    content: m.content,
    timestamp: Math.round(m.createdAt * 1000),
    seq: m.seq,
  };
}

export async function listChatSessions(opts?: {
  surface?: string;
  mode?: string;
  limit?: number;
}): Promise<UnifiedChatSession[]> {
  const base = await getServerUrl();
  const params = new URLSearchParams();
  if (opts?.surface) params.set('surface', opts.surface);
  if (opts?.mode) params.set('mode', opts.mode);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await authFetch(`${base}/kb/chat/sessions${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export async function createChatSession(opts: {
  title?: string;
  surface?: string;
  mode?: string;
}): Promise<UnifiedChatSession> {
  const base = await getServerUrl();
  const res = await authFetch(`${base}/kb/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  const data = await res.json();
  return data.session;
}

export async function getChatSession(id: string, limit = 200): Promise<UnifiedChatSession | null> {
  const base = await getServerUrl();
  const res = await authFetch(`${base}/kb/chat/sessions/${encodeURIComponent(id)}?limit=${limit}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get session failed: ${res.status}`);
  const data = await res.json();
  const session = data.session as UnifiedChatSession;
  if (session?.messages) {
    // The server delivers each message with `createdAt` (seconds); map from
    // the raw (untyped) payload so toClientMessage sees that shape rather than
    // the already-normalized `timestamp` the cast above implies.
    session.messages = (data.session.messages ?? []).map(toClientMessage);
  }
  return session;
}

export async function appendChatMessage(
  sessionId: string,
  role: UnifiedChatRole,
  content: string,
): Promise<void> {
  const base = await getServerUrl();
  const res = await authFetch(`${base}/kb/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, content }),
  });
  if (!res.ok) throw new Error(`append message failed: ${res.status}`);
}

export async function clearChatSessionMessages(sessionId: string): Promise<void> {
  const base = await getServerUrl();
  const res = await authFetch(`${base}/kb/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`clear messages failed: ${res.status}`);
}

/** Resolve the active extension transcript session id (server-backed). */
export async function ensureTranscriptSessionId(): Promise<string | null> {
  try {
    const stored = await chrome.storage?.local?.get(SESSION_STORAGE_KEY);
    const existing = stored?.[SESSION_STORAGE_KEY];
    if (typeof existing === 'string' && existing) {
      const session = await getChatSession(existing, 1);
      if (session) return existing;
    }
    const sessions = await listChatSessions({ surface: 'extension', mode: 'transcript', limit: 1 });
    if (sessions.length > 0) {
      await chrome.storage?.local?.set({ [SESSION_STORAGE_KEY]: sessions[0].id });
      return sessions[0].id;
    }
    const created = await createChatSession({
      title: 'Meeting chat',
      surface: 'extension',
      mode: 'transcript',
    });
    await chrome.storage?.local?.set({ [SESSION_STORAGE_KEY]: created.id });
    return created.id;
  } catch {
    return null;
  }
}

export async function loadTranscriptMessages(sessionId: string): Promise<UnifiedChatMessage[]> {
  const session = await getChatSession(sessionId, 200);
  return session?.messages ?? [];
}
