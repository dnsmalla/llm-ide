// GitLab client on the fake gitlab.com: projects (bad rows dropped), tree paging, submodules skipped, raw files by
// preview kind, blob search, web URLs, and the token in every request. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSources } from './helpers/fake-sources.mjs';
import { createGitLabClient, parseProject } from '../src/sources/gitlab.ts';

const setup = () => { const fake = createFakeSources(); const auth = { token: async () => fake.tokens.gitlab, refresh: async () => null };
  return { fake, c: createGitLabClient(auth, { fetchImpl: fake.fetchImpl, sleep: async () => {} }) }; };

test('projects: membership list, invalid or foreign rows dropped, empty project marked', async () => {
  const { fake, c } = setup();
  const page = await c.list(null, null);
  assert.deepEqual(page.entries.map((e) => e.path), ['dee/demo', 'dee/empty']);
  assert.equal(page.entries[1].detail, 'Empty project');
  assert.equal(page.next, null);
  const u = new URL(fake.calls[0].url);
  assert.equal(u.searchParams.get('membership'), 'true');
  assert.equal(fake.calls[0].headers.Authorization, 'Bearer gitlab-access-1');
  assert.equal(parseProject({ id: 1, name: 'x', path_with_namespace: 'a/x', web_url: 'http://gitlab.com/a/x' }), null);
  assert.deepEqual((await c.list(page.entries[1], null)).entries, [], 'no default branch: nothing to list, no request');
});

test('tree: pages through X-Next-Page, skips submodules, descends into folders', async () => {
  const { c } = setup();
  const [demo] = (await c.list(null, null)).entries;
  const p1 = await c.list(demo, null);
  assert.deepEqual(p1.entries.map((e) => [e.name, e.kind]), [['src', 'dir'], ['README.md', 'file']]);
  assert.equal(p1.next, '2');
  const p2 = await c.list(demo, p1.next);
  assert.deepEqual(p2.entries.map((e) => e.name), ['logo.png', 'big.txt', 'doc.pdf']);
  const src = await c.list(p1.entries[0], null);
  assert.deepEqual(src.entries.map((e) => e.path), ['src/app.ts']);
  assert.equal(src.entries[0].id, '7:src/app.ts');
});

test('open: code and markdown as text, binary refused, over-cap text truncated, pdf bytes; raw path is encoded', async () => {
  const { fake, c } = setup();
  const [demo] = (await c.list(null, null)).entries;
  const root = [...(await c.list(demo, null)).entries, ...(await c.list(demo, '2')).entries];
  const src = (await c.list(root[0], null)).entries[0];
  const app = await c.open(src);
  assert.equal(app.kind, 'code'); assert.equal(app.language, 'typescript'); assert.equal(app.text, 'export const x = 1;\n');
  assert.match(fake.calls.at(-1).url, /\/repository\/files\/src%2Fapp\.ts\/raw\?ref=main$/);
  const readme = await c.open(root.find((e) => e.name === 'README.md'));
  assert.equal(readme.kind, 'markdown'); assert.match(readme.text, /<script>/, 'kept as text; the screen renders it as text');
  assert.equal((await c.open(root.find((e) => e.name === 'logo.png'))).reason, 'type');
  const big = await c.open(root.find((e) => e.name === 'big.txt'));
  assert.equal(big.truncated, true); assert.equal(big.text.length, 1_048_576);
  const pdf = await c.open(root.find((e) => e.name === 'doc.pdf'));
  assert.equal(pdf.kind, 'pdf'); assert.ok(pdf.bytes instanceof Uint8Array);
  assert.equal(c.webUrl(src), 'https://gitlab.com/dee/demo/-/blob/main/src/app.ts');
  assert.equal(c.webUrl(root[0]), 'https://gitlab.com/dee/demo/-/tree/main/src');
});

test('search: projects at the root, blobs inside a project (deduplicated, snippet kept as text)', async () => {
  const { fake, c } = setup();
  assert.deepEqual((await c.search('dem', null)).entries.map((e) => e.path), ['dee/demo']);
  const [demo] = (await c.list(null, null)).entries;
  const hits = await c.search(' x ', demo);
  assert.deepEqual(hits.entries.map((e) => [e.path, e.detail]), [['src/app.ts', 'export const x = 1;']]);
  const u = new URL(fake.calls.at(-1).url);
  assert.equal(u.searchParams.get('scope'), 'blobs'); assert.equal(u.searchParams.get('search'), 'x');
  await assert.rejects(c.search('', demo), (e) => e.code === 'bad_query');
});

test('only GET requests reach the API', async () => {
  const { fake, c } = setup();
  const [demo] = (await c.list(null, null)).entries;
  await c.list(demo, null); await c.search('x', demo);
  assert.ok(fake.calls.every((k) => k.method === 'GET'));
});
