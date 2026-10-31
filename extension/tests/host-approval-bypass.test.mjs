// F3 core half: host-signed approval for permissionMode "bypass" (core/host-approval.mjs, routes/agent-v2.mjs).
// Hermetic: scratch DB, req/res doubles, injected turn runner. No model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
delete process.env.LLMIDE_HOST_APPROVAL_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_agent-v2-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_host-approval-bypass-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const H = await import('../core/host-approval.mjs');
const { redact } = await import('../core/redact-object.mjs');
const { redactSecrets } = await import('../core/redact-secrets.mjs');

const KEY_HEX = crypto.randomBytes(32).toString('hex');
const KEY = Buffer.from(KEY_HEX, 'hex');
const BUS_PROOF = H.busHostProof({ LLMIDE_HOST_APPROVAL_KEY: KEY_HEX });
const desk = { 'x-llmide-client': 'desktop-ui', [H.BUS_PROOF_HEADER]: BUS_PROOF };
// v2 is chat-bound (purpose `bypass:<chat>`); v1 is the legacy unbound format (accepted only with LLMIDE_HOST_APPROVAL_COMPAT=1).
const mint = ({ key = KEY, chat = 'c', purpose, version = 'v2', now = Date.now(), ttl = 60_000, nonce = crypto.randomBytes(16).toString('hex') } = {}) => {
  const expiry = now + ttl;
  const p = purpose ?? (version === 'v2' ? `bypass:${chat}` : 'bypass');
  const mac = crypto.createHmac('sha256', key).update(`llmide-host-approval/${version}|${p}|${expiry}|${nonce}`).digest('hex');
  return `${version}.${expiry}.${nonce}.${mac}`;
};
const P = 'bypass:c';

// ---- verifier (unit) ---------------------------------------------------------------------------------------------
test('verifier: a valid token passes once, the replay is refused', () => {
  const v = H.createHostApprovalVerifier();
  const t = mint();
  assert.equal(v.verify(t, KEY, P), true);
  assert.equal(v.verify(t, KEY, P), false);
});

test('verifier: expired, far-future, wrong key, wrong purpose, tampered and malformed tokens are refused', () => {
  const clock = { t: 1_000_000 };
  const v = H.createHostApprovalVerifier({ now: () => clock.t });
  const at = (o) => mint({ now: clock.t, ...o });
  assert.equal(v.verify(at({ ttl: -1 }), KEY, P), false, 'expired');
  assert.equal(v.verify(at({ ttl: 60_000 + 5_001 }), KEY, P), false, 'lifetime beyond 60 s + skew');
  assert.equal(v.verify(at({ ttl: 60_000 + 5_000 }), KEY, P), true, 'skew tolerated');
  assert.equal(v.verify(at({ key: crypto.randomBytes(32) }), KEY, P), false, 'wrong key');
  assert.equal(v.verify(at({ purpose: 'terminal' }), KEY, P), false, 'other purpose');
  assert.equal(v.verify(at({ chat: 'other-chat' }), KEY, P), false, 'bound to another chat');
  assert.equal(v.verify(at({}), KEY, 'bypass:c|x'), false, 'a purpose with the separator is never verifiable');
  const good = at({});
  const [ver, exp, nonce, mac] = good.split('.');
  assert.equal(v.verify([ver, Number(exp) + 1, nonce, mac].join('.'), KEY, P), false, 'expiry tampered');
  assert.equal(v.verify([ver, exp, '0'.repeat(32), mac].join('.'), KEY, P), false, 'nonce tampered');
  assert.equal(v.verify([ver, exp, nonce, mac.replace(/.$/, mac.endsWith('0') ? '1' : '0')].join('.'), KEY, P), false, 'mac tampered');
  for (const bad of ['', 'v2', `v3.${exp}.${nonce}.${mac}`, `${good}.x`, good.toUpperCase(), undefined, null, 42, 'x'.repeat(5000)]) {
    assert.equal(v.verify(bad, KEY, P), false, `malformed ${String(bad).slice(0, 12)}`);
  }
  assert.equal(v.verify(good, null, P), false, 'no key');
  assert.equal(v.verify(good), false, 'no purpose');
  assert.equal(v.verify(good, KEY, P), true, 'the untampered token still works (failed attempts burn nothing)');
});

test('verifier: used nonces are pruned at expiry and the set is bounded (fails closed when full)', () => {
  const clock = { t: 5_000_000 };
  const v = H.createHostApprovalVerifier({ now: () => clock.t });
  for (let i = 0; i < H.MAX_USED_NONCES; i++) assert.equal(v.verify(mint({ now: clock.t }), KEY, P), true);
  assert.equal(v._size(), H.MAX_USED_NONCES);
  assert.equal(v.verify(mint({ now: clock.t }), KEY, P), false, 'full: refused, never evicts a live nonce');
  clock.t += 61_000;
  assert.equal(v.verify(mint({ now: clock.t }), KEY, P), true, 'expired entries pruned');
  assert.equal(v._size(), 1);
});

test('key parsing: only 64 hex characters, anything else verifies nothing', () => {
  assert.equal(H.hostApprovalEnabled({}), false);
  assert.equal(H.hostApprovalEnabled({ LLMIDE_HOST_APPROVAL_KEY: '' }), false);
  assert.equal(H.hostApprovalEnabled({ LLMIDE_HOST_APPROVAL_KEY: 'zz' }), true, 'set but malformed = enabled and fail closed');
  assert.equal(H.hostApprovalKey({ LLMIDE_HOST_APPROVAL_KEY: 'zz' }), null);
  assert.deepEqual(H.hostApprovalKey({ LLMIDE_HOST_APPROVAL_KEY: KEY_HEX }), KEY);
  const t = mint();
  assert.equal(H.verifyRequestApproval({ headers: { [H.HOST_APPROVAL_HEADER]: t } }, { env: { LLMIDE_HOST_APPROVAL_KEY: 'zz' }, verifier: H.createHostApprovalVerifier(), purpose: P }), false);
});

test('verifier: a v1 token is refused by default and accepted only with the compat switch (and still only once, for a bypass purpose)', () => {
  const v1 = () => mint({ version: 'v1' });
  const req = (t) => ({ headers: { [H.HOST_APPROVAL_HEADER]: t } });
  const env = (compat) => ({ LLMIDE_HOST_APPROVAL_KEY: KEY_HEX, ...(compat ? { LLMIDE_HOST_APPROVAL_COMPAT: '1' } : {}) });
  assert.equal(H.verifyRequestApproval(req(v1()), { env: env(false), verifier: H.createHostApprovalVerifier(), purpose: P }), false);
  const verifier = H.createHostApprovalVerifier();
  const t = v1();
  assert.equal(H.verifyRequestApproval(req(t), { env: env(true), verifier, purpose: P }), true);
  assert.equal(H.verifyRequestApproval(req(t), { env: env(true), verifier, purpose: P }), false, 'single use');
  assert.equal(H.verifyRequestApproval(req(v1()), { env: env(true), verifier, purpose: 'terminal' }), false, 'not a bypass purpose');
  assert.equal(H.verifyRequestApproval(req(mint()), { env: env(false), verifier: H.createHostApprovalVerifier() }), false, 'no purpose given');
});

test('verifier: a v2 token minted for chat A is refused for chat B and works for chat A once', () => {
  const t = mint({ chat: 'chat-A' });
  const verifier = H.createHostApprovalVerifier();
  const env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX };
  const req = { headers: { [H.HOST_APPROVAL_HEADER]: t } };
  assert.equal(H.verifyRequestApproval(req, { env, verifier, purpose: H.bypassPurpose('chat-B') }), false);
  assert.equal(H.verifyRequestApproval(req, { env, verifier, purpose: H.bypassPurpose('chat-A') }), true);
  assert.equal(H.verifyRequestApproval(req, { env, verifier, purpose: H.bypassPurpose('chat-A') }), false);
});

// ---- route (table driven) ----------------------------------------------------------------------------------------
function makeReq({ body, user, headers = {}, remoteAddress }) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const req = {
    method: 'POST', url: '/agent/v2/stream', user, headers, socket: remoteAddress ? { remoteAddress } : undefined,
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end' || event === 'close') cb(); return req; },
  };
  return req;
}
function makeRes() {
  return {
    on() { return this; }, statusCode: 200, headers: {}, _body: '',
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); },
    write(c) { this._body += c; }, end(c) { if (c) this._body += c; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
let n = 0;
const user = registerUser(getDb(), { email: 'host-approval@example.com', password: 'CorrectHorseBattery', displayName: 't' });
async function stream({ chat: chatIn, who = user, permissionMode, headers: headersIn, token, desktop = true, surface, remoteAddress, env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX }, extra = {} }) {
  const chat = chatIn || `chat-ha-${++n}`;
  // token: a mint function of the chat id, a string, or undefined; desktop adds the desktop-ui class + bus host proof
  const tok = typeof token === 'function' ? token(chat) : token;
  const headers = { ...(desktop ? desk : {}), ...(tok ? { [H.HOST_APPROVAL_HEADER]: tok } : {}), ...(headersIn || {}) };
  const saved = process.env.LLMIDE_HOST_APPROVAL_KEY;
  if (env?.LLMIDE_HOST_APPROVAL_KEY) process.env.LLMIDE_HOST_APPROVAL_KEY = env.LLMIDE_HOST_APPROVAL_KEY; else delete process.env.LLMIDE_HOST_APPROVAL_KEY;
  try {
    let seen = null;
    const res = makeRes();
    const body = { message: 'go', mode: 'execute', ...(permissionMode === undefined ? {} : { permissionMode }), ...extra,
      agentContext: { chatSessionId: chat, workspaceRoot: WS, ...(surface ? { surface } : {}) } };
    await handleAgentV2Routes(makeReq({ body, user: who, headers, remoteAddress }), res, {
      runTurn: async (args) => { seen = args; return { result: { subtype: 'success' }, usageTotals: {} }; },
    });
    return { res, ran: seen !== null, permissionMode: seen?.permissionMode, chat: body.agentContext.chatSessionId, args: seen };
  } finally {
    if (saved === undefined) delete process.env.LLMIDE_HOST_APPROVAL_KEY; else process.env.LLMIDE_HOST_APPROVAL_KEY = saved;
  }
}
const auditRows = (action) => getDb().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

const REFUSED = [
  ['header missing', () => undefined],
  ['empty header', () => ''],
  ['expired', (chat) => mint({ chat, ttl: -1 })],
  ['wrong key', (chat) => mint({ chat, key: crypto.randomBytes(32) })],
  ['tampered payload', (chat) => { const [a, e, nn, m] = mint({ chat }).split('.'); return [a, Number(e) + 1, nn, m].join('.'); }],
  ['other purpose', (chat) => mint({ chat, purpose: 'terminal' })],
  ['minted for another chat (v2 is chat-bound)', () => mint({ chat: 'some-other-chat' })],
  ['legacy v1 (compat is off by default)', () => mint({ version: 'v1' })],
  ['garbage', () => 'not-a-token'],
];
for (const [name, mk] of REFUSED) {
  test(`stream bypass with host key: ${name} is refused 403 HOST_APPROVAL_REQUIRED before any turn`, async () => {
    const r = await stream({ permissionMode: 'bypass', token: mk });
    assert.equal(r.res.statusCode, 403);
    assert.equal(r.res.json().error.code, 'HOST_APPROVAL_REQUIRED');
    assert.equal(r.ran, false);
    assert.ok(!/v[12]\./.test(r.res._body), 'no token echoed');
  });
}

test('stream bypass with host key: a valid chat-bound token runs the turn as bypass once, audited approvedBy host; the replay is refused', async () => {
  const chat = 'chat-once';
  const t = mint({ chat });
  const before = auditRows('agent.bypass_turn').length;
  const ok = await stream({ chat, permissionMode: 'bypass', token: t });
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.permissionMode, 'bypass');
  const rows = auditRows('agent.bypass_turn');
  assert.equal(rows.length, before + 1);
  const last = rows.at(-1);
  assert.equal(last.outcome, 'success');
  assert.equal(last.resource, ok.chat);
  assert.equal(String(last.user_id), String(user.id));
  assert.deepEqual(JSON.parse(last.detail), { approvedBy: 'host', via: 'token' });
  assert.ok(!JSON.stringify(last).includes(t), 'the token is never in the audit row');
  const replay = await stream({ chat: 'chat-once-2', permissionMode: 'bypass', token: t });
  assert.equal(replay.res.statusCode, 403);
  assert.equal(replay.ran, false);
  assert.ok(auditRows('agent.bypass_refused').length >= 1);
});

test('stream bypass: a legacy v1 token works only with LLMIDE_HOST_APPROVAL_COMPAT=1', async () => {
  process.env.LLMIDE_HOST_APPROVAL_COMPAT = '1';
  try {
    const r = await stream({ chat: 'chat-compat', permissionMode: 'bypass', token: mint({ version: 'v1' }) });
    assert.equal(r.permissionMode, 'bypass');
  } finally { delete process.env.LLMIDE_HOST_APPROVAL_COMPAT; }
});

test('stream bypass with host key: phone, extension, relay and remote origins are capped at Ask even with a valid token', async () => {
  const cases = [
    ['ios-native class', { headers: { 'x-llmide-client': 'ios-native' } }],
    ['phone-pwa class', { headers: { 'x-llmide-client': 'phone-pwa' } }],
    ['extension class', { headers: { 'x-llmide-client': 'extension' } }],
    ['relay-bridge', { headers: { 'x-llmide-client': 'relay-bridge' } }],
    ['extension surface', { surface: 'extension' }],
    ['phone surface', { surface: 'phone' }],
    ['remote peer', { remoteAddress: '203.0.113.9' }],
    // M2: no client header at all, or desktop-ui WITHOUT the host proof, is not the desktop
    ['no x-llmide-client header', { desktop: false, headers: { [H.BUS_PROOF_HEADER]: BUS_PROOF } }],
    ['desktop-ui without the host proof', { desktop: false, headers: { 'x-llmide-client': 'desktop-ui' } }],
    ['desktop-ui with a wrong proof', { desktop: false, headers: { 'x-llmide-client': 'desktop-ui', [H.BUS_PROOF_HEADER]: 'ab'.repeat(32) } }],
    ['desktop-ui with the /health nonce as proof', { desktop: false, headers: { 'x-llmide-client': 'desktop-ui', [H.BUS_PROOF_HEADER]: 'ef'.repeat(24) } }],
  ];
  for (const [name, o] of cases) {
    const chat = `chat-cap-${++n}`;
    const t = mint({ chat });
    const r = await stream({ chat, permissionMode: 'bypass', ...o, token: t });
    assert.equal(r.res.statusCode, 200, name);
    assert.equal(r.permissionMode, 'ask', name);
    // the token was not spent by a capped request
    assert.equal(H.createHostApprovalVerifier().verify(t, KEY, H.bypassPurpose(chat)), true, `${name}: token untouched`);
  }
  assert.ok(auditRows('agent.bypass_capped').length >= cases.length);
  const chat = 'chat-desktop-ok';
  const desktop = await stream({ chat, permissionMode: 'bypass', token: mint({ chat }), remoteAddress: '127.0.0.1' });
  assert.equal(desktop.permissionMode, 'bypass', 'desktop-ui + host proof on loopback with a chat-bound token is the allowed path');
});

test('stream with host key: non-bypass modes need no token and pass through unchanged', async () => {
  for (const pm of ['ask', 'accept-edits', 'manual', undefined, 'junk', 7, null]) {
    const r = await stream({ permissionMode: pm });
    assert.equal(r.res.statusCode, 200, String(pm));
    const want = ['ask', 'accept-edits', 'manual'].includes(pm) ? pm : null;
    assert.equal(r.permissionMode, want, String(pm));
  }
});

test('legacy: with LLMIDE_HOST_APPROVAL_KEY unset bypass behaves exactly as before, header ignored', async () => {
  const plain = await stream({ permissionMode: 'bypass', env: null, desktop: false });
  const withHdr = await stream({ permissionMode: 'bypass', env: null, desktop: false, headers: { [H.HOST_APPROVAL_HEADER]: 'garbage' } });
  const withCap = await stream({ permissionMode: 'bypass', env: null, desktop: false, headers: { 'x-llmide-client': 'ios-native' }, remoteAddress: '203.0.113.9' });
  for (const r of [plain, withHdr, withCap]) {
    assert.equal(r.res.statusCode, 200);
    assert.equal(r.permissionMode, 'bypass');
  }
  const norm = (r) => JSON.stringify({ ...r.args, onEvent: undefined, signal: undefined, abortController: undefined, agentContext: undefined, resumeSdkSessionId: undefined });
  assert.equal(norm(plain), norm(withHdr));
  assert.equal(norm(plain), norm(withCap));
  assert.equal(plain.res._body.replace(/"turnId":"[^"]*"/g, ''), withHdr.res._body.replace(/"turnId":"[^"]*"/g, ''));
});

test('malformed key: the host is assumed present and every bypass fails closed', async () => {
  const r = await stream({ permissionMode: 'bypass', env: { LLMIDE_HOST_APPROVAL_KEY: 'not-hex' }, token: (chat) => mint({ chat }) });
  assert.ok(r.permissionMode !== 'bypass');
  assert.equal(r.res.statusCode === 403 || r.permissionMode === 'ask', true);
});

// ---- entry points ------------------------------------------------------------------------------------------------
test('entry points: only the stream route reads a permission mode from a request; the engine is its only consumer (core/host-approval.mjs names the purpose, server.mjs the API-version note)', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'tests', 'dist', 'build'].includes(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs') && /['"]bypass['"]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(hits.sort(), ['core/host-approval.mjs', 'llm_agent/sdk/engine.mjs', 'routes/agent-v2.mjs', 'server.mjs'].sort(),
    'a new file that names the bypass mode is a new entry point: gate it with core/host-approval.mjs and add it to this list');
  const route = fs.readFileSync(path.join(root, 'routes/agent-v2.mjs'), 'utf8');
  assert.equal((route.match(/body\.permissionMode/g) || []).length >= 2, true);
  assert.ok(route.indexOf('gateBypassRequest(req, res, userId, body') < route.indexOf('runV2Stream('), 'gate runs before the turn starts');
});

test('entry points: session route, decision and cancel ignore a smuggled permissionMode', async () => {
  // Their handlers never read permissionMode (asserted above by the source scan); a request that carries one is
  // handled as if it did not.
  const saved = process.env.LLMIDE_HOST_APPROVAL_KEY;
  process.env.LLMIDE_HOST_APPROVAL_KEY = KEY_HEX;
  try {
    for (const [method, url, body] of [
      ['POST', '/agent/v2/decision', { requestId: 'x', sdkSessionId: 'y', action: 'approve', permissionMode: 'bypass' }],
      ['POST', '/agent/v2/cancel', { chatSessionId: 'z', permissionMode: 'bypass' }],
      ['PUT', '/agent/v2/session/route', { chatSessionId: 'z', permissionMode: 'bypass', mode: 'bypass' }],
    ]) {
      const req = makeReq({ body, user }); req.method = method; req.url = url;
      const res = makeRes();
      await handleAgentV2Routes(req, res, { runTurn: async () => { throw new Error('no turn'); } });
      assert.notEqual(res.json().error?.code, 'HOST_APPROVAL_REQUIRED', url);
      assert.ok(!/bypass/.test(res._body) || res.statusCode >= 400, url);
    }
  } finally { if (saved === undefined) delete process.env.LLMIDE_HOST_APPROVAL_KEY; else process.env.LLMIDE_HOST_APPROVAL_KEY = saved; }
});

// ---- redaction ---------------------------------------------------------------------------------------------------
test('redaction: the header, the key and a token in free text never survive redact()', () => {
  const t = mint();
  const out = JSON.stringify(redact({
    headers: { 'x-llmide-host-approval': t, 'user-agent': 'x' }, hostApproval: t, LLMIDE_HOST_APPROVAL_KEY: KEY_HEX,
    message: `retrying with ${t} now`,
  }));
  assert.ok(!out.includes(t));
  assert.ok(!out.includes(KEY_HEX));
  assert.ok(!redactSecrets(`header x-llmide-host-approval: ${t}`).includes(t));
});

// ---- per-chat grant (a token per Bypass enable, not per message) ---------------------------------------------------
test('grant: a valid token enables Bypass for that chat only; other chats, other users, a mode switch and expiry end it', async () => {
  const other = registerUser(getDb(), { email: 'host-approval-2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const first = await stream({ chat: 'chat-grant-1', permissionMode: 'bypass', token: (c) => mint({ chat: c }) });
  assert.equal(first.permissionMode, 'bypass');
  const second = await stream({ chat: 'chat-grant-1', permissionMode: 'bypass' });
  assert.equal(second.permissionMode, 'bypass', 'next message of the same chat needs no new token');
  assert.equal(JSON.parse(auditRows('agent.bypass_turn').at(-1).detail).via, 'chat_grant');
  assert.equal((await stream({ chat: 'chat-grant-2', permissionMode: 'bypass' })).res.statusCode, 403, 'another chat');
  assert.equal((await stream({ chat: 'chat-grant-1', who: other, permissionMode: 'bypass' })).res.statusCode, 403, 'another user, same chat id');
  assert.equal((await stream({ chat: 'chat-grant-1', permissionMode: 'ask' })).permissionMode, 'ask');
  assert.equal((await stream({ chat: 'chat-grant-1', permissionMode: 'bypass' })).res.statusCode, 403, 'switching Bypass off ends the grant');
  const clock = { t: 1_000 };
  const g = H.createBypassGrants({ now: () => clock.t });
  assert.equal(g.grant('u', 'c'), true);
  assert.equal(g.has('u', 'c'), true);
  assert.equal(g.has('u', 'd'), false);
  clock.t += H.GRANT_TTL_MS;
  assert.equal(g.has('u', 'c'), false, 'expired');
  for (let i = 0; i < H.MAX_GRANTS; i++) g.grant('u', `c${i}`);
  assert.equal(g.grant('u', 'overflow'), false, 'bounded');
});

test('grant: a capped origin never gains or uses Bypass through a grant', async () => {
  await stream({ chat: 'chat-grant-3', permissionMode: 'bypass', token: (c) => mint({ chat: c }) });
  const phone = await stream({ chat: 'chat-grant-3', permissionMode: 'bypass', desktop: false, headers: { 'x-llmide-client': 'ios-native' } });
  assert.equal(phone.permissionMode, 'ask');
  const noProof = await stream({ chat: 'chat-grant-3', permissionMode: 'bypass', desktop: false, headers: { 'x-llmide-client': 'desktop-ui' } });
  assert.equal(noProof.permissionMode, 'ask', 'a live grant is not usable without the host proof');
});
