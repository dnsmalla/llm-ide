// Close server, as one rule shared by the server home and the Settings server card: the unsaved-work question first,
// then the app restart. The restart opens the local Welcome, because a launch in SSH mode already saved the mode back to
// Local. There is no stop and no mode save here by design: the server core keeps running, so the next connect is quick.

/** The guard that every change of the active project runs through (`projectStore.guardLeave`). */
export type LeaveGuard = <T>(cancelled: T, action: () => Promise<T>) => Promise<T>;

/** Resolves false when the user stays in the open project (nothing restarts), true after the restart is requested. */
export function closeServerConnection(guard: LeaveGuard, restart: () => Promise<unknown>): Promise<boolean> {
  return guard(false, async () => {
    await restart();
    return true;
  });
}
