import { HttpError, readJson, send } from '../http.mjs';
import { accountDeletedMail, passkeyRemovedMail } from '../mail-templates.mjs';
import { getUser, publicAccount } from '../users.mjs';
import { displayName, language, onlyKeys, timeZone } from '../validate.mjs';

const PROFILE_FIELDS = ['displayName', 'language', 'timeZone'];

export function accountRoutes(routes, ctx) {
  routes.set('GET /v1/account', async (req, res) => {
    const session = ctx.sessions.require(req);
    send(res, 200, publicAccount(ctx.db, getUser(ctx.db, session.user_id)));
  });

  routes.set('PATCH /v1/account', async (req, res) => {
    const session = ctx.sessions.require(req);
    const body = await readJson(req);
    onlyKeys(body, PROFILE_FIELDS);
    const user = getUser(ctx.db, session.user_id);
    const next = {
      displayName: body.displayName === undefined ? user.display_name : displayName(body.displayName),
      language: body.language === undefined ? user.language : language(body.language),
      timeZone: body.timeZone === undefined ? user.time_zone : timeZone(body.timeZone),
    };
    ctx.db.prepare('UPDATE users SET display_name = ?, language = ?, time_zone = ?, updated_at = ? WHERE id = ?')
      .run(next.displayName, next.language, next.timeZone, ctx.now(), user.id);
    ctx.audit('profile_updated', { userId: user.id, ip: req.clientIp, detail: { fields: Object.keys(body) } });
    send(res, 200, publicAccount(ctx.db, getUser(ctx.db, user.id)));
  });

  routes.set('POST /v1/passkeys/remove', async (req, res) => {
    const session = ctx.sessions.require(req);
    ctx.sessions.requireFresh(session);
    const body = await readJson(req);
    onlyKeys(body, ['id']);
    const user = getUser(ctx.db, session.user_id);
    ctx.db.transaction(() => {
      const owned = typeof body.id === 'string' && ctx.db.prepare('SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?').get(body.id, user.id);
      if (!owned) throw new HttpError(404, 'not_found');
      const count = ctx.db.prepare('SELECT COUNT(*) FROM passkeys WHERE user_id = ?').pluck().get(user.id);
      if (count <= 1) throw new HttpError(409, 'last_passkey'); // passkey-only accounts must keep one
      ctx.db.prepare('DELETE FROM passkeys WHERE id = ?').run(body.id);
    })();
    ctx.audit('passkey_removed', { userId: user.id, ip: req.clientIp, detail: { passkeyId: body.id } });
    ctx.mail(passkeyRemovedMail(ctx.config, user.email));
    send(res, 200, { status: 'passkey_removed' });
  });

  routes.set('POST /v1/sessions/revoke-others', async (req, res) => {
    const session = ctx.sessions.require(req);
    ctx.sessions.requireFresh(session);
    await readJson(req);
    const revoked = ctx.sessions.revokeOthers(session.user_id, session.id_hash);
    ctx.audit('sessions_revoked', { userId: session.user_id, ip: req.clientIp, detail: { revoked } });
    send(res, 200, { revoked });
  });

  routes.set('GET /v1/account/export', async (req, res) => {
    const session = ctx.sessions.require(req);
    const user = getUser(ctx.db, session.user_id);
    const sessions = ctx.db
      .prepare('SELECT scope, via, created_at, last_seen_at, expires_at, revoked_at, ip FROM sessions WHERE user_id = ? ORDER BY created_at')
      .all(user.id);
    const auditEvents = ctx.db
      .prepare('SELECT at, event, ip, detail FROM audit_events WHERE user_id = ? ORDER BY id')
      .all(user.id)
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
    ctx.audit('account_exported', { userId: user.id, ip: req.clientIp });
    send(res, 200, { exportedAt: ctx.now(), account: publicAccount(ctx.db, user), sessions, auditEvents }, {
      'content-disposition': 'attachment; filename="llm-ide-account.json"',
    });
  });

  routes.set('POST /v1/account/delete', async (req, res) => {
    const session = ctx.sessions.require(req);
    ctx.sessions.requireFresh(session);
    const body = await readJson(req);
    onlyKeys(body, ['confirmEmail']);
    const user = getUser(ctx.db, session.user_id);
    if (typeof body.confirmEmail !== 'string' || body.confirmEmail.trim().toLowerCase() !== user.email) {
      throw new HttpError(400, 'confirm_mismatch');
    }
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM email_tokens WHERE email = ?').run(user.email);
      ctx.db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // cascades passkeys, sessions, challenges
    })();
    ctx.audit('account_deleted', { userId: user.id, ip: req.clientIp });
    ctx.mail(accountDeletedMail(ctx.config, user.email));
    send(res, 200, { status: 'deleted' }, { 'set-cookie': ctx.sessions.clearCookie() });
  });
}
