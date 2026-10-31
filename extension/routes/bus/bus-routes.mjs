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
//   GET  /bus/kinds                         the registry as this caller sees it
//   PUT  /bus/kinds/:kind                   desktop-class only: the user's enable flag for a kind
import { send, readJson } from '../../server/route-http.mjs';
import {
  getCommand, listCommands, listEvents, lastSeq, ensureTerminal, expireStale, hasTerminal, terminalEvent, listPendingApprovals,
  setKindEnabled, listKindFlags,
} from '../../kb/bus-store.mjs';
import { getDb } from '../../kb/db.mjs';
import { REGISTRY, LIMITS, kindInfo, decideReceipt, mayApprove } from './registry.mjs';
import { resolveClient } from './client.mjs';
import { BusError, approvalNonce, busEnabled } from './executor.mjs';
import { engineStatusList } from './engines.mjs';

export function isBusRoute(url) {
  const path = String(url || '').split('?')[0];
  return path === '/bus' || path.startsWith('/bus/');
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const fail = (res, status, code, message, details) => send(res, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });
const iso = (s) => s;

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
    kind, tier: info.tier, lane: info.lane, write: info.write, available: info.available, description: info.description,
    engines: engineStatus.filter((e) => e.available).map((e) => e.id), engineStatus, args: info.args, enabled: !!flags[kind],
    allowed: gate.outcome !== 'tier_denied' && gate.outcome !== 'unknown_kind',
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
      send(res, 200, { items: listCommands(userId, { state, limit }).map((c) => shapeCommand(userId, c)) });
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
      send(res, 200, { kind, enabled: setKindEnabled(userId, kind, body.enabled) });
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
        if (!c) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        send(res, 200, { command: shapeCommand(userId, c, { withResult: true }) });
        return;
      }
      if (tail === '/events' && req.method === 'GET') {
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw == null || afterRaw === '' ? 0 : Number(afterRaw);
        if (!Number.isInteger(after) || after < 0 || after > 1e9) { fail(res, 400, 'VALIDATION_FAILED', 'after must be an integer >= 0'); return; }
        if (!getCommand(userId, id)) { fail(res, 404, 'NOT_FOUND', 'command not found'); return; }
        streamEvents(req, res, userId, id, after);
        return;
      }
      if (tail === '/cancel' && req.method === 'POST') {
        send(res, 200, { command: shapeCommand(userId, bus.cancel(userId, id)) });
        return;
      }
      if (tail === '/approve' && req.method === 'POST') {
        let body;
        try { body = await readJson(req, 8192); } catch { fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
        send(res, 200, { command: shapeCommand(userId, bus.approve(userId, id, { client, nonce: body.nonce, confirm: body.confirm })) });
        return;
      }
      if (tail === '/deny' && req.method === 'POST') {
        try { await readJson(req, 8192); } catch { fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
        send(res, 200, { command: shapeCommand(userId, bus.deny(userId, id, { client })) });
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
