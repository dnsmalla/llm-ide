import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tasks } from '../llm_agent/runtime/handlers/session-tasks.mjs';
import {
  buildSessionTaskPromptBlock,
  taskTurnResponse,
} from '../llm_agent/runtime/task-session-context.mjs';

test('taskTurnResponse: execute mode reports pending work', () => {
  const userId = 'u-task-ctx';
  const agentContext = { chatSessionId: 'chat-1' };
  tasks.createTask(userId, 'chat-1', 'Add tests');
  const out = taskTurnResponse(userId, agentContext, 'execute');
  assert.equal(out.continueNeeded, true);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].title, 'Add tests');
});

test('taskTurnResponse: plan mode hides tasks and continueNeeded', () => {
  const userId = 'u-task-ctx-2';
  const agentContext = { chatSessionId: 'chat-2' };
  tasks.createTask(userId, 'chat-2', 'Stale task');
  const out = taskTurnResponse(userId, agentContext, 'plan');
  assert.equal(out.continueNeeded, false);
  assert.deepEqual(out.tasks, []);
});

test('buildSessionTaskPromptBlock: injects task list for execute', () => {
  const userId = 'u-task-ctx-3';
  const agentContext = { chatSessionId: 'chat-3' };
  tasks.createTask(userId, 'chat-3', 'Fix bug in parser');
  const block = buildSessionTaskPromptBlock(userId, agentContext, 'execute');
  assert.match(block, /Your current task list/);
  assert.match(block, /Fix bug in parser/);
  assert.match(block, /\(id:1\)/);
});

test('buildSessionTaskPromptBlock: empty for restricted modes', () => {
  const userId = 'u-task-ctx-4';
  const agentContext = { chatSessionId: 'chat-4' };
  tasks.createTask(userId, 'chat-4', 'Hidden');
  assert.equal(buildSessionTaskPromptBlock(userId, agentContext, 'review'), '');
});
