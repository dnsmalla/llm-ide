// One classifier for every IP spelling, and the base-URL guard built on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
const { classifyIp, ipRefusal } = await import('../server/ip-classifier.mjs');
const { assertProviderBaseUrl, joinBaseUrl, privateProvidersAllowed } = await import('../server/base-url-guard.mjs');
const { assertSafeBaseUrl } = await import('../providers/providers.mjs');

const CASES = [
  // [address, class]
  ['8.8.8.8', 'public'], ['1.1.1.1', 'public'], ['2606:4700::1111', 'public'], ['::ffff:8.8.8.8', 'public'], ['100.63.255.255', 'public'], ['172.32.0.1', 'public'],
  ['127.0.0.1', 'private'], ['127.255.255.254', 'private'], ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'],
  ['100.64.0.1', 'private'], ['100.127.255.255', 'private'], ['::1', 'private'], ['fc00::1', 'private'], ['fd12:3456::1', 'private'], ['fec0::1', 'private'],
  // IPv4-mapped, IPv4-compatible, NAT64 and 6to4 spellings of the same addresses
  ['::ffff:127.0.0.1', 'private'], ['::ffff:7f00:1', 'private'], ['[::ffff:7f00:1]', 'private'], ['0:0:0:0:0:ffff:7f00:1', 'private'],
  ['::127.0.0.1', 'private'], ['64:ff9b::7f00:1', 'private'], ['2002:7f00:1::', 'private'], ['::ffff:10.0.0.1', 'private'], ['::ffff:192.168.0.9', 'private'],
  ['169.254.169.254', 'never'], ['::ffff:169.254.169.254', 'never'], ['::ffff:a9fe:a9fe', 'never'], ['[::ffff:a9fe:a9fe]', 'never'], ['::169.254.169.254', 'never'],
  ['64:ff9b::a9fe:a9fe', 'never'], ['2002:a9fe:a9fe::', 'never'], ['169.254.0.1', 'never'], ['fe80::1', 'never'], ['fe80::1%en0', 'never'], ['febf::1', 'never'],
  ['fd00:ec2::254', 'never'], ['0.0.0.0', 'never'], ['0.1.2.3', 'never'], ['::', 'never'], ['::ffff:0.0.0.0', 'never'],
  ['224.0.0.1', 'never'], ['239.255.255.255', 'never'], ['ff02::1', 'never'], ['255.255.255.255', 'never'], ['240.0.0.1', 'never'],
  ['192.0.2.1', 'never'], ['198.51.100.7', 'never'], ['203.0.113.9', 'never'], ['2001:db8::1', 'never'], ['198.18.0.1', 'never'], ['192.0.0.8', 'never'],
];

test('classifier: every spelling gets the verdict of the address it names', () => {
  for (const [addr, cls] of CASES) assert.equal(classifyIp(addr).class, cls, addr);
});

test('classifier: hostnames and junk are not IPs', () => {
  for (const t of ['example.com', 'localhost', '', 'a.b.c.d', '999.1.1.1', '1.2.3', 'g::1', '1:2:3:4:5:6:7:8:9']) assert.equal(classifyIp(t).ip, false, t);
});

test('ipRefusal: private only with the opt-in, never-class never', () => {
  assert.match(ipRefusal('127.0.0.1'), /loopback/);
  assert.equal(ipRefusal('127.0.0.1', { allowPrivate: true }), null);
  assert.match(ipRefusal('::ffff:169.254.169.254', { allowPrivate: true }), /never allowed/);
  assert.match(ipRefusal('fd00:ec2::254', { allowPrivate: true }), /never allowed/);
  assert.equal(ipRefusal('8.8.8.8'), null);
  assert.equal(ipRefusal('example.com'), null);
});

// What the WHATWG URL parser makes of the IPv4 spellings the classifier never sees raw.
const URL_FORMS = ['https://0x7f.0.0.1/v1', 'https://2130706433/v1', 'https://017700000001/v1', 'https://127.1/v1', 'https://0177.0.0.1/v1',
  'https://[::ffff:127.0.0.1]/v1', 'https://[::ffff:7f00:1]/v1', 'https://[0:0:0:0:0:ffff:7f00:1]/v1', 'https://[::127.0.0.1]/v1',
  'https://[::ffff:169.254.169.254]/v1', 'https://[::ffff:a9fe:a9fe]/v1', 'https://0xa9fe.0xa9fe/v1', 'https://2852039166/v1', 'https://0.0.0.0/v1',
  'https://100.64.0.1/v1', 'https://[fc00::1]/v1', 'https://[fd00:ec2::254]/v1', 'https://[fe80::1]/v1', 'https://[::]/v1', 'https://[2002:7f00:1::]/v1',
  'https://[64:ff9b::7f00:1]/v1', 'https://224.0.0.1/v1', 'https://255.255.255.255/v1', 'https://[ff02::1]/v1', 'https://192.0.2.1/v1'];

test('strict guard (both implementations) refuses every spelling of a non-public address', () => {
  for (const u of URL_FORMS) {
    assert.throws(() => assertProviderBaseUrl(u), undefined, `catalog guard: ${u}`);
    assert.throws(() => assertSafeBaseUrl(u), /SSRF guard/, `legacy guard: ${u}`);
  }
});

test('private opt-in allows only the private class; link-local and metadata stay refused in every spelling', () => {
  for (const ok of ['http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1', 'http://[::ffff:127.0.0.1]:8080/v1', 'http://2130706433:8080/v1',
    'http://100.64.0.1/v1', 'http://[fd12::1]/v1', 'http://192.168.1.5/v1', 'https://gateway.local/v1', 'http://localhost:11434/v1']) {
    assert.doesNotThrow(() => assertProviderBaseUrl(ok, { allowPrivate: true }), ok);
  }
  for (const bad of ['http://169.254.169.254/v1', 'http://[::ffff:169.254.169.254]/v1', 'http://[::ffff:a9fe:a9fe]/v1', 'http://[fd00:ec2::254]/v1',
    'http://[fe80::1]/v1', 'http://0.0.0.0:11434/v1', 'http://224.0.0.1/v1', 'http://[::]/v1', 'https://169.254.169.254/v1', 'http://2852039166/v1']) {
    assert.throws(() => assertProviderBaseUrl(bad, { allowPrivate: true }), undefined, bad);
  }
  // http only to a private target
  assert.throws(() => assertProviderBaseUrl('http://api.example.com/v1', { allowPrivate: true }));
  assert.throws(() => assertProviderBaseUrl('http://8.8.8.8/v1', { allowPrivate: true }));
});

test('a query or fragment cannot ride in a base URL (the "#" suffix trick)', () => {
  for (const u of ['https://api.example.com/v1#', 'https://api.example.com/v1#x', 'https://api.example.com/v1?x=1', 'https://api.example.com/v1?', 'https://api.example.com#/v1']) {
    assert.throws(() => assertProviderBaseUrl(u), /query string or fragment/, u);
    assert.throws(() => assertSafeBaseUrl(u), /query string or fragment/, u);
  }
  assert.equal(joinBaseUrl('https://api.example.com/v1', 'models'), 'https://api.example.com/v1/models');
  assert.equal(joinBaseUrl('https://api.example.com/v1/', '/models'), 'https://api.example.com/v1/models');
  // even if one slipped through, the joined URL keeps the path and drops the rest
  assert.equal(joinBaseUrl('https://api.example.com/v1?x=1#frag', 'models'), 'https://api.example.com/v1/models');
});

test('operator gate: explicit env wins; unset follows the bind', () => {
  assert.equal(privateProvidersAllowed({ LLMIDE_ALLOW_PRIVATE_PROVIDERS: '1' }), true);
  assert.equal(privateProvidersAllowed({ LLMIDE_ALLOW_PRIVATE_PROVIDERS: '0' }), false);
  assert.equal(privateProvidersAllowed({}), true, 'this test process is bound locally (no LLMIDE_ALLOW_REMOTE)');
});
