import { HttpError, readJson, send } from '../http.mjs';
import { passkeyAddedMail } from '../mail-templates.mjs';
import { getUser } from '../users.mjs';

function requirePasskeySession(req, ctx) {
  const session = ctx.sessions.require(req, ['setup', 'full']);
  if (session.scope === 'full') ctx.sessions.requireFresh(session);
  // A sign-up setup session only creates the first passkey. Once the account is active, only a
  // fresh full session (or an email-proven recovery session) may add one.
  if (session.scope === 'setup' && session.via === 'signup' && getUser(ctx.db, session.user_id)?.status !== 'pending_passkey') {
    throw new HttpError(401, 'unauthenticated');
  }
  return session;
}

function passkeyName(value) {
  if (value === undefined) return 'Passkey';
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 60 || /\p{Cc}/u.test(value)) {
    throw new HttpError(400, 'invalid_name');
  }
  return value.trim();
}

export function passkeyRoutes(routes, ctx) {
  routes.set('POST /v1/passkeys/options', async (req, res) => {
    const session = requirePasskeySession(req, ctx);
    await readJson(req);
    const user = getUser(ctx.db, session.user_id);
    const existing = ctx.db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id);
    const options = await ctx.webauthn.generateRegistrationOptions({
      rpName: ctx.config.rpName,
      rpID: ctx.config.rpId,
      userName: user.email,
      userDisplayName: user.display_name,
      userID: user.webauthn_user_id,
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    send(res, 200, { ceremonyId: ctx.ceremonies.save('register', options.challenge, user.id), options });
  });

  routes.set('POST /v1/passkeys/verify', async (req, res) => {
    const session = requirePasskeySession(req, ctx);
    const body = await readJson(req, 64 * 1024);
    const response = body.response;
    if (!response || typeof response !== 'object' || typeof response.id !== 'string' || response.id.length > 1024) {
      throw new HttpError(400, 'invalid_payload');
    }
    const name = passkeyName(body.name);
    const ceremony = ctx.ceremonies.take(body.ceremonyId, 'register');
    if (!ceremony || ceremony.user_id !== session.user_id) throw new HttpError(400, 'ceremony_expired');

    let result = null;
    try {
      result = await ctx.webauthn.verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ctx.config.origin,
        expectedRPID: ctx.config.rpId,
        requireUserVerification: true,
      });
    } catch {
      result = null;
    }
    if (!result?.verified) throw new HttpError(400, 'passkey_rejected');

    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const user = getUser(ctx.db, session.user_id);
    const t = ctx.now();
    const viaRecovery = session.via === 'recovery';
    try {
      ctx.db.transaction(() => {
        // Re-check after the async WebAuthn verify: the session may have been revoked meanwhile (the real
        // owner verified their email link or activated the account), and a sign-up session only ever
        // creates the first passkey of a still-pending account.
        const now = ctx.db.prepare('SELECT revoked_at, expires_at FROM sessions WHERE id_hash = ?').get(session.id_hash);
        if (!now || now.revoked_at !== null || now.expires_at <= t) throw new HttpError(401, 'unauthenticated');
        if (session.scope === 'setup' && session.via === 'signup'
          && ctx.db.prepare('SELECT status FROM users WHERE id = ?').get(user.id)?.status !== 'pending_passkey') {
          throw new HttpError(401, 'unauthenticated');
        }
        ctx.db.prepare(
          `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(credential.id, user.id, Buffer.from(credential.publicKey), credential.counter,
          JSON.stringify(credential.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0, name, t);
        if (session.scope === 'setup') {
          ctx.db.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").run(t, user.id);
          if (viaRecovery) {
            ctx.db.prepare('UPDATE users SET recovered_at = ? WHERE id = ?').run(t, user.id);
            ctx.sessions.revokeOthers(user.id, null); // every session, this setup session included
          }
          ctx.sessions.revokeSetup(user.id); // every setup session, not only this one
        }
      })();
    } catch (err) {
      if (String(err?.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'passkey_exists');
      throw err;
    }

    ctx.audit('passkey_added', { userId: user.id, ip: req.clientIp, detail: { passkeyId: credential.id, via: session.via } });
    const headers = {};
    if (session.scope === 'setup') {
      headers['set-cookie'] = ctx.sessions.create({ userId: user.id, scope: 'full', via: 'passkey', ip: req.clientIp }).cookie;
    }
    if (viaRecovery || session.scope === 'full') ctx.mail(passkeyAddedMail(ctx.config, user.email, { viaRecovery }));
    send(res, 201, { status: 'passkey_added', passkeyId: credential.id }, headers);
  });
}
