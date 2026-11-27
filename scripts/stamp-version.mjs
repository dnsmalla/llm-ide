// CI-only: write a release version into the desktop app's version files (never commit the result).
// Usage: node scripts/stamp-version.mjs <x.y.z> [repo-root]
// Touches desktop/package.json (+ lock root), desktop/src-tauri/tauri.conf.json, desktop/src-tauri/Cargo.toml
// and the llmide-desktop entry of Cargo.lock, so a --locked build still passes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const version = process.argv[2];
const root = resolve(process.argv[3] ?? new URL('..', import.meta.url).pathname);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: stamp-version.mjs <x.y.z> [repo-root]');
  process.exit(2);
}
const desktop = join(root, 'desktop');

function editJson(file, edit) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  edit(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
function editText(file, pattern, replacement) {
  const text = readFileSync(file, 'utf8');
  if (!pattern.test(text)) throw new Error(`pattern not found in ${file}`);
  writeFileSync(file, text.replace(pattern, replacement));
}

editJson(join(desktop, 'package.json'), (d) => { d.version = version; });
editJson(join(desktop, 'package-lock.json'), (d) => {
  d.version = version;
  if (d.packages?.['']) d.packages[''].version = version;
});
editJson(join(desktop, 'src-tauri/tauri.conf.json'), (d) => { d.version = version; });
editText(join(desktop, 'src-tauri/Cargo.toml'), /^version = "[^"]*"/m, `version = "${version}"`);
editText(
  join(desktop, 'src-tauri/Cargo.lock'),
  /(name = "llmide-desktop"\nversion = )"[^"]*"/,
  `$1"${version}"`,
);
console.log(`stamped ${version}`);
