// Core execution adapter for the task registry. `core-route` tasks call a fixed adapter registered here; `agent`
// tasks use the registry prompt through the same Loop engine (wired in a later task). No prompt is composed here:
// the registry owns it. Shell and desktop-action tasks are refused: they need the Tauri host.
import { config } from '../core/config.mjs';
import { ALIASES, TASK_BY_ID } from '../core/task-registry.generated.mjs';
import { runPlanStatus } from './tasks/plan-status.mjs';

export class TaskCoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TaskCoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function resolveTask(idOrAlias) {
  const id = Object.hasOwn(TASK_BY_ID, idOrAlias) ? idOrAlias : Object.hasOwn(ALIASES, idOrAlias) ? ALIASES[idOrAlias] : null;
  if (id === null) return null;
  const task = TASK_BY_ID[id] ?? null;
  if (task?.availability.status === 'alias' && task.aliasOf && Object.hasOwn(TASK_BY_ID, task.aliasOf)) return TASK_BY_ID[task.aliasOf];
  return task;
}

function featureRefusal(task) {
  const enabled = config.features;
  if (enabled === null || enabled === undefined) return null;
  const missing = task.features.find((f) => !enabled.has(f));
  return missing ?? null;
}

/**
 * Run one registry task inside the core.
 * @returns {Promise<{taskId: string, runner: string, ok: boolean, summary: string, output: string, warnings: string[], code?: string}>}
 */
export async function runCoreTask({ taskId, userId, projectRoot, args = {}, signal, emit, deps = {} }) {
  const task = resolveTask(taskId);
  if (!task) throw new TaskCoreError('TASK_NOT_FOUND', `Unknown task "${taskId}".`);
  if (task.availability.status !== 'available') {
    throw new TaskCoreError('TASK_NOT_AVAILABLE', task.availability.reason ?? `Task "${task.id}" is ${task.availability.status}.`);
  }
  const missing = featureRefusal(task);
  if (missing) throw new TaskCoreError('feature_disabled', `The ${missing} feature is off.`, { feature: missing });
  const runner = task.runner;
  if (!runner) throw new TaskCoreError('TASK_NOT_AVAILABLE', `Task "${task.id}" has no runner.`);
  if (runner.kind === 'shell' || runner.kind === 'desktop-action') {
    throw new TaskCoreError('TASK_LOCAL_ONLY', `Task "${task.id}" needs the desktop app.`);
  }
  if (runner.kind === 'agent') {
    throw new TaskCoreError('TASK_NOT_IMPLEMENTED', `The agent runner for "${task.id}" is not wired yet.`);
  }
  if (runner.kind !== 'core-route') throw new TaskCoreError('TASK_BAD_RUNNER', `Task "${task.id}" has an unknown runner.`);

  if (runner.route === 'sources-update') {
    const run = deps.runSourcesUpdate;
    if (typeof run !== 'function') throw new TaskCoreError('TASK_NOT_IMPLEMENTED', 'sources.update is not wired in this process.');
    if (signal?.aborted) return { taskId: task.id, runner: 'core-route', ok: false, summary: 'cancelled', output: '', warnings: [], code: 'cancelled' };
    emit?.('progress', { step: 'syncing sources' });
    try {
      const result = await run({ userId, args, signal, projectRoot, emit });
      const text = typeof result?.text === 'string' ? result.text : `Synced ${result?.synced ?? 0} source(s).`;
      return { taskId: task.id, runner: 'core-route', ok: true, summary: text, output: text, warnings: [], result };
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : 'TASK_FAILED';
      return { taskId: task.id, runner: 'core-route', ok: false, summary: err instanceof Error ? err.message : String(err), output: '', warnings: [], code };
    }
  }
  if (runner.route === 'plan-status') {
    try {
      const result = await runPlanStatus({ userId, creds: deps.creds, deps });
      return { taskId: task.id, runner: 'core-route', ok: true, summary: result.summary, output: result.output, warnings: [], result: result.result };
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : 'TASK_FAILED';
      return { taskId: task.id, runner: 'core-route', ok: false, summary: err instanceof Error ? err.message : String(err), output: '', warnings: [], code };
    }
  }
  throw new TaskCoreError('TASK_BAD_ROUTE', `No adapter is registered for "${runner.route}".`);
}
