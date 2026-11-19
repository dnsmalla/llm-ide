// Remembered facts checked against the code (graphkit/memory-check.mjs): a fact whose cited files are all gone is
// flagged, ranked last and labelled; nothing is ever removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const { citedPaths, staleFactChecker, STALE_NOTE } = await import('../graphkit/memory-check.mjs');
const { selectChatMemoryFacts } = await import('../graphkit/memory.mjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memcheck-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, 'src', 'kb'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'kb', 'db.ts'), '');
fs.mkdirSync(path.join(root, 'system'), { recursive: true });
fs.writeFileSync(path.join(root, 'system', 'project.json'), '{}');
fs.mkdirSync(path.join(root, 'code', 'app', 'lib'), { recursive: true });
fs.writeFileSync(path.join(root, 'code', 'app', 'lib', 'util.py'), '');

test('citedPaths finds file paths and nothing else', () => {
  assert.deepEqual(citedPaths('[db] Migrations live in `src/kb/db.ts:42` and src/kb/old.ts.'), ['src/kb/db.ts', 'src/kb/old.ts']);
  assert.deepEqual(citedPaths('Uses a client/server split and/or REST; see https://example.com/a/b.html (v1.2/3).'), []);
  assert.deepEqual(citedPaths('Never touch ../outside/secret.env or /etc/passwd.conf'), [], 'no escapes, no absolute paths');
  assert.deepEqual(citedPaths('Tests run with pnpm test'), []);
});

test('a fact is stale only when every file it cites is gone', () => {
  const isStale = staleFactChecker(root);
  assert.equal(isStale('Migrations live in src/kb/db.ts'), false, 'the file exists');
  assert.equal(isStale('The importer is src/kb/importer.ts'), true, 'the only cited file is gone');
  assert.equal(isStale('Moved from src/kb/legacy.ts to src/kb/db.ts'), false, 'one cited file still exists');
  assert.equal(isStale('Helpers are in lib/util.py'), false, 'found in a repo under code/');
  assert.equal(isStale('Tests run with pnpm test'), false, 'a fact with no path is never flagged');
  assert.equal(staleFactChecker('')('x src/a.ts'), false);
});

test('in the prompt a stale fact goes last and says so; the others are untouched', () => {
  const content = '# Chat memory\n- The importer is src/kb/importer.ts\n- Migrations live in src/kb/db.ts\n- Tests run with pnpm test\n';
  const out = selectChatMemoryFacts(content, { userMessage: 'where is the importer?', room: 4000, isStale: staleFactChecker(root) }).split('\n');
  assert.equal(out.length, 3);
  assert.equal(out.at(-1), `- The importer is src/kb/importer.ts${STALE_NOTE}`, 'most relevant to the question, yet last: it is probably wrong');
  assert.ok(out.slice(0, 2).every((l) => !l.includes('may be outdated')));
  // Without a checker nothing changes.
  assert.ok(!selectChatMemoryFacts(content, { userMessage: 'importer', room: 4000 }).includes('may be outdated'));
});
