// /agent/v2/* — the public HTTP surface of the v2 chat engine (the
// Agent-SDK-powered successor of the CLI loop behind the Mac chat). Wire
// contract: docs/superpowers/specs/2026-08-18-agent-v2-engine-design.md §4;
// pinned shapes in tests/agent-v2-routes.test.mjs.
//
// Three endpoints, all JWT-authenticated (req.user is attached by the
// global auth middleware before dispatch reaches here):
//   POST   /agent/v2/stream   one chat turn → SSE event stream
//   POST   /agent/v2/decision answers a parked AskUserQuestion approval
//   DELETE /agent/v2/session  drops the chat→SDK-session mapping (+ SDK
//                             transcript files, best-effort)
//
// Contract (mirrors the sibling route modules):
//   handleAgentV2Routes(req, res, deps) → Promise<boolean>
//     true  = route handled (response written)
//     false = not an /agent/v2/* request — caller continues dispatch
// The `deps` seam ({ runTurn }) is how the tests fake the engine;
// production always runs the real runAgentV2Turn.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentV2Turn, agentSdkHomeFor } from '../llm_agent/sdk/engine.mjs';
import { taskTurnResponse } from '../llm_agent/runtime/task-session-context.mjs';
import { answerDecision, abortDecisionsForSession } from '../llm_agent/sdk/decisions.mjs';
import { classifyCodeAssistMode, MODES } from '../llm_agent/runtime/mode-classify.mjs';
import { buildPerUserSkillSet } from '../llm_agent/skills/registry.mjs';
import { expandSlashCommand } from '../plugins/loader.mjs';
import { getDb } from '../kb/db.mjs';
import { deleteSessionMemory } from '../kb/session-memory.mjs';
import {
  getOrCreateAgentSession,
  markAgentSessionUsed,
  deleteAgentSession,
} from '../kb/agent-sessions.mjs';
import { recordUsage } from '../kb/usage.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';

// Mirrors buildEngineOptions' mode default so the mode_set echo reports
// what actually ran. Keep the two in sync.
const DEFAULT_MODE = 'execute';

// Leading-slash plugin commands expand exactly like the legacy loop
// (llm_agent/runtime/route.mjs): the enabled command set for THIS user,
// then template expansion before the turn runs. Default seam so tests can
// pin the route contract without plugin state on disk.
function expandUserSlashCommand(message, userId) {
  const { commands: userCommands } = buildPerUserSkillSet(userId);
  return expandSlashCommand(message, userCommands);
}

// One v2 turn at a time per (user, chat session): `agent_sessions` has no
// row-level lock, so two overlapping streams for the same chat would both
// read the same `sdk_session_id` and call `resume:` on it concurrently — the
// SDK has no defined behavior for resuming one session from two callers at
// once. In-process Set is sufficient (single Node server, single writer);
// a second request for a key already running is rejected fast, before any
// session-row or engine work, rather than raced.
const inFlightChatSessions = new Set();

function chatSessionLockKey(userId, chatSessionId) {
  return `${userId}:${chatSessionId}`;
}

export async function handleAgentV2Routes(
  req,
  res,
  deps = { runTurn: runAgentV2Turn, classifyMode: classifyCodeAssistMode, expandSlash: expandUserSlashCommand },
) {
  const url = req.url || '';
  if (!url.startsWith('/agent/v2')) return false;

  // Tenancy gate — the dispatcher has already authenticated, but this module
  // is also callable directly (tests); refuse to operate without a user.
  const userId = req.user?.id;
  if (!userId) {
    sendJSON(res, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authenticated user required' } });
    return true;
  }

  if (req.method === 'POST' && url === '/agent/v2/stream') {
    return handleV2Stream(req, res, userId, deps);
  }
  if (req.method === 'POST' && url === '/agent/v2/decision') {
    return handleV2Decision(req, res, userId);
  }
  if (req.method === 'DELETE' && url === '/agent/v2/session') {
    return handleV2SessionDelete(req, res, userId);
  }

  sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: `No agent/v2 route for ${req.method} ${url}` } });
  return true;
}

// --- POST /agent/v2/stream ----------------------------------------------------
//
// Body: { message, language?, model?, mode?, skills?, planExecute?, agentContext:
// { chatSessionId, workspaceRoot, … }, attachments?, fresh? } → SSE stream
// of engine events with `mode_set` injected right after the first `init`.
//
// Session mapping: the server owns the chat→SDK-session binding
// (kb/agent-sessions.mjs) so consecutive turns resume the same SDK
// conversation; `fresh` deliberately skips the recorded id (client asked to
// start over, e.g. after SESSION_UNRESUMABLE). On success the mapping is
// refreshed with the session the stream actually reported and the turn is
// metered into the usage ledger (per-model caps keep working).

async function handleV2Stream(req, res, userId, deps) {
  const body = parseJSON(await readBody(req, 8 * 1024 * 1024)) || {};

  // Validation happens BEFORE the SSE headers: once the stream has started
  // the status code is fixed, so a bad request must answer as plain JSON.
  const message = typeof body.message === 'string' ? body.message : '';
  if (!message.trim()) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing message' } });
    return true;
  }
  const agentContext = body.agentContext && typeof body.agentContext === 'object' ? body.agentContext : {};
  const chatSessionId = typeof agentContext.chatSessionId === 'string' ? agentContext.chatSessionId : '';
  if (!chatSessionId) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'agentContext.chatSessionId is required' } });
    return true;
  }
  const workspaceRoot = typeof agentContext.workspaceRoot === 'string' ? agentContext.workspaceRoot : '';
  if (!workspaceRoot) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'agentContext.workspaceRoot is required' } });
    return true;
  }

  // Mode resolution — parity with the legacy loop (llm_agent/runtime/
  // route.mjs): "auto" (the Mac client's default) classifies the message
  // into a concrete mode, an explicit mode must be a known MODES member,
  // and anything else (missing / typo / stale client) runs execute rather
  // than a mode string the engine's personas don't recognize. Resolved
  // BEFORE the lock so the per-chat lock never spans the classifier's LLM
  // call; the classifier's own failure fallback (execute) is defended here
  // too so a classify infrastructure error can never fail the turn.
  const requestedMode = typeof body.mode === 'string' && body.mode ? body.mode : '';
  let mode;
  if (requestedMode === 'auto') {
    try {
      const classified = (await deps.classifyMode(message, { userId }))?.mode;
      mode = typeof classified === 'string' && MODES.has(classified) ? classified : DEFAULT_MODE;
    } catch {
      mode = DEFAULT_MODE;
    }
  } else {
    mode = requestedMode && MODES.has(requestedMode) ? requestedMode : DEFAULT_MODE;
  }

  // Slash-command expansion — parity with the legacy loop: a message that
  // starts with "/" is looked up against the user's enabled command set
  // and its template expanded before the turn. An unknown/bad command
  // answers pre-SSE JSON like the other validation failures.
  let effectiveMessage = message;
  if (message.trim().startsWith('/')) {
    const expansion = deps.expandSlash(message, userId);
    if (expansion && expansion.error) {
      sendJSON(res, 400, { error: { code: 'SLASH_COMMAND_FAILED', message: expansion.error } });
      return true;
    }
    if (expansion) effectiveMessage = expansion.prompt;
  }

  const model = typeof body.model === 'string' && body.model ? body.model : null;

  const lockKey = chatSessionLockKey(userId, chatSessionId);
  if (inFlightChatSessions.has(lockKey)) {
    sendJSON(res, 409, {
      error: { code: 'TURN_IN_PROGRESS', message: 'A turn is already in progress for this chat session' },
    });
    return true;
  }
  inFlightChatSessions.add(lockKey);
  try {
    return await runV2Stream(req, res, userId, chatSessionId, agentContext, mode, model, effectiveMessage, body, deps);
  } finally {
    inFlightChatSessions.delete(lockKey);
  }
}

// The rest of the turn, once this chat session's lock is held — split out so
// the lock's try/finally above stays a thin wrapper around it.
async function runV2Stream(req, res, userId, chatSessionId, agentContext, mode, model, message, body, deps) {
  const db = getDb();
  const row = getOrCreateAgentSession(db, userId, chatSessionId);
  const resumeSdkSessionId = body.fresh ? null : row.sdk_session_id;

  // SSE framing identical to the legacy /code-assist + spike streams.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const ac = new AbortController();
  // The SDK session THIS turn runs in: the resumed id until the stream
  // reports its own (init carries it first). A dropped stream unparks any
  // pending approval for exactly that session immediately — belt and braces
  // alongside the engine's own abort wiring (its canUseTool listeners
  // target the same id).
  let currentSdkSessionId = resumeSdkSessionId;
  req.on('close', () => {
    ac.abort();
    if (currentSdkSessionId) abortDecisionsForSession(currentSdkSessionId);
  });
  const send = (obj) => {
    if (!res.writableEnded && !ac.signal.aborted) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };
  // mode_set rides right after the first init event (spec §4 ordering) —
  // the engine doesn't know its resolved mode is a UI concern.
  let initSeen = false;
  // The model the engine actually ran, mirrored from currentSdkSessionId's
  // capture pattern: the SDK's system/init reports it (result events don't
  // carry model, so one guard covers exactly the init). Without it, a turn
  // whose client sent no `model` would meter model:null — recordUsage skips
  // such rows entirely, blinding the per-model usage caps.
  let resolvedModel = null;
  // Last task list emitted as a `tasks_progress` event, as a compact
  // signature. A turn can run dozens of tool calls; recomputing the list is
  // an in-memory map read, but re-sending an unchanged list on every one of
  // them would be pure stream noise.
  let lastTaskSignature = null;
  // Live task progress. The terminal `tasks` event below is emitted AFTER
  // the SDK result, so before this a plan-execute run of 30 steps showed a
  // progress bar frozen at "Step 1 of 30" for the whole turn — the client
  // only learned what had completed once everything had. A task tool can
  // only change the list by running, so a tool_result is the exact moment
  // to re-check it.
  //
  // Deliberately a SEPARATE event type from the terminal `tasks`: that one
  // also carries `continueNeeded`, which the Mac uses to decide whether to
  // fire an auto-continue turn. Mid-turn that answer is always "yes, work
  // remains" and acting on it would chain a second turn on top of the one
  // still running, so this event carries the list only.
  const emitTaskProgress = () => {
    let currentTasks;
    try {
      ({ tasks: currentTasks } = taskTurnResponse(userId, agentContext, mode));
    } catch { return; }   // task bookkeeping must never break the turn's stream
    if (!Array.isArray(currentTasks) || currentTasks.length === 0) return;
    const signature = currentTasks.map((t) => `${t.id}:${t.status}:${t.title}`).join('|');
    if (signature === lastTaskSignature) return;
    lastTaskSignature = signature;
    send({ type: 'tasks_progress', tasks: currentTasks });
  };
  const onEvent = (ev) => {
    if (ev && typeof ev.sessionId === 'string' && ev.sessionId) currentSdkSessionId = ev.sessionId;
    if (typeof ev?.model === 'string' && ev.model) resolvedModel = ev.model;
    send(ev);
    if (!initSeen && ev && ev.type === 'init') {
      initSeen = true;
      send({ type: 'mode_set', mode });
    }
    if (ev && ev.type === 'tool_result') emitTaskProgress();
  };

  try {
    const { usageTotals } = await deps.runTurn({
      message,
      userId,
      mode,
      model,
      language: body.language,
      skills: body.skills,
      // Set by the saved-plan card's "Execute plan" action — the one
      // signal the server can trust that this Execute turn is working an
      // already-approved plan, so the pipeline injects the execution
      // skill (llm_agent/runtime/plan-pipeline.mjs).
      planExecute: body.planExecute === true,
      agentContext,
      attachments: body.attachments,
      resumeSdkSessionId: resumeSdkSessionId ?? undefined,
      onEvent,
      signal: ac.signal,
      // Auth ladder's last rung (spec §7, the same ladder runClaude uses):
      // after the per-user vault key and ANTHROPIC_API_KEY miss, the SDK
      // subprocess falls back to the operator's ambient claude login. The
      // engine keeps the rung opt-in (hermetic tests pin the no-key error);
      // the route is what enables it — without this, a user with no stored
      // key gets ENGINE_ERROR on every v2 turn.
      allowAmbientAuth: true,
    });
    // Success bookkeeping: bind/refresh the mapping with the session the
    // stream reported, then meter the turn. The engine-resolved model wins
    // over the client's request (the SDK resolves defaults/fallbacks); with
    // neither, model is null and recordUsage skips the row — accepted, since
    // there is then genuinely no model name to meter under. (recordUsage's
    // real params are userId/provider/model/source/endpoint/inputTokens/
    // outputTokens/runs/requestId — cost is not a ledger column, so costUsd
    // is not passed.)
    const meteredModel = resolvedModel ?? model;
    if (currentSdkSessionId) {
      markAgentSessionUsed(db, userId, chatSessionId, { sdkSessionId: currentSdkSessionId, model: meteredModel, mode });
      // A fresh turn (or an unresumable-session recovery) REPLACES the
      // recorded SDK session — the old session's transcript then belongs to
      // no mapping, so session delete could never find it again. Clean it
      // now. Gated on "no resume was attempted" rather than a bare
      // id-comparison: today a resumed turn reports the SAME id (verified
      // live), but if a future SDK resumes-as-fork, an id-only check would
      // delete the parent transcript holding the conversation's history.
      if (!resumeSdkSessionId && row.sdk_session_id && row.sdk_session_id !== currentSdkSessionId) {
        deleteSdkTranscripts(userId, row.sdk_session_id);
      }
    }
    recordUsage(db, {
      userId,
      provider: 'anthropic',
      model: meteredModel,
      endpoint: '/agent/v2/stream',
      inputTokens: usageTotals?.inputTokens,
      outputTokens: usageTotals?.outputTokens,
    });
    // Task parity with legacy /code-assist: emit after the SDK result so the
    // Mac can populate PlanTimelineCard and auto-continue when work remains.
    const { tasks: currentTasks, continueNeeded } = taskTurnResponse(userId, agentContext, mode);
    send({ type: 'tasks', tasks: currentTasks, continueNeeded });
  } catch (err) {
    if (err?.code === 'SESSION_UNRESUMABLE') {
      // The resumed SDK session is gone (pruned/cleared). Terminal error
      // event carrying the code — the stream has already started, so the
      // "409" is realized here; the client retries the turn with fresh:true.
      send({
        type: 'error',
        code: 'SESSION_UNRESUMABLE',
        message: err?.message || 'SDK session is no longer resumable',
        retryable: true,
      });
    } else if (!ac.signal.aborted) {
      send({ type: 'error', code: 'ENGINE_ERROR', message: err?.message || 'agent v2 turn failed', retryable: false });
    }
  }
  if (!res.writableEnded) res.end();
  return true;
}

// --- POST /agent/v2/decision ----------------------------------------------------
//
// Body: { requestId, sdkSessionId, answers } → resolves a parked approval
// (llm_agent/sdk/decisions.mjs). The registry owns tenancy: the deciding
// user AND session must match the parked entry.

async function handleV2Decision(req, res, userId) {
  const body = parseJSON(await readBody(req, 64 * 1024)) || {};
  const out = answerDecision({
    requestId: body.requestId,
    sdkSessionId: body.sdkSessionId,
    userId,
    action: body.action,
    answers: body.answers,
  });
  if (out.ok) {
    sendJSON(res, 200, { ok: true });
    return true;
  }
  if (out.reason === 'tenancy') {
    sendJSON(res, 403, {
      error: { code: 'DECISION_FORBIDDEN', message: 'This decision belongs to another user or session' },
    });
    return true;
  }
  // unknown | expired — either way there is nothing pending to answer.
  sendJSON(res, 404, {
    error: {
      code: out.reason === 'expired' ? 'DECISION_EXPIRED' : 'DECISION_UNKNOWN',
      message: `No pending decision for this requestId (${out.reason})`,
    },
  });
  return true;
}

// --- DELETE /agent/v2/session ---------------------------------------------------

async function handleV2SessionDelete(req, res, userId) {
  const body = parseJSON(await readBody(req, 16 * 1024)) || {};
  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId : '';
  if (!chatSessionId) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'chatSessionId is required' } });
    return true;
  }
  const dropped = deleteAgentSession(getDb(), userId, chatSessionId);
  const sdkSessionId = dropped?.sdkSessionId ?? null;
  deleteSdkTranscripts(userId, sdkSessionId);
  // The chat's DB-backed session-memory facts go with it — one route call
  // cleans everything, instead of trusting every client to also call
  // DELETE /kb/agent/session-memory (session memory keys on the same
  // chatSessionId — see resolveChatSessionId).
  try { deleteSessionMemory(userId, chatSessionId); } catch { /* best-effort, like the transcript cleanup */ }
  sendJSON(res, 200, { ok: true, sdkSessionId });
  return true;
}

// Best-effort SDK transcript cleanup. The SDK stores per-session JSONL
// transcripts under <config dir>/projects/<encoded-workspace>/. KEYED turns
// run under the per-user CLAUDE_CONFIG_DIR (agentSdkHomeFor in
// llm_agent/sdk/engine.mjs); AMBIENT turns run under the operator's default
// config dir (env CLAUDE_CONFIG_DIR, or ~/.claude) — redirecting them would
// hide the operator's login. Whether a given chat's turns were keyed can
// change over its lifetime, so cleanup scans BOTH roots; matching is by the
// chat's unique sdk session id, so scanning the operator dir can only ever
// remove this chat's own files. Pure fs — never a shell call — and silent
// on any failure (no engine home for the user, projects dir missing,
// unreadable entries): transcript cleanup must never fail the mapping
// delete it follows.
function deleteSdkTranscripts(userId, sdkSessionId) {
  // Matching is by `includes(sdkSessionId)`, and the ambient root is the
  // operator's REAL config dir — a degenerate needle (short/garbage id)
  // could wipe unrelated transcripts, so anything that doesn't look like an
  // SDK session id (UUID-shaped, server-recorded) deletes nothing at all.
  if (typeof sdkSessionId !== 'string' || !/^[0-9a-fA-F-]{16,}$/.test(sdkSessionId)) return;
  const ambientRoot = process.env.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');
  // Directory-level recursive rm stays confined to the server-owned per-user
  // home; inside the operator's dir only per-file transcript matches go.
  const perUserHome = agentSdkHomeFor(userId);
  if (perUserHome) deleteTranscriptsUnder(perUserHome, sdkSessionId, { allowDirRm: true });
  deleteTranscriptsUnder(ambientRoot, sdkSessionId, { allowDirRm: false });
}

function deleteTranscriptsUnder(root, sdkSessionId, { allowDirRm }) {
  const projectsDir = path.join(root, 'projects');
  let workspaces;
  try {
    workspaces = fs.readdirSync(projectsDir);
  } catch {
    return; // no projects dir — nothing to clean
  }
  for (const name of workspaces) {
    const entryPath = path.join(projectsDir, name);
    if (allowDirRm && name.includes(sdkSessionId)) {
      try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch { /* best effort */ }
      continue;
    }
    // Transcripts live one level down, inside the encoded workspace dirs.
    let files;
    try {
      files = fs.readdirSync(entryPath);
    } catch {
      continue; // not a directory / unreadable
    }
    for (const file of files) {
      if (!file.includes(sdkSessionId)) continue;
      try { fs.rmSync(path.join(entryPath, file), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
