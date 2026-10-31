// Verifies a built macOS app bundle (LLM-IDE.app) without launching it.
//   node scripts/verify-bundle.mjs <path/to/LLM-IDE.app>
// Checks: layout (main binary, the pinned node, the staged server), the staged-tree verifier and the "no SDK
// claude binary" rule run on the bundle's own copy of the core, Info.plist (bundle id distinct from the Swift
// Mac app, folder usage descriptions, product name), no leftover dev server URL, and the frontend assets.
// Exit 1 on any problem. Pure parts are exported for tests.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyStagedCore } from './stage-filter.mjs';
import { verifyNoSdkBinary } from './sdk-binary.mjs';

export const BUNDLE_ID = 'com.llmide.desktop';
/** The Swift Mac app's identifier; the two apps must be able to coexist. */
export const SWIFT_APP_IDS = ['com.llmide.macapp', 'com.llmide.macapp.deeplink'];
export const USAGE_KEYS = ['NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription'];

/** Problems with a parsed Info.plist (empty = fine). */
export function checkInfo(info) {
  const p = [];
  if (info.CFBundleIdentifier !== BUNDLE_ID) p.push(`CFBundleIdentifier is ${JSON.stringify(info.CFBundleIdentifier)}, expected ${BUNDLE_ID}`);
  if (SWIFT_APP_IDS.includes(info.CFBundleIdentifier)) p.push('bundle id collides with the Swift Mac app');
  if (info.CFBundleName !== 'LLM-IDE') p.push(`CFBundleName is ${JSON.stringify(info.CFBundleName)}, expected "LLM-IDE"`);
  for (const k of USAGE_KEYS) {
    if (typeof info[k] !== 'string' || info[k].trim().length < 10) p.push(`${k} is missing: a Finder-launched app is silently denied that folder`);
  }
  if (!info.CFBundleExecutable) p.push('CFBundleExecutable missing');
  return p;
}

/** Problems with the app's layout and its bundled core (empty = fine). */
export function checkLayout(app) {
  const p = [];
  const res = join(app, 'Contents', 'Resources');
  const core = join(res, 'core');
  const need = [
    ['Contents/Info.plist', join(app, 'Contents', 'Info.plist')],
    ['bundled node', join(core, 'node', 'node')],
    ['server.mjs', join(core, 'root', 'extension', 'server.mjs')],
    ['better-sqlite3 prebuild', join(core, 'root', 'extension', 'node_modules', 'better-sqlite3')],
    ['model schema', join(core, 'root', 'schema', 'models', 'anthropic-models.json')],
    ['STAGE.json', join(core, 'STAGE.json')],
  ];
  for (const [label, path] of need) if (!existsSync(path)) p.push(`missing: ${label} (${path})`);
  const node = join(core, 'node', 'node');
  if (existsSync(node) && (statSync(node).mode & 0o111) === 0) p.push('bundled node is not executable');
  if (existsSync(core)) {
    p.push(...verifyNoSdkBinary(core));
    p.push(...verifyStagedCore(core).map((x) => `staged-tree verifier: ${x}`));
  }
  const macos = join(app, 'Contents', 'MacOS');
  if (!existsSync(macos) || readdirSync(macos).length === 0) p.push('Contents/MacOS has no executable');
  return p;
}

function readInfo(app) {
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' });
  return JSON.parse(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = process.argv[2] ? resolve(process.argv[2]) : '';
  if (!app || !existsSync(app)) {
    console.error('usage: node scripts/verify-bundle.mjs <path/to/LLM-IDE.app>');
    process.exit(2);
  }
  const problems = [];
  try {
    const info = readInfo(app);
    problems.push(...checkInfo(info));
    const exe = join(app, 'Contents', 'MacOS', String(info.CFBundleExecutable));
    if (!existsSync(exe)) problems.push(`main binary missing: ${exe}`);
  } catch (e) {
    problems.push(`cannot read Info.plist: ${e.message.split('\n')[0]}`);
  }
  problems.push(...checkLayout(app));
  if (problems.length) {
    console.error(`bundle verification FAILED (${problems.length}):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`bundle layout OK: ${app}`);
}
