// Code-sync — deterministic, no LLM.  For every task, ask the code
// graph (graphkit) for the top-N file references matching the task
// title + description.  Designed to be fast: a large plan (30 tasks)
// costs ~30 BM25 lookups, all of which run in milliseconds against a
// typical repo.  The rollup/traversal-hygiene logic lives in graphkit
// so every graph consumer shares it.

import { findRelatedCode } from '../graphkit/index.mjs';

const FILES_PER_TASK = 5;

export function codeSync(userId, { plan }) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  const tasks = plan.tasks.map((t) => ({
    ...t,
    files: findRelatedCode(userId, [t.title, t.description].filter(Boolean).join(' '), FILES_PER_TASK),
  }));
  return { ...plan, tasks };
}
