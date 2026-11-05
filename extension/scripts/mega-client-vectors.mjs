// cd extension && node scripts/mega-client-vectors.mjs          check the fixture against megajs
// cd extension && node scripts/mega-client-vectors.mjs --write  regenerate it
// Real megajs 1.3.10 login/session and folder creation against an in-process fake MEGA API. Upload ciphertext, node
// keys and attributes come from megajs's own exported encryptor (the Storage upload completion callback is avoided:
// it reads its key before the transform flush sets it). No network.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createCipheriv, generateKeyPairSync, pbkdf2Sync } from 'node:crypto';
import { Storage, encrypt } from 'megajs';

const FILE = new URL('../../ios_app/SharedProtocol/Tests/SharedProtocolTests/Fixtures/mega-client.json', import.meta.url);
const e64 = (b) => Buffer.from(b).toString('base64url');
const d64 = (s) => Buffer.from(s, 'base64url');
const ecb = (key, data) => createCipheriv('aes-128-ecb', key, null).setAutoPadding(false).update(data);
const big = (buf) => BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
const bytesOf = (n) => { let h = n.toString(16); if (h.length % 2) h = `0${h}`; return Buffer.from(h, 'hex'); };
const mpi = (n) => { const bits = n.toString(2).length; return Buffer.concat([Buffer.from([bits >> 8, bits & 255]), bytesOf(n)]); };
const modPow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const modInv = (a, m) => { let [r0, r1, s0, s1] = [a % m, m, 1n, 0n]; while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return ((s0 % m) + m) % m; };
const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255));
const attr = (name, key16) => {
  let b = Buffer.from(`MEGA{"n":"${name}"}`);
  b = Buffer.concat([b, Buffer.alloc((16 - b.length % 16) % 16)]);
  return e64(createCipheriv('aes-128-cbc', key16, Buffer.alloc(16)).setAutoPadding(false).update(b));
};
const encryptBuffer = async (key24, plain) => {
  const s = encrypt(key24); const out = [];
  s.on('data', (c) => out.push(c));
  const done = new Promise((res, rej) => { s.on('end', res); s.on('error', rej); });
  s.end(plain);
  await done;
  return { ciphertext: Buffer.concat(out), key: Buffer.from(s.key), mac: Buffer.from(s.mac) };
};

function freshInputs() {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const [n, e, d, p, q] = ['n', 'e', 'd', 'p', 'q'].map((k) => big(d64(jwk[k])));
  const master = Buffer.alloc(16, 0x4d);
  let privk = Buffer.concat([mpi(p), mpi(q), mpi(d), mpi(modInv(p, q))]);
  privk = Buffer.concat([privk, Buffer.alloc((16 - privk.length % 16) % 16)]);
  const sidRaw = Buffer.concat([Buffer.from([0x53]), Buffer.alloc(42, 0x2a)]);
  const m = big(Buffer.concat([sidRaw, Buffer.alloc(200, 0x11)]));
  return {
    email: 'sync-it@example.com', password: 'correct horse battery staple', salt: e64(Buffer.alloc(32, 0x5a)),
    masterKeyHex: master.toString('hex'), privk: e64(ecb(master, privk)), csid: e64(mpi(modPow(m, e, n))), sid: e64(sidRaw),
    challenge: `1:255:1762300000:${e64(Buffer.alloc(48, 0x48))}`, mkdirKeyHex: '6b'.repeat(16), uploadKeyHex: '75'.repeat(24),
    plaintextHex: Buffer.from('{"v":1,"hello":"sync"}').toString('hex'), bigSize: 393232,
  };
}

async function run(inp) {
  const derived = pbkdf2Sync(Buffer.from(inp.password), d64(inp.salt), 100000, 32, 'sha512');
  const uh = e64(derived.subarray(16));
  const k = e64(ecb(derived.subarray(0, 16), Buffer.from(inp.masterKeyHex, 'hex')));
  const master = Buffer.from(inp.masterKeyHex, 'hex');
  const USER = 'USERHNDL';
  let challenged = false; let token = null; let n = 0;
  const nodes = [{ h: 'ROOTHNDL', t: 2, a: '', k: '', s: 0, ts: 1762300000, u: USER }];
  const reply = (body, headers = {}) => new Response(Buffer.isBuffer(body) ? body : JSON.stringify(body), { status: 200, headers });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/cs') {
      if (!challenged) { challenged = true; return reply([-3], { 'X-Hashcash': inp.challenge }); }
      token ??= opts.headers?.['X-Hashcash'] ?? null;
      const [cmd] = JSON.parse(opts.body);
      if (cmd.a === 'us0') return reply([{ v: 2, s: inp.salt }]);
      if (cmd.a === 'us') return reply([cmd.uh === uh ? { k, csid: inp.csid, privk: inp.privk, u: USER } : -9]);
      if (cmd.a === 'ug') return reply([{ u: USER, name: 'sync' }]);
      if (cmd.a === 'f') return reply([{ f: nodes, ok: [] }]);
      if (cmd.a === 'p') {
        const out = cmd.n.map((x) => {
          const node = { h: `NODE${String(++n).padStart(4, '0')}`, p: cmd.t, t: x.t, a: x.a, k: `${USER}:${x.k}`, s: x.t ? 0 : 0, ts: 1762300000 + n, u: USER };
          nodes.push(node); return node;
        });
        return reply([{ f: out }]);
      }
      return reply([-2]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const storage = await new Storage({ email: inp.email, password: inp.password, keepalive: false, fetch }).ready;
  if (storage.sid !== inp.sid) throw new Error('megajs derived another session id');
  const folder = await storage.root.mkdir({ name: 'llmide-sync', key: Buffer.alloc(16, 0x66) });
  const inFolder = await folder.mkdir({ name: 'in', key: Buffer.from(inp.mkdirKeyHex, 'hex') });
  const plain = Buffer.from(inp.plaintextHex, 'hex');
  const upKey = Buffer.from(inp.uploadKeyHex, 'hex');
  const up = await encryptBuffer(upKey, plain);
  const upNode = { h: 'UPLOAD01', p: folder.nodeId, t: 0, a: attr('hello.bin', upKey.subarray(0, 16)), k: `${USER}:${e64(ecb(master, up.key))}`, s: plain.length, ts: 1762300001, u: USER };
  const bigKey = Buffer.alloc(24, 0x42);
  const bigPlain = pattern(inp.bigSize);
  const bigUp = await encryptBuffer(bigKey, bigPlain);
  const bigNode = { h: 'BIG00001', p: folder.nodeId, t: 0, a: attr('big.bin', bigKey.subarray(0, 16)), k: `${USER}:${e64(ecb(master, bigUp.key))}`, s: bigPlain.length, ts: 1762300002, u: USER };
  nodes.push(upNode, bigNode);
  const node = (h) => nodes.find((x) => x.h === h);
  return {
    v: 1, megajs: '1.3.10',
    login: { email: inp.email, password: inp.password, salt: inp.salt, uh, k, privk: inp.privk, csid: inp.csid, sid: inp.sid, masterKeyHex: inp.masterKeyHex, userHandle: USER },
    hashcash: { challenge: inp.challenge, token },
    mkdir: { h: inFolder.nodeId, keyHex: inp.mkdirKeyHex, name: 'in', parent: folder.nodeId, a: node(inFolder.nodeId).a, k: node(inFolder.nodeId).k.split(':')[1] },
    upload: { keyHex: inp.uploadKeyHex, name: 'hello.bin', parent: folder.nodeId, plaintextHex: inp.plaintextHex, ciphertext: e64(up.ciphertext), a: upNode.a, k: upNode.k.split(':')[1] },
    big: { h: bigNode.h, name: 'big.bin', size: inp.bigSize },
    nodes, blobs: { [upNode.h]: e64(up.ciphertext), [bigNode.h]: e64(bigUp.ciphertext) },
    inputs: inp,
  };
}

const write = process.argv.includes('--write');
const committed = write ? null : JSON.parse(readFileSync(FILE));
const out = await run(write ? freshInputs() : committed.inputs);
if (write) {
  mkdirSync(new URL('.', FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(out, null, 1)}\n`);
  console.log('wrote', FILE.pathname);
} else {
  const strip = (o) => JSON.stringify({ ...o, nodes: o.nodes.filter((x) => x.h !== o.big.h), blobs: { ...o.blobs, [o.big.h]: null } });
  if (strip(out) !== strip(committed)) { console.error('mega client fixture out of date: node scripts/mega-client-vectors.mjs --write'); process.exit(1); }
  console.log('mega client fixture ok (megajs 1.3.10)');
}
process.exit(0);
