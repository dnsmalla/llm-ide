import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE_ID, checkInfo, checkLayout } from './verify-bundle.mjs';

const good = {
  CFBundleIdentifier: BUNDLE_ID, CFBundleName: 'LLM-IDE', CFBundleExecutable: 'llmide-desktop-poc',
  NSDesktopFolderUsageDescription: 'LLM-IDE reads project files on the Desktop.',
  NSDocumentsFolderUsageDescription: 'LLM-IDE reads project files in Documents.',
  NSDownloadsFolderUsageDescription: 'LLM-IDE reads project files in Downloads.',
};

test('a good Info.plist passes; the Swift app id, a missing usage text or a wrong name fail', () => {
  assert.deepEqual(checkInfo(good), []);
  assert.match(checkInfo({ ...good, CFBundleIdentifier: 'com.llmide.macapp' }).join('|'), /collides/);
  assert.match(checkInfo({ ...good, NSDocumentsFolderUsageDescription: undefined }).join('|'), /Documents/);
  assert.match(checkInfo({ ...good, CFBundleName: 'LLM-IDE Desktop PoC' }).join('|'), /CFBundleName/);
});

function fakeApp({ sdk = false, db = false } = {}) {
  const app = mkdtempSync(join(tmpdir(), 'bundle-')) + '/LLM-IDE.app';
  const core = join(app, 'Contents', 'Resources', 'core');
  for (const d of [join(app, 'Contents', 'MacOS'), join(core, 'node'), join(core, 'root', 'extension', 'node_modules', 'better-sqlite3'), join(core, 'root', 'schema', 'models')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '');
  writeFileSync(join(app, 'Contents', 'MacOS', 'x'), '');
  writeFileSync(join(core, 'node', 'node'), ''); chmodSync(join(core, 'node', 'node'), 0o755);
  writeFileSync(join(core, 'root', 'extension', 'server.mjs'), '');
  writeFileSync(join(core, 'root', 'schema', 'models', 'anthropic-models.json'), '{}');
  writeFileSync(join(core, 'STAGE.json'), '{}');
  if (sdk) { mkdirSync(join(core, 'root', 'extension', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'), { recursive: true }); }
  if (db) writeFileSync(join(core, 'root', 'extension', 'data.db'), 'x');
  return app;
}

test('layout: a complete core passes; an SDK claude package or a database file fails', () => {
  const a = fakeApp();
  assert.deepEqual(checkLayout(a), []);
  assert.match(checkLayout(fakeApp({ sdk: true })).join('|'), /SDK binary package/);
  assert.match(checkLayout(fakeApp({ db: true })).join('|'), /data\.db/);
  const empty = mkdtempSync(join(tmpdir(), 'bundle-')) + '/X.app';
  assert.match(checkLayout(empty).join('|'), /missing: bundled node/);
  rmSync(a, { recursive: true, force: true });
});
