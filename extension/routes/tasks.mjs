// The task registry's HTTP adapter (feature auto_tasks). Every task's prompt/route is fixed by the registry; this
// route never accepts a prompt, a command or a repo path. The desktop is the only caller (D14): a JWT-only or hub
// caller gets 403 HOST_PROOF_REQUIRED before the body is read.
import { getDb } from '../kb/db.mjs';
import { randomUUID } from 'node:crypto';
import { sendJSON, readBody, parseJSON, onClientDisconnect } from '../core/utils.mjs';
import { recordUsage } from '../kb/usage.mjs';
import { resolveProjectRoot } from '../kb/project-roots.mjs';
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
import { scopedProjectRoot, scopedRepoRoot, defaultProjectAllowed } from './bus/project-scope.mjs';
import { runReviewTask } from '../agents/tasks/review.mjs';
import { runGrouped } from '../core/process-group.mjs';

const BODY_KEYS = new Set(['projectId', 'args']);

// What a registry task's `runner.needs` may ask the route for. Each need resolves to deps; only the route reads the vault.
const NEEDS = Object.freeze({
  trackerCreds: (userId) => ({
    creds: {
      github: { token: getSecret(getDb(), userId, 'github.token') || undefined },
      backlog: { apiKey: getSecret(getDb(), userId, 'backlog.apiKey') || undefined },
      linear: { apiKey: getSecret(getDb(), userId, 'linear.apiKey') || undefined },
    },
  }),
});

// The real collaborators of the agent ports. A test replaces them through `ctx.taskPorts`; the router never does.
const DEFAULT_PORTS = Object.freeze({
  runTask,
  engineIdFor,
  runGit,
  spawn: (cmd, argv, opts = {}) => runGrouped(cmd, argv, opts),
  resolveProjectRoot,
  projectAllowed: defaultProjectAllowed,
});

const MODEL_RE = /^[A-Za-z0-9._:/[\]-]{1,128}$/;

/**
 * Ledger rows for one agent task run, the same rule the Loop route meters by: one row per model the run used, with
 * the run's cost and turns on the primary model's row only. `source: 'auto-task'` and `endpoint: 'auto-task:<id>'`
 * are what the usage report reads. Best effort: the answer never depends on the write.
 */
function meterTaskRun({ userId, taskId, projectId, run, requestId }) {
  const usage = run?.usage;
  if (!usage) return;
  try {
    const rows = Array.isArray(run.byModel) && run.byModel.length ? run.byModel : [{ model: run.model ?? 'unknown', ...usage }];
    const primary = Math.max(0, rows.findIndex((row) => row.model === run.model));
    const runCost = Number(usage.costUsd);
    const turns = Number(usage.numTurns) > 0 ? Number(usage.numTurns) : null;
    rows.forEach((row, index) => recordUsage(getDb(), {
      userId, provider: 'anthropic', model: row.model, source: 'auto-task', endpoint: `auto-task:${taskId}`, requestId,
      inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens,
      projectId: projectId ?? null,
      ...(index === primary ? { turns, stopReason: run.stopReason ?? null, costUsd: runCost > 0 ? runCost : null } : {}),
    }));
  } catch { /* metering is best-effort */ }
}

// The agent runner's port per bus kind: the engine, git and spawn come from `ports`; agents/ never imports them.
const AGENT_PORTS = Object.freeze({
  review: async ({ task, userId, projectRoot, projectId, args, signal, emit, ports }) => {
    const { repo, model, focusText } = args;
    if (model !== undefined && !MODEL_RE.test(model)) throw Object.assign(new Error('model is not valid'), { code: 'TASK_BAD_ARG' });
    // A clone folder inside the project (the linked repo) is what the review reads; it must pass the same checks.
    const cwd = repo === undefined ? projectRoot : scopedRepoRoot(userId, projectRoot, repo, { allowed: ports.projectAllowed });
    let run = null;
    const r = await runReviewTask({
      userId,
      args: {
        ...task.runner.busArgs,
        ...(focusText !== undefined ? { focusText } : {}),
        ...(model !== undefined ? { engine: { provider: 'anthropic', model } } : {}),
      },
      cwd,
      signal,
      spawn: ports.spawn,
      emit,
      deterministicFirst: task.runner.deterministicFirst ?? null,
      deps: {
        runTask: (opts) => ports.runTask(opts).then((answer) => { run = answer; return answer; }),
        engineIdFor: ports.engineIdFor,
        runGit: ports.runGit,
      },
    });
    if (run) meterTaskRun({ userId, taskId: task.id, projectId, run, requestId: `task-${randomUUID()}` });
    return { ok: true, summary: r.text.split('\n').find((l) => l.trim()) ?? 'completed', output: r.text, warnings: r.truncated ? ['The review was truncated.'] : [] };
  },
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
  const ports = { ...DEFAULT_PORTS, ...(ctx.taskPorts ?? {}) };
  let projectRoot = null;
  if (task.runner?.kind === 'agent') {
    try { projectRoot = scopedProjectRoot(userId, raw.projectId, { resolve: ports.resolveProjectRoot, allowed: ports.projectAllowed }); } catch (err) {
      return err.message === 'project_not_registered'
        ? failure(res, 404, 'project_not_registered', 'The project is not registered.')
        : failure(res, 403, 'project_not_allowed', 'The project is not allowed.');
    }
  }

  // The run stops when the client goes away before the answer is sent (the desktop's Stop, or a closed app).
  const ac = new AbortController();
  onClientDisconnect(req, res, () => ac.abort());
  const port = task.runner?.kind === 'agent' ? AGENT_PORTS[task.runner.busKind] : undefined;
  const deps = {
    runSourcesUpdate,
    ...(port ? { runAgent: (run) => port({ ...run, ports, projectId: raw.projectId ?? null }) } : {}),
    ...(task.runner?.needs ?? []).reduce((acc, need) => ({ ...acc, ...NEEDS[need]?.(userId) }), {}),
  };
  try {
    const result = await runCoreTask({
      taskId: task.id,
      userId,
      projectRoot,
      args: raw.args ?? {},
      signal: ac.signal,
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
