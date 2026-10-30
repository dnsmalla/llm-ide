// Guards the Monaco DOMPurify fix (Phase 0 report, "Security notes for Phase 1").
// Monaco ships its own DOMPurify under esm/vs/base/browser/dompurify/; vite.config.ts
// redirects that import to the npm `dompurify` package. Checked here, offline:
//   1. package.json pins dompurify to an exact version >= MIN_SAFE and overrides it
//   2. package-lock.json resolves every dompurify to that version (no nested copy)
//   3. if dist/ exists, it embeds the pinned version and not Monaco's vendored one
// Usage: node scripts/check-dompurify.mjs   (exit 1 on any failure)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** First DOMPurify release without the advisories reported against <= 3.4.16. */
export const MIN_SAFE = '3.4.17';

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** Pure check over parsed inputs; returns a list of problems (empty = ok). */
export function check({ pkg, lock, vendoredVersion, distTexts }) {
  const problems = [];
  const pin = pkg.dependencies?.dompurify;
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) problems.push(`package.json dompurify must be an exact version, got ${pin}`);
  else if (cmp(pin, MIN_SAFE) < 0) problems.push(`package.json dompurify ${pin} < ${MIN_SAFE}`);
  if (pkg.overrides?.dompurify !== pin) problems.push('package.json overrides.dompurify must equal the pinned version');
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path.endsWith('node_modules/dompurify') && entry.version !== pin) {
      problems.push(`${path} resolves to ${entry.version}, expected ${pin}`);
    }
  }
  if (distTexts) {
    const all = distTexts.join('\n');
    if (!all.includes(`"${pin}"`) && !all.includes(`'${pin}'`)) problems.push(`dist does not embed DOMPurify ${pin}`);
    if (vendoredVersion && vendoredVersion !== pin && (all.includes(`DOMPurify ${vendoredVersion}`) || all.includes(`DOMPurify/blob/${vendoredVersion}`))) {
      problems.push(`dist still embeds Monaco's vendored DOMPurify ${vendoredVersion}`);
    }
  }
  return problems;
}

function distTexts(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.(js|mjs)$/.test(e.name)) out.push(readFileSync(join(d, e.name), 'utf8'));
    }
  };
  walk(dir);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, '..');
  const vendored = join(root, 'node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js');
  const banner = existsSync(vendored) ? readFileSync(vendored, 'utf8').slice(0, 200).match(/DOMPurify (\d+\.\d+\.\d+)/) : null;
  const dist = join(root, 'dist');
  const problems = check({
    pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    lock: JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')),
    vendoredVersion: banner?.[1],
    distTexts: existsSync(dist) ? distTexts(dist) : null,
  });
  for (const p of problems) console.error(`check-dompurify: ${p}`);
  console.log(problems.length ? 'FAIL' : `ok (dompurify pinned, dist ${existsSync(dist) ? 'checked' : 'not built, skipped'})`);
  process.exit(problems.length ? 1 : 0);
}
