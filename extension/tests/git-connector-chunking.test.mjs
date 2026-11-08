// Pure ingest helpers for the local-repo connector. chunkLines produces
// the line-range titles (`<rel>:start-end`) the agent later reads back via
// codegen, so off-by-one ranges would point the model at the wrong lines;
// isProbablyBinary gates what reaches the KB at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkLines, isProbablyBinary } from '../connectors/git.mjs';

const CHUNK = 80;       // CHUNK_LINES in git.mjs
const MAX_CHUNKS = 20;  // MAX_CHUNKS_PER_FILE in git.mjs

test('chunkLines: short file is a single 1-based chunk', () => {
  const out = chunkLines('a\nb\nc');
  assert.equal(out.length, 1);
  assert.equal(out[0].startLine, 1);
  assert.equal(out[0].endLine, 3);
  assert.equal(out[0].body, 'a\nb\nc');
});

test('chunkLines: splits on CHUNK_LINES boundaries with contiguous ranges', () => {
  const text = Array.from({ length: CHUNK + 5 }, (_, i) => `L${i + 1}`).join('\n');
  const out = chunkLines(text);
  assert.equal(out.length, 2);
  assert.deepEqual(
    [out[0].startLine, out[0].endLine],
    [1, CHUNK],
  );
  assert.deepEqual(
    [out[1].startLine, out[1].endLine],
    [CHUNK + 1, CHUNK + 5],
  );
});

test('chunkLines: caps at MAX_CHUNKS_PER_FILE for huge files', () => {
  const text = Array.from({ length: CHUNK * (MAX_CHUNKS + 10) }, () => 'x').join('\n');
  const out = chunkLines(text);
  assert.equal(out.length, MAX_CHUNKS);
});

test('chunkLines: handles CRLF line endings', () => {
  const out = chunkLines('a\r\nb\r\nc');
  assert.equal(out.length, 1);
  assert.equal(out[0].endLine, 3);
  assert.equal(out[0].body, 'a\nb\nc'); // normalized to \n
});

test('isProbablyBinary: plain text is not binary', () => {
  assert.equal(isProbablyBinary(Buffer.from('hello world\nconst x = 1;')), false);
});

test('isProbablyBinary: a NUL byte marks it binary', () => {
  assert.equal(isProbablyBinary(Buffer.from([0x68, 0x69, 0x00, 0x21])), true);
});

test('isProbablyBinary: only samples the first N bytes', () => {
  // NUL beyond the sample window is not detected.
  const buf = Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from([0x00])]);
  assert.equal(isProbablyBinary(buf, 10), false);
});

test('C6: a 3,000-line file is indexed with truncated: true and counted in the result', async () => {
  const { indexLocalRepo, isTruncatedText } = await import('../connectors/git.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-trunc-'));
  const file = path.join(dir, 'big.mjs');
  fs.writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`).join('\n'));
  fs.writeFileSync(path.join(dir, 'small.mjs'), 'const a = 1;');
  const { getDb } = await import('../kb/db.mjs');
  getDb().prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u-trunc','t@e.st','T','x','user','active')").run();
  try {
    const out = await indexLocalRepo('u-trunc', dir, { walk: async function* () { yield file; yield path.join(dir, 'small.mjs'); } });
    assert.equal(out.truncatedFiles, 1);
    assert.equal(isTruncatedText(fs.readFileSync(file, 'utf8')), true);
    assert.equal(out.chunks, 21, 'the big file contributes 20 chunks, the small one 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
