// The own-server path end to end in CI (design 8.1): the desktop writes through the SFTP adapter (fake SFTP over a temp
// folder); the reference device reads and writes only through the vhost's /sync/ locations (emulated over the same
// folder). Every device request must hit an allowed location, and every folder a device writes into must already exist.
// Plus static checks of the sshd and nginx files under deploy/vps/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_sync-own-server-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const E = await import('../core/sync-enroll.mjs');
const { withTimeouts } = await import('../connectors/sync-store/index.mjs');
const { createSftpStore } = await import('../connectors/sync-store/sftp.mjs');
const { publishOnce } = await import('../routes/sync/producer.mjs');
const { drainOnce } = await import('../routes/sync/consumer.mjs');
const { revokeDevice } = await import('../routes/sync/registry.mjs');
const { startEnrollment, pollEnrollment, confirmEnrollment, _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');
const { createFakeSftp } = await import('./helpers/fake-sftp.mjs');
const { createFakeNginx, syncLocations, vhostText } = await import('./helpers/fake-nginx-sync.mjs');

const T = 1_762_400_000_000;
const CFG = { host: 'sync.example.com', port: 22, username: 'llmidesync', hostFingerprint: `SHA256:${'A'.repeat(43)}`, webHost: 'llm-ide.com', root: '/data' };
const kinds = () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k, Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: 1, truncated: false, items: [] }))]));
const turnDeps = { phoneChatId: async () => 'phone-chat', cancel: () => {}, turn: async (args) => { args.onEvent({ type: 'delta', text: 'hi from the desktop' }); args.onEvent({ type: 'result' }); } };
let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `os-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'o' }).id;

async function linked() {
  _resetEnrollmentsForTest();
  const u = user();
  st.ensureSyncState(u, { storeKind: 'sftp', storeConfig: CFG });
  st.setSyncEnabled(u, true);
  const fake = createFakeSftp();
  const store = withTimeouts(createSftpStore(CFG, { privateKey: 'unused by the fake' }, { connect: fake.connect }));
  const web = createFakeNginx(path.join(fake.root, 'data'));
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  assert.equal(E.parsePair(qr).st, 'sftp:llm-ide.com');
  const dev = createReferenceDevice({ tier: 'ios', name: 'Own-server phone' });
  await dev.scanAndClaim(web, qr, { now: T + 600 });
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'confirm');
  assert.equal(await dev.readAck(web), p.sas, 'the ack is readable through nginx');
  await confirmEnrollment(u, { now: T + 2000 });
  assert.equal(await dev.readWrap(web), true);
  return { u, store, web, dev, fake };
}

test('enroll, publish, queued prompt and reply: the device uses only the nginx allow-list', async () => {
  const { u, store, web, dev } = await linked();
  await publishOnce({ userId: u, store, now: T + 3000, loadKinds: kinds });
  const snap = await dev.readSnapshot(web, { now: T + 4000 });
  assert.deepEqual(Object.keys(snap.kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
  const id = await dev.sendRequest(web, 'hello from the phone', { now: T + 4000 });
  await drainOnce({ userId: u, store, now: T + 5000, deps: turnDeps });
  const reply = await dev.readReply(web, id);
  assert.equal(reply.ok, true); assert.equal(reply.text, 'hi from the desktop');
  assert.deepEqual([...new Set(web.log.map(([m]) => m))].sort(), ['GET', 'PUT']);
});

test('a revoked device cannot write: its folder is gone and nginx never recreates it', async () => {
  const { u, store, web, dev } = await linked();
  assert.equal(await revokeDevice(u, dev.deviceId, { store }), true);
  await assert.rejects(dev.sendRequest(web, 'still there?', { now: T + 4000 }), (e) => e.code === 'SYNC_MISSING');
});

test('nginx locations: exact allow-list, no listing, logs off, small PUTs, rate limit, exact CORS, no ^~ shadowing', () => {
  const text = vhostText();
  const locs = syncLocations(text);
  assert.deepEqual(locs.map((l) => l.method), ['GET', 'PUT']);
  const [get, put] = locs;
  const sid = 'A'.repeat(22); const dir = 'B'.repeat(22); const id = 'C'.repeat(22); const blob = 'a'.repeat(32);
  for (const f of ['key.bin', 'wrap.bin', 'manifest.bin', `s/${blob}.bin`, `out/${id}.bin`]) assert.ok(get.re.test(`/sync/${sid}/d/${dir}/${f}`), f);
  assert.ok(get.re.test(`/sync/${sid}/e/${id}/ack.bin`), 'the enrollment ack');
  for (const f of [`d/${dir}/`, `d/${dir}/in/0000000000001-${id}.bin`, `e/${id}/${id}.bin`, `d/${dir}/../key.bin`, `d/${dir}/key.binx`]) assert.ok(!get.re.test(`/sync/${sid}/${f}`), f);
  assert.ok(put.re.test(`/sync/${sid}/d/${dir}/in/0000000000001-${id}.bin`));
  assert.ok(put.re.test(`/sync/${sid}/e/${id}/${id}.bin`));
  for (const f of [`d/${dir}/manifest.bin`, `d/${dir}/key.bin`, `e/${id}/ack.bin`, `d/${dir}/out/${id}.bin`]) assert.ok(!put.re.test(`/sync/${sid}/${f}`), f);
  for (const l of locs) {
    for (const must of ['access_log off;', 'error_log /var/log/nginx/error.log crit;', 'limit_req zone=llmidesync', 'limit_req_status 429;', 'Cache-Control "no-store"', 'Access-Control-Allow-Origin $llmidesync_origin always;']) {
      assert.ok(l.body.includes(must), `${l.method} location has ${must}`);
    }
  }
  for (const must of ['client_max_body_size 64k;', 'create_full_put_path off;', 'dav_methods PUT;', 'dav_access group:rw;', 'client_body_temp_path /srv/llmide-sync-tmp;']) assert.ok(put.body.includes(must), must);
  // A symlink made over SFTP must never send nginx outside data/ (review 2026-11-06).
  for (const loc of [get, put]) assert.ok(loc.body.includes('disable_symlinks on;'), 'disable_symlinks on');
  assert.match(put.body, /Access-Control-Allow-Headers "Content-Type"/, 'the browser PUT preflight allows its Content-Type');
  assert.match(text, /limit_req_zone \$binary_remote_addr zone=llmidesync:1m rate=2r\/s;/);
  assert.match(text, /map \$http_origin \$llmidesync_origin \{\n\s+default "";\n\s+"https:\/\/llm-ide\.com" \$http_origin;/);
  assert.match(text, /location \/sync\/ \{ access_log off; return 404; \}/);
  assert.doesNotMatch(text, /location \^~ \/sync\//, '^~ would stop the regex search and 404 every /sync/ request');
  assert.doesNotMatch(text, /Access-Control-Allow-Origin "?\*/);
});

test('sshd Match block: chrooted internal-sftp, key only, nothing forwarded', () => {
  const conf = fs.readFileSync(path.resolve(HERE, '../../deploy/vps/50-llmidesync.conf'), 'utf8');
  for (const line of ['Match User llmidesync', 'AuthorizedKeysFile /etc/ssh/authorized_keys/%u', 'AuthenticationMethods publickey', 'PubkeyAuthentication yes',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'ChrootDirectory /srv/llmide-sync', 'ForceCommand internal-sftp -d /data -u 0007',
    'AllowTcpForwarding no', 'AllowStreamLocalForwarding no', 'AllowAgentForwarding no', 'PermitTunnel no', 'X11Forwarding no', 'PermitTTY no', 'PermitUserRC no']) {
    assert.match(conf, new RegExp(`^\\s*${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'), line);
  }
});
