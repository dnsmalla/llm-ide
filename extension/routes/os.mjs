// GET /kb/os/state — the read-only System view aggregate. Joins the SQL reads
// in kb/os-state.mjs (and the kb helpers they sit beside) with the in-memory
// registries of this process (chat turns, meeting-agent runs, live sessions).
// No model call and no write; every number comes from data the server already
// records. Always on: it is not owned by any LLMIDE_FEATURES group.
import { sendJSON, onClientDisconnect } from '../core/utils.mjs';
import { config } from '../core/config.mjs';
import { onOsEvent } from '../core/os-events.mjs';
import { getDb } from '../kb/db.mjs';
import { listActivity, unreadCount } from '../kb/activity.mjs';
import { usageForWindow, rollupTurnComposition, knowledgeCounts, kitStatus, TOKEN_WINDOWS } from '../kb/os-state.mjs';
import { memoryLedgerRepos } from '../kb/memory-ledger.mjs';
import { turnCompositionRecent } from '../kb/turn-composition.mjs';
import { listInFlightChatTurns } from './agent-v2.mjs';
import { listRuns } from '../agents/meeting-agent.mjs';
import { listActiveSessions } from '../agents/live-sessions.mjs';

const ACTIVITY_DEFAULT = 30;
const ACTIVITY_MAX = 100;
const TURN_COMPOSITION_LIMIT = 50;

// Set by server.mjs at boot (configureOsRoutes): the API version this server
// reports, and the same health probes /health runs. Until configured the
// route reports "degraded" with every check false rather than inventing health.
let serverInfo = {
  apiVersion: null,
  health: async () => ({ status: 'degraded', checks: { db: false, claude: false, skills: false } }),
};

/** Install the API version and the health probe source (server.mjs boot). */
export function configureOsRoutes({ apiVersion, health }) {
  serverInfo = { apiVersion, health };
}

function iso(value) {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cancelChat(chatSessionId) {
  return { method: 'POST', path: '/agent/v2/cancel', body: { chatSessionId } };
}

function cancelMeetingAgent(sessionId) {
  return { method: 'POST', path: '/kb/agent/stop', body: { sessionId } };
}

// GET /kb/os/stream — Server-Sent Events telling the System view WHEN to
// re-fetch /kb/os/state. Each event is `{ type, at }` only (never payload);
// the client debounces its own refetch. Safeguards mirror /kb/live/:id/stream.
const MAX_OS_STREAMS_PER_USER = 4;
const OS_STREAM_IDLE_MS = 10 * 60 * 1000;
const OS_HEARTBEAT_MS = 30_000;
const OS_COALESCE_MS = 250;
const osStreams = new Map(); // userId -> open stream count

function handleOsStream(req, res, userId) {
  const userStreams = osStreams.get(userId) || 0;
  if (userStreams >= MAX_OS_STREAMS_PER_USER) {
    sendJSON(res, 429, { error: { code: 'TOO_MANY_STREAMS', message: 'Too many concurrent System streams' } });
    return true;
  }
  osStreams.set(userId, userStreams + 1);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  let seq = 0;
  const hello = `event: hello\nid: ${++seq}\ndata: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`;
  try {
    res.write(hello);
  } catch {
    // Roll back the slot from the pre-increment value (see routes/live.mjs).
    if (userStreams <= 0) osStreams.delete(userId);
    else osStreams.set(userId, userStreams);
    return true;
  }

  let cleanedUp = false;
  let unsubscribe = null;
  let idleTimer = null;
  let heartbeatTimer = null;
  // Per event type: the open coalescing window. `dirty` = another event
  // arrived inside the window, so one trailing event is sent when it closes.
  const windows = new Map();

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (unsubscribe) unsubscribe();
    if (idleTimer) clearTimeout(idleTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const w of windows.values()) clearTimeout(w.timer);
    windows.clear();
    const left = (osStreams.get(userId) || 1) - 1;
    if (left <= 0) osStreams.delete(userId);
    else osStreams.set(userId, left);
  };
  const endStream = () => { cleanup(); try { res.end(); } catch { /* socket already gone */ } };
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(endStream, OS_STREAM_IDLE_MS);
  };

  const writeEvent = (type) => {
    if (cleanedUp) return;
    if (!res.writable) { cleanup(); return; }
    try {
      const data = JSON.stringify({ type, at: new Date().toISOString() });
      res.write(`event: ${type}\nid: ${++seq}\ndata: ${data}\n\n`);
      resetIdle();
    } catch {
      cleanup();
    }
  };

  const openWindow = (type) => {
    const w = { dirty: false, timer: null };
    const tick = () => {
      if (cleanedUp) return;
      if (w.dirty) {
        w.dirty = false;
        writeEvent(type);
        // A failed write cleans the stream up; do not re-arm after that.
        if (!cleanedUp) w.timer = setTimeout(tick, OS_COALESCE_MS);
      } else {
        windows.delete(type);
      }
    };
    w.timer = setTimeout(tick, OS_COALESCE_MS);
    windows.set(type, w);
    return w;
  };

  // At most one event per type per OS_COALESCE_MS: a chat turn records many
  // usage rows, and the client refetches once per burst anyway.
  const onEvent = (ev) => {
    if (cleanedUp || !ev || typeof ev.type !== 'string') return;
    const open = windows.get(ev.type);
    if (open) { open.dirty = true; return; }
    writeEvent(ev.type);
    if (!cleanedUp) openWindow(ev.type);
  };

  unsubscribe = onOsEvent(userId, onEvent);
  resetIdle();
  heartbeatTimer = setInterval(() => {
    if (cleanedUp || !res.writable) { cleanup(); return; }
    try { res.write(': heartbeat\n\n'); }
    catch { cleanup(); }
  }, OS_HEARTBEAT_MS);

  onClientDisconnect(req, res, cleanup);
  req.on('error', cleanup);
  return true;
}

/**
 * Handle GET /kb/os/state and GET /kb/os/stream. Returns false for any other
 * request so the caller can continue routing.
 */
export async function handleOsRoutes(req, res, { userId, url }) {
  if (req.method === 'GET' && url.split('?')[0] === '/kb/os/stream') {
    return handleOsStream(req, res, userId);
  }
  if (req.method !== 'GET' || url.split('?')[0] !== '/kb/os/state') return false;
  const u = new URL(url, 'http://127.0.0.1');

  const windowParam = u.searchParams.get('window') || 'day';
  if (!Object.hasOwn(TOKEN_WINDOWS, windowParam)) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'window must be "day" or "week"' } });
    return true;
  }
  const activityRaw = u.searchParams.has('activity') ? Number(u.searchParams.get('activity')) : ACTIVITY_DEFAULT;
  const activityLimit = Number.isInteger(activityRaw) && activityRaw > 0 ? Math.min(activityRaw, ACTIVITY_MAX) : ACTIVITY_DEFAULT;

  const db = getDb();
  const health = await serverInfo.health();
  const features = config.features;

  const chatTurns = listInFlightChatTurns(userId).map((t) => ({
    chatSessionId: t.chatSessionId,
    startedAt: t.startedAt,
    cancel: cancelChat(t.chatSessionId),
  }));
  const meetingAgentRuns = listRuns(userId).map((r) => ({
    sessionId: r.sessionId,
    planId: r.planId ?? null,
    startedAt: iso(r.startedAt),
    lastTickAt: iso(r.lastTickAt),
    cancel: cancelMeetingAgent(r.sessionId),
  }));
  const liveSessions = listActiveSessions(userId).map((s) => ({
    sessionId: s.sessionId,
    meetingTitle: s.meetingTitle ?? null,
    startedAt: iso(s.startedAt),
    lastWrite: iso(s.lastWrite),
    captionCount: s.captionCount,
    cancel: null,
  }));

  const activityItems = listActivity(db, userId, { limit: activityLimit }).map((a) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    detail: a.detail,
    link: a.link,
    createdAt: a.created_at,
  }));

  const turnComposition = rollupTurnComposition(turnCompositionRecent(userId, { limit: TURN_COMPOSITION_LIMIT }));

  sendJSON(res, 200, {
    generatedAt: new Date().toISOString(),
    apiVersion: serverInfo.apiVersion,
    system: {
      features: features ? [...features].sort() : null,
      kits: kitStatus(features),
      status: health.status,
      checks: health.checks,
    },
    running: { chatTurns, meetingAgentRuns, liveSessions },
    activity: { unread: unreadCount(db, userId), items: activityItems },
    tokens: { ...usageForWindow(db, userId, windowParam), turnComposition },
    knowledge: {
      ...knowledgeCounts(db, userId),
      projectMemory: memoryLedgerRepos(userId).map((r) => ({
        repoRoot: r.repoRoot,
        facts: r.facts,
        active: r.active,
        superseded: r.superseded,
        lastConfirmedAt: r.lastConfirmedAt,
      })),
    },
    macOnly: { loop: 'on this Mac', autoTasks: 'on this Mac' },
  });
  return true;
}
