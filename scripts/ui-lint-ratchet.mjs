#!/usr/bin/env node
// Hook-bug ratchet for the React/TS trees outside extension/ (`make lint-ui`).
//
// Runs ESLint (config: extension/eslint.ui.config.mjs, binary from
// extension/node_modules) and compares the per-file problem counts with
// scripts/ui-lint-baseline.json ({ "<file>": { "errors": n, "warnings": n } }).
// Fails when a file has more errors OR more warnings than its baseline, or a
// file not in the baseline has any. Improvements pass; run with --update to
// rewrite the baseline after fixing (it may only shrink in review).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const BASELINE = join(ROOT, 'scripts', 'ui-lint-baseline.json');
const ESLINT = join(ROOT, 'extension', 'node_modules', '.bin', 'eslint');
const TREES = ['ui/screens', 'ui/kit/src', 'desktop/src', 'web/src'];

if (!existsSync(ESLINT)) {
  console.error('lint-ui: extension/node_modules missing; run: npm ci --prefix extension');
  process.exit(1);
}

const out = join(mkdtempSync(join(tmpdir(), 'ui-lint-')), 'eslint.json');
const run = spawnSync(
  ESLINT,
  ['--config', 'extension/eslint.ui.config.mjs', '-f', 'json', '-o', out, ...TREES],
  { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
);
if (!existsSync(out) || (run.status !== 0 && run.status !== 1)) {
  console.error('lint-ui: eslint did not complete (exit ' + run.status + ')');
  process.exit(2);
}

const current = {};
for (const file of JSON.parse(readFileSync(out, 'utf8'))) {
  const errors = file.messages.filter((m) => m.severity === 2).length;
  const warnings = file.messages.filter((m) => m.severity === 1).length;
  if (errors + warnings > 0) current[relative(ROOT, file.filePath)] = { errors, warnings };
}

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log('lint-ui: baseline written (' + Object.keys(sorted).length + ' files)');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const failures = [];
for (const [file, now] of Object.entries(current)) {
  const max = baseline[file] ?? { errors: 0, warnings: 0 };
  if (now.errors > max.errors || now.warnings > max.warnings) {
    failures.push(`${file}: errors ${now.errors}/${max.errors}, warnings ${now.warnings}/${max.warnings} (now/allowed)`);
  }
}
if (failures.length > 0) {
  console.error('lint-ui: new React hook problems (see `extension/node_modules/.bin/eslint --config extension/eslint.ui.config.mjs <file>`):');
  for (const line of failures) console.error('  ' + line);
  process.exit(1);
}
console.log('lint-ui: ok (' + Object.keys(current).length + ' files with baselined hook problems)');
