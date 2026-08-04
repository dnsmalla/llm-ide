// SCIP index connector — mirrors connectors/git.mjs indexLocalRepo. Shells to the
// Sourcegraph `scip` CLI (loadScipIndex), parses into CGData, then:
//   - writes one kind='code' sources row per symbol (meta.source='scip') — augment,
//     coexists with the git chunk index.
//   - persists nodes/edges into code_graph_* for multi-hop traversal.
// `load` is injectable so tests feed a fixture without the real CLI.

import path from 'node:path';
import fs from 'node:fs/promises';
import { ingestSources } from '../kb/db.mjs';
import { writeCodeGraph, clearCodeGraph, deleteScipSources } from '../kb/code-graph.mjs';
import { loadScipIndex, parseScipJson } from './scip-scanner.mjs';

export async function indexScip(userId, repoPath, scipPath, opts = {}) {
  const repoId = path.resolve(repoPath);
  let stat;
  try { stat = await fs.stat(repoId); }
  catch (err) { throw new Error(`Cannot access repo ${repoId}: ${err.message}`); }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${repoId}`);

  const load = opts.load || loadScipIndex;
  const cg = parseScipJson(await load(scipPath));

  const replace = opts.replace !== false;
  if (replace) {
    deleteScipSources(userId, repoId);
    clearCodeGraph(userId, repoId);
  }

  const items = [];
  let i = 0;
  for (const n of cg.nodes) {
    const m = n.metadata || {};
    const abs = m.source_file ? path.join(repoId, m.source_file) : repoId;
    const line = m.line || 'L0';
    const parts = [n.kind || 'symbol'];
    if (m.language) parts.push(m.language);
    if (m.doc) parts.push(m.doc);
    parts.push(n.id);
    items.push({
      kind: 'code',
      ref: `${abs}:${line}`,
      chunkIdx: i,
      title: n.title || n.id,
      body: parts.join(' · '),
      meta: { source: 'scip', symbol_id: n.id, kind: n.kind || 'symbol', language: m.language || '' },
    });
    i += 1;
  }

  const written = ingestSources(userId, items);
  const graph = writeCodeGraph(userId, repoId, cg);
  return { repo: repoId, symbols: written, nodes: graph.nodes, edges: graph.edges };
}
