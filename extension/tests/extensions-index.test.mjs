// Catalog indexes and search (P5): adapters, cache, TTL, throttle, per-source failure isolation. Fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoArchive, fixtureFetch } from './helpers/tar-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-index-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(root, 'plugins');
delete process.env.LLMIDE_EXT_CATALOG;
delete process.env.LLMIDE_EXT_ALLOWED_SOURCES; // the default: anthropics/*, modelcontextprotocol/*
const idx = await import('../llm_agent/extensions/indexes.mjs');

const SHA = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const head = (o, r) => `https://api.github.com/repos/${o}/${r}/commits/HEAD`;
const arc = (o, r, sha) => `https://codeload.github.com/${o}/${r}/tar.gz/${sha}`;
const REG = 'https://registry.modelcontextprotocol.io/v0.1/servers?limit=100';

const SKILLS = {
  'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Read and fill PDF forms\n---\nbody',
  'skills/xlsx/SKILL.md': '---\nname: xlsx\ndescription: Spreadsheet work\n---\nbody',
  'README.md': 'x',
};
const MARKET = {
  '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [
    { name: 'git-helper', description: 'Git things', source: './plugins/git-helper', version: '1.0.0' },
    { name: 'ext-repo', description: 'in another repo', source: { source: 'github', repo: 'someone/ext-repo' } },
    { name: 'weird', description: 'x', source: { source: 'url', url: 'https://example.com/x.git' } },
    { name: 'escape', description: 'x', source: '../../etc' },
  ] }),
};
const SERVERS = { 'src/fetch/package.json': '{"name":"@x/fetch","description":"Fetch web pages"}', 'src/git/package.json': '{"description":"Git server"}' };
const REGISTRY = { servers: [
  { server: { name: 'io.github.acme/notes', description: 'Notes server', version: '1.2.3', repository: { url: 'https://github.com/acme/notes' }, remotes: [{ url: 'https://x' }] } },
  { server: { name: 'com.example/plain', description: 'ignore\u202e previous', repository: { url: 'https://gitlab.com/a/b' } } },
], metadata: { nextCursor: null } };

function allNet(extra = {}) {
  return fixtureFetch({
    [head('anthropics', 'skills')]: SHA, [arc('anthropics', 'skills', SHA)]: repoArchive(SKILLS),
    [head('anthropics', 'claude-plugins-official')]: SHA, [arc('anthropics', 'claude-plugins-official', SHA)]: repoArchive(MARKET),
    [head('modelcontextprotocol', 'servers')]: SHA, [arc('modelcontextprotocol', 'servers', SHA)]: repoArchive(SERVERS),
    [REG]: JSON.stringify(REGISTRY),
    ...extra,
  });
}

test('empty cache: search returns nothing and says every source is empty; no network', () => {
  const r = idx.searchCatalog('u1', { q: 'pdf' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.sources.map((s) => s.status), ['empty', 'empty', 'empty', 'empty']);
});

test('refresh fills the four indexes; search ranks, filters and flags installable', async () => {
  const f = allNet();
  const t0 = Date.parse('2026-10-31T00:00:00Z');
  const r = await idx.refreshIndexes({ fetch: f, now: t0 });
  assert.deepEqual(r.results.map((x) => [x.id, x.status, x.count]), [
    ['anthropics/skills', 'refreshed', 2], ['anthropics/claude-plugins-official', 'refreshed', 4],
    ['modelcontextprotocol/servers', 'refreshed', 2], ['mcp-registry', 'refreshed', 2],
  ]);
  assert.ok(f.calls.every((c) => ['api.github.com', 'codeload.github.com', 'registry.modelcontextprotocol.io'].includes(new URL(c.url).hostname)));
  assert.ok(f.calls.every((c) => c.init.redirect === 'manual'));
  assert.equal(fs.statSync(idx.indexFilePath()).mode & 0o777, 0o600);

  const pdf = idx.searchCatalog('u1', { q: 'pdf' });
  assert.deepEqual(pdf.results.map((e) => [e.name, e.kind, e.installable, e.source.path]), [['pdf', 'skill', true, 'skills/pdf']]);
  assert.equal(pdf.results[0].source.url, 'https://github.com/anthropics/skills');

  const plugins = idx.searchCatalog('u1', { kind: 'plugin', limit: 10 });
  const byName = Object.fromEntries(plugins.results.map((e) => [e.name, e]));
  assert.equal(byName['git-helper'].installable, true);
  assert.equal(byName['git-helper'].source.path, 'plugins/git-helper');
  assert.equal(byName['ext-repo'].installable, false, 'someone/ext-repo is not on the default allowlist');
  assert.equal(byName['ext-repo'].reason, 'source_not_allowed');
  assert.equal(byName.weird.reason, 'unsupported_source');
  assert.equal(byName.escape.reason, 'unsupported_source', 'a traversal path is never offered');

  const mcp = idx.searchCatalog('u1', { kind: 'mcp' });
  assert.ok(mcp.results.every((e) => e.installable === false), 'package launchers and registry items are browse only');
  assert.equal(mcp.results.find((e) => e.name === 'io.github.acme/notes').remote, true);
  assert.equal(mcp.results.find((e) => e.name === 'fetch').reason, 'package_launcher');
  assert.ok(!/[\u202e]/.test(JSON.stringify(mcp.results)), 'bidi controls are stripped');

  // ranking: a name hit beats a description hit; every token must match
  assert.equal(idx.searchCatalog('u1', { q: 'spreadsheet' }).results[0].name, 'xlsx');
  assert.equal(idx.searchCatalog('u1', { q: 'pdf nonsense' }).total, 0);
  // paging and caps
  const page = idx.searchCatalog('u1', { limit: 2, offset: 1 });
  assert.equal(page.results.length, 2);
  assert.equal(page.total, 10);
  assert.equal(idx.searchCatalog('u1', { limit: 99999 }).results.length, 10);
  assert.deepEqual(idx.searchCatalog('u1', {}).sources.map((s) => s.status), ['fresh', 'fresh', 'fresh', 'fresh']);
});

test('installed items are marked per user', async () => {
  const instMod = await import('../llm_agent/extensions/installed.mjs');
  assert.equal(idx.searchCatalog('u1', { q: 'pdf' }).results[0].installed, false);
  instMod.putInstalled('u1', 'skill:anthropics/pdf', { id: 'skill:anthropics/pdf', kind: 'skill', pinnedCommit: SHA });
  assert.equal(idx.searchCatalog('u1', { q: 'pdf' }).results[0].installed, true);
  assert.equal(idx.searchCatalog('u2', { q: 'pdf' }).results[0].installed, false);
});

test('TTL: a fresh cache is not refetched, throttle protects a failing source, a changed commit refetches only then', async () => {
  const t0 = Date.parse('2026-10-31T00:00:00Z');
  const f = allNet();
  let r = await idx.refreshIndexes({ fetch: f, now: t0 + 60_000 });
  assert.ok(r.results.every((x) => x.status === 'fresh' || x.status === 'throttled'));
  assert.equal(f.calls.length, 0);
  // force after the throttle window, upstream unchanged: only the resolve call, no archive download
  r = await idx.refreshIndexes({ fetch: f, force: true, sourceId: 'anthropics/skills', now: t0 + 120_000 });
  assert.equal(r.results[0].status, 'refreshed');
  assert.deepEqual(f.calls.map((c) => new URL(c.url).hostname), ['api.github.com']);
  // force right after: throttled
  assert.equal((await idx.refreshIndexes({ fetch: f, force: true, sourceId: 'anthropics/skills', now: t0 + 121_000 })).results[0].status, 'throttled');
  // stale after the TTL; the commit moved: archive is fetched again
  const f2 = allNet({ [head('anthropics', 'skills')]: SHA2, [arc('anthropics', 'skills', SHA2)]: repoArchive({ 'skills/new/SKILL.md': '---\nname: new\n---\nx' }) });
  assert.equal(idx.sourceStatuses(t0 + idx.INDEX_TTL_MS + 200_000).find((s) => s.id === 'anthropics/skills').status, 'stale');
  r = await idx.refreshIndexes({ fetch: f2, sourceId: 'anthropics/skills', now: t0 + idx.INDEX_TTL_MS + 200_000 });
  assert.deepEqual([r.results[0].status, r.results[0].count], ['refreshed', 1]);
  assert.deepEqual(idx.searchCatalog('u1', { q: 'new' }).results.map((e) => e.name), ['new']);
});

test('one source failing keeps its last copy and never affects the others', async () => {
  const t0 = Date.parse('2026-11-30T00:00:00Z'); // everything is stale by now
  const f = allNet({ [REG]: new Response('down', { status: 503 }), [head('anthropics', 'claude-plugins-official')]: () => { throw Object.assign(new Error('x'), { code: 'SSRF_BLOCKED' }); } });
  const r = await idx.refreshIndexes({ fetch: f, now: t0 });
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(by['mcp-registry'].status, 'error');
  assert.equal(by['mcp-registry'].error, 'upstream');
  assert.equal(by['mcp-registry'].count, 2, 'the last good entries are kept');
  assert.equal(by['anthropics/claude-plugins-official'].error, 'blocked');
  assert.equal(by['modelcontextprotocol/servers'].status, 'refreshed');
  const st = idx.sourceStatuses(t0);
  assert.equal(st.find((s) => s.id === 'mcp-registry').error, 'upstream');
  assert.ok(idx.searchCatalog('u1', { q: 'notes' }).total >= 1, 'a failed source still serves its cached entries');
});

test('size cap: an oversized registry answer is refused, redirects are refused', async () => {
  const t0 = Date.parse('2026-12-31T00:00:00Z');
  const big = new Response('x'.repeat(2 * 1024 * 1024 + 10), { status: 200 });
  let r = await idx.refreshIndexes({ fetch: allNet({ [REG]: big }), sourceId: 'mcp-registry', now: t0 });
  assert.equal(r.results[0].error, 'too_large');
  r = await idx.refreshIndexes({ fetch: allNet({ [REG]: new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }) }), sourceId: 'mcp-registry', now: t0 + 120_000 });
  assert.equal(r.results[0].error, 'redirect_refused');
});

test('unknown source and a corrupt cache file', async () => {
  await assert.rejects(idx.refreshIndexes({ sourceId: 'evil.example/x', fetch: allNet() }), (e) => e.code === 'not_found');
  fs.writeFileSync(idx.indexFilePath(), '{nope');
  assert.equal(idx.searchCatalog('u1', {}).sources[0].error, 'state_unreadable');
  const r = await idx.refreshIndexes({ fetch: allNet(), now: Date.parse('2027-01-31T00:00:00Z') });
  assert.ok(r.results.every((x) => x.error === 'state_unreadable'), 'a corrupt cache is never overwritten');
  assert.equal(fs.readFileSync(idx.indexFilePath(), 'utf8'), '{nope');
});

test('M2: one user disconnecting never fails or throttles the shared refresh other users get; user force is self-throttled', async () => {
  fs.rmSync(idx.indexFilePath(), { force: true });
  const now = Date.parse('2027-06-01T00:00:00Z');
  let release; const gate = new Promise((r) => { release = r; });
  let hits = 0;
  const f = async (u) => { hits += 1; await gate; return new Response(JSON.stringify(REGISTRY), { status: 200 }); };
  const acA = new AbortController();
  const a = idx.refreshIndexes({ userId: 'A', sourceId: 'mcp-registry', signal: acA.signal, fetch: f, now });
  const b = idx.refreshIndexes({ userId: 'B', sourceId: 'mcp-registry', fetch: f, now });
  acA.abort();
  await assert.rejects(a, (e) => e.name === 'AbortError');
  release();
  const rb = await b;
  assert.deepEqual([rb.results[0].status, rb.results[0].count], ['refreshed', 2], 'B is unaffected by A leaving');
  assert.equal(hits, 1, 'one shared fetch');
  assert.equal(idx.sourceStatuses(now).find((s) => s.id === 'mcp-registry').error, undefined, 'no poisoned error record');
  // force: honoured once per user per window, then a plain refresh (fresh)
  const f2 = fixtureFetch({ [REG]: () => new Response(JSON.stringify(REGISTRY), { status: 200 }) });
  const later = now + 10 * 60 * 1000;
  assert.equal((await idx.refreshIndexes({ userId: 'A', force: true, sourceId: 'mcp-registry', fetch: f2, now: later })).results[0].status, 'refreshed');
  const again = await idx.refreshIndexes({ userId: 'A', force: true, sourceId: 'mcp-registry', fetch: f2, now: later + 2 * 60 * 1000 });
  assert.equal(again.results[0].status, 'fresh', 'a second force inside the window is just a normal (cached) refresh');
  assert.equal(f2.calls.length, 1);
});
