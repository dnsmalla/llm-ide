// In-memory count of Loop agent runs in progress, across all users. Chat
// turns are counted by routes/agent-v2.mjs; Loop runs never enter that turn
// lock, so they are counted here. Counts only: no user or run id is kept, so
// the summary served by GET /kb/agent-sdk reveals nothing per user.

let loopRuns = 0;

/** Count one Loop run as started. The returned function ends it; calling it again is a no-op. */
export function beginLoopRun() {
  loopRuns += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    loopRuns -= 1;
  };
}

/** `{ chatTurns, loopRuns, total }` for the given chat-turn count (the caller's). */
export function agentBusySummary(chatTurns) {
  return { chatTurns, loopRuns, total: chatTurns + loopRuns };
}
