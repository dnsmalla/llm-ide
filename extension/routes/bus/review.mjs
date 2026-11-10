// The bus `review` kind: a thin wrapper that supplies the real engine, git and task-route ports to the review task family
// (agents/tasks/review.mjs). The phone and the desktop run the same engine; nothing here writes.
import { runGit } from './git-safe.mjs';
import { runTask, engineIdFor } from './engines.mjs';
import { runReviewTask } from '../../agents/tasks/review.mjs';

/** `emit(type, payload)` appends a bus event; `cwd` is the validated project root. `deps` are the engine test seams. */
export function runReview({ userId, args, cwd, signal, spawn, emit, deps = {} }) {
  // The bus has no registry entry: its conflicts focus is the one that asks git first.
  const deterministicFirst = args.focus === 'conflicts' ? 'git-conflicts' : null;
  return runReviewTask({ userId, args, cwd, signal, spawn, emit, deterministicFirst, deps: { runTask, engineIdFor, runGit, engineDeps: deps } });
}
