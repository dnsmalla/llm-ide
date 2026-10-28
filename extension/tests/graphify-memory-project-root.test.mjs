// D1 (2026-10-28): generated graph/memory/faults/Q&A live in the PROJECT's own
// `system/`, never in a cloned repo's `system/` under `code/<child>/`. These
// tests fail if the server resolves a writer target under a child repo, and pin
// the N-1 read fallback to the legacy `<repo>/system/` location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-projroot-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const paths = await import('../graphkit/paths.mjs');
const { renderGraphifyMemory } = await import('../graphkit/memory.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function cleanupDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

function freshUser(tag) {
  cleanupDb();
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

function write(abs, body) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

/** `<tmp>/<name>/system/project.json` plus `code/<child>` repos. */
function makeProject(tag, children) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `projroot-${tag}-`));
  const project = path.join(base, 'proj');
  write(path.join(project, 'system', 'project.json'), '{}');
  const repos = children.map((c) => {
    const repo = path.join(project, 'code', c);
    write(path.join(repo, 'main.py'), 'print(1)\n');
    return repo;
  });
  return { base, project, repos };
}

test('a code/<child> repo resolves to the project root for every generated path', () => {
  const { base, project, repos: [app] } = makeProject('resolve', ['app']);
  try {
    assert.equal(paths.projectRootOf(app), project);
    assert.equal(paths.memoryDir(app), path.join(project, 'system', 'memory'));
    assert.equal(paths.chatMemoryFile(app), path.join(project, 'system', 'memory', 'chat-memory.md'));
    assert.equal(paths.systemDir(app), path.join(project, 'system'));
    // Single repo: graph is flat at the project root.
    assert.equal(paths.graphDir(app), path.join(project, 'system', 'graph'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('with two code repos each graph gets its own system/graph/<child>/', () => {
  const { base, project, repos: [a, b] } = makeProject('multi', ['a', 'b']);
  try {
    assert.equal(paths.graphDir(a), path.join(project, 'system', 'graph', 'a'));
    assert.equal(paths.graphDir(b), path.join(project, 'system', 'graph', 'b'));
    assert.equal(paths.graphDir(project), path.join(project, 'system', 'graph'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a project living under a folder named code is its own root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'projroot-codefolder-'));
  try {
    const project = path.join(base, 'code', 'myproj');
    write(path.join(project, 'system', 'project.json'), '{}');
    assert.equal(paths.projectRootOf(project), project);
    assert.equal(paths.memoryDir(project), path.join(project, 'system', 'memory'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('legacy <repo>/system/ output is a read fallback, never a write target', () => {
  const { base, project, repos: [app] } = makeProject('legacy', ['app']);
  try {
    write(path.join(app, 'system', 'graph', 'index.md'), '# legacy overview\n');
    // Reader finds the legacy overview until the migration moves it.
    assert.equal(paths.graphIndexFile(app), path.join(app, 'system', 'graph', 'index.md'));
    // A writer target never points back into the repo.
    assert.ok(!paths.memoryDir(app).startsWith(app + path.sep));
    assert.ok(!paths.graphDir(app).startsWith(app + path.sep));
    assert.ok(!paths.chatMemoryFile(app).startsWith(app + path.sep));
    // Once the project copy exists it wins.
    write(path.join(project, 'system', 'graph', 'index.md'), '# project overview\n');
    assert.equal(paths.graphIndexFile(app), path.join(project, 'system', 'graph', 'index.md'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('memory reader shows faults and Q&A from the project and from the N-1 legacy location', () => {
  const U = freshUser('n1');
  const { base, project, repos: [app] } = makeProject('reader', ['app']);
  try {
    // Pre-D1 fault, still in the repo (not yet migrated).
    write(path.join(app, 'system', 'faults', '2026-01-01-legacy.md'), '# Legacy fault marker\n');
    // Post-D1 Q&A at the project root.
    write(path.join(project, 'system', 'q&a', '2026-01-02-new.md'), 'Project Q&A marker\n');
    db.addUserRepo(U, app);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: app, name: 'app' }] }, U);
    assert.match(out, /faults\/ \(1\)/);
    assert.match(out, /Legacy fault marker/);
    assert.match(out, /q&a\/ \(1\)/);
    assert.match(out, /Project Q&A marker/);
  } finally {
    cleanupDb();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the same project-level fault is listed once when both locations hold it', () => {
  const U = freshUser('dedupe');
  const { base, project, repos: [app] } = makeProject('dedupe', ['app']);
  try {
    write(path.join(project, 'system', 'faults', 'same.md'), '# Same fault\n');
    write(path.join(app, 'system', 'faults', 'same.md'), '# Same fault\n');
    db.addUserRepo(U, app);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: app, name: 'app' }] }, U);
    assert.match(out, /faults\/ \(1\)/);
  } finally {
    cleanupDb();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Parity with Swift `GeneratedDataLocator.readableMemoryFile`: the memory is read
// per file, so an empty project memory dir does not hide a legacy artifact.
test('an empty project memory dir does not hide the legacy graph-notes artifact', () => {
  const U = freshUser('memmerge');
  const { base, project, repos: [app] } = makeProject('memmerge', ['app']);
  try {
    fs.mkdirSync(path.join(project, 'system', 'memory'), { recursive: true });
    write(path.join(app, 'system', 'memory', 'graph-notes.md'), '# Notes\n\nLEGACY-GRAPH-NOTES-MARK\n');
    db.addUserRepo(U, app);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: app, name: 'app' }] }, U);
    assert.match(out, /LEGACY-GRAPH-NOTES-MARK/);
  } finally {
    cleanupDb();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Parity with Swift readableGraphDir: a flat graph is served to its own child
// after a second repo is added, and never to the sibling.
test('graphIndexFile: the flat graph stays with its child after a second repo is added', () => {
  const { base, project, repos: [a] } = makeProject('grow', ['a']);
  try {
    write(path.join(a, 'a-file.py'), 'print(1)\n');
    write(path.join(project, 'system', 'graph', 'index.md'), '# flat overview\n');
    write(path.join(project, 'system', 'graph', 'graph.json'),
      JSON.stringify({ version: '1.1', files: [{ path: 'a-file.py' }], calls: [] }));
    const b = path.join(project, 'code', 'b');
    write(path.join(b, 'main.py'), 'print(2)\n');

    assert.equal(paths.graphIndexFile(a), path.join(project, 'system', 'graph', 'index.md'));
    assert.notEqual(paths.graphIndexFile(b), path.join(project, 'system', 'graph', 'index.md'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Parity with Swift readableGraphDir: a per-repo leftover is found after the second repo goes.
test('graphIndexFile: a per-repo graph is found flat after the second repo is removed', () => {
  const { base, project, repos: [a, b] } = makeProject('shrink', ['a', 'b']);
  try {
    write(path.join(project, 'system', 'graph', 'a', 'index.md'), '# a overview\n');
    fs.rmSync(b, { recursive: true, force: true });
    assert.equal(paths.graphIndexFile(a), path.join(project, 'system', 'graph', 'a', 'index.md'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
