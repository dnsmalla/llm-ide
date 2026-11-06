#!/usr/bin/env node
// Status of docs/superpowers/MASTER-PLAN.md.
//
// Reads every `## ` section that holds checkbox lines and counts, per section:
//   - [x] done   - [~] partial   - [ ] not started   (- [-] retired/parked: not counted)
// then prints a table (default), JSON (--json), or verifies that the numbers in
// the plan's "Status dashboard" table equal the computed ones (--check, exit 1
// on drift). --fix rewrites the dashboard numbers in place from the checkboxes.
//
//   node scripts/plan-status.mjs [--json] [--check] [--fix] [--file <path>]
//
// Dashboard row format (first cell = the surface section title without the
// leading "S<n>. "; a "Total" row is checked against the sum):
//   | Surface | Done | Partial | Not started | Total | State |
//
// It also generates the "To execute / Needs you / Waiting" lists between the
// <!-- owner-lists:start --> and <!-- owner-lists:end --> markers from each open
// item's last owner tag: (you) or a partial item tagged with you → Needs you
// (decide, confirm or run); (wait) alone → Waiting; anything else → To execute.

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

const OWNER_TAG = /\((?:me|you|wait|core)(?:,?\s+(?:with\s+)?(?:me|you|wait|core))*\)/g;
const OPEN_BOX = /^\s*[-*]\s+\[( |~)\]\s+(.*)$/;
const START = '<!-- owner-lists:start -->';
const END = '<!-- owner-lists:end -->';

/** The owner group of one open item: 'execute', 'you' or 'wait'. */
export function ownerGroup(box, text) {
  const tags = text.match(OWNER_TAG) ?? [];
  const tag = tags.at(-1) ?? '(me)'; // untagged items are agent work until someone tags them
  const you = /\byou\b/.test(tag), me = /\b(me|core)\b/.test(tag);
  if (you && (!me || box === '~')) return 'you';
  if (/\bwait\b/.test(tag) && !me && !you) return 'wait';
  return 'execute';
}

/** A short name for an item: its text up to the first ':', ' (', ';' or ' — ', links and code reduced to text. A
 * label of three words or fewer before ':' ("Phase 0 open", "Loose ends") keeps the clause after it. */
export function itemTitle(text) {
  let t = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\*\*/g, '').replace(OWNER_TAG, '').trim();
  const colon = t.indexOf(': ');
  const short = colon > 0 && t.slice(0, colon).split(/\s+/).length <= 3 && !/ \(/.test(t.slice(0, colon));
  const head = short ? `${t.slice(0, colon)}: ` : '';
  t = short ? t.slice(colon + 2) : t;
  const cut = t.search(short ? / \(|; | — / : /: | \(|; | — /);
  if (cut > 0) t = t.slice(0, cut);
  t = head + t;
  if (t.length > 110) t = `${t.slice(0, 110).replace(/\s+\S*$/, '')}…`;
  return t.replace(/[.,\s]+$/, '');
}

/** Open items (not started or partial) with their section and owner group, in file order. */
export function openItems(md) {
  const items = [];
  let section = null;
  let fenced = false;
  let inLists = false;
  for (const line of md.split('\n')) {
    if (line.includes(START)) { inLists = true; continue; }
    if (line.includes(END)) { inLists = false; continue; }
    if (inLists) continue;
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { section = stripNumber(h[1]); continue; }
    const m = section && OPEN_BOX.exec(line);
    if (!m) continue;
    items.push({ section, partial: m[1] === '~', group: ownerGroup(m[1], m[2]), title: itemTitle(m[2]) });
  }
  return items;
}

const GROUPS = [
  ['execute', 'To execute', 'Code and docs an agent (or I) can do now, from the linked plans.'],
  ['you', 'Needs you', 'Your decision, confirmation or real run (device, account, meeting, money). Commands and steps: [USER-NEEDS.md](USER-NEEDS.md).'],
  ['wait', 'Waiting', 'Time-gated: real usage or data must accumulate first.'],
];

/** The generated lists (markers included). Plain bullets, never checkboxes, so the dashboard does not count them. */
export function renderOwnerLists(md) {
  const items = openItems(md);
  const out = [START, '_Generated by `node scripts/plan-status.mjs --fix` from the owner tags below; edit the items, not this list. `~` = built, partly done._', ''];
  for (const [key, name, about] of GROUPS) {
    const mine = items.filter((i) => i.group === key);
    out.push(`### ${name} (${mine.length})`, '', about, '');
    let last = null;
    for (const i of mine) {
      if (i.section !== last) { out.push(`- **${i.section}**`); last = i.section; }
      out.push(`  - ${i.partial ? '~ ' : ''}${i.title}`);
    }
    out.push('');
  }
  out.push(END);
  return out.join('\n');
}

function currentOwnerLists(md) {
  const a = md.indexOf(START), b = md.indexOf(END);
  return a >= 0 && b > a ? md.slice(a, b + END.length) : null;
}

export function fixOwnerLists(md) {
  const cur = currentOwnerLists(md);
  return cur === null ? md : md.replace(cur, () => renderOwnerLists(md));
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
    fs.writeFileSync(o.file, fixOwnerLists(fixDashboard(md)));
    console.log(`dashboard numbers and owner lists rewritten in ${path.relative(ROOT, o.file)}`);
    return;
  }
  const sections = parseSections(md);
  if (o.check) {
    const problems = checkDashboard(md);
    const lists = currentOwnerLists(md);
    if (lists !== null && lists !== renderOwnerLists(md)) problems.push('the To execute / Needs you / Waiting lists are out of date');
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
