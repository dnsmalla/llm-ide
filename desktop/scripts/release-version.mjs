// desktop/scripts/release-version.mjs
// The release tag, tauri.conf.json `version` and Cargo.toml `[package] version` must name the same X.Y.Z
// (the updater compares tauri.conf's version; crash reports use CARGO_PKG_VERSION).
//   node scripts/release-version.mjs desktop-v0.1.0     -> prints version=0.1.0, exit 0; else the problems, exit 1
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TAURI = resolve(import.meta.dirname, '..', 'src-tauri');
export const TAG_RE = /^desktop-v(\d+\.\d+\.\d+)$/;

export const tagVersion = (tag) => TAG_RE.exec(tag ?? '')?.[1] ?? null;

export function cargoVersion(text) {
  const pkg = text.split(/^\[/m).find((s) => s.startsWith('package]'));
  return (pkg && /^version\s*=\s*"([^"]+)"/m.exec(pkg)?.[1]) || null;
}

export function versionProblems({ tag, conf, cargo }) {
  const p = [];
  const t = tagVersion(tag);
  if (!t) p.push(`tag ${JSON.stringify(tag)} is not desktop-vX.Y.Z`);
  if (conf !== cargo) p.push(`tauri.conf.json version ${conf} != Cargo.toml version ${cargo}`);
  if (t && conf !== t) p.push(`tauri.conf.json version ${conf} != tag ${t}`);
  if (conf === '0.0.0') p.push('version 0.0.0 is the unreleased placeholder; bump it first (docs/how-to/desktop-release.md)');
  return p;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const conf = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8')).version;
  const cargo = cargoVersion(readFileSync(join(TAURI, 'Cargo.toml'), 'utf8'));
  const p = versionProblems({ tag: process.argv[2], conf, cargo });
  if (p.length) { for (const x of p) console.error(`::error::${x}`); process.exit(1); }
  console.log(`version=${conf}`);
}
