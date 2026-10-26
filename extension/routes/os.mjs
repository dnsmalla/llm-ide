// GET /kb/os/state — the read-only System view aggregate. Joins the SQL reads
// in kb/os-state.mjs (and the kb helpers they sit beside) with the in-memory
// registries of this process (chat turns, meeting-agent runs, live sessions).
// No model call and no write; every number comes from data the server already
// records. Always on: it is not owned by any LLMIDE_FEATURES group.
import { sendJSON } from '../core/utils.mjs';
import { config } from '../core/config.mjs';
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
// route answers an honest "unknown" health rather than inventing one.
let serverInfo = {
  apiVersion: null,
  health: async () => ({ status: 'unknown', checks: { db: false, claude: false, skills: false } }),
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

/**
 * Handle GET /kb/os/state. Returns false for any other request so the caller
 * can continue routing.
 */
export async function handleOsRoutes(req, res, { userId, url }) {
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
