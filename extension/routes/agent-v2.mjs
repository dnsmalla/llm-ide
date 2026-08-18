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
import path from 'node:path';
import { runAgentV2Turn, agentSdkHomeFor } from '../llm_agent/sdk/engine.mjs';
import { answerDecision, abortDecisionsForSession } from '../llm_agent/sdk/decisions.mjs';
import { getDb } from '../kb/db.mjs';
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

export async function handleAgentV2Routes(req, res, deps = { runTurn: runAgentV2Turn }) {
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
// Body: { message, language?, model?, mode?, skills?, agentContext:
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

  const mode = typeof body.mode === 'string' && body.mode ? body.mode : DEFAULT_MODE;
  const model = typeof body.model === 'string' && body.model ? body.model : null;

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
  const onEvent = (ev) => {
    if (ev && typeof ev.sessionId === 'string' && ev.sessionId) currentSdkSessionId = ev.sessionId;
    if (typeof ev?.model === 'string' && ev.model) resolvedModel = ev.model;
    send(ev);
    if (!initSeen && ev && ev.type === 'init') {
      initSeen = true;
      send({ type: 'mode_set', mode });
    }
  };

  try {
    const { usageTotals } = await deps.runTurn({
      message,
      userId,
      mode,
      model,
      language: body.language,
      skills: body.skills,
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
    }
    recordUsage(db, {
      userId,
      provider: 'anthropic',
      model: meteredModel,
      endpoint: '/agent/v2/stream',
      inputTokens: usageTotals?.inputTokens,
      outputTokens: usageTotals?.outputTokens,
    });
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
  sendJSON(res, 200, { ok: true, sdkSessionId });
  return true;
}

// Best-effort SDK transcript cleanup. The SDK stores per-session JSONL
// transcripts under <engine home>/projects/<encoded-workspace>/ — the SAME
// per-user CLAUDE_CONFIG_DIR the engine composes for every turn
// (agentSdkHomeFor in llm_agent/sdk/engine.mjs; production never sets the
// env var by hand) — so a deleted chat's transcripts are dead weight (and a
// privacy remnant): remove every entry whose name contains the sdk session
// id. Pure fs — never a shell call — and silent on any failure (no engine
// home for the user, projects dir missing, unreadable entries): transcript
// cleanup must never fail the mapping delete it follows.
function deleteSdkTranscripts(userId, sdkSessionId) {
  const root = agentSdkHomeFor(userId);
  if (!root || !sdkSessionId) return;
  const projectsDir = path.join(root, 'projects');
  let workspaces;
  try {
    workspaces = fs.readdirSync(projectsDir);
  } catch {
    return; // no projects dir — nothing to clean
  }
  for (const name of workspaces) {
    const entryPath = path.join(projectsDir, name);
    if (name.includes(sdkSessionId)) {
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
