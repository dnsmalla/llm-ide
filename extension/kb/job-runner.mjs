// Core job runner: drains the persisted queue (kb/job-queue.mjs) with bounded
// concurrency. Lane lock lives in the DB (unique index), cancel and quit abort a
// per-job AbortSignal, and children spawned through ctx.spawn run in their own
// process group so a stop kills the whole tree. Library only: nothing here is
// wired into boot or HTTP, so existing callers are unchanged.
//
// A handler is `async ({ job, signal, spawn, log }) => result` (or
// `{ run, resumable: true }` when re-running after a crash is safe).
import { runGrouped, killGroup } from '../core/process-group.mjs';
import {
  claimNextJobSystem, finishJobSystem, requestCancel, sweepInterruptedSystem, getJob,
} from './job-queue.mjs';

export const DEFAULT_MAX_CONCURRENT = 2;

export function createJobRunner({ handlers = {}, maxConcurrent = DEFAULT_MAX_CONCURRENT, graceMs = 2000, logger } = {}) {
  const norm = (h) => (typeof h === 'function' ? { run: h, resumable: false } : h);
  const table = new Map(Object.entries(handlers).map(([k, h]) => [k, norm(h)]));
  const limit = Math.max(1, Math.floor(maxConcurrent) || 1);
  /** @type {Map<string, {ctl: AbortController, pids: Set<number>, done: Promise<void>}>} */
  const active = new Map();
  let started = false;
  let stopping = false;
  const log = (level, event, data) => { try { logger?.[level]?.(event, data); } catch { /* best effort */ } };

  function execute(job) {
    const ctl = new AbortController();
    const pids = new Set();
    const handler = table.get(job.kind);
    const spawn = (cmd, args, opts = {}) => runGrouped(cmd, args, {
      ...opts, signal: ctl.signal, graceMs,
      onSpawn: (pid) => { pids.add(pid); opts.onSpawn?.(pid); },
    });
    const done = (async () => {
      let state; let result; let error;
      try {
        if (!handler) throw new Error(`no handler for kind ${job.kind}`);
        result = await handler.run({ job, signal: ctl.signal, spawn, log: (m) => log('info', 'job.log', { id: job.id, m }) });
        state = ctl.signal.aborted ? 'cancelled' : 'succeeded';
      } catch (e) {
        state = ctl.signal.aborted ? 'cancelled' : 'failed';
        error = ctl.signal.aborted ? (stopping ? 'server_quit' : 'cancelled') : String(e?.message || e);
      }
      if (state === 'cancelled' && !error) error = stopping ? 'server_quit' : 'cancelled';
      finishJobSystem(job.id, state, { result: state === 'succeeded' ? result : undefined, error });
      active.delete(job.id);
      if (!stopping) pump();
    })();
    active.set(job.id, { ctl, pids, done });
  }

  /** Fill free slots from the queue. Safe to call any time; sync. */
  function pump() {
    if (!started || stopping) return;
    while (active.size < limit) {
      const job = claimNextJobSystem();
      if (!job) return;
      execute(job);
    }
  }

  return {
    /** Boot step: mark orphaned running rows, then start draining. */
    start() {
      if (started) return { requeued: [], interrupted: [] };
      const resumable = [...table].filter(([, h]) => h.resumable).map(([k]) => k);
      const swept = sweepInterruptedSystem(resumable);
      started = true;
      stopping = false;
      pump();
      return swept;
    },
    /** Call after enqueueJob (or on a timer) to start whatever fits. */
    pump,
    /** Cancel for one user: queued is cancelled at once, running is aborted. */
    cancel(userId, id) {
      const r = requestCancel(userId, id);
      if (r.ok && r.was === 'running') active.get(id)?.ctl.abort();
      return r;
    },
    /** Server quit: abort every running job, wait up to graceMs*2, force-kill stragglers' groups. */
    async stop() {
      stopping = true;
      for (const a of active.values()) a.ctl.abort();
      const all = Promise.allSettled([...active.values()].map((a) => a.done));
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(r, graceMs * 2 + 500); timer.unref?.(); });
      await Promise.race([all, timeout]);
      clearTimeout(timer);
      for (const a of active.values()) for (const pid of a.pids) killGroup(pid, 'SIGKILL');
      started = false;
    },
    activeCount: () => active.size,
    get: getJob,
  };
}
