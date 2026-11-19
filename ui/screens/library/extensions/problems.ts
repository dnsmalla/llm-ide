// How many extensions have a known problem this session, for the sidebar's indicator. The Extensions screen reports
// each list's count as health results arrive; the last counts stay when the screen closes (nothing is stored on disk).
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let total = 0;

export const problemStore = {
  set(key: string, n: number): void {
    if ((counts.get(key) ?? 0) === n) return;
    counts.set(key, n);
    total = [...counts.values()].reduce((a, b) => a + b, 0);
    for (const l of [...listeners]) l();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot: (): number => total,
  reset(): void {
    counts.clear();
    total = 0;
    for (const l of [...listeners]) l();
  },
};

export const countProblems = (health: Readonly<Record<string, { status: string }>>): number => Object.values(health).filter((r) => r.status === "problem").length;
