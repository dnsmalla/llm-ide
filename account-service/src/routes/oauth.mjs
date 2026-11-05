import { HttpError, nativeClient, readForm, readJson, redirect, send } from '../http.mjs';
import { CLIENT_ID, validChallenge, validRedirectUri, validState } from '../oauth.mjs';

// OAuth 2.0 token requests use form encoding (RFC 6749 4.1.3); the desktop may also send JSON.
// Unknown parameters are ignored, as the RFC requires; duplicate ones are refused.
async function tokenFields(req) {
  const type = req.headers['content-type'] ?? '';
  if (/^application\/x-www-form-urlencoded(\s*;|$)/i.test(type)) {
    const params = await readForm(req);
    return (name) => {
      const values = params.getAll(name);
      if (values.length > 1) throw new HttpError(400, 'invalid_request');
      return values[0];
    };
  }
  if (/^application\/json(\s*;|$)/i.test(type)) {
    const body = await readJson(req);
    return (name) => (typeof body[name] === 'string' ? body[name] : undefined);
  }
  throw new HttpError(415, 'unsupported_content_type');
}

function required(field, name) {
  const value = field(name);
  if (value === undefined) throw new HttpError(400, 'invalid_request');
  return value;
}

export function oauthRoutes(routes, ctx) {
  routes.set('GET /v1/oauth/authorize', async (req, res) => {
    // A full web session (passkey sign-in, design 4.2) is required; setup sessions cannot authorize.
    // Require a fresh passkey proof (5 min) as the minimum consent gate until the account UI adds the
    // explicit "Sign in LLM-IDE on this computer?" confirmation page.
    const session = ctx.sessions.require(req);
    ctx.sessions.requireFresh(session);
    const url = new URL(req.url, 'http://localhost');
    const param = (name) => {
      const values = url.searchParams.getAll(name);
      if (values.length > 1) throw new HttpError(400, 'invalid_request');
      return values[0];
    };
    if (param('client_id') !== CLIENT_ID) throw new HttpError(400, 'invalid_client');
    const redirectUri = param('redirect_uri');
    if (!validRedirectUri(redirectUri)) throw new HttpError(400, 'invalid_request');
    // The design's authorize URL omits response_type; accept it only when it is the code flow.
    const responseType = param('response_type');
    if (responseType !== undefined && responseType !== 'code') throw new HttpError(400, 'unsupported_response_type');
    const challenge = param('code_challenge');
    if (param('code_challenge_method') !== 'S256' || !validChallenge(challenge)) {
      throw new HttpError(400, 'invalid_request');
    }
    const state = param('state');
    if (!validState(state)) throw new HttpError(400, 'invalid_request');

    const code = ctx.oauth.issueCode({ userId: session.user_id, redirectUri, challenge });
    ctx.audit('oauth_code_issued', { userId: session.user_id, ip: req.clientIp });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    redirect(res, target.toString());
  });

  // No cookie, no CORS: the desktop is a public client and PKCE protects the exchange.
  routes.set('POST /v1/oauth/token', nativeClient(async (req, res) => {
    const field = await tokenFields(req);
    const grantType = field('grant_type');
    if (grantType === 'authorization_code') {
      const { userId, tokens } = ctx.oauth.exchangeCode({
        code: required(field, 'code'),
        clientId: required(field, 'client_id'),
        redirectUri: required(field, 'redirect_uri'),
        verifier: required(field, 'code_verifier'),
      });
      ctx.audit('oauth_code_exchanged', { userId, ip: req.clientIp });
      send(res, 200, tokens);
      return;
    }
    if (grantType === 'refresh_token') {
      const { userId, tokens } = ctx.oauth.rotateRefresh({
        refreshToken: required(field, 'refresh_token'),
        clientId: required(field, 'client_id'),
      });
      ctx.audit('oauth_refresh_rotated', { userId, ip: req.clientIp });
      send(res, 200, tokens);
      return;
    }
    if (grantType === undefined) throw new HttpError(400, 'invalid_request');
    throw new HttpError(400, 'unsupported_grant_type');
  }));

  // Sign-out revokes the refresh family. It is idempotent and never reveals whether the token existed.
  routes.set('POST /v1/oauth/revoke', nativeClient(async (req, res) => {
    const field = await tokenFields(req);
    const clientId = field('client_id');
    if (clientId !== undefined && clientId !== 'llmide-desktop') throw new HttpError(400, 'invalid_client');
    const token = field('token');
    if (typeof token === 'string') ctx.oauth.revokeRefresh({ refreshToken: token, clientId: 'llmide-desktop' });
    send(res, 200, {});
  }));
}
