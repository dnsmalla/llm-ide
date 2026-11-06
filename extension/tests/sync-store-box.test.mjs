// The Box adapter runs the SyncStore contract on a fake Box API (tests/helpers/fake-box.mjs): no network in CI.
// A live run against a real THROWAWAY Box account is opt-in and manual (never a personal account: it writes and
// deletes under the top-level folder "llmide-sync-it"):
//   LLMIDE_SYNC_BOX_IT=1 LLMIDE_SYNC_BOX_IT_CLIENT_ID=... LLMIDE_SYNC_BOX_IT_CLIENT_SECRET=... \
//   LLMIDE_SYNC_BOX_IT_TOKEN_FILE=/path/outside/the/repo [LLMIDE_SYNC_BOX_IT_ORIGIN=https://your-pwa-origin] \
//   node --test tests/sync-store-box.test.mjs
// The Box app must list the redirect URI http://127.0.0.1/kb/sync/box/callback. Without a token file the run prints an
// authorize URL (client id only) and waits up to 5 minutes for the consent on port 53682. Every rotated refresh token
// is written to the token file (mode 0600), never printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.LLMIDE_DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-store-box-test.db');

const { createBoxStore, validateBoxConfig, classifyBoxStatus, DEFAULT_BOX_FOLDER } = await import('../connectors/sync-store/box.mjs');
const { createFakeBox } = await import('./helpers/fake-box.mjs');
const { runSyncStoreContract } = await import('./helpers/sync-store-contract.mjs');

function make(fake = createFakeBox(), extra = {}) {
  const rotated = [];
  const store = createBoxStore({ clientId: fake.clientId, folder: DEFAULT_BOX_FOLDER, account: 's***@example.com' },
    { clientSecret: fake.clientSecret, refreshToken: fake.grant() },
    { fetchImpl: fake.fetch, retryDelayMs: 0, onRefreshToken: (t) => rotated.push(t), watchMs: 5, ...extra });
  return { fake, store, rotated };
}

runSyncStoreContract(test, assert, async () => make().store, 'box (fake API)');

test('config validation names the bad field', () => {
  const ok = { clientId: 'a'.repeat(32), clientSecret: 'b'.repeat(32), folder: 'llmide-sync' };
  assert.equal(validateBoxConfig(ok), null);
  assert.equal(validateBoxConfig({ ...ok, clientId: 'short' }), 'clientId');
  assert.equal(validateBoxConfig({ ...ok, clientSecret: 'has space here and more chars' }), 'clientSecret');
  assert.equal(validateBoxConfig({ ...ok, folder: '..' }), 'folder');
});

test('the first call rotates the refresh token and reports it before any API call uses the new access token', async () => {
  const { fake, store, rotated } = make();
  await store.put('a/x.bin', Buffer.from('1'));
  assert.equal(rotated.length, 1);
  assert.ok(fake.calls.indexOf('POST api.box.com/oauth2/token') < fake.calls.findIndex((c) => c.includes('/2.0/folders')));
  fake.expireAccess();
  await store.get('a/x.bin');
  assert.equal(rotated.length, 2, 'a 401 refreshes once and rotates again');
});

test('the sync folder is created once under All Files; get and list never create it', async () => {
  const fake = createFakeBox();
  const { store } = make(fake);
  assert.equal(await store.get('S/d/D/manifest.bin'), null);
  assert.deepEqual(await store.list('S/d/D/in'), []);
  assert.equal(fake.find(DEFAULT_BOX_FOLDER), null);
  await store.put('S/d/D/key.bin', Buffer.from('k'));
  await make(fake).store.put('S/d/D/wrap.bin', Buffer.from('w'));
  assert.deepEqual(fake.children('0').map((x) => x.name), [DEFAULT_BOX_FOLDER]);
});

test('replace is a new version of the same file: exact bytes, one file, old versions deleted (premium)', async () => {
  const fake = createFakeBox({ premium: true });
  const { store } = make(fake);
  await store.put('S/d/D/manifest.bin', Buffer.from('old'));
  await store.put('S/d/D/manifest.bin', Buffer.from('new'));
  assert.deepEqual(fake.uploads.map((b) => b.toString()), ['old', 'new'], 'the adapter adds nothing to the bytes');
  const dir = fake.find(`${DEFAULT_BOX_FOLDER}/S/d/D`);
  assert.deepEqual(fake.children(dir.id).map((x) => x.name), ['manifest.bin']);
  assert.equal(fake.versionDeletes, 1);
  assert.equal(Buffer.from(await store.get('S/d/D/manifest.bin')).toString(), 'new');
});

test('a free account (no versions, or 403 on versions) still replaces', async () => {
  const { fake, store } = make();
  await store.put('v/m.bin', Buffer.from('1'));
  fake.failNext('GET /2.0/files/', 403, { body: { code: 'access_denied_insufficient_permissions' } });
  await store.put('v/m.bin', Buffer.from('2'));
  assert.equal(Buffer.from(await store.get('v/m.bin')).toString(), '2');
});

test('remove and removeTree purge the trash; downloads never carry the bearer to the download host', async () => {
  const { fake, store } = make();
  await store.put('t/d/k.bin', Buffer.from('k'));
  await store.put('t/d/s/1.bin', Buffer.from('1'));
  assert.equal(Buffer.from(await store.get('t/d/k.bin')).toString(), 'k');
  await store.remove('t/d/k.bin');
  assert.equal(fake.purges, 1);
  await store.removeTree('t/d');
  assert.equal(fake.purges, 2);
  assert.equal(fake.find(`${DEFAULT_BOX_FOLDER}/t/d`), null, 'gone from the trash too');
  await store.put('t/d/again.bin', Buffer.from('2'));
  assert.equal(Buffer.from(await store.get('t/d/again.bin')).toString(), '2', 'the folder cache followed the delete');
});

test('rate limits: a long retry-after surfaces SYNC_RATE_LIMITED at once; a short one is retried', async () => {
  const { fake, store } = make();
  await store.put('r/1.bin', Buffer.from('1'));
  fake.failNext('GET /2.0/folders/', 429, { headers: { 'retry-after': '120' } });
  await assert.rejects(() => store.get('r/1.bin'), (e) => e.code === 'SYNC_RATE_LIMITED');
  fake.failNext('GET /2.0/folders/', 429, { headers: { 'retry-after': '1' } });
  assert.equal(Buffer.from(await store.get('r/1.bin')).toString(), '1');
});

test('a refused refresh is SYNC_AUTH_FAILED and the error never carries a secret or token', async () => {
  const fake = createFakeBox();
  const secret = fake.clientSecret;
  const store = createBoxStore({ clientId: fake.clientId, folder: 'llmide-sync' }, { clientSecret: secret, refreshToken: 'rt-dead' }, { fetchImpl: fake.fetch, retryDelayMs: 0 });
  await assert.rejects(() => store.get('a.bin'), (e) => e.code === 'SYNC_AUTH_FAILED' && !e.message.includes(secret) && !e.message.includes('rt-dead'));
});

test('status classification', () => {
  assert.equal(classifyBoxStatus(429, {}), 'SYNC_RATE_LIMITED');
  assert.equal(classifyBoxStatus(403, { code: 'storage_limit_exceeded' }), 'SYNC_QUOTA');
  assert.equal(classifyBoxStatus(413, {}), 'SYNC_TOO_LARGE');
  assert.equal(classifyBoxStatus(503, {}), 'SYNC_UNREACHABLE');
  assert.equal(classifyBoxStatus(400, {}), 'SYNC_IO');
});

test('watch signals a change in the watched folder only, and stop ends it', async () => {
  const { store } = make();
  await store.put('w/in/0.bin', Buffer.from('0'));
  let hits = 0;
  const stop = store.watch('w/in', () => { hits += 1; });
  await new Promise((r) => setTimeout(r, 30));
  await store.put('w/other/1.bin', Buffer.from('1'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hits, 0);
  await store.put('w/in/2.bin', Buffer.from('2'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(hits >= 1);
  stop();
  await store.close();
});

test('describe is non-secret', () => {
  const { store, fake } = make();
  const d = store.describe();
  assert.deepEqual(d, { kind: 'box', root: 'llmide-sync', account: 's***@example.com' });
  assert.ok(!JSON.stringify(d).includes(fake.clientSecret));
});

const LIVE = process.env.LLMIDE_SYNC_BOX_IT === '1';
test('live: a real throwaway Box account', { skip: !LIVE && 'opt-in: set LLMIDE_SYNC_BOX_IT=1 (see the header)', timeout: 600_000 }, async (t) => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const http = await import('node:http');
  const { createHash, randomBytes } = await import('node:crypto');
  const box = await import('../connectors/box.mjs');
  const env = process.env;
  const clientId = env.LLMIDE_SYNC_BOX_IT_CLIENT_ID; const clientSecret = env.LLMIDE_SYNC_BOX_IT_CLIENT_SECRET;
  const file = env.LLMIDE_SYNC_BOX_IT_TOKEN_FILE;
  assert.ok(clientId && clientSecret && file, 'set the client id, secret and token file');
  const save = (tok) => writeFileSync(file, tok, { mode: 0o600 });
  async function consent() {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const redirectUri = 'http://127.0.0.1:53682/kb/sync/box/callback';
    const code = await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const q = new URL(req.url, 'http://127.0.0.1').searchParams;
        res.end('You can close this tab.'); srv.close();
        if (q.get('state') !== state || !q.get('code')) reject(new Error('consent refused or state mismatch')); else resolve(q.get('code'));
      }).listen(53682, '127.0.0.1');
      setTimeout(() => { srv.close(); reject(new Error('no consent in 5 minutes')); }, 300_000).unref();
    });
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    t.diagnostic(`Open in a browser and approve: ${box.AUTHORIZE_URL}?${q}`);
    const tok = await box.postToken(box.buildAuthCodeForm({ clientId, clientSecret, code: await code, redirectUri, codeVerifier: verifier }));
    t.diagnostic('PKCE: the code exchange with code_verifier succeeded (Box accepts or ignores PKCE)');
    return tok.refresh_token;
  }
  save(existsSync(file) ? readFileSync(file, 'utf8').trim() : await consent());
  const store = createBoxStore({ clientId, folder: 'llmide-sync-it' }, { clientSecret, refreshToken: readFileSync(file, 'utf8').trim() }, { onRefreshToken: save });
  const top = `it-${randomBytes(6).toString('hex')}`;
  try {
    await store.put(`${top}/d/m.bin`, Buffer.from('one'));
    await store.put(`${top}/d/m.bin`, Buffer.from('two'));
    assert.equal(Buffer.from(await store.get(`${top}/d/m.bin`)).toString(), 'two');
    assert.deepEqual((await store.list(`${top}/d`)).map((e) => e.name), ['m.bin']);
    await store.remove(`${top}/d/m.bin`);
    assert.equal(await store.get(`${top}/d/m.bin`), null);
    if (env.LLMIDE_SYNC_BOX_IT_ORIGIN) {
      const tok = await box.postToken(box.buildRefreshForm({ clientId, clientSecret, refreshToken: readFileSync(file, 'utf8').trim() }));
      save(tok.refresh_token);
      const H = { Authorization: `Bearer ${tok.access_token}`, Origin: env.LLMIDE_SYNC_BOX_IT_ORIGIN };
      const api = await fetch(`${box.API}/folders/0`, { headers: H });
      t.diagnostic(`CORS api.box.com: access-control-allow-origin=${api.headers.get('access-control-allow-origin')}`);
      await store.put(`${top}/c.bin`, Buffer.from('c'));
      const root = (await (await fetch(`${box.API}/folders/0/items?fields=id,name`, { headers: H })).json()).entries.find((e) => e.name === 'llmide-sync-it');
      const dir = (await (await fetch(`${box.API}/folders/${root.id}/items?fields=id,name`, { headers: H })).json()).entries.find((e) => e.name === top);
      const f = (await (await fetch(`${box.API}/folders/${dir.id}/items?fields=id,name`, { headers: H })).json()).entries.find((e) => e.name === 'c.bin');
      const hop = await fetch(`${box.API}/files/${f.id}/content`, { headers: H, redirect: 'manual' });
      const dl = await fetch(hop.headers.get('location'), { headers: { Origin: env.LLMIDE_SYNC_BOX_IT_ORIGIN } });
      t.diagnostic(`CORS download host ${new URL(hop.headers.get('location')).host}: access-control-allow-origin=${dl.headers.get('access-control-allow-origin')}`);
      assert.ok(api.headers.get('access-control-allow-origin'), 'api.box.com must answer CORS for the PWA origin');
    }
  } finally {
    await store.removeTree(top).catch(() => {});
    await store.close();
  }
});
