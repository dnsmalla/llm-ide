// POST /kb/loop/agent-run — the Mac Loop's headless, confined agent step
// (skill stages, stage repairs, fault repairs). The engine and the security
// rules live in llm_agent/sdk/loop-agent.mjs; this module owns the wire
// contract: validation, the timeout, client-disconnect cancellation, usage
// metering and the response shape.
//
// Request  { message, skills?: [id], repoRoot, extraRoots?: [abs], language?,
//            model?, provider?, timeoutMs?, writeScope?: ".factory" }
//
// `provider` (API v66, the Mac's Loop tier route): "anthropic" or an
// Anthropic-compatible "custom:<id>" (one with an anthropicBaseURL). Absent =
// first-party Anthropic, exactly as before. The engine resolves it with the
// v2 chat's gate (resolveAgentEngineAuth) before anything spawns; a refusal
// answers 400 { error: { code: PROVIDER_UNAVAILABLE | PROVIDER_NOT_AGENT_CAPABLE } }.
// The run is metered under the provider that ran.
// Response { reply, changedPaths: [repo-relative], changedExtraPaths: [abs],
//            createdPaths: [repo-relative, the subset a Write created],
//            usage, resolvedSkills, unresolvedSkills, truncatedSkills, ran,
//            resultSubtype, denied, noProgressReason? }
//
// Contract (mirrors the sibling route modules):
//   handleLoopAgentRoutes(req, res, { userId }, deps) → Promise<boolean>
// `deps` ({ runAgent, validateRoot }) is the tests' seam for the engine.
// Also POST /kb/loop/ship (handleLoopShip below): commit, scan, push and a draft PR/MR for a Factory worktree.

import { randomUUID } from 'node:crypto';
// constants.mjs, not engine.mjs: a route must not load the chat engine for one string.
// MAX_LOOP_MESSAGE_CHARS is here too, so validation runs before the Loop engine import.
import { AGENT_SDK_PROVIDER, MAX_LOOP_MESSAGE_CHARS } from '../llm_agent/sdk/constants.mjs';
import { recordUsage, pickMainModelRow } from '../kb/usage.mjs';
import { getDb, recordToolEvents } from '../kb/db.mjs';
import { beginAgentRun, runTotals } from '../kb/agent-runs.mjs';
import { sendJSON, readBody, parseJSON, onClientDisconnect } from '../core/utils.mjs';
import { beginLoopRun } from '../core/agent-busy.mjs';
import { isSdkUpdating } from '../llm_agent/sdk/updater.mjs';
import { isPluginUpdating } from '../plugins/claude-update.mjs';
import { authorizeAction, enforceRouteAuthority, hubFolderRefusal, projectScopeRefusal } from '../server/route-authority.mjs';
import { projectIdForFolder } from '../kb/projects.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { getSecret } from '../server/vault.mjs';
import { createDraftPr, assertSafeBaseBranch } from '../agents/github-pr.mjs';
import {
  commitAndPush, createDraftMr, findOpenRequest, neutraliseMentions, parseShipBody, scanShipText, isFactoryWorktree, isProviderWebUrl, originMatchesRepo,
} from '../agents/factory-ship.mjs';

const MAX_SKILL_IDS = 5;
// "custom:" + a 100-char id (server/tier-routing.mjs's provider shape) fits.
const MAX_PROVIDER_CHARS = 128;
// resolveAgentEngineAuth's refusals — the caller's choice of provider, not an
// engine failure, so they are a 400 with the code kept (as agent-v2.mjs does).
const PROVIDER_ERROR_CODES = new Set(['PROVIDER_NOT_AGENT_CAPABLE', 'PROVIDER_UNAVAILABLE']);
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
// happened — a metering failure never changes the answer. `turnId` keys the
// ledger rows (request_id) to the run's tool calls (turn_tool_events), so
// "which tools did an expensive step call" is one join.
// `provider` is the one the run was started with: the engine refuses an
// unusable one before spawning, so a run that reaches here really ran on it
// (the same rule /agent/v2/stream meters by).
// R-034 #6: the run's own `costUsd` and the resolved `projectId` ride along. The run total is put on
// the primary model's row only (like `turns`) so a helper model cannot multiply it; a 0/absent cost
// leaves the column NULL and `recordUsage` estimates from the tokens.
function meterRun(userId, out, requestedModel, turnId, provider = AGENT_SDK_PROVIDER, projectId = null) {
  if (!out) return;
  recordToolEvents(userId, { turnId, engine: 'loop', events: out.toolEvents });
  const meteredModel = out.model ?? requestedModel;
  const runCost = Number(out.usage?.costUsd);
  const costUsd = Number.isFinite(runCost) && runCost > 0 ? runCost : null;
  try {
    const db = getDb();
    const rows = Array.isArray(out.byModel) && out.byModel.length
      ? out.byModel
      : (meteredModel && out.ran ? [{ model: meteredModel, ...out.usage }] : []);
    // Round trips belong to the RUN, not to a model: put them on the primary
    // model's row only, or a run that also used a helper model would count twice.
    const turns = Number(out.usage?.numTurns) > 0 ? Number(out.usage.numTurns) : null;
    // The same selection the chat meter uses: the init name and the SDK's per-model
    // keys can differ by a suffix ("[1m]"), and an exact match alone would put the
    // turns on whichever model happened to be listed first — often a small helper.
    const primaryIndex = Math.max(0, rows.indexOf(pickMainModelRow(rows, meteredModel)));
    rows.forEach((row, index) => {
      recordUsage(db, {
        userId, provider, model: row.model, endpoint: '/kb/loop/agent-run', requestId: turnId,
        inputTokens: row.inputTokens, outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens,
        projectId: projectId || null,
        ...(index === primaryIndex ? { turns, stopReason: out.resultSubtype ?? null, costUsd } : {}),
      });
    });
  } catch { /* metering is best-effort */ }
}

// The Loop engine (llm_agent/sdk/loop-agent.mjs) imports the Agent SDK and
// engine.mjs. This route module is loaded at boot whenever auto_tasks is
// enabled (routes/feature-routes.mjs), so a static import put the SDK and the
// whole chat engine on every default boot. Imported on the first Loop run
// instead; memoised, and a rejected import is forgotten so the next run
// retries rather than failing until restart.
let loopEnginePromise = null;
function loadLoopEngine() {
  loopEnginePromise ??= import('../llm_agent/sdk/loop-agent.mjs')
    .catch((err) => { loopEnginePromise = null; throw err; });
  return loopEnginePromise;
}

export async function handleLoopAgentRoutes(req, res, { userId } = {}, deps = {}) {
  const sdkUpdating = deps.isSdkUpdating ?? isSdkUpdating;
  const pluginUpdating = deps.isPluginUpdating ?? isPluginUpdating;
  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/kb/loop/ship') return handleLoopShip(req, res, { userId }, deps);
  if (!(req.method === 'POST' && (req.url || '').split('?')[0] === '/kb/loop/agent-run')) return false;

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
  if (body.provider != null && (typeof body.provider !== 'string' || body.provider.length > MAX_PROVIDER_CHARS)) {
    return validationError(res, `provider must be a string of at most ${MAX_PROVIDER_CHARS} characters`);
  }
  const provider = body.provider ? body.provider.trim() || undefined : undefined;
  const meteredProvider = provider || AGENT_SDK_PROVIDER;
  // Factory Intake / Review write only their reports (.factory/). Only that literal is accepted.
  if (body.writeScope != null && body.writeScope !== '.factory') {
    return validationError(res, 'writeScope must be ".factory"', 'invalid_write_scope');
  }
  const writeScope = body.writeScope === '.factory' ? '.factory' : undefined;

  // R-021 #1: the Loop root decides the project. A body projectId that names another project is a mismatch, and a
  // hub run in an unregistered folder is refused. R-020 Q1: the project grant may only narrow the team grant.
  const namedProjectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
  const folder = typeof body.repoRoot === 'string' && body.repoRoot ? body.repoRoot : null;
  const folderProjectId = folder ? projectIdForFolder(getDb(), folder) : null;
  if (namedProjectId && folderProjectId && namedProjectId !== folderProjectId) {
    sendJSON(res, 403, { error: { code: 'PROJECT_MISMATCH', message: 'That project does not own this folder' } });
    return true;
  }
  // R-023 #1: on a hub this run edits a folder that must belong to a project (and it always edits a folder).
  const hubRefusal = hubFolderRefusal(folder, folderProjectId);
  if (hubRefusal) { sendJSON(res, hubRefusal.status, { error: { code: hubRefusal.code, message: hubRefusal.message } }); return true; }
  const projectId = folderProjectId || namedProjectId;
  const scopeRefusal = projectScopeRefusal(getDb(), userId, projectId);
  if (scopeRefusal) { sendJSON(res, scopeRefusal.status, { error: { code: scopeRefusal.code, message: scopeRefusal.message } }); return true; }
  // ADR 0021 + R-014#1: a Loop run edits files on the operator's model login.
  // The server dispatcher applies the same table; this call keeps the direct
  // handler (and its tests) on the one gate, after body validation and before
  // the engine import, the root allow-list or any model call.
  if (enforceRouteAuthority(getDb(), req, res)) return true;
  if (projectId) {
    const decision = authorizeAction(getDb(), userId, 'model.exec', { projectId, req });
    if (!decision.ok) { sendJSON(res, decision.status, { error: { code: decision.code, message: decision.message } }); return true; }
  }

  // The engine is imported only now: everything above is pure validation, so
  // a malformed request is answered without pulling in the Agent SDK. The
  // root checks below are engine code (the allow-list and worktree rules live
  // with the security rules they protect), so this is the first real use.
  let engine;
  try {
    engine = await loadLoopEngine();
  } catch (err) {
    // Same answer as a run that failed inside the engine (see the catch below).
    process.stderr.write(`[loop-agent] engine import failed: ${err?.message || err}\n`);
    sendJSON(res, 502, {
      error: { code: 'INTERNAL_ERROR', message: `The Loop agent run failed: ${err?.message || err}` },
    });
    return true;
  }
  const runAgent = deps.runAgent ?? engine.runLoopAgent;
  const validateRoot = deps.validateRoot ?? engine.validateLoopRepoRoot;

  const rootCheck = validateRoot(userId, body.repoRoot);
  if (!rootCheck.ok) return validationError(res, rootCheck.reason, 'REPO_ROOT_NOT_ALLOWED');
  const extraCheck = engine.validateLoopExtraRoots(body.extraRoots, rootCheck.root);
  if (!extraCheck.ok) return validationError(res, extraCheck.reason, 'EXTRA_ROOT_NOT_ALLOWED');
  // R-034 #9: every extra root is project work too. It must resolve to a registered project, and the
  // caller needs `model.exec` THERE — a nested project's admin cannot write the enclosing project's docs.
  for (const extraRoot of extraCheck.roots) {
    const extraProjectId = projectIdForFolder(getDb(), extraRoot);
    if (!extraProjectId) {
      sendJSON(res, 403, { error: { code: 'EXTRA_ROOT_NOT_ALLOWED', message: 'That extra root is not in a registered project' } });
      return true;
    }
    const decision = authorizeAction(getDb(), userId, 'model.exec', { projectId: extraProjectId, req });
    if (!decision.ok) {
      sendJSON(res, decision.status, { error: { code: 'EXTRA_ROOT_NOT_ALLOWED', message: 'That extra root is in a project you cannot edit' } });
      return true;
    }
  }

  // One controller for both ways a run ends early: the timeout, and the
  // client going away (Loop Stop / app quit). `abortController` is the shape
  // the SDK needs to kill its CLI subprocess.
  const ac = new AbortController();
  const turnId = randomUUID();
  // agent.db run row (plan 2.5): run_id = turnId. Closed once, in the finally.
  const agentRun = beginAgentRun(userId, { runId: turnId, source: 'loop', engine: 'loop', provider: meteredProvider, model: model ?? null });
  let runOut = null;          // a finished run's output, or a cut-off run's partial usage
  let runStatus = 'error';
  let runErrorCode = null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  onClientDisconnect(req, res, () => ac.abort());
  // Same guards as /agent/v2/stream: replacing the SDK or plugin tree under a
  // running Loop step would launch its CLI from a half-installed package. The
  // updater's own busy check catches a run that is already active; this closes
  // the opposite race, a run that starts while the update is installing.
  if (sdkUpdating()) {
    sendJSON(res, 503, { error: { code: 'SDK_UPDATING', message: 'The Claude Agent SDK is being updated — try again in a moment.' } });
    return true;
  }
  if (pluginUpdating()) {
    sendJSON(res, 503, { error: { code: 'PLUGIN_UPDATING', message: 'A plugin is being updated — try again in a moment.' } });
    return true;
  }
  // Counted for GET /kb/agent-sdk's busy summary: the SDK updater must not run under it.
  const endBusy = beginLoopRun();

  // R-034 #13: a Loop can run for hours. The engine re-reads this before every tool call and aborts
  // the step when the grant or cap no longer allows model.exec on this project.
  const authorityCheck = () => {
    const decision = authorizeAction(getDb(), userId, 'model.exec', { projectId });
    return decision.ok
      ? { ok: true }
      : { ok: false, message: 'Your team or project access changed during this run; it was stopped.' };
  };
  try {
    const out = await runAgent({
      message: body.message,
      skills,
      root: rootCheck.root,
      extraRoots: extraCheck.roots,
      userId,
      language,
      model,
      provider,
      writeScope,
      authorityCheck,
      projectId,
      abortController: ac,
      // The same auth ladder as /agent/v2/stream: vault key → env key →
      // the operator's ambient `claude login`.
      allowAmbientAuth: true,
    });
    // Metered first: a run cut off by the timeout or a disconnect still spent tokens.
    // A run whose stream just ENDS after an abort (no exception) has no result
    // subtype either; name the cut-off so it is not recorded as "unknown".
    meterRun(userId, {
      ...out,
      resultSubtype: out.resultSubtype ?? (timedOut ? 'timeout' : (ac.signal.aborted ? 'aborted' : null)),
    }, model, turnId, meteredProvider, projectId);
    runOut = out;
    runStatus = timedOut ? 'aborted' : (ac.signal.aborted ? 'cancelled' : 'ok');
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
      // Set with resultSubtype 'no_progress' (llm_agent/sdk/loop-progress.mjs).
      ...(out.noProgressReason ? { noProgressReason: out.noProgressReason } : {}),
    });
  } catch (err) {
    // A cut-off run still reports what it spent before it was stopped.
    // Why it was cut off, so "hit the cap" and "timed out" can be told apart later.
    const cutOffReason = timedOut ? 'timeout' : (ac.signal.aborted ? 'aborted' : 'error');
    if (err?.partialUsage) meterRun(userId, { ...err.partialUsage, ran: true, resultSubtype: cutOffReason }, model, turnId, meteredProvider, projectId);
    runOut = err?.partialUsage ? { usage: err.partialUsage } : null;
    runStatus = timedOut ? 'aborted' : (ac.signal.aborted ? 'cancelled' : 'error');
    runErrorCode = err?.code || 'ENGINE_ERROR';
    if (timedOut) {
      sendJSON(res, 504, { error: { code: 'AGENT_RUN_TIMEOUT', message: `The agent run exceeded ${timeoutMs} ms` } });
    } else if (ac.signal.aborted) {
      // Client disconnected mid-run; the socket is gone.
    } else if (PROVIDER_ERROR_CODES.has(err?.code)) {
      sendJSON(res, 400, { error: { code: err.code, message: err.message } });
    } else if (err?.code === 'NO_KEY') {
      sendJSON(res, 503, { error: { code: 'NO_KEY', message: err.message } });
    } else {
      process.stderr.write(`[loop-agent] run failed: ${err?.message || err}\n`);
      sendJSON(res, 502, {
        error: { code: 'INTERNAL_ERROR', message: `The Loop agent run failed: ${err?.message || err}` },
      });
    }
  } finally {
    clearTimeout(timer);
    endBusy();
    agentRun.finish({
      ...runTotals(runOut?.usage),
      status: runStatus,
      toolCalls: Array.isArray(runOut?.toolEvents) ? runOut.toolEvents.length : 0,
      stopReason: runOut?.resultSubtype ?? null,
      errorCode: runStatus === 'error' ? runErrorCode : null,
    });
  }
  return true;
}

// POST /kb/loop/ship: the Factory's only push, from a user click in the desktop Loop screen.
// Body { worktree, branch, provider: 'github'|'gitlab', repo, base, title, body? }
// → { url, commit, reused }. Commit + secret scan + push happen BEFORE any provider call, so a
// refused scan or push never opens a PR/MR. A second ship reuses the open PR/MR.
const SHIP_BODY_LIMIT = 64 * 1024;
const SHIP_STATUS = Object.freeze({
  invalid_worktree: 400, secret_detected: 422, push_rejected: 409, commit_failed: 500, provider_error: 502,
});
const SHIP_PROVIDER_NAME = Object.freeze({ github: 'GitHub', gitlab: 'GitLab' });

function shipFail(res, status, code, message) {
  sendJSON(res, status, { error: { code, message } });
  return true;
}

async function handleLoopShip(req, res, { userId } = {}, deps = {}) {
  // Desktop only (bus host proof), like routes/issue-writes.mjs: this route uses the vaulted token.
  if (!verifyBusHostProof(req)) return shipFail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  const v = parseShipBody(parseJSON(await readBody(req, SHIP_BODY_LIMIT)));
  if (v.error) return shipFail(res, 400, 'VALIDATION_FAILED', v.error);
  // The title and body go to a third party: a secret in them is refused (the rule name only, never the text), and
  // @ mentions are defused so the request cannot ping people.
  if (scanShipText(v.title, v.body)) return shipFail(res, 400, 'secret_detected', 'The title or description appears to contain a secret. Remove it, then Ship again.');
  v.title = neutraliseMentions(v.title);
  v.body = neutraliseMentions(v.body);
  const projectId = projectIdForFolder(getDb(), v.worktree);
  const hubRefusal = hubFolderRefusal(v.worktree, projectId);
  if (hubRefusal) return shipFail(res, hubRefusal.status, hubRefusal.code, hubRefusal.message);
  if (enforceRouteAuthority(getDb(), req, res)) return true;
  if (projectId) {
    const decision = authorizeAction(getDb(), userId, 'external.write', { projectId, req });
    if (!decision.ok) return shipFail(res, decision.status, decision.code, decision.message);
  }
  let engine;
  try { engine = await loadLoopEngine(); } catch { return shipFail(res, 502, 'INTERNAL_ERROR', 'The Loop engine could not be loaded'); }
  const validateRoot = deps.validateRoot ?? engine.validateLoopRepoRoot;
  const rootCheck = validateRoot(userId, v.worktree);
  if (!rootCheck.ok || !isFactoryWorktree(rootCheck.root, v.branch)) {
    return shipFail(res, 400, 'invalid_worktree', 'This is not a Factory run worktree of a repository on your allow-list.');
  }
  try { await assertSafeBaseBranch(rootCheck.root, v.base); } catch { return shipFail(res, 400, 'VALIDATION_FAILED', 'base is not a valid branch name'); }
  // The push goes to the worktree repo's `origin`; the PR/MR goes to `v.repo`. They must be the same repository.
  const originOk = await (deps.originMatchesRepo ?? originMatchesRepo)(rootCheck.root, v.provider, v.repo);
  if (!originOk) return shipFail(res, 400, 'VALIDATION_FAILED', 'The repository origin does not match the target repo on the chosen provider.');
  const name = SHIP_PROVIDER_NAME[v.provider];
  const token = getSecret(getDb(), userId, `${v.provider}.token`);
  if (!token) return shipFail(res, 400, `${v.provider.toUpperCase()}_TOKEN_MISSING`, `Add a ${name} token in Settings → Built-in keys first.`);
  let commit;
  try {
    ({ commit } = await commitAndPush({ worktree: rootCheck.root, branch: v.branch, message: v.title }));
  } catch (err) {
    const known = Object.hasOwn(SHIP_STATUS, err?.code);
    return shipFail(res, known ? SHIP_STATUS[err.code] : 500, known ? err.code : 'commit_failed', known ? err.message : 'The commit could not be made.');
  }
  let url = null;
  let reused = false;
  try {
    url = await findOpenRequest(v.provider, v.repo, v.branch, token);
    reused = Boolean(url);
    if (!url && v.provider === 'github') {
      url = (await createDraftPr({ ghRepo: v.repo, ghToken: token, title: v.title, head: v.branch, base: v.base, body: v.body }))?.html_url;
    } else if (!url) {
      url = (await createDraftMr({ glProject: v.repo, glToken: token, title: v.title, source: v.branch, target: v.base, body: v.body })).url;
    }
  } catch {
    url = null;
  }
  if (!isProviderWebUrl(v.provider, url)) {
    // Fixed text: createDraftPr's error carries (redacted) provider text, which never reaches the client.
    return shipFail(res, 502, 'provider_error', `The branch was pushed, but ${name} did not open the request. Check the token and the base branch, then Ship again.`);
  }
  sendJSON(res, 200, { url, commit, reused });
  return true;
}
