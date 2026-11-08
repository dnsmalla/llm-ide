// Team authority for every HTTP route (ADR 0021, plan H1.2). Every method + path the core serves has
// exactly one action class (kb/members.mjs CLASS_GRANTS); an authenticated request that matches no
// rule is refused (deny by default). tests/route-policy-coverage.test.mjs fails when a served route has
// no rule or a rule names no route. The evidence for each class is
// docs/superpowers/plans/parity-inventory/route-inventory-2026-11-08.md.
//
// Why a table instead of a check per route: the same omission kept recurring —
// a dangerous route was added with a JWT check and nothing else. Every entry
// declares the minimum team role, the highest run mode it needs, and whether it
// spends money under the member's monthly USD cap. `authorizeRoute` reads the
// `members` row through the SAME gate as the rest of the team surface
// (`requireRole`, ADR 0021), then applies max_mode and the cap. A refusal writes
// one `team.deny` audit row with `{ reason }` only — never a prompt, path, body,
// model name or route detail.
//
// The server dispatcher runs `enforceRouteAuthority` for every request after
// authentication and rate limiting (server.mjs); the routes that can be called
// directly in tests (the Loop run, install-skills, the repo allow-list) call it
// themselves too. Routes whose gate is a different one are listed in
// docs/explanation/invariants.md; this module is the one table for the rest.

import { usedUsdMonth } from '../kb/usage.mjs';
import { recordAudit } from './audit.mjs';
import { sendJSON } from '../core/utils.mjs';
import { getMember, classRefusal, CLASS_GRANTS } from '../kb/members.mjs';

const REFUSALS = Object.freeze({
  role_denied: { status: 403, code: 'ROLE_DENIED', message: (need) => `Requires team role ${need?.role ?? 'member'}` },
  max_mode_none: { status: 403, code: 'ROLE_DENIED', message: () => 'Your team grant cannot run this' },
  max_mode_insufficient: { status: 403, code: 'ROLE_DENIED', message: (need) => `Requires the ${need?.mode} run mode` },
  usd_cap: { status: 429, code: 'USD_CAP', message: () => 'Monthly USD cap reached' },
  unknown_class: { status: 403, code: 'ROLE_DENIED', message: () => 'This action is not permitted' },
});

function refuse(db, userId, reason, cls) {
  try {
    // The reason only: never the request body, a path, a prompt or a model.
    recordAudit(db, { userId, action: 'team.deny', outcome: 'denied', detail: { reason } });
  } catch { /* an audit failure must not turn a refusal into a 500 */ }
  const r = REFUSALS[reason];
  return { ok: false, reason, status: r.status, code: r.code, message: r.message(CLASS_GRANTS[cls]) };
}

/**
 * The one audited check (plan H1.2). Reads the caller's members row now, so a grant change applies on
 * the next request or tick. Used by the route policy, the Host API gateway and the background jobs.
 */
export function authorizeAction(db, userId, cls, { req = null } = {}) {
  if (!userId) return refuse(db, null, 'role_denied', cls);
  const member = getMember(db, userId);
  const reason = classRefusal(member, cls, () => usedUsdMonth(db, userId));
  if (reason) return refuse(db, userId, reason, cls);
  if (req) req.member = member;
  return { ok: true, member };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(routePath) {
  return new RegExp(`^${routePath.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeRe(seg))).join('/')}$`);
}
function rules(cls, method, paths) {
  const need = CLASS_GRANTS[cls];
  return paths.map((p) => Object.freeze({
    cls, method, path: p, re: compile(p), literal: !p.includes('/:'),
    role: need?.role ?? null, maxMode: need?.mode ?? null, cap: need?.cap ?? false,
  }));
}

/** Every route the core serves, by class. Generated from the 2026-11-08 route inventory. */
export const ROUTE_POLICY = Object.freeze([
  ...rules('public', 'GET', [
    '/',
    '/auth/google/callback',
    '/auth/mcp-connector/callback',
    '/auth/slack/callback',
    '/auth/well-known',
    '/health',
    '/kb/sync/box/callback',
    '/launch-app',
  ]),
  ...rules('public', 'POST', [
    '/auth/login',
    '/auth/refresh',
    '/auth/register',
    '/auth/reset-confirm',
    '/auth/reset-request',
  ]),
  ...rules('self.read', 'GET', [
    '/agent/v2/session/route',
    '/agent/v2/session/route/history',
    '/agent/v2/turns',
    '/agent/v2/turns/stream',
    '/auth/google/status',
    '/auth/mcp-connector/status',
    '/auth/me',
    '/auth/me/audit',
    '/auth/me/connectors',
    '/auth/me/connectors/catalog',
    '/auth/me/extensions/active',
    '/auth/me/extensions/allowlist',
    '/auth/me/extensions/catalog',
    '/auth/me/extensions/installed',
    '/auth/me/extensions/updates',
    '/auth/me/llm-sources',
    '/auth/me/mcp-plugins',
    '/auth/me/mcp-plugins/catalog',
    '/auth/me/plugins',
    '/auth/me/prefs',
    '/auth/me/repos',
    '/auth/me/secrets',
    '/auth/me/workspace-trust',
    '/auth/slack/status',
    '/bus/commands',
    '/bus/commands/:id',
    '/bus/commands/:id/events',
    '/bus/kinds',
    '/bus/schedules',
    '/kb/activity',
    '/kb/agent-history/settings',
    '/kb/agent-sdk',
    '/kb/agent/ask/history',
    '/kb/agent/catalog',
    '/kb/agent/commands',
    '/kb/agent/diagnose',
    '/kb/agent/feedback/by-task',
    '/kb/agent/feedback/stats',
    '/kb/agent/generation-library',
    '/kb/agent/persona',
    '/kb/agent/personas',
    '/kb/agent/runs',
    '/kb/agent/session-memory',
    '/kb/agent/skill-library',
    '/kb/agent/tool-approvals',
    '/kb/agent/working-state',
    '/kb/calendar-ical/sources',
    '/kb/chat/sessions',
    '/kb/chat/sessions/:id',
    '/kb/entity/:id',
    '/kb/export-all',
    '/kb/google/accounts',
    '/kb/google/status',
    '/kb/index/search',
    '/kb/index/status',
    '/kb/issue-schedule',
    '/kb/issues',
    '/kb/live/:id',
    '/kb/live/:id/capture',
    '/kb/live/:id/status',
    '/kb/live/:id/stream',
    '/kb/live/sessions',
    '/kb/live/unacked',
    '/kb/meeting/:id',
    '/kb/os/state',
    '/kb/os/stream',
    '/kb/outcomes/stats',
    '/kb/outcomes/task/:id',
    '/kb/plan/:id',
    '/kb/plans',
    '/kb/project/:id/export',
    '/kb/providers/catalog',
    '/kb/providers/custom',
    '/kb/providers/settings',
    '/kb/review/get/:id',
    '/kb/review/list',
    '/kb/routing-tiers',
    '/kb/search',
    '/kb/stats',
    '/kb/storage',
    '/kb/system/status',
    '/kb/usage/limits',
    '/kb/usage/ratelimits',
    '/kb/usage/resolve',
    '/kb/usage/summary',
    '/kb/usage/turn-composition',
  ]),
  ...rules('self.read', 'POST', [
    '/chat',
    '/code-assist',
    '/code-assist/decision',
  ]),
  ...rules('self.write', 'POST', [
    '/agent/v2/cancel',
    '/agent/v2/sessions/purge',
    '/auth/google/start',
    '/auth/logout',
    '/auth/me/connectors/add',
    '/auth/me/delete',
    '/auth/me/llm-sources/items',
    '/auth/me/llm-sources/toggle',
    '/auth/me/password',
    '/auth/me/secrets',
    '/auth/slack/start',
    '/bus/commands/:id/cancel',
    '/kb/activity',
    '/kb/activity/seen',
    '/kb/agent-history/clear',
    '/kb/agent-history/compact',
    '/kb/agent/feedback',
    '/kb/agent/personas',
    '/kb/agent/stop',
    '/kb/archive-receipts',
    '/kb/calendar-ical/options',
    '/kb/calendar-ical/sources',
    '/kb/chat/sessions',
    '/kb/chat/sessions/:id/archive/begin',
    '/kb/chat/sessions/:id/archive/commit',
    '/kb/chat/sessions/:id/messages',
    '/kb/connect-qa',
    '/kb/connect-tickets-json',
    '/kb/custom-providers',
    '/kb/delete',
    '/kb/email/seen',
    '/kb/google/disconnect',
    '/kb/google/gmail/seen',
    '/kb/google/options',
    '/kb/google/start',
    '/kb/index/notes',
    '/kb/index/reconcile',
    '/kb/ingest',
    '/kb/ingest-code-graph',
    '/kb/live/:id/ack',
    '/kb/live/:id/append',
    '/kb/live/:id/finalize',
    '/kb/mcp-connector/seen',
    '/kb/plan-task/update',
    '/kb/plan/delete',
    '/kb/plan/save',
    '/kb/providers/catalog/connect',
    '/kb/providers/catalog/disconnect',
    '/kb/review/delete',
    '/kb/review/reject',
    '/kb/review/submit',
    '/kb/routing-tiers',
    '/kb/session-purges',
    '/kb/slack/seen',
    '/kb/usage/record',
  ]),
  ...rules('self.write', 'PUT', [
    '/agent/v2/session/route',
    '/auth/me/prefs',
    '/kb/agent-history/settings',
    '/kb/agent/persona',
    '/kb/agent/personas/:id',
    '/kb/agent/personas/active',
    '/kb/issue-schedule',
    '/kb/providers/settings',
    '/kb/usage/limits',
  ]),
  ...rules('self.write', 'PATCH', [
    '/kb/chat/sessions/:id',
    '/kb/plan-task/update',
  ]),
  ...rules('self.write', 'DELETE', [
    '/agent/v2/session',
    '/auth/me/connectors/:id',
    '/kb/agent/ask/history',
    '/kb/agent/personas/:id',
    '/kb/agent/session-memory',
    '/kb/agent/tool-approvals',
    '/kb/calendar-ical/sources/:id',
    '/kb/chat/sessions/:id',
    '/kb/chat/sessions/:id/messages',
    '/kb/delete',
    '/kb/index/notes/:key',
    '/kb/issue-schedule',
    '/kb/plan/delete',
    '/kb/review/delete',
  ]),
  ...rules('model.ask', 'POST', [
    '/agent/v2/decision',
    '/agent/v2/stream',
    '/kb/agent/ask',
  ]),
  ...rules('model.read', 'POST', [
    '/bus/commands',
    '/extract-entities',
    '/generate-doc',
    '/generate-docx',
    '/generate-notes',
    '/generate-questions',
    '/kb/analyze-risks',
    '/kb/complete',
    '/kb/conflict-questions',
    '/kb/email/classify',
    '/kb/generate-code',
    '/kb/generate-plan',
    '/kb/mcp-connector/classify',
    '/kb/summarize',
  ]),
  ...rules('model.exec', 'POST', [
    '/agent-sdk/spike',
    '/kb/agent/dispatch',
    '/kb/loop/agent-run',
    '/kb/providers/turn',
    '/kb/self-heal/runs',
  ]),
  ...rules('fs.read', 'GET', [
    '/auth/me/claude-plugins/installed',
    '/auth/me/claude-plugins/marketplace',
    '/auth/me/codex-plugins/installed',
    '/auth/me/codex-plugins/marketplace',
    '/kb/agent/project-memory',
    '/kb/docs/commands',
    '/kb/docs/templates',
  ]),
  ...rules('fs.read', 'POST', [
    '/auth/me/claude-plugins/refresh',
    '/auth/me/codex-plugins/refresh',
    '/kb/code-sync',
    '/kb/connect-git',
    '/kb/index/scan',
  ]),
  ...rules('fs.write', 'POST', [
    '/auth/me/repos',
    '/kb/docs/seed',
    '/kb/ingest-scip',
    '/kb/projects/register',
  ]),
  ...rules('fs.write', 'PUT', [
    '/kb/docs/commands/:folder',
    '/kb/docs/templates/:folder',
  ]),
  ...rules('fs.write', 'DELETE', [
    '/auth/me/repos',
    '/kb/agent/project-memory',
    '/kb/docs/commands/:folder',
    '/kb/docs/templates/:folder',
  ]),
  ...rules('external.read', 'GET', [
    '/auth/me/claude-plugins/updates',
    '/auth/me/codex-plugins/updates',
    '/auth/me/llm-sources/updates',
    '/auth/me/mcp-plugins/updates',
    '/kb/google/calendars',
    '/kb/google/drive/folders',
    '/kb/slack/conversations',
  ]),
  ...rules('external.read', 'POST', [
    '/auth/mcp-connector/start',
    '/kb/box/test',
    '/kb/calendar-ical/sync',
    '/kb/connect-box',
    '/kb/connect-github-issues',
    '/kb/email/fetch',
    '/kb/email/test',
    '/kb/google/gmail/fetch',
    '/kb/google/sync',
    '/kb/mcp-connector/fetch',
    '/kb/mcp-connector/test',
    '/kb/outcomes/refresh',
    '/kb/providers/catalog/models',
    '/kb/providers/catalog/test',
    '/kb/providers/models',
    '/kb/providers/verify',
    '/kb/repos/check-token',
    '/kb/slack/fetch',
    '/kb/slack/test',
  ]),
  ...rules('external.write', 'POST', [
    '/kb/issues/close',
    '/kb/issues/comment',
    '/kb/issues/create',
    '/kb/dispatch',
    '/kb/notify/slack',
    '/kb/outcomes/retry-failed',
    '/kb/review/approve',
  ]),
  ...rules('install', 'GET', [
    '/auth/me/llm-sources/:id/discovery',
    '/auth/me/mcp-plugins/:id/resync',
    '/auth/me/mcp-plugins/claude-sources',
    '/auth/me/mcp-plugins/codex-sources',
  ]),
  ...rules('install', 'POST', [
    '/auth/me/claude-plugins/import',
    '/auth/me/claude-plugins/update',
    '/auth/me/codex-plugins/import',
    '/auth/me/extensions/catalog/refresh',
    '/auth/me/extensions/install',
    '/auth/me/extensions/repair',
    '/auth/me/extensions/rollback',
    '/auth/me/extensions/toggle',
    '/auth/me/extensions/uninstall',
    '/auth/me/extensions/update',
    '/auth/me/extensions/update/preview',
    '/auth/me/extensions/updates/check',
    '/auth/me/llm-sources/add',
    '/auth/me/llm-sources/update',
    '/auth/me/mcp-plugins/:id/resync',
    '/auth/me/mcp-plugins/:id/update',
    '/auth/me/mcp-plugins/add',
    '/auth/me/mcp-plugins/consent',
    '/auth/me/mcp-plugins/toggle',
    '/auth/me/plugins/hook-trust',
    '/auth/me/plugins/install',
    '/auth/me/plugins/install-git',
    '/auth/me/plugins/reload',
    '/auth/me/plugins/toggle',
    '/kb/agent-sdk/update',
    '/kb/project/install-skills',
  ]),
  ...rules('install', 'PUT', [
    '/auth/me/extensions/allowlist',
    '/auth/me/workspace-trust',
  ]),
  ...rules('install', 'DELETE', [
    '/auth/me/llm-sources/:id',
    '/auth/me/mcp-plugins/:id',
    '/auth/me/plugins/uninstall/:name',
  ]),
  ...rules('admin', 'GET', [
    '/admin/invites',
    '/admin/members',
    '/metrics',
  ]),
  ...rules('admin', 'POST', [
    '/admin/backup',
    '/admin/maintenance',
    '/admin/invites',
  ]),
  ...rules('admin', 'PATCH', [
    '/admin/members/:userId',
  ]),
  ...rules('admin', 'DELETE', [
    '/admin/invites/:id',
    '/admin/users/:userId',
  ]),
  ...rules('host', 'GET', [
    '/bus/approvals',
    '/host-api/devices',
    '/host-api/push/status',
    '/kb/self-heal/incidents',
    '/kb/sync/status',
  ]),
  ...rules('host', 'POST', [
    '/bus/commands/:id/approve',
    '/bus/commands/:id/deny',
    '/bus/schedules',
    '/host-api/pin',
    '/host-api/push/send',
    '/kb/self-heal/incidents',
    '/kb/self-heal/incidents/:id/ignore',
    '/kb/self-heal/runs/:id/outcome',
    '/kb/self-heal/runs/:id/resolve',
    '/kb/sync/box/poll',
    '/kb/sync/box/start',
    '/kb/sync/devices/enroll',
    '/kb/sync/devices/enroll/cancel',
    '/kb/sync/devices/enroll/confirm',
    '/kb/sync/devices/enroll/poll',
    '/kb/sync/enabled',
    '/kb/sync/mega',
    '/kb/sync/publish',
    '/kb/sync/rotate',
    '/kb/sync/sftp',
    '/kb/sync/test',
  ]),
  ...rules('host', 'PUT', [
    '/bus/kinds/:kind',
    '/host-api/push/apns',
  ]),
  ...rules('host', 'DELETE', [
    '/bus/schedules/:id',
    '/host-api/devices/:id',
    '/host-api/push/apns',
    '/kb/self-heal/incidents',
    '/kb/sync/devices/:id',
  ]),
]);

/** The rule for a request, or null when no rule declares it. A literal path wins over a `:param` path. */
export function routeAuthorityFor(method, url) {
  const p = String(url || '').split('?')[0];
  return ROUTE_POLICY.find((r) => r.literal && r.method === method && r.path === p)
    ?? ROUTE_POLICY.find((r) => !r.literal && r.method === method && r.re.test(p))
    ?? null;
}

/** Apply one rule (or the request's rule). Public and unlisted requests pass here; see enforceRouteAuthority. */
export function authorizeRoute(db, req, { rule = routeAuthorityFor(req?.method, req?.url), userId = req?.user?.id } = {}) {
  if (!rule || rule.cls === 'public') return { ok: true, rule, member: null };
  const decision = authorizeAction(db, userId, rule.cls, { req });
  return decision.ok ? { ...decision, rule } : decision;
}

/**
 * The dispatcher form. Returns true when it answered the request: a refusal (403/429), or 404 for an
 * authenticated request no rule declares (deny by default, logged so the missing rule is found).
 * An unauthenticated request only reaches here on a public path; one with no rule is left to the router.
 */
export function enforceRouteAuthority(db, req, res, { logger = null } = {}) {
  const rule = routeAuthorityFor(req?.method, req?.url);
  if (!rule) {
    if (!req?.user) return false;
    try { logger?.error?.('route_policy_unlisted', { method: req.method, path: String(req.url || '').split('?')[0] }); } catch { /* logging only */ }
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    return true;
  }
  const decision = authorizeRoute(db, req, { rule });
  if (decision.ok) return false;
  sendJSON(res, decision.status, { error: { code: decision.code, message: decision.message } });
  return true;
}
