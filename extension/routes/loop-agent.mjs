// POST /kb/loop/agent-run — the Mac Loop's headless, confined agent step
// (skill stages, stage repairs, fault repairs). The engine and the security
// rules live in llm_agent/sdk/loop-agent.mjs; this module owns the wire
// contract: validation, the timeout, client-disconnect cancellation, usage
// metering and the response shape.
//
// Request  { message, skills?: [id], repoRoot, extraRoots?: [abs], language?,
//            model?, timeoutMs? }
// Response { reply, changedPaths: [repo-relative], changedExtraPaths: [abs],
//            createdPaths: [repo-relative, the subset a Write created],
//            usage, resolvedSkills, unresolvedSkills, truncatedSkills, ran,
//            resultSubtype, denied }
//
// Contract (mirrors the sibling route modules):
//   handleLoopAgentRoutes(req, res, { userId }, deps) → Promise<boolean>
// `deps` ({ runAgent, validateRoot }) is the tests' seam for the engine.

import {
  runLoopAgent, validateLoopRepoRoot, validateLoopExtraRoots, MAX_LOOP_MESSAGE_CHARS,
} from '../llm_agent/sdk/loop-agent.mjs';
import { AGENT_SDK_PROVIDER } from '../llm_agent/sdk/engine.mjs';
import { recordUsage } from '../kb/usage.mjs';
import { getDb } from '../kb/db.mjs';
import { sendJSON, readBody, parseJSON, onClientDisconnect } from '../core/utils.mjs';

const MAX_SKILL_IDS = 5;
const MIN_TIMEOUT_MS = 1_000;
// A Loop step is bounded by default: a headless run nobody is watching must
// not be able to run forever. The Mac passes its own stage budget.
export const DEFAULT_LOOP_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_LOOP_AGENT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function validationError(res, message, code = 'VALIDATION_FAILED') {
  sendJSON(res, 400, { error: { code, message } });
  return true;
}

export function resolveTimeoutMs(raw) {
  if (raw == null) return DEFAULT_LOOP_AGENT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_LOOP_AGENT_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

// Best-effort metering of one run (finished or cut off). The run already
// happened — a metering failure never changes the answer.
function meterRun(userId, out, requestedModel) {
  if (!out) return;
  const meteredModel = out.model ?? requestedModel;
  try {
    const db = getDb();
    const rows = Array.isArray(out.byModel) && out.byModel.length
      ? out.byModel
      : (meteredModel && out.ran ? [{ model: meteredModel, ...out.usage }] : []);
    for (const row of rows) {
      recordUsage(db, {
        userId, provider: AGENT_SDK_PROVIDER, model: row.model, endpoint: '/kb/loop/agent-run',
        inputTokens: row.inputTokens, outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens,
      });
    }
  } catch { /* metering is best-effort */ }
}

export async function handleLoopAgentRoutes(req, res, { userId } = {}, deps = {}) {
  if (!(req.method === 'POST' && (req.url || '').split('?')[0] === '/kb/loop/agent-run')) return false;
  const runAgent = deps.runAgent ?? runLoopAgent;
  const validateRoot = deps.validateRoot ?? validateLoopRepoRoot;

  const body = parseJSON(await readBody(req, 2 * 1024 * 1024));
  if (!body || typeof body !== 'object') return validationError(res, 'Body must be a JSON object');
  if (typeof body.message !== 'string' || !body.message.trim()) {
    return validationError(res, 'message is required');
  }
  if (body.message.length > MAX_LOOP_MESSAGE_CHARS) {
    return validationError(res, `message exceeds ${MAX_LOOP_MESSAGE_CHARS} characters`);
  }
  if (body.skills != null && !Array.isArray(body.skills)) return validationError(res, 'skills must be an array of ids');
  const skills = Array.isArray(body.skills) ? body.skills : [];
  if (skills.length > MAX_SKILL_IDS || skills.some((s) => typeof s !== 'string' || !s)) {
    return validationError(res, `skills must be at most ${MAX_SKILL_IDS} non-empty id strings`);
  }
  const timeoutMs = resolveTimeoutMs(body.timeoutMs);
  if (timeoutMs == null) return validationError(res, 'timeoutMs must be a positive number of milliseconds');
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 128) : undefined;
  const language = typeof body.language === 'string' ? body.language.slice(0, 32) : undefined;

  const rootCheck = validateRoot(userId, body.repoRoot);
  if (!rootCheck.ok) return validationError(res, rootCheck.reason, 'REPO_ROOT_NOT_ALLOWED');
  const extraCheck = validateLoopExtraRoots(body.extraRoots, rootCheck.root);
  if (!extraCheck.ok) return validationError(res, extraCheck.reason, 'EXTRA_ROOT_NOT_ALLOWED');

  // One controller for both ways a run ends early: the timeout, and the
  // client going away (Loop Stop / app quit). `abortController` is the shape
  // the SDK needs to kill its CLI subprocess.
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  onClientDisconnect(req, res, () => ac.abort());

  try {
    const out = await runAgent({
      message: body.message,
      skills,
      root: rootCheck.root,
      extraRoots: extraCheck.roots,
      userId,
      language,
      model,
      abortController: ac,
      // The same auth ladder as /agent/v2/stream: vault key → env key →
      // the operator's ambient `claude login`.
      allowAmbientAuth: true,
    });
    // Metered first: a run cut off by the timeout or a disconnect still spent tokens.
    meterRun(userId, out, model);
    if (ac.signal.aborted && !timedOut) return true; // client gone — nobody to answer
    if (timedOut) {
      sendJSON(res, 504, { error: { code: 'AGENT_RUN_TIMEOUT', message: `The agent run exceeded ${timeoutMs} ms` } });
      return true;
    }
    sendJSON(res, 200, {
      reply: out.reply,
      changedPaths: out.changedPaths,
      changedExtraPaths: out.changedExtraPaths ?? [],
      createdPaths: out.createdPaths ?? [],
      usage: out.usage,
      resolvedSkills: out.resolvedSkills,
      unresolvedSkills: out.unresolvedSkills,
      truncatedSkills: out.truncatedSkills,
      ran: out.ran,
      resultSubtype: out.resultSubtype,
      denied: out.denied,
    });
  } catch (err) {
    // A cut-off run still reports what it spent before it was stopped.
    if (err?.partialUsage) meterRun(userId, { ...err.partialUsage, ran: true }, model);
    if (timedOut) {
      sendJSON(res, 504, { error: { code: 'AGENT_RUN_TIMEOUT', message: `The agent run exceeded ${timeoutMs} ms` } });
    } else if (ac.signal.aborted) {
      // Client disconnected mid-run; the socket is gone.
    } else if (err?.code === 'NO_KEY') {
      sendJSON(res, 503, { error: { code: 'NO_KEY', message: err.message } });
    } else {
      process.stderr.write(`[loop-agent] run failed: ${err?.message || err}\n`);
      sendJSON(res, 502, {
        error: { code: 'INTERNAL_ERROR', message: 'The Loop agent run failed. Please try again.' },
      });
    }
  } finally {
    clearTimeout(timer);
  }
  return true;
}
