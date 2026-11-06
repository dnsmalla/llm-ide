// Box client on the fake Box API: folders (web links dropped), page-length paging, content by preview kind, extracted
// text with one pending poll, missing text, search paths, web URLs. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSources } from './helpers/fake-sources.mjs';
import { createBoxClient, parseBoxEntry } from '../src/sources/box.ts';

const setup = () => { const fake = createFakeSources(); const slept = [];
  const auth = { token: async () => fake.tokens.box, refresh: async () => null };
  return { fake, slept, c: createBoxClient(auth, { fetchImpl: fake.fetchImpl, sleep: async (ms) => { slept.push(ms); } }) }; };
const dir = (id, name = 'Folder', path = name) => ({ id, name, kind: 'dir', path, size: null, detail: null, project: null });
const file = (id, name, path = name) => ({ id, name, kind: 'file', path, size: null, detail: null, project: null });

test('folders: root is 0, web links and bad ids dropped, paths built from the trail', async () => {
  const { fake, c } = setup();
  const root = await c.list(null, null);
  assert.deepEqual(root.entries.map((e) => [e.name, e.kind, e.size]), [['Specs', 'dir', null], ['notes.md', 'file', 8]]);
  assert.equal(root.next, null);
  assert.match(fake.calls[0].url, /\/2\.0\/folders\/0\/items\?fields=id,type,name,size,modified_at,extension&limit=100&offset=0$/);
  const specs = await c.list(root.entries[0], null);
  assert.equal(specs.entries[0].path, 'Specs/plan.docx');
  assert.equal(parseBoxEntry({ type: 'file', id: '../1', name: 'x' }, ''), null);
  await assert.rejects(c.list(dir('1/../2'), null), (e) => e.code === 'bad_response');
});

test('paging: a full page of 100 means more; the next page continues the offset', async () => {
  const { c } = setup();
  const p1 = await c.list(dir('12'), null);
  assert.equal(p1.entries.length, 100); assert.equal(p1.next, '100');
  const p2 = await c.list(dir('12'), p1.next);
  assert.equal(p2.entries.length, 3); assert.equal(p2.next, null);
});

test('open: markdown content, pdf bytes, binary refused, Office via extracted text after one poll, missing text', async () => {
  const { fake, slept, c } = setup();
  const md = await c.open(file('21', 'notes.md'));
  assert.equal(md.kind, 'markdown'); assert.equal(md.text, '# Notes\n');
  assert.equal((await c.open(file('23', 'deck.pdf'))).bytes.length, 9);
  assert.equal((await c.open(file('24', 'raw.txt'))).reason, 'binary');
  const plan = await c.open(file('22', 'plan.docx', 'Specs/plan.docx'));
  assert.equal(plan.kind, 'extracted'); assert.equal(plan.text, 'Plan text from Box');
  assert.ok(slept.includes(1500), 'waited once for the pending representation');
  const info = fake.calls.find((k) => k.url.includes('/2.0/files/22?fields=representations'));
  assert.equal(info.headers['X-Rep-Hints'], '[extracted_text]');
  assert.ok(fake.calls.some((k) => k.url.startsWith('https://dl.boxcloud.com/')));
  const scan = await c.open(file('25', 'scan.docx'));
  assert.equal(scan.reason, 'no_text'); assert.equal(scan.kind, 'unsupported');
  assert.equal(c.webUrl(file('22', 'plan.docx')), 'https://app.box.com/file/22');
  assert.equal(c.webUrl(dir('11')), 'https://app.box.com/folder/11');
});

test('search: files only, path from path_collection without "All Files", scoped to the open folder', async () => {
  const { fake, c } = setup();
  const r = await c.search('plan', dir('11', 'Specs'));
  assert.deepEqual(r.entries.map((e) => e.path), ['Specs/plan.docx']);
  const u = new URL(fake.calls.at(-1).url);
  assert.equal(u.searchParams.get('type'), 'file');
  assert.equal(u.searchParams.get('ancestor_folder_ids'), '11');
  await c.search('plan', null);
  assert.equal(new URL(fake.calls.at(-1).url).searchParams.has('ancestor_folder_ids'), false);
});

test('a 202 "not ready" answer is retried with Retry-After, then reported', async () => {
  const { fake, c } = setup();
  const notReady = () => new Response('', { status: 202, headers: { 'retry-after': '2' } });
  fake.queue('https://api.box.com/2.0/files/21/content', notReady, notReady, notReady);
  await assert.rejects(c.open(file('21', 'notes.md')), (e) => e.code === 'not_ready');
});
