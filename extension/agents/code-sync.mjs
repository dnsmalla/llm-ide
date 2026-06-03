// Code-sync — deterministic, no LLM.  For every task, query the KB
// `code` index (FTS5) with the task title + description and attach
// the top-N matching file references.  Designed to be fast: a large
// plan (30 tasks) costs ~30 BM25 lookups, all of which run in
// milliseconds against a typical repo.

import { findContext } from '../kb/db.mjs';

const FILES_PER_TASK = 5;

function dedupeRefs(rows) {
  // FTS5 returns chunks; many will live in the same file.  Roll up to
  // one entry per file with the best chunk's snippet so the UI stays
  // legible.
  const byRef = new Map();
  for (const r of rows) {
    const ref = r.ref || r.title?.split(':')[0] || '';
    if (!ref) continue;
    // Reject refs that look like path-traversal attempts — they could have
    // been introduced by a malicious KB ingest and would be forwarded to
    // Claude and then to codegen-apply's file reader.
    if (ref.includes('..') || ref.startsWith('/')) continue;
    if (!byRef.has(ref)) {
      byRef.set(ref, {
        ref,
        title: r.title,
        bodyExcerpt: (r.body || '').slice(0, 240),
        rank: r.rank,
      });
    }
  }
  return [...byRef.values()];
}

function searchForTask(userId, task) {
  const q = [task.title, task.description].filter(Boolean).join(' ');
  if (!q) return [];
  const ctx = findContext(userId, q, FILES_PER_TASK * 2);
  return dedupeRefs(ctx.code).slice(0, FILES_PER_TASK);
}

export function codeSync(userId, { plan }) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  const tasks = plan.tasks.map((t) => ({
    ...t,
    files: searchForTask(userId, t),
  }));
  return { ...plan, tasks };
}
