import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, fetchUrl } from '../agents/web-client.mjs';

test('searchWeb: throws on missing API key', async () => {
  await assert.rejects(
    () => searchWeb('test'),
    /SerpAPI key required/
  );
});

test('searchWeb: throws on empty query', async () => {
  await assert.rejects(
    () => searchWeb('', { apiKey: 'test' }),
    /non-empty string/
  );
});

test('fetchUrl: throws on invalid URL', async () => {
  await assert.rejects(
    () => fetchUrl('not a url'),
    /Invalid URL/
  );
});

test('fetchUrl: throws on empty URL', async () => {
  await assert.rejects(
    () => fetchUrl(''),
    /non-empty string/
  );
});
