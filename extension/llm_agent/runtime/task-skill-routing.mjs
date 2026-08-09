// extension/llm_agent/runtime/task-skill-routing.mjs
// Keyword-based classifier mapping a self-reported task title (from
// task-create/task-update, see handlers/session-tasks.mjs) to a skill id
// under the central .skills/ repo. Deliberately NOT another LLM call —
// this runs once per turn already, alongside the existing task-list
// prompt injection in route.mjs, and a task's own title is usually
// descriptive enough for a keyword match. Order matters: first match wins,
// so more specific keywords should come before more general ones.

const TASK_TYPE_SKILLS = [
  { keywords: ['bug', 'fix', 'debug'], skillId: 'skills/systematic-debugging' },
  { keywords: ['test', 'tests'], skillId: 'skills/test-driven-development' },
  { keywords: ['doc', 'docs', 'document'], skillId: 'skills/documentation' },
  { keywords: ['review'], skillId: 'skills/code-review' },
  { keywords: ['feature'], skillId: 'skills/add-feature' },
];

/**
 * Returns the matching skill id for `title`, or null if no keyword matches.
 * Case-insensitive word-boundary match against each keyword group in order.
 */
export function classifyTaskType(title) {
  const lower = String(title ?? '').toLowerCase();
  for (const { keywords, skillId } of TASK_TYPE_SKILLS) {
    if (keywords.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(lower))) return skillId;
  }
  return null;
}
