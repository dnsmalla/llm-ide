// No-progress detection for ONE headless Loop agent step.
//
// Why: a Loop step runs unwatched with maxTurns 60, and every hop re-reads the
// whole (growing) context — a confused agent re-reading the same file or
// retrying a refused edit burns tokens until the cap, then the step fails
// anyway. The Mac Loop already gives up ACROSS iterations (repeatedFailure,
// returnedAfterDifferentDiffs, the per-stage repair budget); this is the
// check WITHIN a step. Deliberately narrow, so a step doing real work is never
// cut off:
//   - the same tool with the same arguments again while no file changed in
//     between (a successful Edit/Write resets it: re-reading a file you just
//     changed is progress). The REPEAT_WARN_AT-th identical call is only
//     DENIED with a hint (its result is already in context); a further
//     identical call stops the step. One redundant read in a long read-only
//     plan stage must not end the stage — ignoring the hint means it is stuck;
//   - ERROR_STREAK_LIMIT failed tool results in a row. A warned (denied)
//     repeat counts as a failure here on purpose: it did nothing either.

export const REPEAT_WARN_AT = 3;
export const ERROR_STREAK_LIMIT = 5;

// Key order must not hide a repeat ({a,b} and {b,a} are the same call).
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @returns {{ onCall(toolName: string, input: object):
 *     {action: 'ok'} | {action: 'warn', message: string} | {action: 'stop', reason: string},
 *   onResult(isError: boolean): string|null, onWrite(): void, readonly stopReason: string|null }}
 *   onResult returns the stop reason once the step should stop, else null;
 *   once stopped, every later call answers 'stop' with the same reason.
 */
export function createProgressGuard({ repeatWarnAt = REPEAT_WARN_AT, errorStreakLimit = ERROR_STREAK_LIMIT } = {}) {
  const seen = new Map();
  let errorStreak = 0;
  let stopReason = null;
  return {
    onCall(toolName, input) {
      if (stopReason) return { action: 'stop', reason: stopReason };
      const key = `${toolName}\u0000${stableStringify(input)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > repeatWarnAt) {
        stopReason = `the same ${toolName} call was made ${count} times with no file changed in between`;
        return { action: 'stop', reason: stopReason };
      }
      if (count === repeatWarnAt) {
        return {
          action: 'warn',
          message: `Not run: this exact ${toolName} call was already made ${count - 1} times and no file has `
            + 'changed since — its result was already returned to you earlier. Use it, or do something different; '
            + 'repeating it again stops this step.',
        };
      }
      return { action: 'ok' };
    },
    onResult(isError) {
      if (stopReason) return stopReason;
      errorStreak = isError ? errorStreak + 1 : 0;
      if (errorStreak >= errorStreakLimit) stopReason = `${errorStreak} tool calls in a row failed`;
      return stopReason;
    },
    onWrite() {
      seen.clear();
    },
    get stopReason() { return stopReason; },
  };
}
