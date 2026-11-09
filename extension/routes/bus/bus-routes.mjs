// HTTP routes of the command bus (spec: docs/spec/command-bus.md). Registered by server.mjs after authenticate and the
// rate limiter ('kbWrite' bucket); nothing else imports it. Every route is per user (req.user.id first); an id that is not
// the caller's answers 404 NOT_FOUND exactly like an unknown id.
//
//   POST /bus/commands                      enqueue by kind (typed args, idem, tier gate)     202 | 200 (idem replay)
//   GET  /bus/commands?state=&limit=        the caller's commands, newest first
//   GET  /bus/commands/:id                  status + bounded result
//   GET  /bus/commands/:id/events?after=N   SSE replay from the durable log, gap-free seq, then live
//   POST /bus/commands/:id/cancel           stop (always allowed; idempotent)
//   POST /bus/commands/:id/approve          desktop-class only, with the per-command nonce
//   POST /bus/commands/:id/deny             desktop-class only
//   GET  /bus/approvals                     desktop-class only: pending commands WITH their nonce
//   GET    /bus/schedules                  desktop + native phone: the user's schedules (no secret in them)
//   POST   /bus/schedules                  desktop-class only: create (optionally with a standing approval)
//   DELETE /bus/schedules/:id              desktop-class only: delete, which also revokes its standing approval
//   GET  /bus/kinds                         the registry as this caller sees it
//   PUT  /bus/kinds/:kind                   desktop-class only: the user's enable flag for a kind
//   GET  /bus/claimable                    desktop + host proof: approved desktop-runner commands no lease holds
//   POST /bus/commands/:id/claim           desktop + host proof: take the single-claimer lease (or renew it)
//   POST /bus/commands/:id/events          desktop + host proof: append one progress event (never a terminal)
//   POST /bus/commands/:id/finish          desktop + host proof: the one terminal event (succeeded|failed|interrupted)
import { send, readJson } from '../../server/route-http.mjs';
import {
  getCommand, listCommands, listEvents, lastSeq, ensureTerminal, expireStale, hasTerminal, terminalEvent, listPendingApprovals,
  setKindEnabled, listKindFlags, appendEvent, claimDesktopCommand, renewDesktopLease, finishClaimedCommand, expireDesktopLeasesSystem,
  listClaimableCommands,
} from '../../kb/bus-store.mjs';
import { getDb } from '../../kb/db.mjs';
import { REGISTRY, LIMITS, kindInfo, classInfo, decideReceipt, mayApprove } from './registry.mjs';
import { resolveClient } from './client.mjs';
import { BusError, approvalNonce, busEnabled, KIND_CLASS } from './executor.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';
import { classRefusal, getMember } from '../../kb/members.mjs';
import { usedUsdMonth } from '../../kb/usage.mjs';
import { engineStatusList } from './engines.mjs';
import { recordAudit } from '../../server/audit.mjs';
import { createSchedule, listSchedules, deleteSchedule } from '../../kb/bus-schedules.mjs';
import { parseScheduleBody } from './schedules.mjs';

export function isBusRoute(url) {
  const path = String(url || '').split('?')[0];
  return path === '/bus' || path.startsWith('/bus/');
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const fail = (res, status, code, message, details) => send(res, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });
const iso = (s) => s;

// Read scope by client class (docs/spec/command-bus.md section 3): the native phone and the desktop (rank 3 and up) read
// every command of the user's; phone-pwa and extension (lower, less trusted classes) read only commands that were
// started by their OWN class. An unreadable command answers 404 exactly like an unknown id, so its existence is not
// confirmed. (Approve and deny are desktop-only anyway.)
const readsAll = (client) => (classInfo(client)?.rank ?? 0) >= 3;
const canRead = (client, c) => !!c && (readsAll(client) || c.originClient === client);

/** One audit row for a state-changing bus call. Never a nonce, a token or a body: ids, kind, class and the error code only. */
function auditBus(req, userId, action, resource, outcome, detail) {
  try {
    recordAudit(getDb(), {
      userId, requestId: req.id, ip: req.socket?.remoteAddress || 'unknown', userAgent: req.headers?.['user-agent'] || '',
      action, resource, outcome, detail,
    });
  } catch { /* an audit failure must never fail the call */ }
}
const outcomeOf = (e) => (e.status === 403 || e.status === 401 ? 'denied' : 'failure');

// ---- desktop-claimed Factory commands (B5) ----
// Only the desktop host that spawned this core may claim, report on or finish one: the client class must be the
// desktop's AND the per-launch host proof must be present (the same proof the approve routes trust).
const MAX_PROGRESS_BYTES = 4 * 1024;
const MAX_FINISH_RESULT_BYTES = 16 * 1024;
const DESKTOP_KINDS = Object.entries(REGISTRY.kinds).filter(([, k]) => k.available && (k.runner ?? 'core') === 'desktop').map(([kind]) => kind);

function desktopOnly(req, res, client) {
  if (!mayApprove(client)) {
    fail(res, 403, 'TIER_DENIED', 'only the desktop can claim or finish a Factory command', { client });
    return false;
  }
  if (!verifyBusHostProof(req)) {
    fail(res, 403, 'HOST_PROOF_REQUIRED', 'this route is for the desktop host that spawned this core');
    return false;
  }
  return true;
}

/** The execution-time permission re-check for a desktop kind: done on every claim and on every claimable read. */
function claimRefusal(userId, kind) {
  const cls = KIND_CLASS[kind];
  if (!cls) return 'kind_not_available';
  return classRefusal(getMember(getDb(), userId), cls, () => usedUsdMonth(getDb(), userId));
}

/** The store's lease errors as bus errors (the wire keeps the three codes the desktop already handles). */
function leaseError(e) {
  if (e instanceof BusError) return e;
  if (e?.code === 'NOT_FOUND') return new BusError(404, 'NOT_FOUND', 'command not found');
  if (e?.code === 'LEASE_HELD') return new BusError(409, 'LEASE_HELD', 'another desktop holds this command');
  if (e?.code === 'LEASE_LOST') return new BusError(409, 'LEASE_LOST', 'the claim is no longer valid');
  if (e?.code === 'invalid_args') return new BusError(400, 'VALIDATION_FAILED', e.message);
  return e;
}

async function readOptionalJson(req, max) {
  try {
    return (await readJson(req, max)) ?? {};
  } catch (err) {
    if (err?.status === 413) throw new BusError(413, 'PAYLOAD_TOO_LARGE', 'the body is too large');
    throw new BusError(400, 'VALIDATION_FAILED', 'Body must be valid JSON');
  }
}

const shapeSchedule = (s) => ({
  id: s.id, kind: s.kind, args: s.args, intervalHours: s.intervalMs / 3_600_000, standing: s.standing,
  standingUntil: s.standingUntil, createdAt: s.createdAt, lastRunAt: s.lastRunAt,
});

function shapeCommand(userId, c, { withResult = false } = {}) {
  const term = c.state === 'queued' || c.state === 'running' || c.state === 'awaiting_approval' ? null : terminalEvent(userId, c.id);
  const out = {
    id: c.id, kind: c.kind, tier: c.tier, state: c.state, originClient: c.originClient,
    createdAt: iso(c.createdAt), expiresAt: iso(c.ttlAt), lastSeq: lastSeq(userId, c.id),
  };
  if (c.approvalReason) out.approvalReason = c.approvalReason;
  if (c.startedAt) out.startedAt = c.startedAt;
  if (c.finishedAt) out.finishedAt = c.finishedAt;
  if (term?.type === 'error') out.errorCode = term.payload.code;
  if (withResult && c.state === 'succeeded' && c.result) out.result = c.result;
  return out;
}

const readersByUser = new Map();
// Open event streams, so shutdown can end them (server.close waits for every open response).
const openStreams = new Set();
export function closeBusStreams() { for (const r of [...openStreams]) { try { r.end(); } catch { /* gone */ } } openStreams.clear(); }

function streamEvents(req, res, userId, id, after) {
  const held = readersByUser.get(userId) || 0;
  if (held >= LIMITS.maxStreamReadersPerUser) { fail(res, 429, 'TOO_MANY_READERS', 'too many event streams are open'); return; }
  readersByUser.set(userId, held + 1);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  openStreams.add(res);
  let closed = false;
  let cursor = after;
  const deadline = Date.now() + LIMITS.streamMaxMs;
  let lastBeat = Date.now();
  const release = () => {
    if (closed) return;
    closed = true;
    openStreams.delete(res);
    const n = (readersByUser.get(userId) || 1) - 1;
    if (n <= 0) readersByUser.delete(userId); else readersByUser.set(userId, n);
  };
  res.on('close', release);
  const tick = () => {
    if (closed) return;
    try {
      expireStale(userId);
      ensureTerminal(userId, id);
      let done = false;
      for (;;) {
        const batch = listEvents(userId, id, cursor, 200);
        if (!batch.length) break;
        for (const ev of batch) {
          res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
          cursor = ev.seq;
          if (ev.terminal) done = true;
        }
        if (batch.length < 200) break;
      }
      if (done || (cursor >= lastSeq(userId, id) && hasTerminal(userId, id))) { release(); res.end(); return; }
      if (Date.now() > deadline) { release(); res.end(); return; } // the client re-attaches with after=<last id>
      if (Date.now() - lastBeat > 15_000) { res.write(': ping\n\n'); lastBeat = Date.now(); }
    } catch { release(); try { res.end(); } catch { /* socket gone */ } return; }
    const t = setTimeout(tick, 300);
    t.unref?.();
  };
  tick();
}

function describeKind(userId, client, flags, kind, info) {
  const gate = decideReceipt({ client, kind, flagEnabled: !!flags[kind] });
  // `engines` lists what can be selected NOW; `engineStatus` lists every engine the kind knows with its availability
  // (codex and gemini: available false, reason ENGINE_NOT_SANDBOXED, until an OS sandbox exists).
  const engineStatus = engineStatusList(info.engines);
  const out = {
    kind, tier: info.tier, lane: info.lane, write: info.write, available: info.available, runner: info.runner ?? 'core', description: info.description,
    engines: engineStatus.filter((e) => e.available).map((e) => e.id), engineStatus, args: info.args, enabled: !!flags[kind],
    allowed: gate.outcome !== 'tier_denied' && gate.outcome !== 'kind_not_allowed' && gate.outcome !== 'unknown_kind',
    needsApproval: gate.outcome === 'needs_approval',
  };
  if (!info.available) out.unavailableReason = info.unavailableReason;
  return out;
}

export async function handleBusRoute(req, res, { bus } = {}) {
  const userId = req.user.id;
  if (!busEnabled() || !bus) { fail(res, 503, 'BUS_DISABLED', 'the command bus is switched off on this server'); return; }
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const { client } = resolveClient(req);
  try {
    // ---- collection ----
    // One literal path per condition line with its method on the same line: scripts/http-inventory.mjs reads the roster's
    // handlers from these lines.
    if (path === '/bus/commands' && req.method === 'POST') {
      let body;
      try { body = await readJson(req, LIMITS.maxCommandBytes); }
      catch (err) { if (err.status === 413) fail(res, 413, 'PAYLOAD_TOO_LARGE', 'the command is too large'); else fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
      const out = bus.receive(userId, body, { client });
      send(res, out.created ? 202 : 200, { command: shapeCommand(userId, out.command), deduped: !out.created });
      return;
    }
    if (path === '/bus/commands' && req.method === 'GET') {
      expireStale(userId);
      const state = url.searchParams.get('state') || undefined;
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw == null || limitRaw === '' ? 50 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) { fail(res, 400, 'VALIDATION_FAILED', 'limit must be an integer from 1 to 200'); return; }
      if (state && !['awaiting_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'denied', 'expired'].includes(state)) { fail(res, 400, 'VALIDATION_FAILED', 'unknown state'); return; }
      send(res, 200, { items: listCommands(userId, { state, limit, ...(readsAll(client) ? {} : { originClient: client }) }).map((c) => shapeCommand(userId, c)) });
      return;
    }
    if (path === '/bus/commands') { fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET or POST only'); return; }

    // ---- kinds ----
    if (path === '/bus/kinds' && req.method === 'GET') {
      const flags = listKindFlags(userId);
      send(res, 200, {
        v: 1, client, registryVersion: REGISTRY.version,
        limits: { maxCommandBytes: LIMITS.maxCommandBytes, maxResultBytes: LIMITS.maxResultBytes, maxActiveCommands: LIMITS.maxActiveCommands, maxPendingApprovals: LIMITS.maxPendingApprovals },
        kinds: Object.entries(REGISTRY.kinds).map(([k, info]) => describeKind(userId, client, flags, k, info)),
      });
      return;
    }
    if (path.startsWith('/bus/kinds/') && req.method === 'PUT') {
      const kind = decodeURIComponent(path.slice('/bus/kinds/'.length));
      if (!mayApprove(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop can switch a kind on or off', { client }); return; }
      if (!kindInfo(kind)) { fail(res, 404, 'NOT_FOUND', 'unknown kind'); return; }
      let body;
      try { body = await readJson(req, 4096); } catch { fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
      if (!body || typeof body.enabled !== 'boolean') { fail(res, 400, 'VALIDATION_FAILED', 'enabled must be a boolean'); return; }
      const enabled = setKindEnabled(userId, kind, body.enabled);
      auditBus(req, userId, 'bus.kind_set', kind, 'success', { kind, enabled, client });
      send(res, 200, { kind, enabled });
      return;
    }

    // ---- schedules (docs/spec/command-bus.md section 9): records only; the desktop enqueues each run ----
    if (path === '/bus/schedules' && req.method === 'GET') {
      if (!readsAll(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop and the native phone can read schedules', { client }); return; }
      send(res, 200, { items: listSchedules(userId).map(shapeSchedule) });
      return;
    }
    if (path === '/bus/schedules' && req.method === 'POST') {
      if (!mayApprove(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop can create a schedule', { client }); return; }
      let body;
      try { body = await readJson(req, 8192); } catch { fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
      const parsed = parseScheduleBody(body);
      if (!parsed.ok) { fail(res, 400, 'INVALID_ARGS', parsed.message, parsed.details); return; }
      let s;
      try { s = createSchedule(userId, parsed.value); }
      catch (e) { if (e.code === 'QUOTA_EXCEEDED') { fail(res, 429, 'QUOTA_EXCEEDED', e.message); return; } throw e; }
      auditBus(req, userId, 'bus.schedule_create', s.id, 'success', {
        kind: s.kind, client, intervalHours: s.intervalMs / 3_600_000, standing: s.standing, standingUntil: s.standingUntil,
        sources: Array.isArray(s.args.sourceIds) ? s.args.sourceIds.length : 'all',
      });
      send(res, 201, { schedule: shapeSchedule(s) });
      return;
    }
    if (path === '/bus/schedules') { fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET or POST only'); return; }
    if (path.startsWith('/bus/schedules/') && req.method === 'DELETE') {
      if (!mayApprove(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop can delete a schedule', { client }); return; }
      const id = decodeURIComponent(path.slice('/bus/schedules/'.length));
      if (!ID_RE.test(id) || !deleteSchedule(userId, id)) { fail(res, 404, 'NOT_FOUND', 'schedule not found'); return; }
      auditBus(req, userId, 'bus.schedule_delete', id, 'success', { client });
      send(res, 200, { deleted: true });
      return;
    }

    // ---- approvals (desktop only) ----
    if (path === '/bus/approvals' && req.method === 'GET') {
      if (!mayApprove(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop can list approvals', { client }); return; }
      expireStale(userId);
      const db = getDb();
      send(res, 200, {
        items: listPendingApprovals(userId).map((c) => ({
          id: c.id, kind: c.kind, tier: c.tier, reason: c.approvalReason || 'tier', originClient: c.originClient, args: c.args,
          createdAt: c.createdAt, expiresAt: c.ttlAt,
          nonce: approvalNonce(userId, c.id, db.prepare('SELECT args_hash FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, c.id).args_hash),
        })),
      });
      return;
    }

    // ---- desktop-claimed Factory commands (B5) ----
    if (path === '/bus/claimable' && req.method === 'GET') {
      if (!desktopOnly(req, res, client)) return;
      expireStale(userId);
      expireDesktopLeasesSystem();
      const items = listClaimableCommands(userId, DESKTOP_KINDS)
        .filter((c) => claimRefusal(userId, c.kind) === null)
        .map((c) => {
          // The desktop's Factory works in folders: report the project's registered folder (null when it has none).
          let projectRoot = null;
          try { projectRoot = c.args.projectId ? bus.projectRootFor?.(userId, c.args.projectId) ?? null : null; } catch { projectRoot = null; }
          return { id: c.id, kind: c.kind, tier: c.tier, args: c.args, createdAt: c.createdAt, expiresAt: c.ttlAt, projectId: c.args.projectId ?? null, projectRoot: typeof projectRoot === 'string' ? projectRoot : projectRoot?.root ?? null };
        });
      send(res, 200, { items });
      return;
    }
    if (path === '/bus/claimable') { fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET only'); return; }

    // ---- one command: /bus/commands/<id>[/events|/cancel|/approve|/deny] ----
    if (path.startsWith('/bus/commands/')) {
      const rest = path.slice('/bus/commands/'.length);
      const slash = rest.indexOf('/');
      const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
      const tail = slash < 0 ? '' : rest.slice(slash);
      if (!ID_RE.test(id)) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
      if (tail === '' && req.method === 'GET') {
        expireStale(userId);
        ensureTerminal(userId, id);
        const c = getCommand(userId, id);
        if (!canRead(client, c)) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        send(res, 200, { command: shapeCommand(userId, c, { withResult: true }) });
        return;
      }
      if (tail === '/events' && req.method === 'GET') {
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw == null || afterRaw === '' ? 0 : Number(afterRaw);
        if (!Number.isInteger(after) || after < 0 || after > 1e9) { fail(res, 400, 'VALIDATION_FAILED', 'after must be an integer >= 0'); return; }
        if (!canRead(client, getCommand(userId, id))) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        streamEvents(req, res, userId, id, after);
        return;
      }
      if (tail === '/claim' && req.method === 'POST') {
        if (!desktopOnly(req, res, client)) return;
        const before = getCommand(userId, id);
        if (!canRead(client, before)) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        if (!DESKTOP_KINDS.includes(before.kind)) { fail(res, 400, 'VALIDATION_FAILED', 'this command is not a desktop-runner kind'); return; }
        const refusal = claimRefusal(userId, before.kind);
        if (refusal) {
          auditBus(req, userId, 'bus.claim', id, 'denied', { kind: before.kind, client, reason: refusal });
          fail(res, 403, 'TIER_DENIED', 'your access no longer allows this command', { reason: refusal });
          return;
        }
        const body = await readOptionalJson(req, 4096).catch((e) => { throw e; });
        try {
          if (typeof body.claimToken === 'string') {
            // Heartbeat: the same route renews the lease; only the current token may do it.
            renewDesktopLease(userId, id, { token: body.claimToken });
            const renewed = getCommand(userId, id);
            auditBus(req, userId, 'bus.claim', id, 'success', { kind: before.kind, client, renewed: true });
            send(res, 200, { command: shapeCommand(userId, renewed), leaseExpiresAt: renewed.leaseExpiresAt });
            return;
          }
          const out = claimDesktopCommand(userId, id, { claimedBy: client });
          auditBus(req, userId, 'bus.claim', id, 'success', { kind: before.kind, client });
          send(res, 200, { command: shapeCommand(userId, out.command), claimToken: out.token, leaseExpiresAt: out.command.leaseExpiresAt });
        } catch (e) {
          if (e instanceof BusError) throw e;
          if (e?.code === 'LEASE_HELD' || e?.code === 'LEASE_LOST' || e?.code === 'NOT_FOUND') {
            auditBus(req, userId, 'bus.claim', id, outcomeOf({ status: e.code === 'NOT_FOUND' ? 404 : 409 }), { kind: before.kind, client, reason: e.code });
          }
          throw leaseError(e);
        }
        return;
      }
      if (tail === '/events' && req.method === 'POST') {
        if (!desktopOnly(req, res, client)) return;
        if (!canRead(client, getCommand(userId, id))) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        const body = await readOptionalJson(req, 8 * 1024);
        if (body.type !== 'progress') { fail(res, 400, 'VALIDATION_FAILED', 'only progress events can be appended from the desktop'); return; }
        const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : null;
        if (!payload) { fail(res, 400, 'VALIDATION_FAILED', 'payload must be an object'); return; }
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PROGRESS_BYTES) { fail(res, 413, 'PAYLOAD_TOO_LARGE', `payload must be at most ${MAX_PROGRESS_BYTES} bytes`); return; }
        try {
          // A progress report is also the heartbeat: the token must still be the current one.
          renewDesktopLease(userId, id, { token: body.claimToken });
        } catch (e) { throw leaseError(e); }
        let ev;
        try { ev = appendEvent(userId, id, { type: 'progress', payload }); } catch (e) { throw leaseError(e); }
        if (!ev) { fail(res, 409, 'ALREADY_FINISHED', 'this command has already finished'); return; }
        send(res, 200, { event: ev, leaseExpiresAt: getCommand(userId, id).leaseExpiresAt });
        return;
      }
      if (tail === '/finish' && req.method === 'POST') {
        if (!desktopOnly(req, res, client)) return;
        if (!canRead(client, getCommand(userId, id))) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        const body = await readOptionalJson(req, 64 * 1024);
        if (body.state !== 'succeeded' && body.state !== 'failed' && body.state !== 'interrupted') {
          fail(res, 400, 'VALIDATION_FAILED', 'state must be succeeded, failed or interrupted');
          return;
        }
        if (body.result !== undefined && Buffer.byteLength(JSON.stringify(body.result), 'utf8') > MAX_FINISH_RESULT_BYTES) {
          fail(res, 413, 'PAYLOAD_TOO_LARGE', `result must be at most ${MAX_FINISH_RESULT_BYTES} bytes`);
          return;
        }
        try {
          const cmd = finishClaimedCommand(userId, id, { token: body.claimToken, state: body.state, result: body.result, errorCode: body.errorCode });
          auditBus(req, userId, 'bus.finish', id, 'success', { kind: cmd.kind, client, state: body.state });
          send(res, 200, { command: shapeCommand(userId, cmd, { withResult: true }) });
        } catch (e) {
          if (!(e instanceof BusError) && e?.code === 'LEASE_LOST') auditBus(req, userId, 'bus.finish', id, 'failure', { kind: getCommand(userId, id)?.kind, client, reason: e.code });
          throw leaseError(e);
        }
        return;
      }
      if (tail === '/cancel' && req.method === 'POST') {
        const before = getCommand(userId, id);
        if (!canRead(client, before)) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        try {
          const cmd = bus.cancel(userId, id);
          auditBus(req, userId, 'bus.cancel', id, 'success', { kind: before.kind, client });
          send(res, 200, { command: shapeCommand(userId, cmd) });
        } catch (e) {
          if (e instanceof BusError) auditBus(req, userId, 'bus.cancel', id, outcomeOf(e), { kind: before.kind, client, reason: e.code });
          throw e;
        }
        return;
      }
      if (tail === '/approve' && req.method === 'POST') {
        let body;
        try { body = await readJson(req, 8192); } catch { fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
        const before = getCommand(userId, id);
        // Only a well-formed id goes into the audit row; anything else still reaches approve and is refused there.
        const via = body.scheduleId === undefined ? {} : { via: 'standing', ...(typeof body.scheduleId === 'string' && ID_RE.test(body.scheduleId) ? { scheduleId: body.scheduleId } : {}) };
        try {
          const cmd = bus.approve(userId, id, { client, nonce: body.nonce, confirm: body.confirm, scheduleId: body.scheduleId });
          auditBus(req, userId, 'bus.approve', id, 'success', { kind: cmd.kind, tier: cmd.tier, client, ...via });
          send(res, 200, { command: shapeCommand(userId, cmd) });
        } catch (e) {
          if (e instanceof BusError) auditBus(req, userId, 'bus.approve', id, outcomeOf(e), { kind: before?.kind, client, reason: e.code, ...via });
          throw e;
        }
        return;
      }
      if (tail === '/deny' && req.method === 'POST') {
        try { await readJson(req, 8192); } catch { fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
        const before = getCommand(userId, id);
        try {
          const cmd = bus.deny(userId, id, { client });
          auditBus(req, userId, 'bus.deny', id, 'success', { kind: cmd.kind, tier: cmd.tier, client });
          send(res, 200, { command: shapeCommand(userId, cmd) });
        } catch (e) {
          if (e instanceof BusError) auditBus(req, userId, 'bus.deny', id, outcomeOf(e), { kind: before?.kind, client, reason: e.code });
          throw e;
        }
        return;
      }
      fail(res, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      return;
    }
    fail(res, 404, 'NOT_FOUND', 'no such bus route');
  } catch (e) {
    if (e instanceof BusError) { fail(res, e.status, e.code, e.message, e.details); return; }
    send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error' } });
  }
}
