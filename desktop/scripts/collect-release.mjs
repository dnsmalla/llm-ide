// desktop/scripts/collect-release.mjs
// Copies one target's Tauri bundle outputs to <outDir> under canonical, arch-carrying names and checks the
// 150 MB per-installer budget (Tauri plan §6). Signed runs also need each updater artifact's .sig.
//   node scripts/collect-release.mjs --target darwin-arm64 --version 0.1.0 [--signed] <bundleDir> <outDir>
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const BUDGET_BYTES = 150 * 1024 * 1024;
const INSTALLER_RE = /\.(dmg|exe|AppImage|deb|rpm|msi|tar\.gz)$/;

// Each entry: the source file (regex on the bundle-relative path), its canonical name, and whether it is an
// updater artifact (then a .sig must sit beside it in a signed run).
export const TARGETS = {
  'darwin-arm64': (v) => [
    { re: new RegExp(`^dmg/LLM-IDE_${v}_aarch64\\.dmg$`), to: `LLM-IDE_${v}_aarch64.dmg` },
    { re: /^macos\/LLM-IDE\.app\.tar\.gz$/, to: `LLM-IDE_${v}_aarch64.app.tar.gz`, updater: true },
  ],
  'darwin-x64': (v) => [
    { re: new RegExp(`^dmg/LLM-IDE_${v}_x64\\.dmg$`), to: `LLM-IDE_${v}_x64.dmg` },
    { re: /^macos\/LLM-IDE\.app\.tar\.gz$/, to: `LLM-IDE_${v}_x64.app.tar.gz`, updater: true },
  ],
  'win32-x64': (v) => [
    { re: new RegExp(`^nsis/LLM-IDE_${v}_x64-setup\\.exe$`), to: `LLM-IDE_${v}_x64-setup.exe`, updater: true },
  ],
  'linux-x64': (v) => [
    { re: new RegExp(`^appimage/LLM-IDE_${v}_amd64\\.AppImage$`), to: `LLM-IDE_${v}_amd64.AppImage`, updater: true },
    { re: new RegExp(`^deb/LLM-IDE_${v}_amd64\\.deb$`), to: `LLM-IDE_${v}_amd64.deb` },
  ],
};

export function planCollect({ target, version, files, signed }) {
  const spec = TARGETS[target];
  if (!spec) return { copies: [], problems: [`unknown target ${target}`] };
  const v = version.replaceAll('.', '\\.');
  const copies = [];
  const problems = [];
  const found = files.filter((f) => INSTALLER_RE.test(f) && !f.includes('.app/')).join(', ') || 'nothing';
  for (const e of spec(v)) {
    const want = e.to.replaceAll('\\.', '.');
    const from = files.find((f) => e.re.test(f));
    if (!from) { problems.push(`missing ${want} (found: ${found})`); continue; }
    copies.push({ from, to: want });
    if (e.updater && signed) {
      if (files.includes(`${from}.sig`)) copies.push({ from: `${from}.sig`, to: `${want}.sig` });
      else problems.push(`missing ${want}.sig (the updater signature; is TAURI_SIGNING_PRIVATE_KEY set?)`);
    }
  }
  return { copies, problems };
}

export function budgetProblems(entries) {
  return entries
    .filter((e) => !e.name.endsWith('.sig') && e.size > BUDGET_BYTES)
    .map((e) => `${e.name} is ${(e.size / 1048576).toFixed(1)} MB, over the 150 MB installer budget`);
}

function walk(dir, root = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    // A .app is a directory; its inside is never a release file, so do not descend.
    if (statSync(p).isDirectory() && !n.endsWith('.app')) walk(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : null; };
  const target = opt('--target');
  const version = opt('--version');
  const signed = a.includes('--signed');
  const [bundleDir, outDir] = a.filter((x) => x !== '--signed');
  const { copies, problems } = planCollect({ target, version, files: walk(resolve(bundleDir)), signed });
  mkdirSync(outDir, { recursive: true });
  for (const c of copies) copyFileSync(join(bundleDir, c.from), join(outDir, c.to));
  problems.push(...budgetProblems(copies.map((c) => ({ name: c.to, size: statSync(join(outDir, c.to)).size }))));
  for (const c of copies) console.log(`${c.to}  ${(statSync(join(outDir, c.to)).size / 1048576).toFixed(1)} MB`);
  if (problems.length) { for (const p of problems) console.error(`::error::${p}`); process.exit(1); }
}
