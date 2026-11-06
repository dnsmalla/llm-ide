// Generates the release-only Tauri config overlay passed as `tauri build --config <file>` (a JSON merge patch on
// tauri.conf.json). Local and dry-run builds never get it: no sign command, no updater, no updater artifacts.
//   WIN_SIGNTOOL=... WIN_DLIB=... WIN_METADATA=... node scripts/release-config.mjs --windows-sign > overlay.json
import { resolve } from 'node:path';

export const windowsSignArgs = ({ dlib, metadata }) =>
  ['/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', dlib, '/dmdf', metadata];

export function releaseConfig({ windowsSign, updater } = {}) {
  const c = {};
  if (windowsSign) {
    for (const k of ['signtool', 'dlib', 'metadata']) if (!windowsSign[k]) throw new Error(`windows signing: ${k} is empty`);
    c.bundle = { ...(c.bundle ?? {}), windows: { signCommand: { cmd: windowsSign.signtool, args: ['sign', ...windowsSignArgs(windowsSign), '%1'] } } };
  }
  return c; // `updater` is accepted and ignored until Task 11
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2);
  const windowsSign = a.includes('--windows-sign') ? { signtool: process.env.WIN_SIGNTOOL, dlib: process.env.WIN_DLIB, metadata: process.env.WIN_METADATA } : undefined;
  process.stdout.write(JSON.stringify(releaseConfig({ windowsSign }), null, 2) + '\n');
}
