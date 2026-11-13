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
 * True while the host `pid` is still alive.
 * - signal 0 only asks whether the process exists: ESRCH means gone, EPERM means it exists (and is not ours to signal).
 * - on POSIX an orphan is re-parented, so a ppid that CHANGED since the watch began (`bornUnder`) means our parent is
 *   gone even if the host's pid was reused since. The comparison is against the ppid at the start, not against the
 *   host pid: when node is started through a wrapper that stays its parent, ppid never equals the host pid, and a
 *   strict comparison would stop a healthy core two seconds after boot.
 */
export function parentAlive(pid, { kill = process.kill.bind(process), ppid = () => process.ppid, platform = process.platform, bornUnder = pid } = {}) {
  if (platform !== 'win32' && ppid() !== bornUnder) return false;
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
export function watchParent({ pid, onGone, intervalMs = 500, alive = parentAlive, setTimer = setInterval, clearTimer = clearInterval, ppid = () => process.ppid }) {
  if (pid === null || pid === undefined) return () => {};
  let done = false;
  const bornUnder = ppid();
  // A short interval: the sooner an orphan stops, the smaller the window in which a relaunched app finds it still
  // holding the port and the database. The check is one syscall.
  const timer = setTimer(() => {
    if (done || alive(pid, { bornUnder })) return;
    done = true;
    clearTimer(timer);
    onGone();
  }, intervalMs);
  timer?.unref?.();
  return () => { done = true; clearTimer(timer); };
}
