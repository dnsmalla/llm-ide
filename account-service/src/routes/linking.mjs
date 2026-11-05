import { HttpError, nativeClient, readJson, send } from '../http.mjs';
import { newId } from '../db.mjs';
import { linkCommitment, linkSas } from '../linking.mjs';
import { deviceLabel, onlyKeys, p256PublicKey } from '../validate.mjs';

const LINK_TTL_MS = 10 * 60_000;
const KINDS = new Set(['web', 'ios']);
const STATES = new Set(['pending', 'approved', 'keys', 'linked', 'unlinked']);
const b64u32 = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
const tokenHash = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new HttpError(400, 'invalid_request');
  return value;
}

function rowFor(db, userId, id) {
  const row = db.prepare(
    `SELECT r.*, d.kind, d.label, d.signing_key, d.ecdh_key, d.status AS device_status
       FROM link_requests r JOIN devices d ON d.id = r.device_id
      WHERE r.id = ? AND r.user_id = ?`,
  ).get(id, userId);
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

function expire(db, now, row) {
  if (row.state !== 'linked' && row.state !== 'unlinked' && now() >= row.expires_at) {
    db.transaction(() => {
      db.prepare("UPDATE link_requests SET state = 'unlinked', updated_at = ? WHERE id = ? AND state IN ('pending','approved','keys')").run(now(), row.id);
      db.prepare("UPDATE devices SET status = 'unlinked', updated_at = ? WHERE id = ? AND status = 'pending'").run(now(), row.device_id);
    })();
    return { ...row, state: 'unlinked' };
  }
  return row;
}

function publicStatus(db, row) {
  const desktop = db.prepare(
    "SELECT id, signing_key, ecdh_key FROM devices WHERE user_id = ? AND kind = 'desktop' AND status = 'linked'",
  ).get(row.user_id);
  const out = {
    requestId: row.id,
    deviceId: row.device_id,
    state: row.state,
    expiresAt: row.expires_at,
  };
  if (desktop) out.desktopId = desktop.id;
  if (row.state === 'approved' || row.state === 'keys' || row.state === 'linked') {
    out.desktopNonce = row.desktop_nonce;
    if (desktop) { out.desktopSigningKey = desktop.signing_key; out.desktopEcdhKey = desktop.ecdh_key; }
  }
  if (row.state === 'keys' || row.state === 'linked') {
    out.deviceSigningKey = row.signing_key;
    out.deviceEcdhKey = row.ecdh_key;
    if (desktop) out.sas = linkSas(row.signing_key, row.ecdh_key, desktop.signing_key, row.device_nonce, row.desktop_nonce);
  }
  return out;
}

function desktopView(row) {
  return {
    requestId: row.id,
    deviceId: row.device_id,
    state: row.state,
    kind: row.kind,
    label: row.label,
    commitment: row.commitment,
    deviceNonce: row.device_nonce,
    desktopNonce: row.desktop_nonce,
    signingKey: row.signing_key || null,
    ecdhKey: row.ecdh_key || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function linkingRoutes(routes, ctx) {
  // A signed-in browser/phone starts a link. It sends only the commitment; its public keys and nonce
  // stay on the device until the desktop has approved with a fresh desktop nonce.
  routes.set('POST /v1/link/requests', async (req, res) => {
    const session = ctx.sessions.require(req);
    if (session.scope !== 'full') throw new HttpError(403, 'full_session_required');
    ctx.limiter.hit(`link-ip:${req.clientIp}`, 10, 60_000);
    const body = await readJson(req);
    onlyKeys(body, ['kind', 'label', 'commitment']);
    if (!KINDS.has(body.kind)) throw new HttpError(400, 'invalid_kind');
    if (typeof body.commitment !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.commitment)) throw new HttpError(400, 'invalid_commitment');
    const label = deviceLabel(body.label);
    const t = ctx.now();
    const result = ctx.db.transaction(() => {
      const id = newId();
      const deviceId = newId();
      const expiresAt = t + LINK_TTL_MS;
      ctx.db.prepare(
        `INSERT INTO devices (id, user_id, kind, label, status, signing_key, ecdh_key, tier, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', '', '', 'web', ?, ?)`,
      ).run(deviceId, session.user_id, body.kind, label, t, t);
      ctx.db.prepare(
        'INSERT INTO link_requests (id, user_id, device_id, commitment, state, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, session.user_id, deviceId, body.commitment, 'pending', t, t, expiresAt);
      return { requestId: id, expiresAt };
    })();
    ctx.audit('link_requested', { userId: session.user_id, ip: req.clientIp, detail: { requestId: result.requestId } });
    send(res, 201, result);
  });

  // The device polls this; it never sees another user's request.
  routes.set('GET /v1/link/requests/status', async (req, res) => {
    const session = ctx.sessions.require(req);
    if (session.scope !== 'full') throw new HttpError(403, 'full_session_required');
    const id = requestId(new URL(req.url, 'http://localhost').searchParams.get('requestId'));
    const row = expire(ctx.db, ctx.now, rowFor(ctx.db, session.user_id, id));
    send(res, 200, publicStatus(ctx.db, row));
  });

  // Reveal the keys and the client-held token hash only after the desktop approved. The service
  // checks the commitment, so a swapped key pair cannot match the value the device committed to.
  routes.set('POST /v1/link/requests/keys', async (req, res) => {
    const session = ctx.sessions.require(req);
    if (session.scope !== 'full') throw new HttpError(403, 'full_session_required');
    const body = await readJson(req);
    onlyKeys(body, ['requestId', 'signingKey', 'ecdhKey', 'nonce', 'tokenHash']);
    const id = requestId(body.requestId);
    const signingKey = p256PublicKey(body.signingKey);
    const ecdhKey = p256PublicKey(body.ecdhKey);
    if (!b64u32(body.nonce)) throw new HttpError(400, 'invalid_nonce');
    if (!tokenHash(body.tokenHash)) throw new HttpError(400, 'invalid_token_hash');
    const row = expire(ctx.db, ctx.now, rowFor(ctx.db, session.user_id, id));
    if (row.state !== 'approved') throw new HttpError(409, row.state === 'keys' ? 'already_revealed' : 'not_approved');
    if (linkCommitment(signingKey, ecdhKey, body.nonce) !== row.commitment) throw new HttpError(400, 'commitment_mismatch');
    const t = ctx.now();
    try {
      ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE devices SET signing_key = ?, ecdh_key = ?, token_hash = ?, updated_at = ? WHERE id = ?')
          .run(signingKey, ecdhKey, body.tokenHash, t, row.device_id);
        ctx.db.prepare("UPDATE link_requests SET device_nonce = ?, state = 'keys', updated_at = ? WHERE id = ?")
          .run(body.nonce, t, id);
      })();
    } catch (err) {
      if (String(err?.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'token_already_used');
      throw err;
    }
    ctx.audit('link_keys_revealed', { userId: session.user_id, ip: req.clientIp, detail: { requestId: id } });
    send(res, 200, publicStatus(ctx.db, rowFor(ctx.db, session.user_id, id)));
  });

  // Desktop: poll pending link requests with its Bearer access token (the same token used for OAuth).
  routes.set('GET /v1/link/requests', nativeClient(async (req, res) => {
    const { user } = ctx.oauth.requireAccess(req);
    const rows = ctx.db.prepare(
      "SELECT r.*, d.kind, d.label, d.signing_key, d.ecdh_key FROM link_requests r JOIN devices d ON d.id = r.device_id WHERE r.user_id = ? AND r.state IN ('pending','approved','keys') ORDER BY r.created_at",
    ).all(user.id).map((row) => expire(ctx.db, ctx.now, row)).filter((row) => STATES.has(row.state) && row.state !== 'unlinked');
    send(res, 200, { requests: rows.map(desktopView) });
  }));

  // Desktop approves. nK is a fresh 256-bit nonce; it is safe to expose (it only prevents the service
  // from precomputing a matching SAS before the desktop chose it).
  routes.set('POST /v1/link/requests/approve', nativeClient(async (req, res) => {
    const { user } = ctx.oauth.requireAccess(req);
    const body = await readJson(req);
    onlyKeys(body, ['requestId', 'desktopNonce']);
    const id = requestId(body.requestId);
    if (!b64u32(body.desktopNonce)) throw new HttpError(400, 'invalid_desktop_nonce');
    const row = expire(ctx.db, ctx.now, rowFor(ctx.db, user.id, id));
    if (row.state !== 'pending') throw new HttpError(409, row.state === 'approved' ? 'already_approved' : 'not_pending');
    const desktop = ctx.db.prepare("SELECT signing_key, ecdh_key FROM devices WHERE user_id = ? AND kind = 'desktop' AND status = 'linked'").get(user.id);
    if (!desktop) throw new HttpError(409, 'desktop_missing');
    ctx.db.prepare("UPDATE link_requests SET desktop_nonce = ?, state = 'approved', updated_at = ? WHERE id = ?").run(body.desktopNonce, ctx.now(), id);
    ctx.audit('link_approved', { userId: user.id, ip: req.clientIp, detail: { requestId: id } });
    send(res, 200, { requestId: id, state: 'approved', desktopNonce: body.desktopNonce });
  }));

  // Desktop can refuse a request; the pending device is unlinked immediately.
  routes.set('POST /v1/link/requests/deny', nativeClient(async (req, res) => {
    const { user } = ctx.oauth.requireAccess(req);
    const body = await readJson(req);
    onlyKeys(body, ['requestId']);
    const id = requestId(body.requestId);
    const row = expire(ctx.db, ctx.now, rowFor(ctx.db, user.id, id));
    if (row.state === 'linked') throw new HttpError(409, 'already_linked');
    const t = ctx.now();
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE link_requests SET state = 'unlinked', updated_at = ? WHERE id = ?").run(t, id);
      ctx.db.prepare("UPDATE devices SET status = 'unlinked', updated_at = ? WHERE id = ? AND status = 'pending'").run(t, row.device_id);
    })();
    ctx.audit('link_denied', { userId: user.id, ip: req.clientIp, detail: { requestId: id } });
    send(res, 200, { requestId: id, state: 'unlinked' });
  }));

  // Desktop confirms after comparing the SAS. The service cannot invent this step: it only flips the
  // device to linked once the desktop has the revealed keys and has shown the user the code.
  routes.set('POST /v1/link/requests/confirm', nativeClient(async (req, res) => {
    const { user } = ctx.oauth.requireAccess(req);
    const body = await readJson(req);
    onlyKeys(body, ['requestId']);
    const id = requestId(body.requestId);
    const row = expire(ctx.db, ctx.now, rowFor(ctx.db, user.id, id));
    if (row.state !== 'keys') throw new HttpError(409, row.state === 'linked' ? 'already_linked' : 'not_ready');
    const desktop = ctx.db.prepare("SELECT signing_key FROM devices WHERE user_id = ? AND kind = 'desktop' AND status = 'linked'").pluck().get(user.id);
    if (!desktop) throw new HttpError(409, 'desktop_missing');
    const t = ctx.now();
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE link_requests SET state = 'linked', updated_at = ? WHERE id = ?").run(t, id);
      ctx.db.prepare("UPDATE devices SET status = 'linked', linked_at = ?, updated_at = ? WHERE id = ?").run(t, t, row.device_id);
    })();
    ctx.audit('link_confirmed', { userId: user.id, ip: req.clientIp, detail: { requestId: id } });
    send(res, 200, { requestId: id, state: 'linked', sas: linkSas(row.signing_key, row.ecdh_key, desktop, row.device_nonce, row.desktop_nonce) });
  }));
}

