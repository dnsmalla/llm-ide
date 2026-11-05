// Fails if the service imports anything but node: built-ins, its own files and the three
// allowed dependencies, or if package.json gains a dependency. Keeps extension/ and AI code out.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))) + sep;
const ALLOWED = ['@simplewebauthn/server', 'better-sqlite3', 'nodemailer'];
const problems = [];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {}).sort();
if (JSON.stringify(deps) !== JSON.stringify(ALLOWED)) problems.push(`package.json dependencies must be exactly ${ALLOWED.join(', ')}`);
if (pkg.devDependencies && Object.keys(pkg.devDependencies).length) problems.push('package.json must have no devDependencies');

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith('.mjs')) check(path);
  }
}

function check(file) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const ok = spec.startsWith('node:')
      || ALLOWED.some((d) => spec === d || spec.startsWith(`${d}/`))
      || ((spec.startsWith('./') || spec.startsWith('../')) && resolve(dirname(file), spec).startsWith(root));
    if (!ok) problems.push(`${file.slice(root.length)}: importing "${spec}" is not allowed`);
  }
}

for (const dir of ['src', 'bin', 'scripts', 'tests']) {
  try { walk(join(root, dir)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('account-service boundary: ok');
