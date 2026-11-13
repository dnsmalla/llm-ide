// The Auto Task the shell scheduler is running right now, with the AbortController that stops it. The scheduler holds
// the shared lock (lock.ts) while it runs, so without this the Auto Tasks page shows nothing running and Run Now only
// says "Another Auto Task is running". A plain observable store, like the repo's other stores.
export interface ScheduledRunInfo { label: string; startedAt: string }

let current: { info: ScheduledRunInfo; abort: AbortController } | null = null;
const listeners = new Set<() => void>();

function emit(): void { for (const l of [...listeners]) l(); }

/** The in-flight scheduled run, or null. The same object is returned until the run changes (a stable snapshot). */
export function getScheduledRun(): ScheduledRunInfo | null { return current?.info ?? null; }

export function subscribeScheduledRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Records the run that is starting and returns the controller whose signal the run must honour. */
export function beginScheduledRun(label: string, now: () => Date = () => new Date()): AbortController {
  const abort = new AbortController();
  current = { info: { label, startedAt: now().toISOString() }, abort };
  emit();
  return abort;
}

/** Clears the run recorded by `beginScheduledRun`; a stale call for an older controller is ignored. */
export function endScheduledRun(abort: AbortController): void {
  if (current?.abort !== abort) return;
  current = null;
  emit();
}

// Stop means "stop the scheduler's work now", not only the task on screen: the same pass may hold more due tasks,
// and without this the next one started the moment the first was stopped.
let passStopped = false;

/** Aborts the in-flight scheduled run and keeps the rest of this scheduler pass from starting. Returns false when none is running. */
export function stopScheduledRun(): boolean {
  if (!current) return false;
  passStopped = true;
  current.abort.abort();
  return true;
}

/** True once Stop was pressed during the current pass. */
export function scheduledPassStopped(): boolean { return passStopped; }

/** A new pass begins (the scheduler took the lock): an earlier Stop no longer applies. */
export function beginScheduledPass(): void { passStopped = false; }
