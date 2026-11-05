import { nativeClient, readJson, send } from '../http.mjs';
import { listDevices, publicDevice, registerDesktop, revokeDevice } from '../devices.mjs';
import { deviceLabel, onlyKeys, publicKeyText } from '../validate.mjs';

export function desktopRoutes(routes, ctx) {
  // The desktop's profile read (design 4.4). Bearer access token only: the cookie is never read here,
  // so this route needs no CSRF guard and GET /v1/account stays cookie-only.
  routes.set('GET /v1/desktop/account', nativeClient(async (req, res) => {
    const { user } = ctx.oauth.requireAccess(req);
    // Only what the desktop shows; passkeys and audit stay on the web account page.
    send(res, 200, { id: user.id, email: user.email, displayName: user.display_name });
  }));

  // Register-only half of design 4.4 step 5: replace/link/relay are later sub-projects.
  routes.set('POST /v1/desktop', nativeClient(async (req, res) => {
    const { user } = ctx.oauth.requireAccess(req);
    const body = await readJson(req);
    onlyKeys(body, ['label', 'signingKey', 'ecdhKey']);
    const device = registerDesktop(ctx.db, ctx.now, {
      userId: user.id,
      label: deviceLabel(body.label),
      signingKey: publicKeyText(body.signingKey),
      ecdhKey: publicKeyText(body.ecdhKey),
    });
    ctx.audit('desktop_registered', { userId: user.id, ip: req.clientIp, detail: { deviceId: device.id } });
    send(res, 201, { status: 'desktop_registered', device: publicDevice(device) });
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
