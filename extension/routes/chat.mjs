// /kb/chat/* — unified chat sessions shared by macOS + extension.
import { sendJSON, readBody, parseJSON, readJsonBody } from '../core/utils.mjs';
import { archiveBegin, archiveCommit } from '../kb/chat-lifecycle.mjs';
import {
  createChatSession,
  listChatSessions,
  getChatSession,
  updateChatSession,
  deleteChatSession,
  clearChatMessages,
  appendChatMessage,
} from '../kb/chat-sessions.mjs';

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
      offset: u.searchParams.has('offset') ? Number(u.searchParams.get('offset')) : undefined,
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

  // POST /kb/chat/sessions/:id/archive/begin — the fenced, paged archive snapshot
  // (plan 3.3). Without ?after= it marks the chat `archiving`, bumps its fence and
  // returns page 1 plus the digest of all messages. With ?after=<seq>&fence=<n> it
  // returns the next page under the same fence (409 ARCHIVE_STALE otherwise).
  if (req.method === 'POST' && sub === 'archive/begin') {
    const hasAfter = u.searchParams.has('after');
    const opts = hasAfter
      ? { after: Number(u.searchParams.get('after')), fence: Number(u.searchParams.get('fence')), limit: Number(u.searchParams.get('limit') || 0) || undefined }
      : { limit: Number(u.searchParams.get('limit') || 0) || undefined };
    if (hasAfter && (!Number.isInteger(opts.after) || opts.after < 0 || !Number.isInteger(opts.fence))) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'after and fence must be integers' } });
      return true;
    }
    const snap = archiveBegin(userId, sessionId, opts);
    if (snap === null) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'session not found' } });
      return true;
    }
    if (snap.stale) {
      sendJSON(res, 409, { error: { code: 'ARCHIVE_STALE', message: 'the archive fence no longer matches; begin again' } });
      return true;
    }
    sendJSON(res, 200, snap);
    return true;
  }

  // POST /kb/chat/sessions/:id/archive/commit — deletes the rows once the Mac has
  // verified its file: the presented fence and the Mac's own hash must both match.
  //   200 deleted | already_archived (a receipt with this hash exists)
  //   404 NOT_FOUND (gone, and no receipt says it was archived)
  //   409 ARCHIVE_STALE (fence or hash differ: begin again)
  //   409 INCOMPLETE_ARCHIVE (the caps dropped messages; pass acceptIncomplete:true)
  if (req.method === 'POST' && sub === 'archive/commit') {
    const body = await readJsonBody(req, 16 * 1024);
    if (!Number.isInteger(body.fence) || typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'fence (integer) and hash (64 hex) are required' } });
      return true;
    }
    const result = archiveCommit(userId, sessionId, {
      fence: body.fence, hash: body.hash, acceptIncomplete: body.acceptIncomplete === true,
    });
    if (result.status === 'not_found') {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'session not found and no archive receipt for it' } });
      return true;
    }
    if (result.status === 'stale') {
      sendJSON(res, 409, { error: { code: 'ARCHIVE_STALE', message: 'the archive fence or hash no longer matches; begin again' } });
      return true;
    }
    if (result.status === 'incomplete') {
      sendJSON(res, 409, {
        error: {
          code: 'INCOMPLETE_ARCHIVE',
          message: 'this chat lost messages to the store caps; archive it with acceptIncomplete:true to accept that',
          details: { prunedMessages: result.prunedMessages, truncatedMessages: result.truncatedMessages },
        },
      });
      return true;
    }
    sendJSON(res, 200, { deleted: result.status === 'deleted', status: result.status });
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
