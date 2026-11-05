import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { linkCommitment } from '../src/linking.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

export const ORIGIN = 'http://localhost:3470';
export const WEB_ORIGIN = 'http://app.localhost:5173';
export const DESKTOP_CLIENT = 'llmide-desktop';
export const DESKTOP_REDIRECT = 'http://127.0.0.1:49152/auth/callback';
export const OAUTH_STATE = 'test-state-0123456789';

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
    ACCOUNTS_RELAY: '1',
    ACCOUNTS_ALLOWED_WEB_ORIGINS: WEB_ORIGIN,
    ...env,
  });
  let t = startAt;
  const clock = { now: () => t, advance(ms) { t += ms; } };
  const db = openDb(config.dbPath);
  const app = createApp({ config, db, mailer, webauthn, now: clock.now, relayEnv: env });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  return {
    config, db, clock, mailer, webauthn, base,
    client: () => createClient(base),
    relay: app.relay,
    async close() {
      app.relay?.close();
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

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

// A null/undefined parameter is left out, so a test can exercise the missing-parameter case.
export function authorizePath({
  challenge = null,
  redirectUri = DESKTOP_REDIRECT,
  state = OAUTH_STATE,
  clientId = DESKTOP_CLIENT,
  method = 'S256',
  responseType = 'code',
} = {}) {
  const params = new URLSearchParams();
  const fields = {
    client_id: clientId,
    response_type: responseType,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: method,
    state,
  };
  for (const [name, value] of Object.entries(fields)) if (value != null) params.set(name, value);
  return `/v1/oauth/authorize?${params}`;
}

export function authorizeGet(app, web, params = {}) {
  return rawRequest(app.base, 'GET', authorizePath(params), undefined, { cookie: web.cookie });
}

// The consent page's POST: the authorize query string as the browser got it, plus the user's choice.
export function consent(app, web, request, decision = 'allow', headers = {}) {
  return rawRequest(app.base, 'POST', '/v1/oauth/consent', JSON.stringify({ request, decision }), {
    'content-type': 'application/json', origin: ORIGIN, cookie: web.cookie, ...headers,
  });
}

// The whole browser leg: authorize, then Allow on the consent page. A successful Allow is returned
// as the 302 the page performs (location = the loopback redirect); anything else is returned as is.
export async function authorize(app, web, params = {}) {
  const res = await authorizeGet(app, web, params);
  if (res.status !== 302 || !res.headers.location.startsWith('/consent.html?')) return res;
  const allowed = await consent(app, web, res.headers.location.slice('/consent.html?'.length));
  if (allowed.status !== 200) return allowed;
  return { ...allowed, status: 302, headers: { ...allowed.headers, location: allowed.body.redirect } };
}

export function tokenRequest(app, fields, { form = true, headers = {} } = {}) {
  const body = form ? new URLSearchParams(fields).toString() : JSON.stringify(fields);
  return rawRequest(app.base, 'POST', '/v1/oauth/token', body, {
    'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
    ...headers,
  });
}

// The whole desktop flow: sign in with a passkey, authorize, exchange the code. `reuse` signs in a
// second desktop for an existing web client; `fresh` first repeats the passkey sign-in on it.
export async function signInDesktop(app, { reuse = null, fresh = false, ...params } = {}) {
  const web = reuse ?? app.client();
  if (!reuse) await signUpAndRegister(app, web);
  if (fresh) {
    const opts = await web.call('POST', '/v1/signin/options', {});
    const done = await web.call('POST', '/v1/signin/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-ada', challenge: opts.body.options.challenge } });
    if (done.status !== 200) throw new Error(`signin ${done.status}`);
  }
  const { verifier, challenge } = pkcePair();
  const auth = await authorize(app, web, { ...params, challenge });
  if (auth.status !== 302) throw new Error(`authorize ${auth.status} ${JSON.stringify(auth.body)}`);
  const code = new URL(auth.headers.location).searchParams.get('code');
  const token = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: params.redirectUri ?? DESKTOP_REDIRECT,
    client_id: DESKTOP_CLIENT,
    code_verifier: verifier,
  });
  if (token.status !== 200) throw new Error(`token ${token.status} ${JSON.stringify(token.body)}`);
  return { web, verifier, challenge, code, tokens: token.body };
}

// A desktop key set as account_oauth.rs makes it: P-256, SPKI DER, base64url without padding.
export function desktopKeys() {
  const make = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signing = make();
  const ecdh = make();
  const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { signing, signingKey: spki(signing), ecdhKey: spki(ecdh) };
}

// Proof of possession (devices.mjs desktopProofMessage): the signing key signs the keys bound to the
// SHA-256 of the access token it registers with. ECDSA P-256 / SHA-256, raw r||s, base64url.
export function desktopProof(accessToken, keys, privateKey = keys.signing.privateKey) {
  const tokenHash = createHash('sha256').update(accessToken).digest('hex');
  const message = `llmide/desktop/register/v1\n${tokenHash}\n${keys.signingKey}\n${keys.ecdhKey}`;
  return sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

export function desktopBody(accessToken, keys = desktopKeys(), label = 'Ada Mac') {
  return { label, signingKey: keys.signingKey, ecdhKey: keys.ecdhKey, proof: desktopProof(accessToken, keys) };
}

// A desktop plus one linked web device, driven through the real routes. The device token hash is SHA-256 of the
// DECODED 32 bytes, exactly as public/link.js computes it (the relay recomputes it the same way).
export async function linkedPair(app, { kind = 'web' } = {}) {
  const { web, tokens } = await signInDesktop(app);
  const desktop = desktopKeys();
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` };
  const reg = await rawRequest(app.base, 'POST', '/v1/desktop', JSON.stringify(desktopBody(tokens.access_token, desktop)), auth);
  if (reg.status !== 201) throw new Error(`register ${reg.status}`);
  const make = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signing = make(); const ecdh = make();
  const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const raw = randomBytes(32);
  const device = { signing, ecdh, signingKey: spki(signing), ecdhKey: spki(ecdh), token: raw.toString('base64url'), tokenHash: createHash('sha256').update(raw).digest('hex') };
  const cookie = { 'content-type': 'application/json', origin: ORIGIN, cookie: web.cookie };
  const created = await rawRequest(app.base, 'POST', '/v1/link/requests', JSON.stringify({ kind, label: 'Phone', commitment: linkCommitment(device.signingKey, device.ecdhKey, nonce) }), cookie);
  const requestId = created.body.requestId;
  await rawRequest(app.base, 'POST', '/v1/link/requests/approve', JSON.stringify({ requestId, desktopNonce: randomBytes(32).toString('base64url') }), auth);
  const keys = await rawRequest(app.base, 'POST', '/v1/link/requests/keys', JSON.stringify({ requestId, signingKey: device.signingKey, ecdhKey: device.ecdhKey, nonce, tokenHash: device.tokenHash }), cookie);
  const done = await rawRequest(app.base, 'POST', '/v1/link/requests/confirm', JSON.stringify({ requestId }), auth);
  if (done.status !== 200) throw new Error(`confirm ${done.status}`);
  const user = app.db.prepare('SELECT user_id FROM devices WHERE id = ?').get(reg.body.device.id);
  return { userId: user.user_id, web, desktop: { ...desktop, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, deviceId: reg.body.device.id }, device: { ...device, deviceId: keys.body.deviceId } };
}
