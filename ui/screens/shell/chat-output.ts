// The latest finished assistant text, for Doc Gen's Use-chat source. UI-only and in memory; no persistence.
export interface ChatOutput { title: string; text: string; at: number }
let latest: ChatOutput | null = null;
const listeners = new Set<() => void>();
export const chatOutputStore = {
  get: (): ChatOutput | null => latest,
  set(next: ChatOutput | null): void {
    if (next?.text === latest?.text) return;
    latest = next;
    for (const l of [...listeners]) l();
  },
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); },
};
