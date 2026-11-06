// Generates the release-only Tauri config overlay passed as `tauri build --config <file>` (a JSON merge patch on
// tauri.conf.json). Local and dry-run builds never get it: no sign command, no updater, no updater artifacts.
//   WIN_SIGNTOOL=... WIN_DLIB=... WIN_METADATA=... node scripts/release-config.mjs --windows-sign > overlay.json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Must equal CHANNEL_URL in src-tauri/src/updater.rs (a test pins it).
export const CHANNEL_URL = 'https://github.com/dnsmalla/llm-ide/releases/download/desktop-stable/latest.json';

export const windowsSignArgs = ({ dlib, metadata }) =>
  ['/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', dlib, '/dmdf', metadata];

export function releaseConfig({ windowsSign, updater } = {}) {
  const c = {};
  if (windowsSign) {
    for (const k of ['signtool', 'dlib', 'metadata']) if (!windowsSign[k]) throw new Error(`windows signing: ${k} is empty`);
    c.bundle = { ...(c.bundle ?? {}), windows: { signCommand: { cmd: windowsSign.signtool, args: ['sign', ...windowsSignArgs(windowsSign), '%1'] } } };
  }
  if (updater) {
    if (!updater.pubkey || updater.pubkey.trim().length < 40) throw new Error('updater: pubkey is empty or short');
    c.bundle = { ...(c.bundle ?? {}), createUpdaterArtifacts: true };
    // Only these keys: updater.rs config_problem rejects any other key under plugins.updater.
    c.plugins = { updater: { pubkey: updater.pubkey.trim(), endpoints: [CHANNEL_URL], windows: { installMode: 'passive' } } };
  }
  return c;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2);
  const windowsSign = a.includes('--windows-sign') ? { signtool: process.env.WIN_SIGNTOOL, dlib: process.env.WIN_DLIB, metadata: process.env.WIN_METADATA } : undefined;
  const i = a.indexOf('--updater');
  const updater = i >= 0 ? { pubkey: readFileSync(a[i + 1], 'utf8') } : undefined;
  process.stdout.write(JSON.stringify(releaseConfig({ windowsSign, updater }), null, 2) + '\n');
}
