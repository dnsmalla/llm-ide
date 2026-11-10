// The bus `review` kind: a thin wrapper that supplies the real engine, git and task-route ports to the review task family
// (agents/tasks/review.mjs). The phone and the desktop run the same engine; nothing here writes.
import { randomUUID } from 'node:crypto';
import { runGit } from './git-safe.mjs';
import { runTask, engineIdFor } from './engines.mjs';
import { runReviewTask } from '../../agents/tasks/review.mjs';
import { meterAgentRun } from './metering.mjs';

/** `emit(type, payload)` appends a bus event; `cwd` is the validated project root. `deps` are the engine test seams. */
export function runReview({ userId, args, cwd, signal, spawn, emit, deps = {} }) {
  // The bus has no registry entry: its conflicts focus is the one that asks git first.
  const deterministicFirst = args.focus === 'conflicts' ? 'git-conflicts' : null;
  // The engine's answer is kept so its usage is metered whether the run finished or was aborted with partial usage.
  let run = null;
  const meteredRunTask = (opts) => runTask(opts).then((answer) => { run = answer; return answer; });
  return runReviewTask({ userId, args, cwd, signal, spawn, emit, deterministicFirst, deps: { runTask: meteredRunTask, engineIdFor, runGit, engineDeps: deps } })
    .then((r) => {
      meterAgentRun({ userId, run, source: 'bus', endpoint: 'bus:review', projectId: args.projectId ?? null, requestId: `bus-${randomUUID()}` });
      return r;
    });
}
