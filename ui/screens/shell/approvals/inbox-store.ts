// The pending bus approvals, polled while the status-bar inbox is mounted. A NEW pending id raises the host's fixed
// `approval_needed` notification with our own kind title (never server text); the host sanitises and rate-limits it.
import { core } from "../runtime";
import { invokeHost, isHostAvailable } from "../host";
import { busApi, type PendingApproval } from "./bus-api";
import { kindTitle } from "./summary";

export interface InboxDeps { approvals(): Promise<PendingApproval[]>; notify(detail: string): void | Promise<void> }
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
        try { await d.notify(fresh.length === 1 ? kindTitle(fresh[0].kind) : `${fresh.length} jobs`); } catch { /* notifications are best effort */ }
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
  notify: async (detail) => { if (isHostAvailable()) await invokeHost("notify", { kind: "approval_needed", detail }); },
});
