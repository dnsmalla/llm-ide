// Real core (bench-fake engine, no model) with LLMIDE_HOST_API_DEV=1: the desktop UI's route mints a PIN with the bus
// host proof, then a v1 client pairs over the loopback listener, runs a chat turn, reads the snapshot and revokes itself.
// Binds local ports: run unsandboxed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startCore } from '../../ui/screens/shell/tests/e2e/core-server.mjs';
import { busHostProof, BUS_PROOF_HEADER } from '../core/host-approval.mjs';
import { budget } from './helpers/perf.mjs';

const KEY = randomBytes(32).toString('hex');
const PROOF = busHostProof({ LLMIDE_HOST_APPROVAL_KEY: KEY });
const skip = typeof WebSocket !== 'function' ? 'no global WebSocket in this Node' : process.env.LLMIDE_E2E === '0' ? 'LLMIDE_E2E=0' : false;
let core;
let access;

before(async () => {
  if (skip) return;
  core = await startCore({ env: { LLMIDE_HOST_API_DEV: '1', LLMIDE_HOST_APPROVAL_KEY: KEY } });
  const r = await fetch(`${core.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: core.email, password: core.password }) });
  assert.equal(r.status, 200);
  access = (await r.json()).accessToken;
});
after(() => core?.stop());

const http = (method, path, proof = PROOF) => fetch(`${core.base}${path}`, {
  method, headers: { Authorization: `Bearer ${access}`, ...(proof ? { [BUS_PROOF_HEADER]: proof } : {}) },
});

async function mintPin() {
  // The listener starts after the core's own listen: retry the 503 for a moment.
  for (let i = 0; i < 100; i++) {
    const r = await http('POST', '/host-api/pin');
    if (r.status !== 503) { assert.equal(r.status, 200, await r.clone().text()); return r.json(); }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`listener never came up: ${core.tail()}`);
}

function client(url) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data);
    frames.push(f);
    for (const w of [...waiters]) if (w.match(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  };
  const wait = (match, ms = budget(15_000)) => {
    const hit = frames.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timed out; frames: ${JSON.stringify(frames).slice(-1500)}`)), ms);
    });
  };
  let n = 0;
  const call = async (command, payload = {}) => {
    const id = `c-${++n}`;
    ws.send(JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: Date.now() }));
    return wait((f) => f.replyTo === id && (f.type === 'response' || f.type === 'error'));
  };
  const open = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return { ws, frames, wait, call, open };
}

test('the routes refuse a caller without the host proof', { skip }, async () => {
  const r = await http('POST', '/host-api/pin', null);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'HOST_PROOF_REQUIRED');
});

test('hello (desktop), pair, chat.send gives delta then done, snapshot, revoke', { skip }, async () => {
  const { pin, port } = await mintPin();
  assert.match(pin, /^[0-9]{6}$/);
  const c = client(`ws://127.0.0.1:${port}/host-api/v1`);
  await c.open;

  const hello = await c.call('host.hello', { clientName: 'e2e', clientVersion: '0.0.0', platform: 'ios', apiVersions: [1] });
  assert.equal(hello.type, 'response', JSON.stringify(hello));
  assert.equal(hello.result.hostKind, 'desktop');
  assert.deepEqual(hello.result.apiVersions, [1]);

  const pair = await c.call('host.auth.pair', { pin });
  assert.equal(pair.type, 'response', JSON.stringify(pair));
  const { token } = pair.result;
  assert.ok(typeof token === 'string' && token.length >= 16);

  const devices = await (await http('GET', '/host-api/devices')).json();
  assert.deepEqual(devices.devices.map((d) => d.name), ['e2e']);

  const sent = await c.call('chat.send', { text: 'hi' });
  assert.deepEqual(sent.result, { accepted: true, requestId: sent.replyTo });
  const done = await c.wait((f) => f.type === 'event' && f.command === 'chat.done' && f.replyTo === sent.replyTo, budget(30_000));
  const deltas = c.frames.filter((f) => f.type === 'event' && f.command === 'chat.delta' && f.replyTo === sent.replyTo);
  assert.ok(deltas.length >= 1, 'at least one chat.delta before chat.done');
  assert.ok(c.frames.indexOf(deltas.at(-1)) < c.frames.indexOf(done));
  assert.match(deltas.map((f) => f.payload.text).join(''), /^(ok )+/, 'the bench-fake canned reply');

  const snap = await c.call('chat.snapshot');
  assert.equal(snap.type, 'response', JSON.stringify(snap));
  assert.ok(Array.isArray(snap.result.messages));

  const revoke = await c.call('host.auth.revoke', { token });
  assert.deepEqual(revoke.result, { revoked: true });
  assert.deepEqual((await (await http('GET', '/host-api/devices')).json()).devices, []);
  c.ws.close();
});

test('chat.snapshot carries the user and assistant lines of a finished turn', { skip }, async () => {
  const { pin, port } = await mintPin();
  const c = client(`ws://127.0.0.1:${port}/host-api/v1`);
  await c.open;
  await c.call('host.hello', { clientName: 'e2e-snap', clientVersion: '0.0.0', platform: 'ios', apiVersions: [1] });
  const { result: { token } } = await c.call('host.auth.pair', { pin });
  try {
    const sent = await c.call('chat.send', { text: 'snapshot me' });
    await c.wait((f) => f.type === 'event' && f.command === 'chat.done' && f.replyTo === sent.replyTo, budget(30_000));
    const snap = await c.call('chat.snapshot');
    assert.deepEqual(snap.result.messages.slice(-2).map((m) => m.role), ['user', 'assistant']);
    assert.equal(snap.result.messages.at(-2).content, 'snapshot me');
    assert.match(snap.result.messages.at(-1).content, /^(ok )+/, 'the bench-fake canned reply');
  } finally {
    await c.call('host.auth.revoke', { token });
    c.ws.close();
  }
});
