import { HttpError, nativeClient, readForm, readJson, redirect, send } from '../http.mjs';
import { CLIENT_ID, validChallenge, validRedirectUri, validState } from '../oauth.mjs';
import { onlyKeys } from '../validate.mjs';

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

// Validates an authorize query string (from the GET, or echoed back by the consent page). The checks
// run before any redirect, so a bad redirect_uri is never followed.
function authorizeRequest(query) {
  const params = new URLSearchParams(query);
  const param = (name) => {
    const values = params.getAll(name);
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
  return { redirectUri, challenge, state };
}

export function oauthRoutes(routes, ctx) {
  // Design 4.4 step 2: authorize issues nothing. A full session goes to the consent page; anyone else
  // signs in first and comes back to it. Only the consent POST below issues a code.
  routes.set('GET /v1/oauth/authorize', async (req, res) => {
    const query = new URL(req.url, 'http://localhost').search.slice(1);
    authorizeRequest(query);
    const consentPage = `/consent.html?${query}`;
    const session = ctx.sessions.read(req);
    if (session?.scope === 'full') redirect(res, consentPage);
    else redirect(res, `/signin.html?return=${encodeURIComponent(consentPage)}`);
  });

  // The consent page's Allow/Deny. A cookie route, so the server's exact-Origin check applies, and the
  // Strict cookie is never sent cross-site. Allow needs a fresh passkey proof (5 min); the code carries
  // this session's auth_at, which /v1/desktop/replace later checks.
  routes.set('POST /v1/oauth/consent', async (req, res) => {
    const session = ctx.sessions.require(req);
    const body = await readJson(req);
    onlyKeys(body, ['request', 'decision']);
    if (typeof body.request !== 'string' || body.request.length > 4096) throw new HttpError(400, 'invalid_request');
    if (body.decision !== 'allow' && body.decision !== 'deny') throw new HttpError(400, 'invalid_request');
    const { redirectUri, challenge, state } = authorizeRequest(body.request);
    const target = new URL(redirectUri);
    if (body.decision === 'deny') {
      target.searchParams.set('error', 'access_denied');
    } else {
      ctx.sessions.requireFresh(session);
      const code = ctx.oauth.issueCode({ userId: session.user_id, redirectUri, challenge, authAt: session.auth_at });
      ctx.audit('oauth_code_issued', { userId: session.user_id, ip: req.clientIp });
      target.searchParams.set('code', code);
    }
    target.searchParams.set('state', state);
    // The page navigates there itself: the CSP's form-action 'none' rules out a form POST + 302.
    send(res, 200, { redirect: target.toString() }, { 'referrer-policy': 'no-referrer' });
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
