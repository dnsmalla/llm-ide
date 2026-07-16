// /kb/chat/* — unified chat sessions shared by macOS + extension.
import { sendJSON, readBody, parseJSON } from '../../core/utils.mjs';
import {
  createChatSession,
  listChatSessions,
  getChatSession,
  updateChatSession,
  deleteChatSession,
  clearChatMessages,
  appendChatMessage,
} from '../chat-sessions.mjs';

export async function handleChatRoutes(req, res, ctx) {
  const { userId, url } = ctx;
  if (!url.startsWith('/kb/chat')) return false;

  const path = url.split('?')[0];
  const u = new URL(url, 'http://127.0.0.1');

  // GET /kb/chat/sessions
  if (req.method === 'GET' && path === '/kb/chat/sessions') {
    const sessions = listChatSessions(userId, {
      surface: u.searchParams.get('surface') || undefined,
      mode: u.searchParams.get('mode') || undefined,
      limit: u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : undefined,
    });
    sendJSON(res, 200, { sessions });
    return true;
  }

  // POST /kb/chat/sessions
  if (req.method === 'POST' && path === '/kb/chat/sessions') {
    const body = parseJSON(await readBody(req, 64 * 1024)) || {};
    const session = createChatSession(userId, {
      title: body.title,
      surface: body.surface,
      mode: body.mode,
      projectId: body.projectId ?? body.project_id ?? null,
    });
    sendJSON(res, 201, { session });
    return true;
  }

  const prefix = '/kb/chat/sessions/';
  if (!path.startsWith(prefix)) {
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown chat route' } });
    return true;
  }

  const rest = decodeURIComponent(path.slice(prefix.length));
  const slash = rest.indexOf('/');
  const sessionId = slash === -1 ? rest : rest.slice(0, slash);
  const sub = slash === -1 ? '' : rest.slice(slash + 1);

  if (!sessionId) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'session id required' } });
    return true;
  }

  // GET /kb/chat/sessions/:id
  if (req.method === 'GET' && sub === '') {
    const session = getChatSession(userId, sessionId, {
      messageLimit: u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : undefined,
    });
    if (!session) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'session not found' } });
      return true;
    }
    sendJSON(res, 200, { session });
    return true;
  }

  // PATCH /kb/chat/sessions/:id
  if (req.method === 'PATCH' && sub === '') {
    const body = parseJSON(await readBody(req, 64 * 1024)) || {};
    if (typeof body.title !== 'string') {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'title required' } });
      return true;
    }
    const ok = updateChatSession(userId, sessionId, { title: body.title });
    if (!ok) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'session not found' } });
      return true;
    }
    sendJSON(res, 200, { ok: true });
    return true;
  }

  // DELETE /kb/chat/sessions/:id
  if (req.method === 'DELETE' && sub === '') {
    const ok = deleteChatSession(userId, sessionId);
    if (!ok) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'session not found' } });
      return true;
    }
    sendJSON(res, 200, { ok: true });
    return true;
  }

  // POST /kb/chat/sessions/:id/messages
  if (req.method === 'POST' && sub === 'messages') {
    const body = parseJSON(await readBody(req, 256 * 1024)) || {};
    if (body.role !== 'user' && body.role !== 'assistant' && body.role !== 'system') {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'role required' } });
      return true;
    }
    try {
      const result = appendChatMessage(userId, sessionId, {
        role: body.role,
        content: body.content,
        meta: body.meta ?? null,
      });
      sendJSON(res, 201, result);
    } catch (e) {
      const msg = e?.message || 'append failed';
      const code = msg === 'session not found' ? 404 : 400;
      sendJSON(res, code, { error: { code: code === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED', message: msg } });
    }
    return true;
  }

  // DELETE /kb/chat/sessions/:id/messages
  if (req.method === 'DELETE' && sub === 'messages') {
    const n = clearChatMessages(userId, sessionId);
    sendJSON(res, 200, { cleared: n });
    return true;
  }

  sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown chat route' } });
  return true;
}
