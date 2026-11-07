// The push kind table on every surface (push notifications plan): the core's payload builders, the web worker's text
// table and the iPhone's Localizable.strings must say exactly what desktop/src-tauri/src/notify.rs says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PUSH_KINDS, COUNTED, isPushKind, webPayload, apnsPayload } from '../server/push/kinds.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm objects come from another realm
const rs = read('desktop/src-tauri/src/notify.rs');
const wire = Object.fromEntries([...rs.slice(rs.indexOf('pub fn wire'), rs.indexOf('pub fn from_webview'))
  .matchAll(/Kind::(\w+) => "([a-z_]+)"/g)].map((m) => [m[1], m[2]]));
const one = {};
const many = {};
for (const m of rs.slice(rs.indexOf('pub fn body'), rs.indexOf('/// The category switch'))
  .matchAll(/Kind::(\w+)( if many)? => (?:format!\()?"([^"]+)"/g)) (m[2] ? many : one)[wire[m[1]]] = m[3];
const HOST_ONLY = ['update_ready', 'core_down'];

test('the push kinds are the notifier webview kinds, never a host-only one', () => {
  assert.equal(Object.keys(one).length, 13, 'notify.rs parsed');
  assert.deepEqual([...PUSH_KINDS].sort(), Object.values(wire).filter((k) => !HOST_ONLY.includes(k)).sort());
  assert.deepEqual([...COUNTED].sort(), Object.keys(many).sort());
  for (const k of HOST_ONLY) assert.equal(isPushKind(k), false, k);
  for (const bad of ['', 'Approval_chat', 'approval_chat ', '__proto__', null, 3]) assert.equal(isPushKind(bad), false, String(bad));
});

test('payloads carry only the kind and a clamped count', () => {
  assert.equal(webPayload('loop_done', 1), '{"k":"loop_done","n":1}');
  assert.equal(webPayload('approval_job', 5000), '{"k":"approval_job","n":999}');
  assert.equal(webPayload('approval_job', 0), '{"k":"approval_job","n":1}');
  assert.equal(webPayload('approval_job', 2.5), '{"k":"approval_job","n":1}');
  assert.deepEqual(JSON.parse(apnsPayload('loop_failed', 1)), { aps: { alert: { title: 'LLM-IDE', 'loc-key': 'PUSH_LOOP_FAILED' }, sound: 'default' }, k: 'loop_failed' });
  assert.deepEqual(JSON.parse(apnsPayload('approval_chat', 150)).aps.alert, { title: 'LLM-IDE', 'loc-key': 'PUSH_APPROVAL_CHAT_MANY', 'loc-args': ['99+'] });
  assert.deepEqual(JSON.parse(apnsPayload('approval_job', 3)).aps.alert['loc-args'], ['3']);
  assert.equal(JSON.parse(apnsPayload('loop_done', 7)).aps.alert['loc-key'], 'PUSH_LOOP_DONE', 'only approvals count');
});

test('the web worker text table is the notify.rs table', () => {
  const sandbox = { self: {} };
  vm.runInNewContext(read('web/public/sw-push.js'), sandbox);
  const P = sandbox.self.LLMIDEPush;
  assert.deepEqual(plain(P.ONE), Object.fromEntries(PUSH_KINDS.map((k) => [k, one[k]])));
  assert.deepEqual(plain(P.MANY), many);
  assert.deepEqual(plain(P.render({ k: 'approval_chat', n: 3 })), { title: 'LLM-IDE', body: '3 tools are waiting for your approval in Chat.', tag: 'approval_chat' });
  assert.equal(P.render({ k: 'approval_job', n: 500 }).body, '99+ jobs are waiting for your approval.');
  assert.equal(P.render({ k: 'loop_done', n: 4 }).body, 'A Loop run passed.');
  assert.equal(P.render({ k: 'approval_chat' }).body, 'A tool is waiting for your approval in Chat.');
  for (const bad of [null, {}, { k: 'update_ready' }, { k: '__proto__' }, { k: 'toString' }, 'loop_done', { k: 1 }]) assert.equal(P.render(bad), null, JSON.stringify(bad));
});

test('the iPhone strings are the notify.rs table', () => {
  const strings = Object.fromEntries([...read('ios_app/MyApp/Supporting/Localizable.strings').matchAll(/^"([A-Z_]+)" = "(.*)";$/gm)].map((m) => [m[1], m[2]]));
  const want = {};
  for (const k of PUSH_KINDS) want[`PUSH_${k.toUpperCase()}`] = one[k];
  for (const [k, v] of Object.entries(many)) want[`PUSH_${k.toUpperCase()}_MANY`] = v.replace('{n}', '%@');
  assert.deepEqual(strings, want);
});
