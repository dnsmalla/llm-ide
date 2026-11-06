// The pending bus approvals, polled while the status-bar inbox is mounted. A NEW pending id raises the host's
// `approval_job` notification with that id as an opaque de-dup key and the pending count; the host builds the words.
import { core } from "../runtime";
import { invokeHost, isHostAvailable } from "../host";
import { busApi, type PendingApproval } from "./bus-api";

export interface InboxDeps { approvals(): Promise<PendingApproval[]>; notify(info: { key: string; count: number }): void | Promise<void> }
export interface InboxSnapshot { items: PendingApproval[]; error: string | null }

export function createInboxStore(d: InboxDeps) {
  let snap: InboxSnapshot = { items: [], error: null };
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* a broken listener must not stop the others */ } } };
  async function refresh(): Promise<void> {
    try {
      const items = await d.approvals();
      const fresh = items.filter((a) => !seen.has(a.id));
      for (const a of fresh) seen.add(a.id);
      if (seen.size > 500) for (const id of [...seen].slice(0, seen.size - 500)) seen.delete(id);
      snap = { items, error: null };
      if (fresh.length) {
        try { await d.notify({ key: fresh[0].id, count: items.length }); } catch { /* notifications are best effort */ }
      }
    } catch (e) {
      snap = { items: [], error: e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "UNAVAILABLE" };
    }
    emit();
  }
  return {
    refresh,
    getSnapshot: (): InboxSnapshot => snap,
    subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
    start(ms = 15_000): void { if (timer === null) { void refresh(); timer = setInterval(() => void refresh(), ms); } },
    stop(): void { if (timer !== null) { clearInterval(timer); timer = null; } },
  };
}

/** The app's inbox: approvals from the core, notifications through the host (none in a plain browser). */
export const inboxStore = createInboxStore({
  approvals: () => busApi((path, init) => core.requestRaw(path, init ?? {})).approvals(),
  notify: async ({ key, count }) => { if (isHostAvailable()) await invokeHost("notify_user", { kind: "approval_job", key, count }); },
});
