import { normalizeEmail } from './validate.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const flag = (env, name) => /^(1|true|yes|on)$/i.test(env[name] ?? '');

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const origin = env.ACCOUNTS_ORIGIN ?? 'http://localhost:3470';
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('ACCOUNTS_ORIGIN must be an absolute URL');
  }
  if (url.origin !== origin) throw new Error('ACCOUNTS_ORIGIN must be a bare origin such as https://accounts.llm-ide.com');
  if (prod && url.protocol !== 'https:') throw new Error('ACCOUNTS_ORIGIN must use https in production');
  const rpId = env.ACCOUNTS_RP_ID ?? url.hostname;
  // The PWA delegates WebAuthn to the accounts origin, so the RP ID must be exactly this host.
  // A parent-domain RP ID would scope the passkey to sibling origins (e.g. app.llm-ide.com).
  if (url.hostname !== rpId) {
    throw new Error('ACCOUNTS_RP_ID must equal the origin host; parent-domain RP IDs are not supported');
  }
  const host = env.ACCOUNTS_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('ACCOUNTS_HOST must be a loopback address; put nginx in front');
  const port = Number(env.ACCOUNTS_PORT ?? 3470);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ACCOUNTS_PORT must be a port number');
  const signupOpen = flag(env, 'ACCOUNTS_SIGNUP_OPEN');
  const transport = env.ACCOUNTS_MAIL_TRANSPORT ?? (prod ? 'smtp' : 'file');
  if (!['smtp', 'file', 'none'].includes(transport)) throw new Error('ACCOUNTS_MAIL_TRANSPORT must be smtp, file or none');
  if (prod && transport === 'file') throw new Error('the file mailer writes sign-in links to disk; production needs smtp or none');
  if (transport === 'none' && signupOpen) throw new Error('sign-up cannot open without a mail transport');
  const smtpUrl = env.ACCOUNTS_SMTP_URL ?? '';
  if (transport === 'smtp' && !smtpUrl.startsWith('smtps://')) throw new Error('ACCOUNTS_SMTP_URL must be an smtps:// URL');
  const retryMs = Number(env.ACCOUNTS_MAIL_RETRY_MS ?? 2000);
  if (!Number.isFinite(retryMs) || retryMs < 1) throw new Error('ACCOUNTS_MAIL_RETRY_MS must be a positive number');
  const directSignup = flag(env, 'ACCOUNTS_DIRECT_SIGNUP');
  // Direct sign-up has no proof of email ownership: off a localhost origin (or in production) it may
  // only create the exact addresses the operator names.
  let directSignupEmails = null;
  if (env.ACCOUNTS_DIRECT_SIGNUP_EMAILS?.trim()) {
    try {
      directSignupEmails = Object.freeze(new Set(env.ACCOUNTS_DIRECT_SIGNUP_EMAILS.split(',').map(normalizeEmail)));
    } catch {
      throw new Error('ACCOUNTS_DIRECT_SIGNUP_EMAILS must be a comma-separated list of email addresses');
    }
  }
  if (directSignup && !directSignupEmails && (prod || !LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, '')))) {
    throw new Error('ACCOUNTS_DIRECT_SIGNUP outside localhost needs ACCOUNTS_DIRECT_SIGNUP_EMAILS (the exact addresses allowed)');
  }
  const relayEnabled = flag(env, 'ACCOUNTS_RELAY');
  // The web relay client lives on its OWN origin (relay D1, accounts design 3): a page the accounts/relay operator
  // serves must never hold relay keys, so the accounts origin is refused here.
  const webOrigins = (env.ACCOUNTS_ALLOWED_WEB_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of webOrigins) {
    let u;
    try { u = new URL(o); } catch { throw new Error('ACCOUNTS_ALLOWED_WEB_ORIGINS must list bare origins'); }
    if (u.origin !== o) throw new Error('ACCOUNTS_ALLOWED_WEB_ORIGINS must list bare origins');
    if (prod && u.protocol !== 'https:') throw new Error('ACCOUNTS_ALLOWED_WEB_ORIGINS must use https in production');
    if (o === origin) throw new Error('ACCOUNTS_ALLOWED_WEB_ORIGINS cannot contain the accounts origin: the web client needs its own origin');
  }
  return Object.freeze({
    prod,
    origin,
    rpId,
    rpName: 'LLM-IDE',
    host,
    port,
    dbPath: env.ACCOUNTS_DB_PATH ?? './data/accounts.db',
    signupOpen,
    directSignup,
    directSignupEmails,
    trustProxy: flag(env, 'ACCOUNTS_TRUST_PROXY'),
    secureCookies: url.protocol === 'https:',
    relay: Object.freeze({ enabled: relayEnabled, webOrigins: Object.freeze(new Set(webOrigins)) }),
    mail: Object.freeze({
      transport,
      smtpUrl,
      dir: env.ACCOUNTS_MAIL_DIR ?? './data/mail',
      from: env.ACCOUNTS_MAIL_FROM ?? 'LLM-IDE <no-reply@llm-ide.com>',
      retryMs,
    }),
  });
}
