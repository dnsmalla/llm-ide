// POST /kb/loop/improve/{signal,state,proposals,decide} — thin HTTP wrappers over kb/loop-improve.mjs.
// The client names a folder (`projectRoot`); the project id is resolved here, never trusted from the body,
// so a client cannot write into another project's signals.
//
// Contract (mirrors the sibling route modules):
//   handleLoopImproveRoutes(req, res, { userId }, deps) → Promise<boolean>
// `deps.getDb` is the tests' seam for the database.
import { getDb } from '../kb/db.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { AppError } from '../core/errors.mjs';
import { projectIdForRoot } from '../kb/projects.mjs';
import { authorizeAction } from '../server/route-authority.mjs';
import {
  SIGNAL_KINDS, recordSignal, signalsSinceReview, saveProposals, decide, adoptOffer, dismissOffer, loopState,
} from '../kb/loop-improve.mjs';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_ID_CHARS = 200;
const MAX_LOOPS = 50;
const MAX_STAGE_KEYS = 100;
const MAX_PROPOSALS = 20;
// A proposed change is one stage tweak; a megabyte of JSON is a model gone wrong, not a suggestion.
const MAX_CHANGE_CHARS = 10_000;
const DECIDE_ACTIONS = ['accept', 'reject', 'revert', 'adopt', 'dismiss'];

function fail(res, status, code, message) {
  sendJSON(res, status, { error: { code, message } });
  return true;
}
const invalid = (res, message) => fail(res, 400, 'VALIDATION_FAILED', message);

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
const isCursor = (value) => Number.isInteger(value) && value >= 0;

function sendAppError(res, error) {
  if (error instanceof AppError) {
    return fail(res, error.status ?? 400, error.code ?? 'VALIDATION_FAILED', error.message);
  }
  throw error;
}

function validateSignal(body) {
  if (!isId(body.loopId)) return 'loopId is required';
  if (!SIGNAL_KINDS.includes(body.kind)) return `kind must be one of ${SIGNAL_KINDS.join(', ')}`;
  if (body.stageKey != null && !isId(body.stageKey)) return 'stageKey must be a short string';
  if (body.runId != null && !isId(body.runId)) return 'runId must be a short string';
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return 'payload must be an object';
  return null;
}

function validateLoops(body) {
  if (!Array.isArray(body.loops) || body.loops.length > MAX_LOOPS) return `loops must be an array of at most ${MAX_LOOPS}`;
  for (const loop of body.loops) {
    if (!loop || typeof loop !== 'object' || !isId(loop.loopId)) return 'each loop needs a loopId';
    if (loop.templateKey != null && !isId(loop.templateKey)) return 'templateKey must be a short string';
    if (!Array.isArray(loop.stageKeys) || loop.stageKeys.length > MAX_STAGE_KEYS || loop.stageKeys.some((key) => !isId(key))) {
      return 'each loop needs stageKeys, an array of short strings';
    }
  }
  if (body.reviewInputFor != null && !body.loops.some((loop) => loop.loopId === body.reviewInputFor)) {
    return 'reviewInputFor must name one of the loops';
  }
  return null;
}

function validateProposals(body) {
  if (!isId(body.loopId)) return 'loopId is required';
  if (!isCursor(body.expectedCursor) || !isCursor(body.cursor)) return 'expectedCursor and cursor must be non-negative integers';
  if (!Array.isArray(body.proposals) || body.proposals.length > MAX_PROPOSALS) {
    return `proposals must be an array of at most ${MAX_PROPOSALS}`;
  }
  for (const item of body.proposals) {
    if (!item || typeof item !== 'object' || !item.change || typeof item.change !== 'object') return 'each proposal needs a change object';
    if (typeof item.rationale !== 'string') return 'each proposal needs a rationale string';
    if (item.evidence != null && (typeof item.evidence !== 'object' || !Array.isArray(item.evidence.signalIds))) {
      return 'evidence must be an object with a signalIds array';
    }
    if (item.suggestedScope != null && !['project', 'general'].includes(item.suggestedScope)) {
      return "suggestedScope must be 'project' or 'general'";
    }
    if (JSON.stringify(item.change).length > MAX_CHANGE_CHARS) return `a change must be at most ${MAX_CHANGE_CHARS} characters of JSON`;
  }
  return null;
}

function validateDecide(body) {
  if (!DECIDE_ACTIONS.includes(body.action)) return `action must be one of ${DECIDE_ACTIONS.join(', ')}`;
  if (!isId(body.id)) return 'id is required';
  if (body.action === 'adopt' && !isId(body.loopId)) return 'adopt needs a loopId';
  if (body.scope != null && typeof body.scope !== 'string') return 'scope must be a string';
  return null;
}

const VALIDATORS = { signal: validateSignal, state: validateLoops, proposals: validateProposals, decide: validateDecide };

function run(route, db, userId, projectId, body) {
  if (route === 'signal') {
    return recordSignal(db, userId, {
      projectId, loopId: body.loopId, stageKey: body.stageKey ?? null, kind: body.kind, runId: body.runId ?? null, payload: body.payload,
    });
  }
  if (route === 'state') {
    const state = loopState(db, userId, { projectId, loops: body.loops });
    if (!body.reviewInputFor) return state;
    const { cursor, lastId, signals } = signalsSinceReview(db, userId, projectId, body.reviewInputFor);
    return { ...state, reviewInput: { cursor, lastId, signals } };
  }
  if (route === 'proposals') {
    return saveProposals(db, userId, {
      projectId, loopId: body.loopId, cursor: body.cursor, expectedCursor: body.expectedCursor, proposals: body.proposals,
    });
  }
  if (body.action === 'adopt') return { improvement: adoptOffer(db, userId, { projectId, loopId: body.loopId, offerId: body.id }) };
  if (body.action === 'dismiss') {
    dismissOffer(db, userId, { projectId, offerId: body.id });
    return { improvement: null };
  }
  return { improvement: decide(db, userId, { projectId, id: body.id, action: body.action, scope: body.scope }) };
}

export async function handleLoopImproveRoutes(req, res, { userId } = {}, deps = {}) {
  if (req.method !== 'POST') return false;
  const routePath = (req.url || '').split('?')[0];
  // Literal comparisons, not a prefix slice: scripts/http-inventory.mjs finds a route's handler by scanning
  // string literals on condition lines.
  let route = null;
  if (routePath === '/kb/loop/improve/signal') route = 'signal';
  else if (routePath === '/kb/loop/improve/state') route = 'state';
  else if (routePath === '/kb/loop/improve/proposals') route = 'proposals';
  else if (routePath === '/kb/loop/improve/decide') route = 'decide';
  if (!route) return false;

  const body = parseJSON(await readBody(req, MAX_BODY_BYTES));
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid(res, 'Body must be a JSON object');
  if (typeof body.projectRoot !== 'string' || !body.projectRoot) return invalid(res, 'projectRoot is required');
  const problem = VALIDATORS[route](body);
  if (problem) return invalid(res, problem);

  const db = (deps.getDb ?? getDb)();
  const projectId = projectIdForRoot(db, body.projectRoot);
  if (!projectId) return fail(res, 404, 'PROJECT_UNKNOWN', 'This folder is not in the project registry');
  // The route table already gates the verb (self.read / self.write); a project grant may still narrow it.
  const decision = authorizeAction(db, userId, route === 'state' ? 'self.read' : 'self.write', { projectId, req });
  if (!decision.ok) return fail(res, decision.status, decision.code, decision.message);

  try {
    sendJSON(res, 200, run(route, db, userId, projectId, body));
  } catch (error) {
    return sendAppError(res, error);
  }
  return true;
}
