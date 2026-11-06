import { test, after } from 'node:test';import { randomBytes } from 'node:crypto';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createSftpStore,hostKeyFingerprint,parseHostFingerprint,validateSftpConfig } from '../connectors/sync-store/sftp.mjs';import { MAX_FILE_BYTES } from '../connectors/sync-store/index.mjs';import { createFakeSftp } from './helpers/fake-sftp.mjs';import { runSyncStoreContract } from './helpers/sync-store-contract.mjs';
const FP='SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM';const CFG={host:'sync.example.com',port:22,username:'llmidesync',hostFingerprint:FP,webHost:'llm-ide.com',root:'/data'};const SECRETS={privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n'};const make=(fake=createFakeSftp())=>({fake,store:createSftpStore(CFG,SECRETS,{connect:fake.connect})});const code=(c)=>(e)=>{assert.equal(e.code,c);return true};const onDisk=(fake,p)=>path.join(fake.root,'data',p);
runSyncStoreContract(test,assert,async()=>make().store,'sftp (fake SFTP)');
test('fingerprints',()=>{const blob=Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIGUNOIRsIwfOOUYhJwIlBFBb0cxkQq1Ete227Z9GE+lv','base64');assert.equal(hostKeyFingerprint(blob),FP);assert.equal(parseHostFingerprint(`256 ${FP} root@vps (ED25519)`),FP);assert.equal(parseHostFingerprint(`${FP}=`),FP);assert.equal(validateSftpConfig(CFG),null);for(const[k,v]of[['host','bad host'],['port',0],['username','Root'],['hostFingerprint','SHA256:x'],['webHost','LLM-IDE.com'],['root','/data/../etc']])assert.equal(validateSftpConfig({...CFG,[k]:v}),k)});
test('describe names the device host and the account, never the key',()=>{const{store}=make();assert.deepEqual(store.describe(),{kind:'sftp',root:'llm-ide.com',account:'llmidesync@sync.example.com:22'});assert.ok(!JSON.stringify(store.describe()).includes('PRIVATE'))});
test('atomic put',async()=>{const{fake,store}=make();await store.put('a/manifest.bin',Buffer.from('old'));fake.calls.length=0;await store.put('a/manifest.bin',Buffer.from('new'));assert.deepEqual(fake.calls,['writeFile','ext_openssh_rename']);assert.equal(fs.readFileSync(onDisk(fake,'a/manifest.bin'),'utf8'),'new');fs.writeFileSync(onDisk(fake,'a/.manifest.bin.0123456789ab.part'),'half');assert.deepEqual((await store.list('a')).map((e)=>e.name),['manifest.bin']);assert.equal(fake.lastConfig.privateKey,SECRETS.privateKey);assert.equal(fake.lastConfig.hostFingerprint,FP)});
test('failed rename',async()=>{const{fake,store}=make();await store.put('a/x.bin',Buffer.from('1'));fake.failNext('ext_openssh_rename',Object.assign(new Error('Failure'),{code:4}));await assert.rejects(store.put('a/x.bin',Buffer.from('2')),code('SYNC_IO'));assert.deepEqual(fs.readdirSync(onDisk(fake,'a')),['x.bin']);assert.equal(fs.readFileSync(onDisk(fake,'a/x.bin'),'utf8'),'1')});
test('too large',async()=>{const{fake,store}=make();fs.mkdirSync(onDisk(fake,'b'));fs.writeFileSync(onDisk(fake,'b/big.bin'),Buffer.alloc(MAX_FILE_BYTES+1));await assert.rejects(store.get('b/big.bin'),code('SYNC_TOO_LARGE'))});
test('symlink tree',async()=>{const{fake,store}=make();const outside=fs.mkdtempSync(path.join(os.tmpdir(),'llmide-outside-'));fs.writeFileSync(path.join(outside,'keep.txt'),'x');await store.put('t/d/k.bin',Buffer.from('k'));fs.symlinkSync(outside,onDisk(fake,'t/d/link'));await store.removeTree('t');assert.ok(fs.existsSync(path.join(outside,'keep.txt')));assert.ok(!fs.existsSync(onDisk(fake,'t')))});
test('ensureDir',async()=>{const{fake,store}=make();await store.ensureDir('s/e/slot');await store.ensureDir('s/e/slot');assert.ok(fs.statSync(onDisk(fake,'s/e/slot')).isDirectory());await assert.rejects(store.ensureDir('s/../x'),code('SYNC_BAD_PATH'))});
test('reconnect',async()=>{const{fake,store}=make();await store.put('c/x.bin',Buffer.from('1'));await store.get('c/x.bin');await store.list('c');assert.equal(fake.connects,1);fake.failNext('stat');assert.equal(Buffer.from(await store.get('c/x.bin')).toString(),'1');assert.equal(fake.connects,2);fake.lose();await store.list('c');assert.equal(fake.connects,3);await store.close();assert.ok(fake.closes>=1)});
test('connection refusals surface as codes and are not retried', async () => {
  const { fake, store } = make();
  fake.failNext('connect', Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_CHANGED' }));
  await assert.rejects(store.get('a.bin'), code('SYNC_HOST_KEY_CHANGED'));
  assert.equal(fake.connects, 1);
  assert.equal(await store.get('a.bin'), null, 'the next operation connects again');
});

// Opt-in run against a real server: LLMIDE_SYNC_SFTP_IT=user@host:port plus _FP, _KEY (path) and optional _ROOT.
const IT = process.env.LLMIDE_SYNC_SFTP_IT;
if (IT) {
  const m = /^([a-z_][a-z0-9_-]*)@([^:@\s]+):(\d+)$/.exec(IT);
  if (!m) throw new Error('LLMIDE_SYNC_SFTP_IT must be user@host:port');
  const live = createSftpStore({ host: m[2], port: Number(m[3]), username: m[1], hostFingerprint: process.env.LLMIDE_SYNC_SFTP_IT_FP,
    webHost: 'llm-ide.com', root: process.env.LLMIDE_SYNC_SFTP_IT_ROOT || '/data' }, { privateKey: fs.readFileSync(process.env.LLMIDE_SYNC_SFTP_IT_KEY, 'utf8') });
  const sub = `it-${randomBytes(6).toString('hex')}`;
  const prefixed = Object.fromEntries(['put', 'get', 'list', 'remove', 'removeTree', 'ensureDir'].map((k) => [k, (p, ...a) => live[k](`${sub}/${p}`, ...a)]));
  runSyncStoreContract(test, assert, async () => prefixed, 'sftp (live, opt-in)');
  after(async () => { await live.removeTree(sub).catch(() => {}); await live.close(); });
}
