import { HttpError, readJson, send } from '../http.mjs';
import { recoveryMail } from '../mail-templates.mjs';
import { HOUR, limitMailTo } from '../rate-limit.mjs';
import { getUserByEmail } from '../users.mjs';
import { normalizeEmail, onlyKeys } from '../validate.mjs';

export function recoveryRoutes(routes, ctx) {
  routes.set('POST /v1/recovery', async (req, res) => {
    ctx.limiter.hit(`recovery-ip:${req.clientIp}`, 10, HOUR);
    const body = await readJson(req);
    onlyKeys(body, ['email']);
    const email = normalizeEmail(body.email);
    limitMailTo(ctx.limiter, email);
    const user = getUserByEmail(ctx.db, email);
    if (user) ctx.mail(recoveryMail(ctx.config, email, ctx.tokens.issue('recovery', email)));
    ctx.audit('recovery_requested', { userId: user?.id ?? null, ip: req.clientIp });
    send(res, 202, { status: 'check_email' });
  });

  routes.set('POST /v1/recovery/verify', async (req, res) => {
    ctx.limiter.hit(`verify-ip:${req.clientIp}`, 20, HOUR);
    const body = await readJson(req);
    const found = ctx.tokens.consume('recovery', body.token);
    const user = found ? getUserByEmail(ctx.db, found.email) : null;
    if (!user) throw new HttpError(400, 'invalid_or_expired_link');
    // A setup session may only register a passkey; nothing is revoked until one is added.
    const { cookie } = ctx.sessions.create({ userId: user.id, scope: 'setup', via: 'recovery', ip: req.clientIp });
    ctx.audit('recovery_verified', { userId: user.id, ip: req.clientIp });
    send(res, 200, { status: 'add_passkey' }, { 'set-cookie': cookie });
  });
}
