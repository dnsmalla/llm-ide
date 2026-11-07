// Central member authority for the routes that can run an agent/Loop, edit
// files, install skills, add a repo or spend model money (R-014#1).
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

import { requireRole } from './auth.mjs';
import { usedUsdMonth } from '../kb/usage.mjs';
import { recordAudit } from './audit.mjs';
import { sendJSON } from '../core/utils.mjs';

const exact = (path) => (p) => p === path;
const prefix = (base) => (p) => p === base || p.startsWith(`${base}/`);
const any = (pattern) => (p) => pattern.test(p);

// Every write under /kb/docs (/kb/docs/templates, /commands, /seed) lands in a
// project folder. /kb/projects/register is the map those writes resolve through.
const docsWrite = (method) => ({
  id: `docs.${method.toLowerCase()}`, method, match: prefix('/kb/docs'),
  role: 'member', maxMode: 'execute', cap: false, feature: 'doc_gen',
});

/**
 * The authority table. `cap: true` means the member's monthly USD cap is checked
 * before the route starts (0 = no cap). `feature` is documentation: the feature
 * gate itself still answers 404 `feature_disabled` before this table (server.mjs
 * skips a disabled feature's request and lets the router answer).
 */
export const ROUTE_AUTHORITY = Object.freeze([
  // ── Agent / Loop runs and the meeting agent ──────────────────────────────
  {
    id: 'loop.agent-run', method: 'POST', match: exact('/kb/loop/agent-run'),
    role: 'member', maxMode: 'execute', cap: true, feature: 'auto_tasks',
  },
  {
    id: 'agent.dispatch', method: 'POST', match: exact('/kb/agent/dispatch'),
    role: 'member', maxMode: 'execute', cap: true,
  },
  {
    id: 'providers.turn', method: 'POST', match: exact('/kb/providers/turn'),
    role: 'member', maxMode: 'execute', cap: true,
  },

  // ── One-shot / pipeline model spend ──────────────────────────────────────
  {
    id: 'complete', method: 'POST', match: exact('/kb/complete'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'agent.ask', method: 'POST', match: exact('/kb/agent/ask'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'generate.notes', method: 'POST', match: exact('/generate-notes'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'generate.questions', method: 'POST', match: exact('/generate-questions'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'extract.entities', method: 'POST', match: exact('/extract-entities'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'generate.doc', method: 'POST', match: exact('/generate-doc'),
    role: 'member', maxMode: 'read_only', cap: true, feature: 'doc_gen',
  },
  {
    id: 'plan.generate', method: 'POST', match: exact('/kb/generate-plan'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'plan.risks', method: 'POST', match: exact('/kb/analyze-risks'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'plan.codegen', method: 'POST', match: exact('/kb/generate-code'),
    role: 'member', maxMode: 'read_only', cap: true,
  },
  {
    id: 'connector.classify', method: 'POST',
    match: any(/^\/kb\/(email|slack|box|mcp-connector)\/classify$/),
    role: 'member', maxMode: 'read_only', cap: true,
  },

  // ── File edits, installs and repo allow-list writes ──────────────────────
  {
    id: 'project.install-skills', method: 'POST', match: exact('/kb/project/install-skills'),
    role: 'admin', maxMode: 'execute', cap: false,
  },
  {
    id: 'agent-sdk.update', method: 'POST', match: exact('/kb/agent-sdk/update'),
    role: 'admin', maxMode: 'execute', cap: false,
  },
  {
    id: 'repos.add', method: 'POST', match: exact('/auth/me/repos'),
    role: 'member', maxMode: 'execute', cap: false,
  },
  {
    id: 'repos.remove', method: 'DELETE', match: exact('/auth/me/repos'),
    role: 'member', maxMode: 'execute', cap: false,
  },
  {
    // The extensions catalog installs executable code (skills/plugins/hooks/MCP)
    // and toggles it per user. Admin + execute, like the plugin routes that
    // already call requireRole. The allowlist it searches against is admin too.
    id: 'extensions.write', method: 'POST',
    match: any(/^\/auth\/me\/extensions\/(install|toggle|uninstall|update|rollback|repair|catalog\/refresh)$/),
    role: 'admin', maxMode: 'execute', cap: false,
  },
  {
    id: 'extensions.allowlist', method: 'PUT', match: exact('/auth/me/extensions/allowlist'),
    role: 'admin', maxMode: 'execute', cap: false,
  },
  {
    id: 'review.approve', method: 'POST', match: exact('/kb/review/approve'),
    role: 'member', maxMode: 'execute', cap: false,
  },
  {
    id: 'dispatch', method: 'POST', match: exact('/kb/dispatch'),
    role: 'member', maxMode: 'execute', cap: false,
  },
  docsWrite('POST'),
  docsWrite('PUT'),
  docsWrite('DELETE'),
  {
    id: 'projects.register', method: 'POST', match: exact('/kb/projects/register'),
    role: 'member', maxMode: 'execute', cap: false, feature: 'doc_gen',
  },
]);

/** The rule for a request, or null when the route is not one of the table's. */
export function routeAuthorityFor(method, url) {
  const path = String(url || '').split('?')[0];
  return ROUTE_AUTHORITY.find((rule) => rule.method === method && rule.match(path)) ?? null;
}

/** One rule by id (the direct-call routes name theirs, so a URL typo cannot bypass it). */
export function routeAuthorityById(id) {
  return ROUTE_AUTHORITY.find((rule) => rule.id === id) ?? null;
}

function deny(db, userId, reason, status, code, message) {
  try {
    // The reason only: never the request body, a path, a prompt or a model.
    recordAudit(db, { userId, action: 'team.deny', outcome: 'denied', detail: { reason } });
  } catch { /* an audit failure must not turn a refusal into a 500 */ }
  return { ok: false, reason, status, code, message };
}

/**
 * Apply one rule (or the table's rule for `req`) to the caller.
 * Returns `{ ok: true, rule, member }` or `{ ok: false, reason, status, code, message }`.
 * A denial is already audited. No `members` row fails closed (`role_denied`).
 */
export function authorizeRoute(db, req, { rule = routeAuthorityFor(req?.method, req?.url), userId = req?.user?.id } = {}) {
  if (!rule) return { ok: true, rule: null, member: null };
  if (!userId) return deny(db, null, 'role_denied', 403, 'ROLE_DENIED', 'Authentication required');

  let member;
  try {
    // ADR 0021: the one role gate, reading the members row (never the JWT claim).
    member = requireRole(db, req, rule.role ?? 'member');
  } catch {
    return deny(db, userId, 'role_denied', 403, 'ROLE_DENIED', `Requires team role ${rule.role ?? 'member'}`);
  }

  if (member.maxMode === 'none') {
    return deny(db, userId, 'max_mode_none', 403, 'ROLE_DENIED', 'Your team role cannot run turns');
  }
  if (rule.maxMode === 'execute' && member.maxMode !== 'execute') {
    return deny(db, userId, 'max_mode_insufficient', 403, 'ROLE_DENIED', 'Requires the execute run mode');
  }
  // read_only operations accept read_only and execute; `none` was refused above.
  if (rule.cap) {
    const cap = Number(member.usdCapMonth);
    if (cap > 0 && usedUsdMonth(db, userId) >= cap) {
      return deny(db, userId, 'usd_cap', 429, 'USD_CAP', 'Monthly USD cap reached');
    }
  }
  return { ok: true, rule, member };
}

/**
 * The dispatcher form: enforce the table for `req`, answer a refusal, and return
 * true when the request was handled. Unlisted routes return false (the JWT is
 * still required by `authenticate`, as before).
 */
export function enforceRouteAuthority(db, req, res) {
  const decision = authorizeRoute(db, req);
  if (decision.ok) return false;
  sendJSON(res, decision.status, { error: { code: decision.code, message: decision.message } });
  return true;
}
