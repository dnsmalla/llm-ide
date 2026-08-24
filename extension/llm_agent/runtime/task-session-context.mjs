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
