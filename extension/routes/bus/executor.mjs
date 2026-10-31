// The command bus executor (docs/spec/command-bus.md). One place that receives a command, applies the tier gate, stores
// it, runs it on the job runner and re-checks permission at execution time. HTTP lives in bus-routes.mjs; persistence in
// kb/bus-store.mjs; engines in engines.mjs. Per user everywhere: every call takes `userId` first, from the session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createJobRunner } from '../../kb/job-runner.mjs';
import { getDb } from '../../kb/db.mjs';
import {
  createCommand, getCommand, getCommandArgs, approveCommand, denyCommand, cancelPending, expireStale, expireStaleAllSystem,
  ensureTerminal, appendEvent, terminalFor, backfillTerminalsSystem, purgeOldCommandsSystem, isKindEnabled, ERROR_CODES,
} from '../../kb/bus-store.mjs';
import { reapOrphanedRunningSystem } from '../../kb/job-queue.mjs';
import { resolveProjectRoot } from '../../kb/project-roots.mjs';
import { buildTrustedRoots, isWithinRoots, isTooBroadRoot } from '../../llm_agent/tools/handlers/repo-files.mjs';
import { redactValue } from '../../kb/bus-store.mjs';
import { REGISTRY, COMMAND_SCHEMA, LIMITS, kindInfo, classInfo, decideReceipt, mayApprove } from './registry.mjs';
import { validate } from './schema-validate.mjs';
import { runReview } from './review.mjs';
import { engineIdFor, engineStatus, ENGINE_NOT_SANDBOXED } from './engines.mjs';

export const busEnabled = () => String(process.env.LLMIDE_BUS || '').toLowerCase() !== 'off';

export class BusError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; if (details !== undefined) this.details = details; }
}

// A per-process secret: the approval nonce is HMAC(secret, user|command|args) so it needs no storage, can be recomputed for
// the desktop on every GET /bus/approvals, and dies with the process (a restart simply shows a fresh nonce).
const NONCE_SECRET = crypto.randomBytes(32);
export function approvalNonce(userId, cmdId, argsHash) {
  return crypto.createHmac('sha256', NONCE_SECRET).update(`${userId}|${cmdId}|${argsHash}`).digest('hex');
}

const laneFor = (info, kind, args) => (info.write ? `write:${args.projectId ?? kind}` : `read:${kind}:${args.projectId ?? ''}`);
const codeOf = (e) => (ERROR_CODES.includes(e?.code) ? e.code : 'engine_failed');

/** Strip big text from a result before it goes into a terminal event; the full result is on the command row. */
export function eventResult(result) {
  if (!result || typeof result !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v === 'string') { if (v.length <= 300 && k !== 'text') out[k] = v; else out[`${k}Bytes`] = Buffer.byteLength(v, 'utf8'); }
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function capResult(result) {
  const r = redactValue(result);
  const max = LIMITS.maxResultBytes;
  if (Buffer.byteLength(JSON.stringify(r), 'utf8') > max && typeof r.text === 'string') {
    r.text = r.text.slice(0, Math.max(0, max - 2048));
    r.truncated = true;
  }
  return r;
}

const confirmMatches = (args, confirm) => {
  if (!confirm || typeof confirm !== 'object') return false;
  const norm = (o) => JSON.stringify({ projectId: o.projectId ?? null, issueIds: [...(o.issueIds ?? [])].sort(), ship: !!o.ship });
  return norm(args) === norm(confirm);
};
export { confirmMatches };

/**
 * @param {object} o
 * @param {object} [o.logger]
 * @param {object} [o.deps] test seams: { resolveProjectRoot, projectAllowed, runReview, engineDeps, handlers }
 */
export function createBus({
  logger, deps = {}, maxConcurrent = 3, perUserLimit, graceMs = 2000, sweepMs = 60_000, sweepStaleMs = 30_000, jobTimeoutMs,
} = {}) {
  // Fairness: one user may run at most `perUserLimit` commands at once (default: all slots but one), so a user who
  // queues many commands cannot occupy every slot and starve the others.
  const userLimit = Number.isInteger(perUserLimit) && perUserLimit > 0 ? perUserLimit : Math.max(1, maxConcurrent - 1);
  const log = (level, event, data) => { try { logger?.[level]?.(event, data); } catch { /* best effort */ } };
  const projectRootFor = deps.resolveProjectRoot ?? resolveProjectRoot;
  const projectAllowed = deps.projectAllowed ?? ((userId, root) => {
    let real; try { real = fs.realpathSync(root); } catch { return false; }
    if (isTooBroadRoot(real)) return false;
    let trusted = []; try { trusted = buildTrustedRoots(userId) || []; } catch { trusted = []; }
    return isWithinRoots(real, trusted);
  });
  const review = deps.runReview ?? runReview;

  /** The execution-time re-check and the kind's work. Failures are thrown as `new Error(<registry error code>)`. */
  async function execute(kind, ctx) {
    const { job, signal, spawn } = ctx;
    const userId = job.userId;
    const fail = (code) => { throw Object.assign(new Error(code), { code }); };
    try {
      const cmd = getCommand(userId, job.id);
      const info = kindInfo(kind);
      if (!cmd || !info) fail('not_found');
      if (Date.now() > Date.parse(cmd.ttlAt)) fail('expired');
      if (!info.available) fail('kind_not_available');
      if (!classInfo(cmd.originClient)?.mayStart.includes(info.tier)) fail('tier_denied');
      const approved = !!cmd.approvedBy;
      if (info.tier === 'T0' && cmd.originClient !== 'desktop-ui' && !approved && !isKindEnabled(userId, kind)) fail('switch_off');
      if (!getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) fail('not_found');
      const args = getCommandArgs(userId, job.id) ?? {};
      let root = null;
      if (args.projectId) {
        try { root = projectRootFor(userId, args.projectId); } catch { fail('project_not_registered'); }
        if (root && typeof root === 'object') root = root.root;
        if (!projectAllowed(userId, root)) fail('project_not_allowed');
      }
      const emit = (type, payload) => appendEvent(userId, job.id, { type, payload });
      emit('progress', { step: 'checks passed' });
      let result;
      if (kind === 'review') result = await review({ userId, args, cwd: root, signal, spawn, emit, deps: deps.engineDeps });
      else fail('kind_not_available');
      if (signal.aborted) return undefined;
      result = capResult(result);
      for (let i = 0, text = result.text || ''; i < text.length && i < 40 * 8000; i += 8000) emit('chunk', { text: text.slice(i, i + 8000) });
      return result;
    } catch (e) {
      const code = codeOf(e);
      log('warn', 'bus_job_failed', { kind, code }); // the code only: never a message, path or output
      throw new Error(code);
    }
  }

  const handlers = {};
  for (const [kind, info] of Object.entries(REGISTRY.kinds)) {
    if (info.available) handlers[kind] = { run: (ctx) => execute(kind, ctx), resumable: false, timeoutMs: 20 * 60 * 1000 };
  }
  Object.assign(handlers, deps.handlers || {});

  const runner = createJobRunner({
    handlers, maxConcurrent, perUserLimit: userLimit, graceMs, logger, ...(jobTimeoutMs ? { jobTimeoutMs } : {}),
    onSettled: ({ job, state, result, error }) => {
      const ev = terminalFor(state, state === 'succeeded' ? { ...eventResult(result) } : undefined, error);
      if (ev) appendEvent(job.userId, job.id, { ...ev, terminal: true });
    },
  });

  let timer = null;
  /**
   * A job still 'running' that this runner does not hold means its settle threw (finishJobSystem failed): the lane would
   * stay locked for good. Mark it interrupted, write its terminal event and let the queue move on.
   * @returns {{ id: string, userId: string }[]} the reaped jobs
   */
  function sweepOrphans({ staleMs = sweepStaleMs } = {}) {
    const reaped = reapOrphanedRunningSystem(runner.activeIds(), { staleMs });
    for (const { id, userId } of reaped) {
      log('warn', 'bus_orphan_reaped', { id });
      try { ensureTerminal(userId, id); } catch (e) { log('warn', 'bus_orphan_terminal_failed', { error: String(e?.message || e) }); }
    }
    if (reaped.length) runner.pump();
    return reaped;
  }
  const sweep = () => {
    try { sweepOrphans(); expireStaleAllSystem(); purgeOldCommandsSystem(); backfillTerminalsSystem(); }
    catch (e) { log('warn', 'bus_sweep_failed', { error: String(e?.message || e) }); }
  };

  function receive(userId, rawFrame, { client }) {
    if (!rawFrame || typeof rawFrame !== 'object' || Array.isArray(rawFrame)) throw new BusError(400, 'VALIDATION_FAILED', 'body must be a JSON object');
    const frame = { ...rawFrame };
    for (const k of ['origin', 'userId', 'deviceId']) delete frame[k]; // set by the host from the session, never from the frame
    if (frame.v !== undefined && frame.v !== 1) throw new BusError(400, 'UNSUPPORTED_VERSION', 'unsupported contract version', { supported: [1] });
    if (typeof frame.kind === 'string' && !kindInfo(frame.kind)) throw new BusError(400, 'UNKNOWN_KIND', 'unknown command kind');
    const problems = validate(COMMAND_SCHEMA, frame);
    const info = kindInfo(frame.kind);
    if (info && frame.args && typeof frame.args === 'object' && !Array.isArray(frame.args)) problems.push(...validate(info.args, frame.args, {}, '.args'));
    if (problems.length) throw new BusError(400, 'INVALID_ARGS', 'the command is not valid', { errors: problems.slice(0, 10) });
    const flagEnabled = isKindEnabled(userId, frame.kind);
    const gate = decideReceipt({ client, kind: frame.kind, flagEnabled });
    if (gate.outcome === 'tier_denied') throw new BusError(403, 'TIER_DENIED', 'this client may not start that kind of command', { tier: info.tier, client });
    if (gate.outcome === 'not_available') throw new BusError(501, 'KIND_NOT_AVAILABLE', 'this kind is not available on this server', { reason: info.unavailableReason });
    if (frame.args.projectId) {
      try { projectRootFor(userId, frame.args.projectId); } catch { throw new BusError(404, 'NOT_FOUND', 'project not found'); }
    }
    if (frame.kind === 'review') {
      // An engine that cannot be confined is refused at receipt, so nothing is queued that could never run safely.
      const eid = engineIdFor(frame.args.engine?.provider ?? 'anthropic');
      const st = eid ? engineStatus(eid, deps.engineDeps) : null;
      if (st && !st.available) throw new BusError(501, ENGINE_NOT_SANDBOXED, 'this engine cannot be confined to a read-only run yet', { engine: eid, reason: st.reason });
    }
    const needsApproval = gate.outcome === 'needs_approval';
    const ttlMs = Math.min(LIMITS.maxTtlMs, frame.ttlMs ?? (needsApproval ? LIMITS.approvalTtlMs : LIMITS.defaultTtlMs));
    let out;
    try {
      out = createCommand(userId, {
        kind: frame.kind, tier: info.tier, idem: frame.idem, args: frame.args, originClient: client,
        needsApproval, approvalReason: gate.reason, lane: laneFor(info, frame.kind, frame.args), ttlMs,
        jobPayload: { args: frame.args },
      });
    } catch (e) {
      if (e.code === 'IDEM_CONFLICT') throw new BusError(409, 'IDEM_CONFLICT', e.message);
      if (e.code === 'QUOTA_EXCEEDED' || e.code === 'quota_exceeded') throw new BusError(429, 'QUOTA_EXCEEDED', e.message, e.details);
      if (e.code === 'payload_too_large') throw new BusError(413, 'PAYLOAD_TOO_LARGE', e.message);
      throw e;
    }
    if (out.created && !needsApproval) runner.pump();
    return out;
  }

  function approve(userId, id, { client, nonce, confirm }) {
    if (!mayApprove(client)) throw new BusError(403, 'TIER_DENIED', 'only the desktop can approve a command', { client });
    expireStale(userId);
    const cmd = getCommand(userId, id);
    if (!cmd) throw new BusError(404, 'NOT_FOUND', 'command not found');
    const args = getCommandArgs(userId, id) ?? {};
    const hash = getDb().prepare('SELECT args_hash FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id).args_hash;
    const want = approvalNonce(userId, id, hash);
    const ok = typeof nonce === 'string' && nonce.length === want.length && crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(want));
    if (!ok) throw new BusError(403, 'APPROVAL_NONCE_INVALID', 'the approval nonce is missing or wrong; read it from the desktop approvals list');
    const info = kindInfo(cmd.kind);
    if (REGISTRY.tiers[info.tier].approval === 'desktop_confirm' && !confirmMatches(args, confirm)) {
      throw new BusError(400, 'CONFIRM_MISMATCH', 'confirm must repeat the exact ids this command will act on');
    }
    let command;
    try { command = approveCommand(userId, id, { approvedBy: client, lane: laneFor(info, cmd.kind, args), jobPayload: { args } }); }
    catch (e) {
      if (e.code === 'NOT_FOUND') throw new BusError(404, 'NOT_FOUND', 'command not found');
      if (e.code === 'NOT_PENDING') throw new BusError(409, 'NOT_PENDING', e.message, e.details);
      if (e.code === 'EXPIRED') throw new BusError(409, 'EXPIRED', e.message);
      if (e.code === 'QUOTA_EXCEEDED' || e.code === 'quota_exceeded') throw new BusError(429, 'QUOTA_EXCEEDED', e.message);
      throw e;
    }
    runner.pump();
    return command;
  }

  function deny(userId, id, { client }) {
    if (!mayApprove(client)) throw new BusError(403, 'TIER_DENIED', 'only the desktop can deny a command', { client });
    try { return denyCommand(userId, id, { deniedBy: client }); }
    catch (e) {
      if (e.code === 'NOT_FOUND') throw new BusError(404, 'NOT_FOUND', 'command not found');
      if (e.code === 'NOT_PENDING') throw new BusError(409, 'NOT_PENDING', e.message, e.details);
      throw e;
    }
  }

  function cancel(userId, id) {
    const cmd = getCommand(userId, id);
    if (!cmd) throw new BusError(404, 'NOT_FOUND', 'command not found');
    if (cmd.state === 'awaiting_approval') { cancelPending(userId, id); return getCommand(userId, id); }
    if (['denied', 'expired', 'cancelled', 'succeeded', 'failed', 'interrupted'].includes(cmd.state)) {
      if (cmd.state === 'cancelled') return cmd; // idempotent
      throw new BusError(409, 'ALREADY_FINISHED', 'this command has already finished', { state: cmd.state });
    }
    const r = runner.cancel(userId, id);
    if (!r.ok) throw new BusError(409, 'ALREADY_FINISHED', 'this command has already finished');
    ensureTerminal(userId, id);
    return getCommand(userId, id);
  }

  return {
    runner,
    receive, approve, deny, cancel, sweepOrphans,
    start() {
      const swept = runner.start();
      sweep();
      timer = setInterval(sweep, sweepMs);
      timer.unref?.();
      return swept;
    },
    async stop() {
      clearInterval(timer); timer = null;
      await runner.stop();
    },
    sweep,
  };
}
