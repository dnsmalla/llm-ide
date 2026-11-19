// /extract-entities: a quote the model returns must really be in the transcript (server/ai-routes.mjs quoteIsFrom).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const { quoteIsFrom } = await import('../server/ai-routes.mjs');
const transcript = 'alice: we ship the  importer on\nfriday.  bob: 了解です、金曜に出します。'.toLowerCase().replace(/\s+/g, ' ').trim();

test('a real fragment passes whatever its case, spacing, wrapping quotes or trailing ellipsis', () => {
  for (const q of ['we ship the importer on Friday', '"We ship the importer"', 'ship   the\nimporter on friday…', '「了解です、金曜に出します」', 'importer on fri...']) {
    assert.equal(quoteIsFrom(transcript, q), true, q);
  }
});

test('an invented or reworded quote, and an empty one, do not pass', () => {
  for (const q of ['we ship the exporter on Friday', 'Alice promised Friday', '', '   ', '…']) {
    assert.equal(quoteIsFrom(transcript, q), false, JSON.stringify(q));
  }
});
