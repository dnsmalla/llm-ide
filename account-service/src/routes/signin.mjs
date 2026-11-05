import { HttpError, readJson, send } from '../http.mjs';
import { getUser, publicAccount } from '../users.mjs';

const MINUTE = 60_000;
const failed = () => new HttpError(400, 'signin_failed');

export function signinRoutes(routes, ctx) {
  routes.set('POST /v1/signin/options', async (req, res) => {
    ctx.limiter.hit(`signin-options-ip:${req.clientIp}`, 30, MINUTE);
    await readJson(req);
    // Discoverable credentials: the request names no account, so it cannot enumerate one.
    const options = await ctx.webauthn.generateAuthenticationOptions({
      rpID: ctx.config.rpId,
      userVerification: 'required',
      allowCredentials: [],
    });
    send(res, 200, { ceremonyId: ctx.ceremonies.save('signin', options.challenge), options });
  });

  routes.set('POST /v1/signin/verify', async (req, res) => {
    ctx.limiter.hit(`signin-verify-ip:${req.clientIp}`, 10, MINUTE);
    const body = await readJson(req, 64 * 1024);
    const ceremony = ctx.ceremonies.take(body.ceremonyId, 'signin');
    const credentialId = body.response?.id;
    const passkey = ceremony && typeof credentialId === 'string' && credentialId.length <= 1024
      ? ctx.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(credentialId)
      : undefined;
    const user = passkey ? getUser(ctx.db, passkey.user_id) : null;
    if (!ceremony || !user || user.status !== 'active') {
      ctx.audit('signin_failed', { ip: req.clientIp });
      throw failed();
    }

    let result = null;
    try {
      result = await ctx.webauthn.verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ctx.config.origin,
        expectedRPID: ctx.config.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: passkey.counter,
          transports: JSON.parse(passkey.transports),
        },
      });
    } catch {
      result = null;
    }
    if (!result?.verified) {
      ctx.audit('signin_failed', { userId: user.id, ip: req.clientIp });
      throw failed();
    }

    ctx.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(result.authenticationInfo.newCounter, ctx.now(), passkey.id);
    const previous = ctx.sessions.read(req);
    if (previous) ctx.sessions.revoke(previous.id_hash);
    const { cookie } = ctx.sessions.create({ userId: user.id, scope: 'full', via: 'passkey', ip: req.clientIp });
    ctx.audit('signin', { userId: user.id, ip: req.clientIp, detail: { passkeyId: passkey.id } });
    send(res, 200, { status: 'signed_in', account: publicAccount(ctx.db, user) }, { 'set-cookie': cookie });
  });

  routes.set('POST /v1/signout', async (req, res) => {
    await readJson(req);
    const session = ctx.sessions.read(req);
    if (session) {
      ctx.sessions.revoke(session.id_hash);
      ctx.audit('signout', { userId: session.user_id, ip: req.clientIp });
    }
    send(res, 204, undefined, { 'set-cookie': ctx.sessions.clearCookie() });
  });
}
