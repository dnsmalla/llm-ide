import { nativeClient, readJson, send } from '../http.mjs';
import { publicDevice, registerDesktop } from '../devices.mjs';
import { deviceLabel, onlyKeys, publicKeyText } from '../validate.mjs';

export function desktopRoutes(routes, ctx) {
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
