import { randomBytes } from 'node:crypto';
import { newId } from '../db.mjs';
import { HttpError, readJson, send } from '../http.mjs';
import { alreadyRegisteredMail, signupMail } from '../mail-templates.mjs';
import { HOUR, limitMailTo } from '../rate-limit.mjs';
import { getUserByEmail } from '../users.mjs';
import { displayName, language, normalizeEmail, onlyKeys, timeZone } from '../validate.mjs';

export function signupRoutes(routes, ctx) {
  // Development / initial-account mode: create the account from the form and go straight to passkey
  // setup. No email is sent. Disabled by default and independent of ACCOUNTS_SIGNUP_OPEN.
  routes.set('POST /v1/signup/direct', async (req, res) => {
    if (!ctx.config.directSignup) throw new HttpError(403, 'direct_signup_disabled');
    ctx.limiter.hit(`direct-ip:${req.clientIp}`, 10, HOUR);
    const body = await readJson(req);
    onlyKeys(body, ['email', 'displayName', 'language', 'timeZone']);
    const email = normalizeEmail(body.email);
    const profile = {
      displayName: displayName(body.displayName),
      language: language(body.language ?? 'en'),
      timeZone: timeZone(body.timeZone ?? 'UTC'),
    };
    const userId = ctx.db.transaction(() => {
      const existing = getUserByEmail(ctx.db, email);
      const t = ctx.now();
      if (existing?.status === 'active') throw new HttpError(409, 'account_exists');
      if (existing) {
        ctx.db.prepare('UPDATE users SET display_name = ?, language = ?, time_zone = ?, updated_at = ? WHERE id = ?')
          .run(profile.displayName, profile.language, profile.timeZone, t, existing.id);
        return existing.id;
      }
      const id = newId();
      ctx.db.prepare(
        `INSERT INTO users (id, email, display_name, language, time_zone, status, webauthn_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_passkey', ?, ?, ?)`,
      ).run(id, email, profile.displayName, profile.language, profile.timeZone, randomBytes(32), t, t);
      return id;
    })();
    const { cookie } = ctx.sessions.create({ userId, scope: 'setup', via: 'signup', ip: req.clientIp });
    ctx.audit('signup_direct', { userId, ip: req.clientIp });
    send(res, 201, { status: 'add_passkey' }, { 'set-cookie': cookie });
  });
  routes.set('POST /v1/signup', async (req, res) => {
    if (!ctx.config.signupOpen) throw new HttpError(403, 'signup_closed');
    ctx.limiter.hit(`signup-ip:${req.clientIp}`, 10, HOUR);
    const body = await readJson(req);
    onlyKeys(body, ['email', 'displayName', 'language', 'timeZone']);
    const email = normalizeEmail(body.email);
    const profile = {
      displayName: displayName(body.displayName),
      language: language(body.language ?? 'en'),
      timeZone: timeZone(body.timeZone ?? 'UTC'),
    };
    limitMailTo(ctx.limiter, email);
    const user = getUserByEmail(ctx.db, email);
    if (user?.status === 'active') ctx.mail(alreadyRegisteredMail(ctx.config, email));
    else ctx.mail(signupMail(ctx.config, email, ctx.tokens.issue('signup', email, profile)));
    ctx.audit('signup_requested', { userId: user?.id ?? null, ip: req.clientIp });
    send(res, 202, { status: 'check_email' });
  });

  routes.set('POST /v1/signup/verify', async (req, res) => {
    if (!ctx.config.signupOpen) throw new HttpError(403, 'signup_closed');
    ctx.limiter.hit(`verify-ip:${req.clientIp}`, 20, HOUR);
    const body = await readJson(req);
    const found = ctx.tokens.consume('signup', body.token);
    if (!found) {
      ctx.audit('signup_verify_failed', { ip: req.clientIp });
      throw new HttpError(400, 'invalid_or_expired_link');
    }
    const { email, payload } = found;
    const userId = ctx.db.transaction(() => {
      const existing = getUserByEmail(ctx.db, email);
      const t = ctx.now();
      if (existing?.status === 'active') return null;
      if (existing) {
        ctx.db.prepare('UPDATE users SET display_name = ?, language = ?, time_zone = ?, updated_at = ? WHERE id = ?')
          .run(payload.displayName, payload.language, payload.timeZone, t, existing.id);
        return existing.id;
      }
      const id = newId();
      ctx.db.prepare(
        `INSERT INTO users (id, email, display_name, language, time_zone, status, webauthn_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_passkey', ?, ?, ?)`,
      ).run(id, email, payload.displayName, payload.language, payload.timeZone, randomBytes(32), t, t);
      return id;
    })();
    if (!userId) throw new HttpError(400, 'invalid_or_expired_link');
    const { cookie } = ctx.sessions.create({ userId, scope: 'setup', via: 'signup', ip: req.clientIp });
    ctx.audit('signup_verified', { userId, ip: req.clientIp });
    send(res, 200, { status: 'add_passkey' }, { 'set-cookie': cookie });
  });
}
