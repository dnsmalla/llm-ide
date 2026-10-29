#!/usr/bin/env node
// Note-index baseline benchmark (read-only; never touches the live DB).
//
//   node scripts/bench-note-index.mjs [--sizes 10000,50000] [--corpus 5000] [--json]
//
// Phase 0 of docs/superpowers/plans/2026-10-29-live-then-archive.md (T0.3):
// measures the section 3.8 budget table on SYNTHETIC data in a throwaway DB
// under os.tmpdir(). `note_index` does not exist yet, so every row below is a
// PROXY on today's `meetings` table, which rides the same `search` FTS5 table
// the new index will reuse:
//   search     real kb.search() on a seeded corpus (ranking + hydration), 5
//              queries incl. CJK and a 2-character term, kind=meeting
//   hydrate    kb.getMeeting() by id (the single-row read path)
//   upsert     one INSERT ... ON CONFLICT DO UPDATE of a 20 KB note (trigger +
//              FTS write), p50/p95 over 200 notes
//   reconcile  manifest compare of N (note_key, content_hash) pairs against a
//              table scan, in SQL (a scratch table, not a migration)
//   rebuild    N notes of 20 KB in batches of 100 per transaction (the
//              planned POST /kb/index/notes batch size)
//   scan       writes N Mac-shaped note files and times a Node
//              readdir + read + frontmatter split + sha256 pass (a lower
//              bound for the Swift FolderIndexer; I/O + hash only)
// Content is generated, not copied from anything real.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const sizes = String(arg('--sizes', '10000,50000')).split(',').map(Number).filter(Boolean);
const corpusN = Number(arg('--corpus', '5000'));
const jsonOnly = process.argv.includes('--json');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bench-note-index-'));
const tmpDb = path.join(tmpRoot, 'bench.db');
process.env.LLMIDE_DB_PATH = tmpDb;
process.env.LLMIDE_JWT_SECRET ||= 'b'.repeat(48);
process.env.LLMIDE_VAULT_KEY ||= 'c'.repeat(48);
process.env.NODE_ENV = 'test';
const cleanup = () => fs.rmSync(tmpRoot, { recursive: true, force: true });
process.once('SIGINT', () => { cleanup(); process.exit(130); });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

// ── synthetic text ────────────────────────────────────────────────
let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const EN = ('alpha budget calendar deploy review sprint backlog release migration latency cache index ' +
  'planning roadmap incident rollback customer pricing contract security audit onboarding vendor ' +
  'quarter forecast hiring design prototype feedback metrics dashboard pipeline schema retry timeout').split(' ');
const JA = ['会議', '予算', '設計', '見積', '納期', '障害', '対応', '契約', '開発', '検討', '資料', '共有'];
const word = () => (rnd() < 0.08 ? JA[Math.floor(rnd() * JA.length)] : EN[Math.floor(rnd() * EN.length)]);
function text(bytes) {
  const out = [];
  let n = 0;
  while (n < bytes) { const w = word(); out.push(w); n += Buffer.byteLength(w) + 1; }
  return out.join(' ');
}
const QUERIES = ['budget review', 'rollback', 'ab', '予算', '設計 見積'];

// ── stats ─────────────────────────────────────────────────────────
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const summ = (arr) => ({ p50: r1(pct(arr, 0.5)), p95: r1(pct(arr, 0.95)), n: arr.length });
function time(fn, runs) {
  const t = [];
  for (let i = 0; i < runs; i++) { const a = performance.now(); fn(i); t.push(performance.now() - a); }
  return summ(t);
}

const results = { machine: {}, corpora: {} };
results.machine = {
  node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30),
  tmpdir: os.tmpdir(),
};

const U = users.registerUser(db.getDb(), {
  email: `bench-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'bench',
}).id;
const d = db.getDb();
const insMeeting = d.prepare(`
  INSERT INTO meetings (id, user_id, title, date, duration_sec, language, participants, transcript, meta)
  VALUES (@id, @user_id, @title, @date, @duration_sec, @language, @participants, @transcript, @meta)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, transcript=excluded.transcript, meta=excluded.meta`);
function seedRows(from, to, bytes) {
  const tx = d.transaction((a, b) => {
    for (let i = a; i < b; i++) {
      insMeeting.run({
        id: `m-${i}`, user_id: U, title: `${word()} ${word()} sync ${i}`,
        date: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
        duration_sec: 1800, language: 'en', participants: '["a","b"]',
        transcript: text(bytes), meta: JSON.stringify({ projectId: `p${i % 5}` }),
      });
    }
  });
  for (let a = from; a < to; a += 1000) tx(a, Math.min(to, a + 1000));
}

let have = 0;
for (const n of sizes) {
  const t0 = performance.now();
  seedRows(have, n, 2048);
  have = n;
  const seedMs = performance.now() - t0;
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const out = { rows: n, seedSec: r1(seedMs / 1000), dbMiB: Math.round(fs.statSync(tmpDb).size / 2 ** 20) };
  // warm: one pass of each query so page cache state is comparable
  for (const q of QUERIES) db.search(U, { q, kind: 'meeting', limit: 20 });
  out.search = {};
  const all = [];
  for (const q of QUERIES) {
    const s = time(() => db.search(U, { q, kind: 'meeting', limit: 20 }), 20);
    out.search[q] = s;
    all.push(s.p95);
  }
  out.searchWorstP95 = Math.max(...all);
  out.searchNoKind = summ(Array.from({ length: 20 }, () => {
    const a = performance.now(); db.search(U, { q: 'budget review', limit: 20 }); return performance.now() - a;
  }));
  out.listEmptyQuery = time(() => db.search(U, { q: '', kind: 'meeting', limit: 100 }), 20);
  out.hydrateGetMeeting = time((i) => db.getMeeting(U, `m-${(i * 7919) % n}`), 200);

  // reconcile proxy: manifest of min(n, 5000) keys vs. a table scan
  const m = Math.min(n, 5000);
  d.exec('DROP TABLE IF EXISTS bench_note_index');
  d.exec('CREATE TABLE bench_note_index (user_id TEXT, project_id TEXT, note_key TEXT, content_hash TEXT, UNIQUE(user_id, project_id, note_key))');
  const insIdx = d.prepare('INSERT INTO bench_note_index VALUES (?,?,?,?)');
  d.transaction(() => { for (let i = 0; i < m; i++) insIdx.run(U, 'p0', `meetings/2026/01/n-${i}.md`, `h${i}`); })();
  const manifest = Array.from({ length: m }, (_, i) => ({ noteKey: `meetings/2026/01/n-${i}.md`, contentHash: i % 50 === 0 ? 'changed' : `h${i}` }));
  out.reconcileCompare = { manifestNotes: m, manifestKiB: Math.round(Buffer.byteLength(JSON.stringify(manifest)) / 1024), ...time(() => {
    const rows = d.prepare('SELECT note_key, content_hash FROM bench_note_index WHERE user_id = ? AND project_id = ?').all(U, 'p0');
    const idx = new Map(rows.map((r) => [r.note_key, r.content_hash]));
    let missing = 0, stale = 0;
    for (const e of manifest) { const h = idx.get(e.noteKey); if (h === undefined) missing++; else if (h !== e.contentHash) stale++; }
    const keys = new Set(manifest.map((e) => e.noteKey));
    let extra = 0; for (const k of idx.keys()) if (!keys.has(k)) extra++;
    return { missing, stale, extra };
  }, 20) };
  d.exec('DROP TABLE bench_note_index');
  results.corpora[n] = out;
}

// single-note upsert proxy + rebuild proxy, on the larger corpus
{
  const big = 20 * 1024;
  const notes = Array.from({ length: 200 }, (_, i) => ({ id: `u-${i}`, body: text(big) }));
  out_upsert();
  function out_upsert() {
    const t = [];
    for (const nt of notes) {
      const a = performance.now();
      insMeeting.run({ id: nt.id, user_id: U, title: `upsert ${nt.id}`, date: new Date().toISOString(), duration_sec: 0,
        language: 'en', participants: '[]', transcript: nt.body, meta: '{}' });
      t.push(performance.now() - a);
    }
    results.upsert20KiB = summ(t);
    // second pass = ON CONFLICT DO UPDATE (trigger deletes + reinserts FTS)
    const t2 = [];
    for (const nt of notes) {
      const a = performance.now();
      insMeeting.run({ id: nt.id, user_id: U, title: `upsert2 ${nt.id}`, date: new Date().toISOString(), duration_sec: 0,
        language: 'en', participants: '[]', transcript: nt.body, meta: '{}' });
      t2.push(performance.now() - a);
    }
    results.upsertUpdate20KiB = summ(t2);
  }
  const a = performance.now();
  const tx = d.transaction((from, to) => {
    for (let i = from; i < to; i++) {
      insMeeting.run({ id: `r-${i}`, user_id: U, title: `rebuild ${i}`, date: new Date().toISOString(), duration_sec: 0,
        language: 'en', participants: '[]', transcript: text(big), meta: '{}' });
    }
  });
  for (let i = 0; i < 5000; i += 100) tx(i, i + 100);
  results.rebuild5000x20KiBSec = r1((performance.now() - a) / 1000);
  results.rebuildNote = 'includes text generation time (~tens of ms per 100 notes); batch = 100 per transaction';
}

// Mac-corpus scan proxy (Node, I/O + frontmatter split + sha256)
{
  const root = path.join(tmpRoot, 'source', 'meetings');
  const wa = performance.now();
  for (let i = 0; i < corpusN; i++) {
    const dir = path.join(root, '2026', String((i % 12) + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const fm = `---\nid: ${crypto.randomUUID()}\ntitle: ${word()} ${i}\nstarted_at: 2026-01-01T10:00:00Z\nparticipants:\n- a\n- b\nplatform: meet\nlanguage: en\ntldr: []\n---\n\n## Transcript\n\n`;
    fs.writeFileSync(path.join(dir, `2026-01-01-n-${i}-${String(i).padStart(8, '0')}.md`), fm + text(20 * 1024));
  }
  const writeSec = (performance.now() - wa) / 1000;
  const scan = () => {
    const a = performance.now();
    let n = 0; let bytes = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (!e.name.endsWith('.md') || e.name.endsWith('.partial.md')) continue;
        const c = fs.readFileSync(f, 'utf8');
        const close = c.indexOf('\n---\n', 4);
        void c.slice(4, close);
        crypto.createHash('sha256').update(c).digest('hex');
        n++; bytes += c.length;
      }
    };
    walk(root);
    return { files: n, MiB: Math.round(bytes / 2 ** 20), ms: Math.round(performance.now() - a) };
  };
  results.corpusScanNode = { writeCorpusSec: r1(writeSec), warm: scan(), warm2: scan() };
}

// note_index trigger path (live-then-archive T1.1, F12): 10 000 seeded rows of
// 2 KiB, then 200 updates and 200 inserts of 20 KiB bodies through the real
// AFTER UPDATE / AFTER INSERT triggers (rowid-mapped FTS). Budget: p95 under 20 ms.
{
  const ni = d.prepare('INSERT INTO note_index (user_id, project_id, note_key, title, date, body_text, content_hash, mtime_ms) VALUES (?,?,?,?,?,?,?,?)');
  const small = text(2048);
  d.transaction(() => {
    for (let i = 0; i < 10000; i++) ni.run(U, 'p0', `seed/${i}.md`, `seed ${i}`, '2026-01-01T00:00:00.000Z', small, `s${i}`, i);
  })();
  const upd = d.prepare('UPDATE note_index SET body_text = ?, content_hash = ? WHERE user_id = ? AND project_id = ? AND note_key = ?');
  const bodies = Array.from({ length: 200 }, () => text(20 * 1024));
  const updMs = bodies.map((b, i) => {
    const a = performance.now();
    upd.run(b, `u${i}`, U, 'p0', `seed/${i}.md`);
    return performance.now() - a;
  });
  const insMs = bodies.map((b, i) => {
    const a = performance.now();
    ni.run(U, 'p0', `new/${i}.md`, `new ${i}`, '2026-01-02T00:00:00.000Z', b, `n${i}`, i);
    return performance.now() - a;
  });
  results.noteIndex10k = {
    rows: 10000,
    update20KiB: summ(updMs),
    insert20KiB: summ(insMs),
    budgetP95Ms: 20,
    ftsRowsMatchNotes: d.prepare("SELECT COUNT(*) AS n FROM search WHERE meeting_id LIKE 'n:%'").get().n
      === d.prepare('SELECT COUNT(*) AS n FROM note_index').get().n,
  };
}

cleanup();
if (jsonOnly) console.log(JSON.stringify(results));
else console.log(JSON.stringify(results, null, 2));
