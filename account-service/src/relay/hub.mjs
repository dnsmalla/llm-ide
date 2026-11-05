// Relay hub: authenticated sockets, routing between ONE account's desktop and its linked devices, caps, ping,
// stored wraps. Forwards ciphertext it cannot read; never logs bodies or tokens.
import { authenticate, newChallenge } from './auth.mjs';
import { isUp, parseClient, ProtocolError } from './protocol.mjs';

export const RELAY_LIMITS = Object.freeze({
  authDeadlineMs: 10_000, pingEveryMs: 30_000, pongDeadlineMs: 75_000,
  maxSockets: 1024, maxSocketsPerIp: 16, authFailuresPerIp: 10, authBlockMs: 10 * 60_000,
  envelopesPerMinute: 1200, bytesPerMinute: 32 * 1024 * 1024,
});
export const CLOSE = Object.freeze({ auth: 4001, revoked: 4003, limited: 4008, replaced: 4009, protocol: 1008, idle: 1001, internal: 1011 });

export function createHub(ctx, limits = RELAY_LIMITS) {
  const entries = new Set();
  const byDevice = new Map();
  const perIp = new Map();
  const blocked = new Map();
  const stmt = {
    target: ctx.db.prepare("SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND kind IN ('web', 'ios') AND status = 'linked'"),
    linked: ctx.db.prepare('SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND status = \'linked\''),
    token: ctx.db.prepare('SELECT 1 FROM desktop_tokens WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ?'),
    wrapGet: ctx.db.prepare('SELECT envelope FROM relay_wraps WHERE device_id = ?'),
    wrapPut: ctx.db.prepare(`INSERT INTO relay_wraps (device_id, user_id, epoch, envelope, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET epoch = excluded.epoch, envelope = excluded.envelope, created_at = excluded.created_at
      WHERE excluded.epoch >= relay_wraps.epoch`),
  };
  const timer = setInterval(tick, limits.pingEveryMs);
  timer.unref();

  const send = (entry, obj) => { try { entry.conn.send(JSON.stringify(obj)); } catch { /* closed */ } };
  const once = (key, limit, windowMs) => { try { ctx.limiter.hit(key, limit, windowMs); return true; } catch { return false; } };

  function admit(ipKey) {
    const until = blocked.get(ipKey);
    if (until && until > ctx.now()) return false;
    return entries.size < limits.maxSockets && (perIp.get(ipKey) ?? 0) < limits.maxSocketsPerIp;
  }

  function accept(conn, { ip, ipKey, origin }) {
    const entry = { conn, ip, ipKey, origin, challenge: newChallenge(), id: null, lastPong: ctx.now(), window: { start: ctx.now(), count: 0, bytes: 0 }, overs: 0 };
    entries.add(entry);
    perIp.set(ipKey, (perIp.get(ipKey) ?? 0) + 1);
    entry.deadline = setTimeout(() => { if (!entry.id) end(entry, CLOSE.auth); }, limits.authDeadlineMs);
    entry.deadline.unref?.();
    conn.on('message', (text) => {
      try { onMessage(entry, text); } catch (err) {
        if (err instanceof ProtocolError) { send(entry, { t: 'err', code: err.code }); end(entry, CLOSE.protocol); return; }
        console.error(JSON.stringify({ level: 'error', msg: 'relay_handler', name: err?.name, code: err?.code }));
        end(entry, CLOSE.internal);
      }
    });
    conn.on('close', () => closed(entry));
    send(entry, { t: 'challenge', nonce: entry.challenge });
  }

  function onMessage(entry, text) {
    const msg = parseClient(text);
    if (msg.t === 'pong') { entry.lastPong = ctx.now(); return; }
    if (msg.t === 'auth') return onAuth(entry, msg);
    if (!entry.id) throw new ProtocolError('not_authenticated');
    if (withinBudget(entry, text.length)) route(entry, msg.env);
  }

  function onAuth(entry, msg) {
    const id = authenticate(ctx, { token: msg.token, proof: msg.proof, challenge: entry.challenge });
    const originOk = id && (id.kind === 'web' ? entry.origin !== undefined : entry.origin === undefined);
    const sameDevice = !entry.id || (id && id.deviceId === entry.id.deviceId && id.role === 'desktop');
    if (!id || !originOk || !sameDevice) {
      if (once(`relay-authfail-audit:${entry.ipKey}`, 1, 60_000)) ctx.audit('relay_auth_failed', { ip: entry.ip });
      if (!once(`relay-authfail:${entry.ipKey}`, limits.authFailuresPerIp, limits.authBlockMs)) blocked.set(entry.ipKey, ctx.now() + limits.authBlockMs);
      send(entry, { t: 'err', code: 'auth_failed' });
      return end(entry, CLOSE.auth);
    }
    if (entry.id) { entry.id = id; return; }
    clearTimeout(entry.deadline);
    entry.id = id;
    const old = byDevice.get(id.deviceId);
    if (old) end(old, CLOSE.replaced);
    byDevice.set(id.deviceId, entry);
    if (once(`relay-conn-audit:${id.deviceId}`, 1, 10 * 60_000)) ctx.audit('relay_connected', { userId: id.userId, ip: entry.ip, detail: { deviceId: id.deviceId, role: id.role } });
    send(entry, { t: 'ready', role: id.role, userId: id.userId, deviceId: id.deviceId, desktopId: id.desktopId });
    if (id.role === 'device') {
      const wrap = stmt.wrapGet.pluck().get(id.deviceId);
      if (wrap) send(entry, { t: 'env', env: JSON.parse(wrap) });
      send(entry, { t: 'peer', id: id.desktopId, online: byDevice.has(id.desktopId) });
      const desk = byDevice.get(id.desktopId);
      if (desk) send(desk, { t: 'peer', id: id.deviceId, online: true });
    } else {
      for (const e of byDevice.values()) {
        if (e === entry || e.id.userId !== id.userId) continue;
        send(entry, { t: 'peer', id: e.id.deviceId, online: true });
        send(e, { t: 'peer', id: id.deviceId, online: true });
      }
    }
  }

  function withinBudget(entry, bytes) {
    const t = ctx.now(); const w = entry.window;
    if (t - w.start >= 60_000) { w.start = t; w.count = 0; w.bytes = 0; }
    w.count += 1; w.bytes += bytes;
    if (w.count <= limits.envelopesPerMinute && w.bytes <= limits.bytesPerMinute) { entry.overs = 0; return true; }
    entry.overs += 1;
    if (once(`relay-limit-audit:${entry.id.deviceId}`, 1, 60_000)) ctx.audit('relay_rate_limited', { userId: entry.id.userId, detail: { deviceId: entry.id.deviceId } });
    send(entry, { t: 'err', code: 'rate_limited' });
    if (entry.overs >= 3) end(entry, CLOSE.limited);
    return false;
  }

  function route(entry, env) {
    const id = entry.id;
    const ref = { purpose: env.purpose, session: env.session, seq: env.seq };
    const refuse = (code) => send(entry, { t: 'err', code, ref });
    if (env.userId !== id.userId || env.desktopId !== id.desktopId || env.from !== id.deviceId) return refuse('bad_sender');
    const up = isUp(env.purpose);
    if (up !== (id.role === 'device')) return refuse('bad_direction');
    if (up ? env.to !== id.desktopId : !stmt.target.get(env.to, id.userId)) return refuse('bad_recipient');
    if (env.purpose === 'wrap') {
      stmt.wrapPut.run(env.to, id.userId, env.epoch, JSON.stringify(env), ctx.now());
      ctx.audit('relay_wrap_stored', { userId: id.userId, detail: { deviceId: env.to, epoch: env.epoch } });
    }
    const peer = byDevice.get(env.to);
    if (peer) send(peer, { t: 'env', env });
    else if (env.purpose !== 'wrap') refuse('peer_offline');
  }

  function stillValid(id, t) {
    if (id.role === 'desktop' && (id.expiresAt <= t || !stmt.token.get(id.tokenHash, t))) return false;
    return !!stmt.linked.get(id.deviceId, id.userId);
  }

  function tick() {
    const t = ctx.now();
    for (const entry of [...entries]) {
      if (!entry.id) continue;
      if (t - entry.lastPong > limits.pongDeadlineMs) { end(entry, CLOSE.idle); continue; }
      if (!stillValid(entry.id, t)) { end(entry, CLOSE.revoked); continue; }
      send(entry, { t: 'ping' });
    }
    for (const [k, until] of blocked) if (until <= t) blocked.delete(k);
  }

  function end(entry, code) {
    try { entry.conn.close(code); } catch { /* closed */ }
    closed(entry);
  }

  function closed(entry) {
    if (!entries.delete(entry)) return;
    clearTimeout(entry.deadline);
    const n = (perIp.get(entry.ipKey) ?? 1) - 1;
    if (n > 0) perIp.set(entry.ipKey, n); else perIp.delete(entry.ipKey);
    if (!entry.id || byDevice.get(entry.id.deviceId) !== entry) return;
    byDevice.delete(entry.id.deviceId);
    for (const e of byDevice.values()) if (e.id.userId === entry.id.userId) send(e, { t: 'peer', id: entry.id.deviceId, online: false });
  }

  function disconnect(deviceId, code = CLOSE.revoked) {
    const e = byDevice.get(deviceId);
    if (!e) return;
    ctx.audit('relay_closed_revoked', { userId: e.id.userId, detail: { deviceId } });
    end(e, code);
  }

  function disconnectUser(userId, code = CLOSE.revoked) {
    // Close devices first so they learn their own 4003, not a peer-offline event caused by the desktop closing.
    const own = [...byDevice.values()].filter((e) => e.id.userId === userId);
    for (const e of own.filter((x) => x.id.role !== 'desktop')) disconnect(e.id.deviceId, code);
    for (const e of own.filter((x) => x.id.role === 'desktop')) disconnect(e.id.deviceId, code);
  }

  function close() {
    clearInterval(timer);
    for (const e of [...entries]) end(e, 1001);
  }

  return { admit, accept, disconnect, disconnectUser, close, size: () => entries.size };
}
