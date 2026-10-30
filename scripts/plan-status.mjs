#!/usr/bin/env node
// Status of docs/superpowers/MASTER-PLAN.md.
//
// Reads every `## ` section that holds checkbox lines and counts, per section:
//   - [x] done   - [~] partial   - [ ] not started
// then prints a table (default), JSON (--json), or verifies that the numbers in
// the plan's "Status dashboard" table equal the computed ones (--check, exit 1
// on drift). --fix rewrites the dashboard numbers in place from the checkboxes.
//
//   node scripts/plan-status.mjs [--json] [--check] [--fix] [--file <path>]
//
// Dashboard row format (first cell = the surface section title without the
// leading "S<n>. "; a "Total" row is checked against the sum):
//   | Surface | Done | Partial | Not started | Total | State |

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FILE = path.join(ROOT, 'docs/superpowers/MASTER-PLAN.md');

const BOX = /^\s*[-*]\s+\[( |x|X|~)\]\s/;
const stripNumber = (title) => title.replace(/^S\d+\.\s+/, '').trim();

/** Sections with their counts, in file order. Fenced code is ignored. */
export function parseSections(md) {
  const sections = [];
  let cur = null;
  let fenced = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = { title: stripNumber(h[1]), done: 0, partial: 0, todo: 0 };
      sections.push(cur);
      continue;
    }
    const m = cur && BOX.exec(line);
    if (!m) continue;
    if (m[1] === ' ') cur.todo += 1;
    else if (m[1] === '~') cur.partial += 1;
    else cur.done += 1;
  }
  return sections.filter((s) => s.done + s.partial + s.todo > 0)
    .map((s) => ({ ...s, total: s.done + s.partial + s.todo }));
}

export function totals(sections) {
  const t = { title: 'Total', done: 0, partial: 0, todo: 0, total: 0 };
  for (const s of sections) for (const k of ['done', 'partial', 'todo', 'total']) t[k] += s[k];
  return t;
}

/** Rows of the dashboard table: {line index, cells, name}. */
export function dashboardRows(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s+Status dashboard/i.test(l));
  if (start < 0) return { lines, rows: [] };
  const rows = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) {
    if (!lines[i].startsWith('|')) continue;
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5 || !/^\d+$/.test(cells[1])) continue; // header / separator
    rows.push({ index: i, cells, name: cells[0] });
  }
  return { lines, rows };
}

/** List of human-readable drift problems; empty = consistent. */
export function checkDashboard(md) {
  const sections = parseSections(md);
  const byName = new Map([[totals(sections).title, totals(sections)], ...sections.map((s) => [s.title, s])]);
  const { rows } = dashboardRows(md);
  const problems = [];
  if (rows.length === 0) problems.push('no dashboard rows found under "## Status dashboard"');
  const seen = new Set();
  for (const r of rows) {
    const want = byName.get(r.name);
    if (!want) { problems.push(`dashboard row "${r.name}" matches no checklist section`); continue; }
    seen.add(r.name);
    const got = r.cells.slice(1, 5).map(Number);
    const exp = [want.done, want.partial, want.todo, want.total];
    if (got.join() !== exp.join()) {
      problems.push(`"${r.name}": dashboard ${got.join('/')} but checkboxes ${exp.join('/')} (done/partial/not started/total)`);
    }
  }
  for (const s of [...sections, totals(sections)]) {
    if (!seen.has(s.title)) problems.push(`section "${s.title}" has checkboxes but no dashboard row`);
  }
  return problems;
}

/** The markdown with every dashboard number replaced by the computed one. */
export function fixDashboard(md) {
  const sections = parseSections(md);
  const byName = new Map([['Total', totals(sections)], ...sections.map((s) => [s.title, s])]);
  const { lines, rows } = dashboardRows(md);
  for (const r of rows) {
    const want = byName.get(r.name);
    if (!want) continue;
    const cells = [...r.cells];
    [cells[1], cells[2], cells[3], cells[4]] = [want.done, want.partial, want.todo, want.total].map(String);
    lines[r.index] = `| ${cells.join(' | ')} |`;
  }
  return lines.join('\n');
}

export function formatTable(sections) {
  const rows = [...sections, totals(sections)];
  const w = Math.max(...rows.map((r) => r.title.length), 7);
  const head = `${'Surface'.padEnd(w)}  done  part  todo  total  pct`;
  const out = [head, '-'.repeat(head.length)];
  for (const r of rows) {
    const pct = r.total ? Math.round((100 * (r.done + 0.5 * r.partial)) / r.total) : 0;
    out.push(`${r.title.padEnd(w)}  ${String(r.done).padStart(4)}  ${String(r.partial).padStart(4)}  ${String(r.todo).padStart(4)}  ${String(r.total).padStart(5)}  ${String(pct).padStart(3)}%`);
  }
  return out.join('\n');
}

export function parseArgs(argv) {
  const o = { json: false, check: false, fix: false, file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--check') o.check = true;
    else if (argv[i] === '--fix') o.fix = true;
    else if (argv[i] === '--file') { i += 1; o.file = path.resolve(argv[i] ?? ''); }
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const md = fs.readFileSync(o.file, 'utf8');
  if (o.fix) {
    fs.writeFileSync(o.file, fixDashboard(md));
    console.log(`dashboard numbers rewritten in ${path.relative(ROOT, o.file)}`);
    return;
  }
  const sections = parseSections(md);
  if (o.check) {
    const problems = checkDashboard(md);
    if (problems.length) {
      console.error(`MASTER-PLAN dashboard is out of date (run: node scripts/plan-status.mjs --fix)\n- ${problems.join('\n- ')}`);
      process.exit(1);
    }
    console.log('MASTER-PLAN dashboard matches the checkboxes.');
    return;
  }
  if (o.json) console.log(JSON.stringify({ surfaces: sections, total: totals(sections) }, null, 2));
  else console.log(formatTable(sections));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
