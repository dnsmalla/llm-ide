// Shared session-task prompt injection + turn response fields for legacy
// /code-assist (route.mjs) and Agent v2 (sdk/engine.mjs, routes/agent-v2.mjs).
// All three sites MUST use the same session id resolver and the same
// restrictsTools gate — otherwise tasks written by tools would not match
// what the prompt shows or what continueNeeded reports.

import { tasks, taskStatusIcon } from './handlers/session-tasks.mjs';
import { resolveChatSessionId } from '../../kb/session-memory.mjs';
import { restrictsTools } from './mode-personas.mjs';
import { classifyTaskType } from './task-skill-routing.mjs';
import { readSkillInstructions } from '../skills/skill-library.mjs';

/** Tasks + continueNeeded for one turn's HTTP/SSE response. */
export function taskTurnResponse(userId, agentContext, mode) {
  const sessionId = resolveChatSessionId(agentContext);
  if (restrictsTools(mode)) {
    return { tasks: [], continueNeeded: false };
  }
  return {
    tasks: tasks.listTasks(userId, sessionId),
    continueNeeded: tasks.hasPendingWork(userId, sessionId),
  };
}

/**
 * Live task-progress emitter for one turn's SSE stream, shared by BOTH
 * engines' routes (routes/agent-v2.mjs and server/ai-routes.mjs's legacy
 * /code-assist stream) so the wire event and its dedupe rule have exactly
 * one definition.
 *
 * Returns a closure the route calls after each tool event; it re-reads the
 * session task list and sends `{type:'tasks_progress', tasks}` only when
 * the list actually changed since the last emission. Deliberately a
 * SEPARATE event type from the terminal `tasks`: that one also carries
 * `continueNeeded`, which the Mac auto-chains on — mid-turn that answer is
 * always "work remains", and acting on it would stack a second turn on the
 * one still running, so this event carries the list only.
 *
 * Task bookkeeping must never break a turn's stream — every failure path
 * inside returns silently.
 */
export function makeTaskProgressEmitter({ userId, agentContext, mode, send }) {
  let lastSignature = null;
  return () => {
    let current;
    try {
      ({ tasks: current } = taskTurnResponse(userId, agentContext, mode));
    } catch { return; }
    if (!Array.isArray(current) || current.length === 0) return;
    const signature = current.map((t) => `${t.id}:${t.status}:${t.title}`).join('|');
    if (signature === lastSignature) return;
    lastSignature = signature;
    try { send({ type: 'tasks_progress', tasks: current }); } catch { /* stream over */ }
  };
}

/**
 * Prompt block listing session tasks + optional skill guidance for the
 * active task. Returns "" when the mode restricts tools or no tasks exist.
 */
export function buildSessionTaskPromptBlock(userId, agentContext, mode) {
  if (restrictsTools(mode)) return '';
  const sessionId = resolveChatSessionId(agentContext);
  const sessionTasks = tasks.listTasks(userId, sessionId);
  if (sessionTasks.length === 0) return '';

  const taskLines = sessionTasks
    .map((t) => `- ${taskStatusIcon(t.status)} (id:${t.id}) ${t.title}`)
    .join('\n');
  let block = `\n\n## Your current task list\n${taskLines}\n\nLegend: [ ] pending  [~] in_progress  [x] completed  [-] skipped  [!] failed`;

  const activeTask = sessionTasks.find((t) => t.status === 'in_progress')
                   || sessionTasks.find((t) => t.status === 'pending');
  if (activeTask) {
    const skillId = classifyTaskType(activeTask.title);
    const instructions = skillId ? readSkillInstructions(skillId, userId) : null;
    if (instructions) {
      block += `\n\n## Guidance for your current task ("${activeTask.title}")\n${instructions.content}`;
    }
  }
  return block;
}
