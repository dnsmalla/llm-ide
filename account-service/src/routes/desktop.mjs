import { nativeClient, readJson, send } from '../http.mjs';
import { listDevices, publicDevice, registerDesktop, replaceDesktop, revokeDevice, verifyDesktopProof } from '../devices.mjs';
import { desktopReplacedMail } from '../mail-templates.mjs';
import { deviceLabel, onlyKeys, p256PublicKey } from '../validate.mjs';

export function desktopRoutes(routes, ctx) {
  // The desktop's profile read (design 4.4). Bearer access token only: the cookie is never read here,
  // so this route needs no CSRF guard and GET /v1/account stays cookie-only.
  routes.set('GET /v1/desktop/account', nativeClient(async (req, res) => {
    const { user } = ctx.oauth.requireAccess(req);
    // Only what the desktop shows; passkeys and audit stay on the web account page.
    const desktopId = ctx.db.prepare("SELECT id FROM devices WHERE user_id = ? AND kind = 'desktop' AND status = 'linked'").pluck().get(user.id) ?? null;
    send(res, 200, { id: user.id, email: user.email, displayName: user.display_name, desktopId });
  }));

  // Design 4.4 step 5. The body carries a proof of possession of the signing key (devices.mjs).
  function desktopBody(body, token) {
    onlyKeys(body, ['label', 'signingKey', 'ecdhKey', 'proof']);
    const desktop = { label: deviceLabel(body.label), signingKey: p256PublicKey(body.signingKey), ecdhKey: p256PublicKey(body.ecdhKey) };
    verifyDesktopProof({ tokenHash: token.id_hash, signingKey: desktop.signingKey, ecdhKey: desktop.ecdhKey, proof: body.proof });
    return desktop;
  }

  routes.set('POST /v1/desktop', nativeClient(async (req, res) => {
    const { user, token } = ctx.oauth.requireAccess(req);
    const device = registerDesktop(ctx.db, ctx.now, { userId: user.id, ...desktopBody(await readJson(req), token) });
    ctx.audit('desktop_registered', { userId: user.id, ip: req.clientIp, detail: { deviceId: device.id } });
    send(res, 201, { status: 'desktop_registered', device: publicDevice(device) });
  }));

  // Design 4.7, after 409 desktop_exists: the desktop signs in again (fresh passkey) and replaces.
  routes.set('POST /v1/desktop/replace', nativeClient(async (req, res) => {
    const { user, token } = ctx.oauth.requireAccess(req);
    const body = desktopBody(await readJson(req), token);
    const { device, replacedId, unlinked } = replaceDesktop(ctx.db, ctx.now, { userId: user.id, token, ...body });
    ctx.audit('desktop_replaced', { userId: user.id, ip: req.clientIp, detail: { deviceId: device.id, replacedId, unlinked } });
    ctx.mail(desktopReplacedMail(ctx.config, user.email));
    send(res, 201, { status: 'desktop_replaced', device: publicDevice(device) });
  }));
}

export function deviceRoutes(routes, ctx) {
  // Account-page device list. A full web session is enough to read; revoking needs a fresh passkey proof.
  routes.set('GET /v1/devices', async (req, res) => {
    const session = ctx.sessions.require(req);
    send(res, 200, { devices: listDevices(ctx.db, session.user_id) });
  });

  routes.set('DELETE /v1/devices/:id', async (req, res) => {
    const session = ctx.sessions.require(req);
    ctx.sessions.requireFresh(session);
    const id = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.split('/').pop() ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid device id');
    if (!revokeDevice(ctx.db, ctx.now, { userId: session.user_id, id })) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    ctx.audit('device_revoked', { userId: session.user_id, ip: req.clientIp, detail: { deviceId: id } });
    send(res, 200, { revoked: true });
  });
}
