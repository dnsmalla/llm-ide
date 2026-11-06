// Checks the Linux bundles without installing them: the deb's Depends (incl. the tray's appindicator runtime),
// the deb's contents, and the AppImage's extracted core (staged-tree verifier + no SDK claude binary).
//   node scripts/verify-linux-bundle.mjs <file.deb> <file.AppImage>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyNoSdkBinary } from './sdk-binary.mjs';
import { verifyStagedCore } from './stage-filter.mjs';

export const REQUIRED_DEPENDS = ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libayatana-appindicator3-1'];

export function missingDepends(field) {
  const names = field.split(',').flatMap((d) => d.split('|')).map((d) => d.trim().split(/[\s(]/)[0]).filter(Boolean);
  return REQUIRED_DEPENDS.filter((r) => !names.includes(r));
}

export function listingProblems(paths) {
  const p = [];
  if (!paths.some((x) => x.endsWith('/core/node/node'))) p.push('deb has no core/node/node');
  if (!paths.some((x) => x.endsWith('/core/root/extension/server.mjs'))) p.push('deb has no core/root/extension/server.mjs');
  for (const x of paths) if (/@anthropic-ai\/claude-agent-sdk-linux/.test(x) || /\/claude$/.test(x)) p.push(`deb ships an SDK claude binary: ${x}`);
  return p;
}

function findCore(dir) {
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    if (!n.isDirectory()) continue;
    const p = join(dir, n.name);
    if (n.name === 'core' && readdirSync(p).includes('node')) return p;
    const f = findCore(p);
    if (f) return f;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [deb, appimage] = process.argv.slice(2).map((x) => resolve(x));
  const p = [];
  p.push(...missingDepends(execFileSync('dpkg-deb', ['-f', deb, 'Depends'], { encoding: 'utf8' })).map((d) => `deb Depends lacks ${d}`));
  const listing = execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
  p.push(...listingProblems(listing));
  const tmp = mkdtempSync(join(tmpdir(), 'appimage-'));
  execFileSync(appimage, ['--appimage-extract'], { cwd: tmp, stdio: 'ignore' });
  const core = findCore(join(tmp, 'squashfs-root'));
  if (!core) p.push('AppImage has no core/ folder');
  else p.push(...verifyNoSdkBinary(core), ...verifyStagedCore(core).map((x) => `AppImage staged-tree verifier: ${x}`));
  if (p.length) { for (const x of p) console.error(`::error::${x}`); process.exit(1); }
  console.log('Linux bundles OK');
}
