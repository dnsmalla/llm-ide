// Exit when the desktop host that spawned this core is gone.
//
// The host stops its core on every normal exit. A force quit, a crash or an OOM kill of the host gives it no chance
// to, and on macOS and Linux the core then lives on as an orphan: it keeps the port and the database open, and the
// next app launch starts a second core on the same SQLite file (two writers, the one thing the store must never
// have). Windows is covered by the host's job object; this watch is harmless there.
//
// The host passes its pid in LLMIDE_PARENT_PID. A core started by hand (`npm run server`) has no such variable and
// is never watched.

const PID_RE = /^[1-9][0-9]{0,9}$/;

/** The host pid from the environment, or null when this core was not spawned by a host. */
export function parentPidFrom(env = process.env) {
  const raw = env.LLMIDE_PARENT_PID ?? '';
  return PID_RE.test(raw) ? Number(raw) : null;
}

/**
 * True while `pid` is still this process's live parent.
 * - signal 0 only asks whether the process exists: ESRCH means gone, EPERM means it exists (and is not ours to signal).
 * - on POSIX an orphan is re-parented, so a changed ppid means the parent is gone even if its pid was reused since.
 */
export function parentAlive(pid, { kill = process.kill.bind(process), ppid = () => process.ppid, platform = process.platform } = {}) {
  if (platform !== 'win32' && ppid() !== pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Polls the parent and calls `onGone` once when it has gone. Returns a stop function. The timer is unref'd: it never
 * keeps the process alive on its own.
 */
export function watchParent({ pid, onGone, intervalMs = 2000, alive = parentAlive, setTimer = setInterval, clearTimer = clearInterval }) {
  if (pid === null || pid === undefined) return () => {};
  let done = false;
  const timer = setTimer(() => {
    if (done || alive(pid)) return;
    done = true;
    clearTimer(timer);
    onGone();
  }, intervalMs);
  timer?.unref?.();
  return () => { done = true; clearTimer(timer); };
}
