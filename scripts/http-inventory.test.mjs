// Proves the generated-inventory policy: the contract gate validates route
// coverage from the generator output (a stale committed INVENTORY.md is not a
// failure), while real coverage drift — a client path outside the roster or a
// roster path with no handler — still fails.
//
// The script is run against a throwaway fixture root (HTTP_INVENTORY_ROOT), so
// these tests never read or write the real snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./http-inventory.mjs', import.meta.url));

// A minimal repo the generator can scan. The no-handler rows are the ones in
// ALLOWLIST.noHandler, and the /auth/me/extensions client call is the one in
// ALLOWLIST.clientNotInRoster; without them the stale-allowlist checks would
// fail in the fixture.
const FILES = {
  'extension/server.mjs': `const ALL_ENDPOINTS = [
  '/kb/ping',
  '/kb/sync/devices/:id',
  '/kb/self-heal/incidents/:id/ignore',
  '/kb/self-heal/runs/:id/outcome',
  '/kb/self-heal/runs/:id/resolve',
];

export function route(url, method) {
  if (url === '/health' && method === 'GET') return 1;
  if (url === '/kb/ping' && method === 'GET') return 2;
  return 0;
}
`,
  'extension/server/auth.mjs': `const PUBLIC_PATHS = new Set([
  '/health',
]);
const PUBLIC_PREFIXES = [];
`,
  'extension/server/auth-routes.mjs': `export function isAuthRoute(url) {
  if (url.startsWith('/auth/me/plugins/uninstall/')) return true;
  if (url.startsWith('/auth/me/llm-sources/')) return true;
  if (url.startsWith('/auth/me/mcp-plugins/')) return true;
  if (url.startsWith('/auth/me/connectors/')) return true;
  if (url.endsWith('/discovery')) return true;
  return false;
}
`,
  'extension/routes/extension-routes.mjs': '\n',
  'extension/routes/extensions-catalog.mjs': '\n',
  'extension/routes/workspace-trust.mjs': '\n',
  'extension/routes/feature-routes.mjs': `export const FEATURE_ROUTE_GROUPS = Object.freeze({
});
`,
  'ui/screens/caller.ts': `export const ping = () => fetch('/kb/ping');
`,
  'ui/screens/extensions-api.ts': `export const EXTENSIONS_PREFIX = '/auth/me/extensions';
`,
};

const EMPTY_DIRS = [
  'extension/src',
  'extension/tests',
  'ui/kit/src',
  'desktop/src',
  'web/src',
  'docs',
  'schema/http',
];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'http-inventory-test-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  for (const rel of EMPTY_DIRS) mkdirSync(join(root, rel), { recursive: true });
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, HTTP_INVENTORY_ROOT: root },
    encoding: 'utf8',
  });
}

function withFixture(fn) {
  const root = makeFixture();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a stale committed INVENTORY.md does not fail the coverage gate', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'schema/http/INVENTORY.md'), '# stale snapshot\n');

    const coverage = run(root, '--coverage');
    assert.equal(coverage.status, 0, coverage.stderr);
    assert.match(coverage.stdout, /route coverage OK/);

    // The full drift check still reports the stale snapshot; only the gate stopped comparing it.
    const full = run(root, '--check');
    assert.equal(full.status, 1);
    assert.match(full.stderr, /is stale or missing/);
  });
});

test('a client route outside the roster still fails the coverage gate', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'ui/screens/bad-caller.ts'), "export const ghost = () => fetch('/kb/ghost');\n");

    const coverage = run(root, '--coverage');
    assert.equal(coverage.status, 1);
    assert.match(coverage.stderr, /client calls \/kb\/ghost .*not in ALL_ENDPOINTS/);
  });
});

test('a roster entry with no handler still fails the coverage gate', () => {
  withFixture((root) => {
    const serverRel = join(root, 'extension/server.mjs');
    writeFileSync(
      serverRel,
      readFileSync(serverRel, 'utf8').replace("const ALL_ENDPOINTS = [", "const ALL_ENDPOINTS = [\n  '/kb/orphan',"),
    );

    const coverage = run(root, '--coverage');
    assert.equal(coverage.status, 1);
    assert.match(coverage.stderr, /\/kb\/orphan .*has no handler found by the scanner/);
  });
});

test('a freshly generated snapshot passes the full drift check', () => {
  withFixture((root) => {
    const write = run(root);
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /wrote schema\/http\/INVENTORY\.md/);

    const full = run(root, '--check');
    assert.equal(full.status, 0, full.stderr);
  });
});
