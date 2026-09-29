#!/usr/bin/env node
// find-code retrieval benchmark (read-only; never touches the live DB).
//
//   npm run bench:retrieval -- --graph <graph.json> --repo <abs repo path> [--json]
//
// <graph.json> is a code graph in the Mac upload's wire shape
// ({ nodes:[{id,title,kind,metadata:{source_file,line,language,doc}}], edges:[{fromId,toId,kind,confidence}] })
// — produce it with the graph-kit scanner over <repo>. The script builds a
// throwaway DB in the temp dir (graph + FTS index), runs every question in
// retrieval-bench.questions.json through find-code, and reports:
//   hit@3        a top-3 symbol's title is an expected symbol, or its file is an expected file
//   hitAnywhere  an expected file/symbol appears anywhere in the result (symbols, related, files)
//   chars        the JSON payload the model would receive
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const graphPath = arg('--graph');
const repo = arg('--repo') && path.resolve(arg('--repo'));
const jsonOnly = process.argv.includes('--json');
if (!graphPath || !repo) {
  console.error('usage: retrieval-bench.mjs --graph <graph.json> --repo <abs repo path> [--json]');
  process.exit(2);
}

const tmpDb = path.join(os.tmpdir(), `llmide-bench-${process.pid}.db`);
process.env.LLMIDE_DB_PATH = tmpDb;
process.env.LLMIDE_JWT_SECRET ||= 'b'.repeat(48);
process.env.LLMIDE_VAULT_KEY ||= 'c'.repeat(48);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true }); };

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { ingestStructureGraph } = await import('../connectors/structure-graph.mjs');
const { indexLocalRepo } = await import('../connectors/git.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');

try {
  const U = users.registerUser(db.getDb(), { email: `bench-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'bench' }).id;
  db.addUserRepo(U, repo);
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  let head = null;
  try { head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git repo */ }
  // Upload in batches like the Mac does (the server caps one request): every
  // node first, so no edge batch references a node not yet written.
  for (let i = 0; i < Math.max(1, graph.nodes.length); i += 5000) {
    ingestStructureGraph(U, repo, { nodes: graph.nodes.slice(i, i + 5000), edges: [] },
      { replace: i === 0, commitSha: head });
  }
  for (let i = 0; i < graph.edges.length; i += 20000) {
    ingestStructureGraph(U, repo, { nodes: [], edges: graph.edges.slice(i, i + 20000) }, {});
  }
  await indexLocalRepo(U, repo);

  const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'retrieval-bench.questions.json'), 'utf8'));
  const endsWithAny = (p, files) => files.some((f) => String(p || '').endsWith(f));
  const rows = questions.map(({ q, files, symbols }) => {
    const out = handleFindCode({ query: q }, { userId: U, roots: [repo], workspaceRoot: repo, activeRepoRoot: repo, freshnessCacheMs: 0 });
    const top3 = (out.symbols || []).slice(0, 3);
    const hit3 = top3.some((s) => symbols.includes(s.name) || endsWithAny(s.path, files));
    const all = [...(out.symbols || []), ...(out.related || [])];
    const anywhere = hit3
      || all.some((s) => symbols.includes(s.name) || endsWithAny(s.path, files))
      || (out.files || []).some((f) => endsWithAny(f.path, files));
    return { q, hit3, anywhere, chars: JSON.stringify(out).length, top3: top3.map((s) => `${s.name} (${s.path})`) };
  });

  const sorted = rows.map((r) => r.chars).sort((a, b) => a - b);
  const summary = {
    questions: rows.length,
    hitAt3: rows.filter((r) => r.hit3).length,
    hitAnywhere: rows.filter((r) => r.anywhere).length,
    medianChars: sorted[Math.floor(sorted.length / 2)],
    totalChars: sorted.reduce((a, b) => a + b, 0),
  };
  if (jsonOnly) {
    console.log(JSON.stringify(summary));
  } else {
    for (const r of rows) {
      console.log(`${r.hit3 ? 'HIT3' : r.anywhere ? 'ANY ' : 'MISS'}  ${String(r.chars).padStart(6)}  ${r.q}`);
      console.log(`        top3: ${r.top3.join(' | ') || '(none)'}`);
    }
    console.log(`\nhit@3 ${summary.hitAt3}/${summary.questions} · anywhere ${summary.hitAnywhere}/${summary.questions} · median ${summary.medianChars} chars · total ${summary.totalChars} chars`);
  }
} finally {
  db.closeDb();
  cleanup();
}
