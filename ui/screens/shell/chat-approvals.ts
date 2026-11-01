// App-wide count of the active chat's pending approvals (Mac AppShell's toolbar badge). Chat publishes; the
// shell header renders the reveal button. UI-only, in memory, never persisted.
let count = 0;
const listeners = new Set<() => void>();
export const chatApprovalStore = {
  get: (): number => count,
  set(next: number): void {
    const n = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
    if (n === count) return;
    count = n;
    for (const l of [...listeners]) l();
  },
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); },
};
