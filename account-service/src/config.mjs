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
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw new Error('ACCOUNTS_RP_ID must equal the origin host or be a parent domain of it');
  }
  const host = env.ACCOUNTS_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('ACCOUNTS_HOST must be a loopback address; put nginx in front');
  const port = Number(env.ACCOUNTS_PORT ?? 3470);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ACCOUNTS_PORT must be a port number');
  const transport = env.ACCOUNTS_MAIL_TRANSPORT ?? (prod ? 'smtp' : 'file');
  if (!['smtp', 'file'].includes(transport)) throw new Error('ACCOUNTS_MAIL_TRANSPORT must be smtp or file');
  if (prod && transport !== 'smtp') throw new Error('the file mailer writes sign-in links to disk; production needs smtp');
  const smtpUrl = env.ACCOUNTS_SMTP_URL ?? '';
  if (transport === 'smtp' && !smtpUrl.startsWith('smtps://')) throw new Error('ACCOUNTS_SMTP_URL must be an smtps:// URL');
  const retryMs = Number(env.ACCOUNTS_MAIL_RETRY_MS ?? 2000);
  if (!Number.isFinite(retryMs) || retryMs < 1) throw new Error('ACCOUNTS_MAIL_RETRY_MS must be a positive number');
  return Object.freeze({
    prod,
    origin,
    rpId,
    rpName: 'LLM-IDE',
    host,
    port,
    dbPath: env.ACCOUNTS_DB_PATH ?? './data/accounts.db',
    signupOpen: flag(env, 'ACCOUNTS_SIGNUP_OPEN'),
    trustProxy: flag(env, 'ACCOUNTS_TRUST_PROXY'),
    secureCookies: url.protocol === 'https:',
    mail: Object.freeze({
      transport,
      smtpUrl,
      dir: env.ACCOUNTS_MAIL_DIR ?? './data/mail',
      from: env.ACCOUNTS_MAIL_FROM ?? 'LLM-IDE <no-reply@llm-ide.com>',
      retryMs,
    }),
  });
}
