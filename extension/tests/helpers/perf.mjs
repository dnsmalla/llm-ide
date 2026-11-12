// Wall-clock budgets for timing tests. A budget written for an idle machine is multiplied by how loaded the machine
// is right now, so a busy machine (the pre-push gate runs suites in parallel) does not fail a fast test, while a real
// slowdown or a missing timeout still blows any budget by far more than the load factor.
import os from 'node:os';

const MAX_FACTOR = 8;

/** 1 on an idle machine, up to 8 when the 1-minute load average is far above the CPU count; times LLMIDE_PERF_SLACK. */
export function loadFactor() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 1;
  const load = Math.min(MAX_FACTOR, Math.max(1, os.loadavg()[0] / cpus));
  const slack = Number(process.env.LLMIDE_PERF_SLACK);
  return load * (Number.isFinite(slack) && slack > 0 ? slack : 1);
}

/** `ms` scaled by the current load: the budget a test may spend. */
export function budget(ms) {
  return ms * loadFactor();
}
