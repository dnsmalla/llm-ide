// The task registry's HTTP adapter (feature auto_tasks). Every task's prompt/route is fixed by the registry; this
// route never accepts a prompt, a command or a repo path. The desktop is the only caller (D14): a JWT-only or hub
// caller gets 403 HOST_PROOF_REQUIRED before the body is read.
import { getDb } from '../kb/db.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { authorizeAction } from '../server/route-authority.mjs';
import { getSecret } from '../server/vault.mjs';
import { config } from '../core/config.mjs';
import { TASKS } from '../core/task-registry.generated.mjs';
import { runCoreTask, TaskCoreError } from '../agents/task-runner.mjs';
import { TASK_CLASS } from '../agents/task-classes.mjs';
import { runSourcesUpdate } from './bus/sources-update.mjs';
import { KIND_CLASS } from './bus/executor.mjs';
import { runTask, engineIdFor } from './bus/engines.mjs';
import { runGit } from './bus/git-safe.mjs';
import { scopedProjectRoot } from './bus/project-scope.mjs';
import { runReviewTask } from '../agents/tasks/review.mjs';
import { runGrouped } from '../core/process-group.mjs';

const BODY_KEYS = new Set(['projectId', 'args']);

// The agent runner's port per bus kind: the engine, git and spawn are supplied here, never imported by agents/.
const AGENT_PORTS = Object.freeze({
  review: ({ task, userId, projectRoot, args, signal, emit }) => runReviewTask({
    userId,
    args: { ...task.runner.busArgs, ...args },
    cwd: projectRoot,
    signal,
    spawn: (cmd, argv, opts = {}) => runGrouped(cmd, argv, opts),
    emit,
    deps: { runTask, engineIdFor, runGit },
  }).then((r) => ({ ok: true, summary: r.text.split('\n').find((l) => l.trim()) ?? 'completed', output: r.text, warnings: r.truncated ? ['The review was truncated.'] : [] })),
});

function publicTask(task) {
  const runner = task.runner;
  return {
    id: task.id,
    label: task.label,
    group: task.group,
    description: task.description,
    aliases: task.aliases,
    runner: runner ? {
      kind: runner.kind,
      ...(runner.route ? { route: runner.route } : {}),
      ...(runner.busKind ? { busKind: runner.busKind } : {}),
      ...(runner.action ? { action: runner.action } : {}),
      ...(runner.timeoutSeconds ? { timeoutSeconds: runner.timeoutSeconds } : {}),
    } : null,
    input: task.input,
    output: task.output,
    schedule: task.schedule,
    scope: task.scope,
    readOnly: task.readOnly,
    requiresRepo: task.requiresRepo,
    requiresLocalHost: task.requiresLocalHost,
    features: task.features,
    availability: task.availability,
    revision: task.revision,
  };
}

function taskEnabled(task) {
  const enabled = config.features;
  return enabled == null || task.features.every((f) => enabled.has(f));
}

function failure(res, status, code, message, details) {
  sendJSON(res, status, { error: { code, message, ...(details ? { details } : {}) } });
  return true;
}

export async function handleTaskRoutes(req, res, ctx) {
  const { userId } = ctx;
  const path = String(ctx.url || req.url || '').split('?')[0];
  if (!path.startsWith('/kb/tasks')) return false;

  if (req.method === 'GET' && path === '/kb/tasks') {
    const tasks = TASKS.filter(taskEnabled).filter((t) => t.availability.status === 'available' || t.availability.status === 'unported').map(publicTask);
    sendJSON(res, 200, { tasks });
    return true;
  }

  const m = /^\/kb\/tasks\/([^/]+)\/run$/.exec(path);
  if (req.method !== 'POST' || !m) {
    if (path.startsWith('/kb/tasks/')) return failure(res, 404, 'NOT_FOUND', 'Not found');
    return false;
  }

  if (!verifyBusHostProof(req)) return failure(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');

  let raw;
  try { raw = parseJSON(await readBody(req, 64 * 1024)); } catch { return failure(res, 400, 'VALIDATION_FAILED', 'Invalid JSON body'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure(res, 400, 'VALIDATION_FAILED', 'body must be an object');
  for (const key of Object.keys(raw)) if (!BODY_KEYS.has(key)) return failure(res, 400, 'VALIDATION_FAILED', `unknown field ${key.slice(0, 40)}`);
  if (raw.args !== undefined && (!raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args))) {
    return failure(res, 400, 'VALIDATION_FAILED', 'args must be an object');
  }
  if (raw.projectId !== undefined && typeof raw.projectId !== 'string') return failure(res, 400, 'VALIDATION_FAILED', 'projectId must be a string');
  const sourceIds = raw.args?.sourceIds;
  if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.length > 50 || sourceIds.some((id) => typeof id !== 'string' || id.length > 128))) {
    return failure(res, 400, 'VALIDATION_FAILED', 'sourceIds must be an array of at most 50 strings');
  }

  let taskId;
  try { taskId = decodeURIComponent(m[1]); } catch { return failure(res, 404, 'TASK_NOT_FOUND', 'Unknown task.'); }
  const task = TASKS.find((t) => t.id === taskId || t.aliases.includes(taskId));
  if (!task) return failure(res, 404, 'TASK_NOT_FOUND', `Unknown task "${taskId}".`);
  if (!taskEnabled(task)) {
    const feature = task.features.find((f) => config.features != null && !config.features.has(f));
    return failure(res, 404, 'feature_disabled', `The ${feature} feature is off.`, { feature });
  }
  if (task.availability.status !== 'available') return failure(res, 404, 'TASK_NOT_AVAILABLE', task.availability.reason ?? 'This task is not available.');
  const argSpecs = task.runner?.args ?? {};
  for (const [key, value] of Object.entries(raw.args ?? {})) {
    if (key === 'sourceIds' && task.runner?.route === 'sources-update') continue; // checked above
    const spec = argSpecs[key];
    if (!spec) return failure(res, 400, 'VALIDATION_FAILED', `unknown args field ${key.slice(0, 40)}`);
    const ok = spec.type === 'string'
      ? typeof value === 'string' && value.length <= spec.maxLength
      : Array.isArray(value) && value.length <= (spec.maxItems ?? 50) && value.every((v) => typeof v === 'string' && v.length <= spec.maxLength);
    if (!ok) return failure(res, 400, 'VALIDATION_FAILED', `args.${key.slice(0, 40)} is not valid`);
  }
  if (task.runner?.kind === 'agent' && !raw.projectId) return failure(res, 400, 'PROJECT_REQUIRED', 'This task runs on a registered project.');
  const cls = task.runner?.kind === 'core-route' ? TASK_CLASS[task.runner.route] : task.runner?.kind === 'agent' ? KIND_CLASS[task.runner.busKind] : null;
  if ((task.runner?.kind === 'core-route' || task.runner?.kind === 'agent') && !cls) {
    return failure(res, 400, 'TASK_BAD_ROUTE', `Task "${task.id}" has no action class.`);
  }
  if (cls) {
    const decision = authorizeAction(getDb(), userId, cls, { req, ...(raw.projectId ? { projectId: raw.projectId } : {}) });
    if (!decision.ok) return failure(res, decision.status, decision.code, decision.message);
  }
  // An agent task runs in one registered project; the root is the same realpath-checked one a bus job runs in.
  let projectRoot = null;
  if (task.runner?.kind === 'agent') {
    try { projectRoot = scopedProjectRoot(userId, raw.projectId); } catch (err) {
      return err.message === 'project_not_registered'
        ? failure(res, 404, 'project_not_registered', 'The project is not registered.')
        : failure(res, 403, 'project_not_allowed', 'The project is not allowed.');
    }
  }

  const runAgent = task.runner?.kind === 'agent' ? AGENT_PORTS[task.runner.busKind] : undefined;
  const deps = {
    runSourcesUpdate,
    ...(runAgent ? { runAgent } : {}),
    ...(task.runner?.route === 'plan-status' ? {
      creds: {
        github: { token: getSecret(getDb(), userId, 'github.token') || undefined },
        backlog: { apiKey: getSecret(getDb(), userId, 'backlog.apiKey') || undefined },
        linear: { apiKey: getSecret(getDb(), userId, 'linear.apiKey') || undefined },
      },
    } : {}),
  };
  try {
    const result = await runCoreTask({
      taskId: task.id,
      userId,
      projectRoot,
      args: raw.args ?? {},
      deps,
    });
    sendJSON(res, 200, result);
    return true;
  } catch (err) {
    if (err instanceof TaskCoreError) {
      const status = err.code === 'feature_disabled' ? 404 : err.code === 'TASK_NOT_FOUND' || err.code === 'TASK_NOT_AVAILABLE' ? 404 : err.code === 'TASK_LOCAL_ONLY' ? 400 : 500;
      return failure(res, status, err.code, err.message, err.details);
    }
    return failure(res, 500, 'TASK_FAILED', 'The task could not run.');
  }
}
