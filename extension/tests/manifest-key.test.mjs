// The unpacked and store builds must share one Chrome extension ID: a manifest `key` pins it. The ID is the first
// 32 hex of SHA-256(SPKI), each digit mapped 0-f -> a-p (Chrome's extension-id rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'));
test('manifest key is a valid SPKI and produces the stable ID', () => {
  assert.equal(typeof manifest.key, 'string');
  const der = Buffer.from(manifest.key, 'base64');
  assert.ok(der.length > 200 && der.length < 1024, 'RSA public key DER');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  assert.equal([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''), 'ecojclccfoegmlffpiahbcenmkfhadlk');
});
