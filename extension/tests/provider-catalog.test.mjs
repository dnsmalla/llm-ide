// Catalog data, capability flags and the base-URL guard. Pure: no DB, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogEntries, catalogEntry, isChatModel, modelCapability, TOOL_MODES } from '../server/provider-catalog.mjs';
import { assertProviderBaseUrl } from '../server/base-url-guard.mjs';

const WANT = ['openai', 'google', 'mistral', 'groq', 'deepseek', 'openrouter', 'xai', 'cerebras', 'together', 'ollama', 'openai-compatible'];

test('the catalog lists every provider the plan names, once each', () => {
  const ids = catalogEntries().map((e) => e.id);
  assert.deepEqual([...ids].sort(), [...WANT].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('every hosted entry has an https base URL that passes the strict guard', () => {
  for (const e of catalogEntries()) {
    if (e.local || e.customBaseURL) continue;
    assert.doesNotThrow(() => assertProviderBaseUrl(e.baseURL), e.id);
    assert.ok(e.keyRequired, `${e.id} hosted entries need a key`);
  }
});

test('ollama is local and allowed on loopback only through its own entry', () => {
  const o = catalogEntry('ollama');
  assert.equal(o.local, true);
  assert.equal(o.keyRequired, false);
  assert.doesNotThrow(() => assertProviderBaseUrl(o.baseURL, { allowPrivate: true }));
  assert.throws(() => assertProviderBaseUrl(o.baseURL), /https|local or private/);
});

test('model capability: catalog, inferred, provider, override, unknown', () => {
  const groq = catalogEntry('groq');
  assert.deepEqual(
    (({ toolsSupported, toolsSource }) => ({ toolsSupported, toolsSource }))(modelCapability(groq, 'llama-3.3-70b-versatile')),
    { toolsSupported: true, toolsSource: 'catalog' });
  assert.equal(modelCapability(groq, 'llama-3.1-70b-whatever').toolsSource, 'inferred');
  assert.equal(modelCapability(groq, 'some-new-thing').toolsSupported, false);
  assert.equal(modelCapability(groq, 'some-new-thing').toolsSource, 'unknown');
  assert.equal(modelCapability(groq, 'some-new-thing', { override: true }).toolsSupported, true);
  assert.equal(modelCapability(groq, 'llama-3.3-70b-versatile', { override: false }).toolsSupported, false);
  assert.equal(modelCapability(catalogEntry('openrouter'), 'x/y', { live: { toolsSupported: true, contextWindow: 9000 } }).toolsSource, 'provider');
  assert.equal(modelCapability(catalogEntry('openrouter'), 'x/y', { live: { toolsSupported: false } }).toolsSupported, false);
  assert.equal(modelCapability(groq, 'llama-3.3-70b-versatile').contextWindow, 131072);
  // a reasoning model the provider documents as tool-less stays tool-less
  assert.equal(modelCapability(catalogEntry('deepseek'), 'deepseek-reasoner').toolsSupported, false);
  assert.equal(modelCapability(groq, 'x').streaming, true);
});

test('isChatModel drops embeddings, speech and guard models', () => {
  assert.equal(isChatModel(catalogEntry('openai'), 'text-embedding-3-small'), false);
  assert.equal(isChatModel(catalogEntry('openai'), 'gpt-4o'), true);
  assert.equal(isChatModel(catalogEntry('groq'), 'whisper-large-v3'), false);
  assert.equal(isChatModel(catalogEntry('mistral'), 'mistral-embed'), false);
  assert.equal(isChatModel(catalogEntry('ollama'), 'nomic-embed-text'), false);
  assert.equal(isChatModel(catalogEntry('ollama'), ''), false);
});

test('tool-heavy modes are the ones that need tools', () => {
  for (const m of ['execute', 'plan', 'assist_plan', 'review']) assert.ok(TOOL_MODES.has(m));
  assert.ok(!TOOL_MODES.has('ask'));
});

test('base-url guard: strict posture', () => {
  assert.equal(assertProviderBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  for (const bad of ['http://api.example.com/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.1.2.3/v1',
    'https://192.168.0.5/v1', 'https://172.20.1.1/v1', 'https://[::1]/v1', 'https://user:pw@api.example.com/v1', 'not a url', 'ftp://x.com']) {
    assert.throws(() => assertProviderBaseUrl(bad), undefined, bad);
  }
});

test('base-url guard: private opt-in still refuses link-local and metadata addresses', () => {
  for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://192.168.1.20:3000/v1', 'https://gateway.local/v1', 'http://10.0.0.7/v1']) {
    assert.doesNotThrow(() => assertProviderBaseUrl(ok, { allowPrivate: true }), ok);
  }
  for (const bad of ['http://169.254.169.254/latest', 'https://169.254.1.1/v1', 'http://[fe80::1]/v1', 'http://0.0.0.0:11434/v1',
    'http://public.example.com/v1', 'http://user:pw@127.0.0.1/v1']) {
    assert.throws(() => assertProviderBaseUrl(bad, { allowPrivate: true }), undefined, bad);
  }
});
