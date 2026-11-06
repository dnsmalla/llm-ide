// desktop/scripts/update-manifest.mjs
// Builds the Tauri updater manifest (latest.json) from a release dist folder and refuses to write it unless
// every platform is present and every .sig verifies against the committed public key. Also writes SHA256SUMS.
//   node scripts/update-manifest.mjs --version 0.2.0 --pubkey release/updater.pubkey --notes notes.md <distDir>
//   node scripts/update-manifest.mjs --check latest.json --version 0.2.0
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyMinisign } from './minisign.mjs';

export const RELEASE_BASE = 'https://github.com/dnsmalla/llm-ide/releases/download/';
export const PLATFORMS = [
  { key: 'darwin-aarch64', file: (v) => `LLM-IDE_${v}_aarch64.app.tar.gz` },
  { key: 'darwin-x86_64', file: (v) => `LLM-IDE_${v}_x64.app.tar.gz` },
  { key: 'windows-x86_64', file: (v) => `LLM-IDE_${v}_x64-setup.exe` },
  { key: 'linux-x86_64', file: (v) => `LLM-IDE_${v}_amd64.AppImage` },
];
const NOTES_MAX = 4000;

export function buildManifest({ version, notes, pubDate, files, read, pubkey, verifySig = verifyMinisign }) {
  const problems = [];
  const platforms = {};
  for (const p of PLATFORMS) {
    const name = p.file(version);
    if (!files.includes(name)) { problems.push(`${p.key}: ${name} missing`); continue; }
    if (!files.includes(`${name}.sig`)) { problems.push(`${p.key}: ${name}.sig missing`); continue; }
    const signature = read(`${name}.sig`).toString('utf8').trim();
    const v = verifySig(pubkey, signature, read(name));
    if (!v.ok) { problems.push(`${p.key}: ${name}: ${v.reason}`); continue; }
    platforms[p.key] = { signature, url: `${RELEASE_BASE}desktop-v${version}/${name}` };
  }
  const manifest = { version, notes: String(notes ?? '').slice(0, NOTES_MAX), pub_date: pubDate, platforms };
  return { manifest, problems: [...problems, ...(problems.length ? [] : manifestProblems(manifest, version))] };
}

export function manifestProblems(m, version) {
  const p = [];
  if (m?.version !== version) p.push(`manifest version ${m?.version} != ${version}`);
  const prefix = `${RELEASE_BASE}desktop-v${version}/`;
  for (const { key } of PLATFORMS) {
    const e = m?.platforms?.[key];
    if (!e) { p.push(`${key}: missing`); continue; }
    if (typeof e.url !== 'string' || !e.url.startsWith(prefix)) p.push(`${key}: url must start with ${prefix}`);
    if (typeof e.signature !== 'string' || e.signature.length < 20) p.push(`${key}: empty or short signature`);
  }
  return p;
}

export function sha256Sums(files, read) {
  return files.filter((f) => !f.endsWith('.sig')).sort()
    .map((f) => `${createHash('sha256').update(read(f)).digest('hex')}  ${f}`).join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : null; };
  const version = opt('--version');
  const check = opt('--check');
  if (check) {
    const p = manifestProblems(JSON.parse(readFileSync(check, 'utf8')), version);
    if (p.length) { for (const x of p) console.error(`::error::${x}`); process.exit(1); }
    console.log('latest.json OK'); process.exit(0);
  }
  const pubkey = readFileSync(opt('--pubkey'), 'utf8').trim();
  const notesFile = opt('--notes');
  const dist = resolve(a[0]);
  const files = readdirSync(dist);
  const read = (n) => readFileSync(join(dist, n));
  const { manifest, problems } = buildManifest({ version, notes: notesFile ? readFileSync(notesFile, 'utf8') : '', pubDate: new Date().toISOString(), files, read, pubkey });
  if (problems.length) { for (const x of problems) console.error(`::error::${x}`); process.exit(1); }
  writeFileSync(join(dist, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dist, 'SHA256SUMS'), sha256Sums(readdirSync(dist).filter((f) => f !== 'SHA256SUMS'), read));
  console.log(`latest.json + SHA256SUMS written for ${Object.keys(manifest.platforms).length} platforms`);
}
