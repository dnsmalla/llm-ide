import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

export const ORIGIN = 'http://localhost:3470';

export function memoryMailer() {
  const sent = [];
  return {
    sent,
    fail: 0, // number of upcoming sends that throw
    async send(msg) {
      if (this.fail > 0) {
        this.fail -= 1;
        throw new Error('smtp down');
      }
      sent.push(msg);
    },
  };
}

// Records every call; the real library is @simplewebauthn/server (src/webauthn.mjs).
// A test response is { id, challenge } (+ bad: true to simulate a bad signature).
export function fakeWebAuthn() {
  let n = 0;
  const calls = [];
  return {
    calls,
    async generateRegistrationOptions(opts) {
      calls.push(['generateRegistrationOptions', opts]);
      n += 1;
      return { challenge: `reg-${n}`, rp: { id: opts.rpID, name: opts.rpName }, user: { name: opts.userName } };
    },
    async verifyRegistrationResponse(opts) {
      calls.push(['verifyRegistrationResponse', opts]);
      if (opts.response.challenge !== opts.expectedChallenge) throw new Error('challenge mismatch');
      return {
        verified: true,
        registrationInfo: {
          credential: { id: opts.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      };
    },
    async generateAuthenticationOptions(opts) {
      calls.push(['generateAuthenticationOptions', opts]);
      n += 1;
      return { challenge: `auth-${n}`, rpId: opts.rpID, allowCredentials: opts.allowCredentials };
    },
    async verifyAuthenticationResponse(opts) {
      calls.push(['verifyAuthenticationResponse', opts]);
      if (opts.response.challenge !== opts.expectedChallenge) throw new Error('challenge mismatch');
      if (opts.response.bad) throw new Error('bad signature');
      return { verified: true, authenticationInfo: { newCounter: opts.credential.counter + 1 } };
    },
  };
}

export async function startApp({ env = {}, mailer = memoryMailer(), webauthn = fakeWebAuthn(), startAt = Date.UTC(2026, 10, 5, 9) } = {}) {
  const config = loadConfig({
    ACCOUNTS_ORIGIN: ORIGIN,
    ACCOUNTS_SIGNUP_OPEN: '1',
    ACCOUNTS_DB_PATH: ':memory:',
    ACCOUNTS_MAIL_RETRY_MS: '1',
    ...env,
  });
  let t = startAt;
  const clock = { now: () => t, advance(ms) { t += ms; } };
  const db = openDb(config.dbPath);
  const app = createApp({ config, db, mailer, webauthn, now: clock.now });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  return {
    config, db, clock, mailer, webauthn, base,
    client: () => createClient(base),
    async close() {
      await new Promise((resolve) => app.close(resolve));
      db.close();
    },
  };
}

export function createClient(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, path, body, headers = {}) {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const res = await rawRequest(base, method, path, data, {
        origin: ORIGIN,
        ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      });
      for (const c of res.headers['set-cookie'] ?? []) {
        const [pair] = c.split(';');
        cookie = pair.slice(pair.indexOf('=') + 1) ? pair : '';
      }
      return res;
    },
  };
}

export function rawRequest(base, method, path, data, headers) {
  const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  if (data !== undefined) clean['content-length'] = Buffer.byteLength(data);
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers: clean }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

export async function waitForMail(mailer, count) {
  for (let i = 0; i < 400 && mailer.sent.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (mailer.sent.length < count) throw new Error(`expected ${count} mails, got ${mailer.sent.length}`);
  return mailer.sent[count - 1];
}

export function linkToken(mail) {
  const m = /#purpose=[a-z]+&token=([A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m) throw new Error('no link in mail');
  return m[1];
}

export function insertUser(db, { id = 'user-1', email = 'ada@example.com', status = 'active' } = {}) {
  db.prepare(
    `INSERT INTO users (id, email, display_name, language, time_zone, status, webauthn_user_id, created_at, updated_at)
     VALUES (?, ?, 'Ada', 'en', 'UTC', ?, randomblob(32), 0, 0)`,
  ).run(id, email, status);
  return id;
}

export async function signUpAndRegister(app, client, { email = 'ada@example.com', credentialId = 'cred-ada' } = {}) {
  const before = app.mailer.sent.length;
  const signup = await client.call('POST', '/v1/signup', { email, displayName: 'Ada', language: 'en', timeZone: 'Asia/Tokyo' });
  if (signup.status !== 202) throw new Error(`signup ${signup.status}`);
  const token = linkToken(await waitForMail(app.mailer, before + 1));
  await client.call('POST', '/v1/signup/verify', { token });
  const opts = await client.call('POST', '/v1/passkeys/options', {});
  const done = await client.call('POST', '/v1/passkeys/verify', {
    ceremonyId: opts.body.ceremonyId,
    response: { id: credentialId, challenge: opts.body.options.challenge },
    name: 'Test key',
  });
  if (done.status !== 201) throw new Error(`passkey ${done.status} ${JSON.stringify(done.body)}`);
  return app.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
