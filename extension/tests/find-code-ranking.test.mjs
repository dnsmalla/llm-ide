import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_find-code-ranking-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { searchCodeIndex, queryTerms, stemToken, seedCandidates } = await import('../graphkit/index.mjs');

const U = users.registerUser(db.getDb(), { email: `rk-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'r' }).id;
const REPO = '/r/app';
const n = (file, title, kind = 'function', line = 1) =>
  ({ id: `${kind}:${file}:${title}`, title, kind, metadata: { source_file: file, line: `L${line}` } });

test.before(() => {
  db.writeCodeGraph(U, REPO, { nodes: [
    n('mac/Mobile/MobilePin.swift', 'MobilePin', 'classType', 5),
    n('mac/Mobile/MobilePin.swift', 'rotateInMemory', 'function', 111),
    n('mac/Mobile/PairingThrottle.swift', 'PairingThrottle', 'classType', 3),
    n('mac/Mobile/PairingInfo.swift', 'PairingInfo', 'classType', 3),
    n('mac/Mobile/PairingView.swift', 'PairingView', 'classType', 3),
    n('extension/server/report.mjs', 'serverReport', 'function', 9),
    n('extension/server/report.mjs', 'reportServer', 'function', 20),
    n('extension/tests/pin.test.mjs', 'rotatePinTest', 'function', 4),
    n('docs/mobile/pin.md', 'Rotating the PIN', 'docPage', 1),
    n('mac/Loop/LoopEngineRunner.swift', 'LoopEngineRunner', 'classType', 10),
    n('mac/Loop/LoopEngineRunner.swift', 'retryIteration', 'function', 629),
    n('mac/Loop/LoopRunService.swift', 'runner', 'function', 2),
  ], edges: [] }, { source: 'structure' });
});
test.after(() => { db.closeDb(); for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true }); });

test('stemToken strips inflection but keeps case and a 4-char floor', () => {
  assert.equal(stemToken('rotated'), 'rotat');
  assert.equal(stemToken('retries'), 'retry');
  assert.equal(stemToken('Handling'), 'Handl');
  assert.equal(stemToken('renderGutter'), 'renderGutter');
  assert.equal(stemToken('bus'), 'bus');
});

test('queryTerms drops question and filler words', () => {
  assert.deepEqual(queryTerms('where is the mobile pairing PIN rotated'), ['mobile', 'pair', 'PIN', 'rotat']);
  assert.deepEqual(queryTerms('how does the Loop runner retry a failed stage'), ['Loop', 'runner', 'retry', 'fail', 'stage']);
});

test('queryTerms keeps a compound word whole as well as its parts', () => {
  assert.deepEqual(queryTerms('how does find-code scope results'), ['find-code', 'find', 'scope', 'result']);
});

test('seedCandidates keeps its contract', () => {
  assert.equal(seedCandidates('fix the renderGutter offset')[0], 'fix the renderGutter offset');
  assert.ok(seedCandidates('fix the renderGutter offset').includes('renderGutter'));
  assert.ok(seedCandidates('a b c d e f g h i j k l m n o p q r s t u v w x y z alpha beta gamma delta epsilon').length <= 6);
});

const top3 = (q) => searchCodeIndex(U, q, { repoIds: [REPO] }).symbols.slice(0, 3).map((s) => s.title);

test('a stemmed, multi-term question ranks the real answer first, above its test and doc', () => {
  const all = searchCodeIndex(U, 'where is the mobile pairing PIN rotated', { repoIds: [REPO], limit: 12 }).symbols.map((s) => s.title);
  assert.equal(all[0], 'rotateInMemory', JSON.stringify(all));
  const at = (t) => (all.indexOf(t) === -1 ? Infinity : all.indexOf(t));
  assert.ok(at('rotateInMemory') < at('rotatePinTest'), 'tests rank below code');
  assert.ok(at('rotateInMemory') < at('Rotating the PIN'), 'docs rank below code');
});

test('multi-term coverage beats a generic single-term match', () => {
  const t = top3('how does the Loop runner retry a failed stage');
  assert.ok(t.includes('LoopEngineRunner') || t.includes('retryIteration'), JSON.stringify(t));
  assert.notEqual(t[0], 'runner');
});

test('an exact identifier query still puts the definition first', () => {
  assert.equal(top3('PairingThrottle')[0], 'PairingThrottle');
  assert.equal(top3('rotateInMemory')[0], 'rotateInMemory');
});

test('a compound term finds the file it names', () => {
  db.writeCodeGraph(U, REPO, { nodes: [
    n('extension/handlers/find-code.mjs', 'find-code.mjs', 'file', 0),
    n('extension/finder/finder.mjs', 'findScope', 'function', 3),
  ], edges: [] }, { source: 'structure' });
  assert.ok(top3('how does find-code scope results').includes('find-code.mjs'));
});
