// /kb/live/* routes — append captions during a recording, list
// active sessions, finalize a session, and the SSE stream that
// mirrors live captions to other clients (e.g. Mac app watching a
// Chrome-extension capture). Extracted from kb/router.mjs as part
// of the modularization sweep.
//
// Contract:
//   handleLiveRoutes(req, res, ctx) → boolean
//     ctx = { userId, url }
//
// SSE concurrency is per-user and tracked in module-local state so
// the cap survives across router instances. The map is shared with
// any other module that needs it (today only this one).

import crypto from 'node:crypto';
import {
  appendCaptions, getCaptionsSince, listActiveSessions, finalizeSession, liveEvents,
} from '../../agents/live-sessions.mjs';
import { sendJSON, readBody, parseJSON } from '../../core/utils.mjs';
import { tryConsume } from '../../server/rate-limit.mjs';

// Per-user cap on concurrent SSE streams. A hostile or buggy client
// opening N streams pins N idle timers + listener pairs; we cap so a
// single tenant can't run the process out of FDs or listener slots.
// 4 covers realistic UI patterns (one main panel + a couple of debug
// tabs) while keeping the worst case bounded.
const sseStreams = new Map(); // userId -> count
const MAX_SSE_PER_USER = 4;

export async function handleLiveRoutes(req, res, ctx) {
  const { userId, url } = ctx;
  if (!url.startsWith('/kb/live')) return false;

  // POST /kb/live/sessions/new — server-side sessionId minting.
  // The client can call this before starting a capture to receive a
  // cryptographically-random, unpredictable sessionId, rather than
  // generating one client-side.  Using server-minted IDs:
  //   - prevents collisions even across browser tabs / concurrent clients
  //   - avoids predictable IDs that another user could guess and pre-create
  //     (though userId scoping already blocks cross-user access, belt +
  //     suspenders)
  //   - gives us a single source of truth for auditing live-session starts
  //
  // Clients that already generate their own IDs can continue doing so —
  // this endpoint is opt-in.
  if (req.method === 'POST' && url === '/kb/live/sessions/new') {
    const body = parseJSON(await readBody(req, 64 * 1024)) || {};
    const sessionId = crypto.randomBytes(16).toString('hex');
    const meetingTitle = typeof body.meetingTitle === 'string' ? body.meetingTitle : '';
    // Return the sessionId immediately; the session itself is created
    // lazily on the first appendCaptions call so no state is allocated
    // until data actually arrives.
    sendJSON(res, 200, { sessionId, meetingTitle });
    return true;
  }

  // POST /kb/live/:sessionId/append
  if (req.method === 'POST' && url.endsWith('/append')) {
    const sessionId = decodeURIComponent(url.slice('/kb/live/'.length, -'/append'.length));
    // Rate-limit: cap caption-append bursts per user to prevent a
    // runaway producer from flooding the in-memory ring buffer.
    const rl = tryConsume('liveAppend', userId);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendJSON(res, 429, { error: { code: 'RATE_LIMITED', retryAfterSec: rl.retryAfterSec } });
      return true;
    }
    const body = parseJSON(await readBody(req, 4 * 1024 * 1024));
    if (!sessionId || !Array.isArray(body?.captions)) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'sessionId and captions[] required' } });
      return true;
    }
    const result = appendCaptions(userId, sessionId, body.captions, body.meetingTitle);
    sendJSON(res, 200, result);
    return true;
  }

  // POST /kb/live/:sessionId/finalize
  if (req.method === 'POST' && url.endsWith('/finalize')) {
    const sessionId = decodeURIComponent(url.slice('/kb/live/'.length, -'/finalize'.length));
    const result = finalizeSession(userId, sessionId);
    sendJSON(res, 200, result || { sessionId, finalized: true, captionCount: 0 });
    return true;
  }

  // GET /kb/live/sessions
  if (req.method === 'GET' && url.startsWith('/kb/live/sessions')) {
    sendJSON(res, 200, { sessions: listActiveSessions(userId) });
    return true;
  }

  // GET /kb/live/:sessionId/stream — Server-Sent Events.
  if (req.method === 'GET' && url.endsWith('/stream')) {
    const u = new URL(url, 'http://127.0.0.1');
    const sessionId = decodeURIComponent(u.pathname.slice('/kb/live/'.length, -'/stream'.length));

    const userStreams = sseStreams.get(userId) || 0;
    if (userStreams >= MAX_SSE_PER_USER) {
      sendJSON(res, 429, { error: { code: 'TOO_MANY_STREAMS', message: 'Too many concurrent live streams' } });
      return true;
    }
    sseStreams.set(userId, userStreams + 1);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    try {
      res.write('\n');
    } catch {
      // Roll back the increment. Subtract from the PRE-INCREMENT
      // value (`userStreams`), NOT from sseStreams.get — at this
      // point the map already holds userStreams+1, so
      // `(get() || 1) - 1` would write back userStreams+1-1 ==
      // userStreams, permanently consuming the slot on every
      // failed-initial-write. Slot leaks → 429 forever after 4
      // failures.
      if (userStreams <= 0) sseStreams.delete(userId);
      else sseStreams.set(userId, userStreams);
      return true;
    }

    let lastSeq = Number(u.searchParams.get('since') || 0);
    let cleanedUp = false;
    let heartbeatTimer = null;

    const cleanup = () => {
      // Idempotent — req 'close' and 'error' both fire on abort, and
      // an in-flight onUpdate that fails mid-write also triggers it.
      if (cleanedUp) return;
      cleanedUp = true;
      liveEvents.off(`session-caption-${sessionId}`, onUpdate);
      liveEvents.off(`session-list-update-${userId}`, onUpdate);
      if (idleTimer) clearTimeout(idleTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const left = (sseStreams.get(userId) || 1) - 1;
      if (left <= 0) sseStreams.delete(userId);
      else sseStreams.set(userId, left);
    };
    const endStream = () => { cleanup(); try { res.end(); } catch { /* socket already gone */ } };

    // Kill streams idle for 10 minutes — extension reconnects automatically.
    const IDLE_MS = 10 * 60 * 1000;
    let idleTimer = setTimeout(endStream, IDLE_MS);

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(endStream, IDLE_MS);
    };

    // Heartbeat — send an SSE comment every 30 s.  Proxies and load
    // balancers typically close idle keep-alive connections after 60 s;
    // the heartbeat prevents that from killing the stream between caption
    // bursts.  SSE comments are ignored by EventSource clients.
    const HEARTBEAT_MS = 30_000;
    heartbeatTimer = setInterval(() => {
      if (cleanedUp || !res.writable) { cleanup(); return; }
      try { res.write(': heartbeat\n\n'); }
      catch { cleanup(); }
    }, HEARTBEAT_MS);

    const onUpdate = () => {
      if (cleanedUp) return;
      if (!res.writable) { cleanup(); return; }
      try {
        const result = getCaptionsSince(userId, sessionId, lastSeq);
        if (result.captions.length > 0 || result.finalized) {
          lastSeq = result.sequence;
          res.write(`data: ${JSON.stringify(result)}\n\n`);
          resetIdle();
        }
      } catch {
        // Any throw — JSON.stringify cycle, write-after-close, KB
        // hiccup — collapses to a clean teardown so listeners can
        // never leak on a single bad tick.
        cleanup();
      }
    };

    liveEvents.on(`session-caption-${sessionId}`, onUpdate);
    liveEvents.on(`session-list-update-${userId}`, onUpdate);

    req.on('close', cleanup);
    req.on('error', cleanup);

    onUpdate();
    return true;
  }

  // GET /kb/live/:sessionId?since=N — caller polls for new captions.
  if (req.method === 'GET' && url.startsWith('/kb/live/')) {
    const u = new URL(url, 'http://127.0.0.1');
    const sessionId = decodeURIComponent(u.pathname.slice('/kb/live/'.length));
    const since = Number(u.searchParams.get('since') || 0);
    const result = getCaptionsSince(userId, sessionId, since);
    sendJSON(res, 200, result);
    return true;
  }

  return false;
}
