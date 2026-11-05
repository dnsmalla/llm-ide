import http from 'node:http';
import { HttpError, send } from './http.mjs';
import { checkOrigin, checkOriginIfPresent, clientIp } from './guard.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createAudit } from './audit.mjs';
import { createEmailTokens } from './email-tokens.mjs';
import { deliver } from './mailer.mjs';
import { createSessions } from './sessions.mjs';
import { createOAuth } from './oauth.mjs';
import { healthRoutes } from './routes/health.mjs';
import { signupRoutes } from './routes/signup.mjs';
import { createCeremonies } from './ceremonies.mjs';
import { passkeyRoutes } from './routes/passkeys.mjs';
import { signinRoutes } from './routes/signin.mjs';
import { recoveryRoutes } from './routes/recovery.mjs';
import { accountRoutes } from './routes/account.mjs';
import { oauthRoutes } from './routes/oauth.mjs';
import { desktopRoutes } from './routes/desktop.mjs';

const ROUTE_GROUPS = [healthRoutes, signupRoutes, passkeyRoutes, signinRoutes, recoveryRoutes, accountRoutes, oauthRoutes, desktopRoutes];

export function createApp({ config, db, mailer = null, webauthn = null, now = Date.now }) {
  const ctx = { config, db, mailer, webauthn, now };
  ctx.limiter = createRateLimiter({ now });
  ctx.audit = createAudit(db, now);
  ctx.tokens = createEmailTokens(db, now);
  ctx.mail = (msg) => deliver(mailer, msg, {
    retryMs: config.mail.retryMs,
    onFail: () => ctx.audit('mail_failed', { detail: { subject: msg.subject } }),
  });
  ctx.sessions = createSessions(db, config, now);
  ctx.ceremonies = createCeremonies(db, now);
  ctx.oauth = createOAuth(db, now);
  const routes = new Map();
  for (const register of ROUTE_GROUPS) register(routes, ctx);
  return http.createServer((req, res) => {
    handle(req, res, routes, ctx).catch((err) => internalError(res, err));
  });
}

async function handle(req, res, routes, ctx) {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    const handler = routes.get(`${req.method} ${path}`);
    if (!handler) throw new HttpError(404, 'not_found');
    req.clientIp = clientIp(req, ctx.config);
    ctx.limiter.hit(`ip:${req.clientIp}`, 120, 60_000);
    if (req.method !== 'GET') {
      if (handler.nativeClient) checkOriginIfPresent(req, ctx.config);
      else checkOrigin(req, ctx.config);
    }
    await handler(req, res, ctx);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    send(res, err.status, { error: err.code }, err.headers);
  }
}

function internalError(res, err) {
  // Only the error class and code: never bodies, tokens, cookies or SQL text.
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled', name: err?.name, code: err?.code }));
  if (!res.headersSent) send(res, 500, { error: 'internal' });
  else res.destroy();
}
