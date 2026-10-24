import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// rateLimitProfile is module-private in server.mjs (importing it would boot
// the server), so lift its source and evaluate it standalone.
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
const start = src.indexOf('function rateLimitProfile(');
const end = src.indexOf('\n}\n', start) + 2;
const rateLimitProfile = new Function(`${src.slice(start, end)}; return rateLimitProfile;`)();

test('POST profiles match with a query string appended', () => {
  for (const p of ['/kb/loop/agent-run', '/code-assist', '/agent/v2/stream']) {
    assert.equal(rateLimitProfile(p, 'POST'), 'agentTurn', p);
    assert.equal(rateLimitProfile(`${p}?x=1`, 'POST'), 'agentTurn', `${p}?x=1`);
  }
  assert.equal(rateLimitProfile('/kb/dispatch?a=b', 'POST'), 'dispatch');
  assert.equal(rateLimitProfile('/kb/export-all?x=1', 'GET'), 'kbExport');
});
