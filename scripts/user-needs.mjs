#!/usr/bin/env node
// Open and done counts for docs/superpowers/USER-NEEDS.md.
//
// Counts `- [ ]` (open) and `- [x]` (done) checkbox lines per `## ` section
// (fenced code ignored; indented sub-bullets without a box are not counted),
// prints a table, and keeps the line
//   Open count: <open> open, <done> done, <total> total
// in sync: --check exits 1 on drift, --fix rewrites it. Read-only otherwise.
//
//   node scripts/user-needs.mjs [--check] [--fix] [--file <path>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FILE = path.join(ROOT, 'docs/superpowers/USER-NEEDS.md');

const BOX = /^[-*]\s+\[( |x|X)\]\s/; // top-level items only
const COUNT_LINE = /^Open count: (\d+) open, (\d+) done, (\d+) total[ \t]*$/m;

export function parseSections(md) {
  const sections = [];
  let cur = null;
  let fenced = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { cur = { title: h[1], open: 0, done: 0 }; sections.push(cur); continue; }
    const m = cur && BOX.exec(line);
    if (m) { if (m[1] === ' ') cur.open++; else cur.done++; }
  }
  return sections.filter((s) => s.open + s.done > 0);
}

export function totals(sections) {
  const open = sections.reduce((n, s) => n + s.open, 0);
  const done = sections.reduce((n, s) => n + s.done, 0);
  return { open, done, total: open + done };
}

export const countLine = (t) => `Open count: ${t.open} open, ${t.done} done, ${t.total} total`;

export function checkCount(md) {
  const t = totals(parseSections(md));
  const m = COUNT_LINE.exec(md);
  if (!m) return { ok: false, message: 'missing "Open count:" line', expected: countLine(t) };
  const ok = +m[1] === t.open && +m[2] === t.done && +m[3] === t.total;
  return { ok, message: ok ? 'ok' : `"${m[0]}" should be "${countLine(t)}"`, expected: countLine(t) };
}

export function fixCount(md) {
  const line = countLine(totals(parseSections(md)));
  return COUNT_LINE.test(md) ? md.replace(COUNT_LINE, line) : md;
}

export function formatTable(sections) {
  const w = Math.max(7, ...sections.map((s) => s.title.length));
  const row = (a, b, c, d) => `${a.padEnd(w)}  ${String(b).padStart(5)}  ${String(c).padStart(5)}  ${String(d).padStart(5)}`;
  const t = totals(sections);
  return [row('Section', 'Open', 'Done', 'Total'),
    ...sections.map((s) => row(s.title, s.open, s.done, s.open + s.done)),
    row('Total', t.open, t.done, t.total)].join('\n');
}

export function parseArgs(argv) {
  const o = { check: false, fix: false, file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') o.check = true;
    else if (argv[i] === '--fix') o.fix = true;
    else if (argv[i] === '--file') o.file = path.resolve(argv[++i] ?? '');
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  let md = fs.readFileSync(o.file, 'utf8');
  if (o.fix) {
    const fixed = fixCount(md);
    if (fixed !== md) fs.writeFileSync(o.file, fixed);
    md = fixed;
  }
  console.log(formatTable(parseSections(md)));
  if (o.check) {
    const r = checkCount(md);
    if (!r.ok) { console.error(`user-needs: ${r.message}`); process.exit(1); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
