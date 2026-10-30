import { test } from 'node:test';
import assert from 'node:assert/strict';
const c = await import('../providers/compress.mjs');

const turn = (i, len = 50, role) => ({ role: role ?? (i % 2 ? 'assistant' : 'user'), content: `m${i} ${'x'.repeat(len)}` });

test('headTail keeps both ends and says what it cut; short text is untouched', () => {
  const s = `${'a'.repeat(5000)}${'z'.repeat(5000)}`;
  const t = c.headTail(s, 1000);
  assert.ok(t.length < 1100);
  assert.ok(t.startsWith('aaa') && t.endsWith('zzz'));
  assert.match(t, /9000 characters omitted/);
  assert.equal(c.headTail('short', 1000), 'short');
  assert.equal(c.headTail(undefined, 10), '');
});

test('stale trimming: old long messages are cut, the last turns are verbatim', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => turn(i, 5000));
  const r = c.compressHistory(msgs, { keepTurns: 3 });
  assert.equal(r.messages.length, 30);
  assert.ok(r.trimmed > 20);
  assert.ok(r.messages[0].content.length < 2200);
  assert.equal(r.messages.at(-1).content, msgs.at(-1).content, 'the newest turn is untouched');
  assert.equal(r.messages.at(-5).content, msgs.at(-5).content, 'the last three user turns (and what is between) stay whole');
  assert.ok(r.savedChars > 60_000);
});

test('identical long old messages collapse to a stub; short ones never do', () => {
  const dup = 'file contents '.repeat(80);
  const msgs = [{ role: 'user', content: dup }, { role: 'assistant', content: 'ok' }, { role: 'user', content: dup }, { role: 'assistant', content: 'ok' }, turn(4), turn(5)];
  const r = c.compressHistory(msgs, { keepTurns: 1 });
  assert.match(r.messages[2].content, /identical to an earlier user message/);
  assert.equal(r.messages[3].content, 'ok');
  assert.equal(r.deduped, 1);
});

test('secrets are redacted first, in and out of the protected window', () => {
  const key = 'sk-ant-api03-' + 'q'.repeat(40);
  const r = c.compressHistory([turn(0), { role: 'user', content: `here ${key}` }], { keepTurns: 1 });
  assert.ok(!JSON.stringify(r).includes(key));
});

test('keepTurns 0 treats everything as stale; garbage input is returned safely', () => {
  assert.equal(c.compressHistory(null).messages.length, 0);
  const r = c.compressHistory([turn(0, 5000), { role: 'user', content: 5 }, null], { keepTurns: 0 });
  assert.ok(r.messages[0].content.length < 2200);
  assert.equal(r.messages[1].content, 5);
  assert.equal(r.messages[2], null);
});

test('tools: a big result of a compressible tool keeps head and tail, a repeated identical call becomes a stub, an error is never stubbed', async () => {
  let calls = 0;
  const big = 'line\n'.repeat(5000);
  const tools = c.wrapToolsForCompression([
    { name: 'run-bash', description: 'd', parameters: { type: 'object' }, execute: async () => { calls += 1; return big; } },
    { name: 'find-code', description: 'd', parameters: {}, execute: async () => ({ error: 'nope' }) },
  ], { maxChars: 1000 });
  assert.deepEqual(tools.map((t) => t.name), ['run-bash', 'find-code']);
  const a = await tools[0].execute({ cmd: 'a' });
  assert.ok(a.length < 1200 && /omitted/.test(a));
  const b = await tools[0].execute({ cmd: 'a' });
  assert.match(b, /same output as your earlier run-bash call/);
  const other = await tools[0].execute({ cmd: 'b' });
  assert.ok(/omitted/.test(other), 'different arguments are a different call');
  assert.equal(calls, 3, 'the tool still ran; only what the model sees changed');
  assert.deepEqual(await tools[1].execute({}), { error: 'nope' });
  assert.deepEqual(await tools[1].execute({}), { error: 'nope' });
});

test('file-content tools are never cut or stubbed, only redacted', async () => {
  const body = 'const x = 1;\n'.repeat(3000);
  const [read, skill] = c.wrapToolsForCompression([
    { name: 'read-file', execute: async () => body },
    { name: 'load-skill', execute: async () => ({ content: body }) },
  ], { maxChars: 500 });
  assert.equal(await read.execute({ path: 'a' }), body);
  assert.equal(await read.execute({ path: 'a' }), body, 'a second identical read is NOT stubbed');
  assert.deepEqual(await skill.execute({}), { content: body });
  const key = 'sk-ant-api03-' + 'z'.repeat(40);
  const redacted = await read.execute({ path: 'b' }).then(() => null);
  void redacted;
  const [leaky] = c.wrapToolsForCompression([{ name: 'read-file', execute: async () => `token ${key}` }]);
  assert.ok(!String(await leaky.execute({})).includes(key), 'redacted even though not compressible');
});

test('object results are redacted and stay objects; unchanged ones are returned as they came', async () => {
  const key = 'sk-ant-api03-' + 'q'.repeat(40);
  const [t] = c.wrapToolsForCompression([{ name: 'find-code', execute: async (i) => (i.leak ? { hits: [{ line: `k=${key}` }] } : { hits: [] }) }]);
  const out = await t.execute({ leak: true });
  assert.equal(typeof out, 'object');
  assert.ok(!JSON.stringify(out).includes(key));
  const clean = { hits: [] };
  const [u] = c.wrapToolsForCompression([{ name: 'find-code', execute: async () => clean }]);
  assert.equal(await u.execute({}), clean);
});

test('the repeat stub only applies while the first full result is still recent context', async () => {
  const big = 'abc '.repeat(200);   // 800 chars: over the stub minimum
  const [t] = c.wrapToolsForCompression([{ name: 'web-search', execute: async (i) => (i.filler ? 'x'.repeat(30_000) : big) }], { window: 5_000 });
  assert.equal(await t.execute({ q: 1 }), big);
  assert.match(await t.execute({ q: 1 }), /same output/);
  await t.execute({ filler: true });     // lots of other output lands in between
  assert.equal(await t.execute({ q: 1 }), big, 'the earlier result has left the window: send it in full again');
});

test('changed content for the same arguments is never stubbed', async () => {
  let n = 0;
  const [t] = c.wrapToolsForCompression([{ name: 'fetch-url', execute: async () => `page version ${n += 1} ${'y'.repeat(600)}` }]);
  const a = await t.execute({ url: 'u' });
  const b = await t.execute({ url: 'u' });
  assert.notEqual(a, b);
  assert.ok(!/same output/.test(b));
});

test('a small structured result passes through unchanged', async () => {
  const [t] = c.wrapToolsForCompression([{ name: 'find-code', execute: async () => ({ ok: true, n: 3 }) }]);
  assert.deepEqual(await t.execute({}), { ok: true, n: 3 });
});
