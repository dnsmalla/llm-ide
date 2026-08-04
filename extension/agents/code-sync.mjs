// Code-sync — deterministic, no LLM.  For every task, ask the code
// graph (graphkit) for the top-N file references and compiler-derived
// symbols matching the task title + description.  Each task runs two
// graphkit passes: an FTS-backed code-ref lookup (findRelatedCode) and
// a symbol seed→expand→hydrate over the SCIP graph (findRelatedSymbols).
// The rollup/traversal-hygiene logic lives in graphkit so every graph
// consumer shares it.

import { findRelatedCode, findRelatedSymbols } from '../graphkit/index.mjs';

const FILES_PER_TASK = 5;

export function codeSync(userId, { plan }) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  const tasks = plan.tasks.map((t) => {
    const q = [t.title, t.description].filter(Boolean).join(' ');
    return {
      ...t,
      files: findRelatedCode(userId, q, FILES_PER_TASK),
      symbols: findRelatedSymbols(userId, q, { hops: 1, limit: FILES_PER_TASK }),
    };
  });
  return { ...plan, tasks };
}
