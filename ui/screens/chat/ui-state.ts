// The chat UI choices that belong to the conversation, not to one screen: which chat is open, each chat's picker
// choices (mode, model) and the permission mode. The Chat section and the Explorer's docked Code Assistant read and
// write ONE of these (see `runtime.ts`), so opening a chat in the dock shows it in the Chat section too and a model
// picked in one is the model shown in the other. Pure store, no React; the session list itself lives in the
// `ChatStore`, this only carries a revision number telling other screens to reload it.
import type { PermissionMode } from "./route";

export interface ChatPrefs {
  mode: string;
  provider: string | null;
  model: string | null;
}

export interface ChatUiState {
  activeId: string | null;
  prefs: Readonly<Record<string, ChatPrefs>>;
  permission: PermissionMode;
  /** Bumped when a chat was created, renamed or deleted: every screen listing sessions reloads. */
  sessionsRev: number;
}

export interface ChatUiStore {
  getSnapshot(): ChatUiState;
  subscribe(listener: () => void): () => void;
  setActiveId(id: string | null): void;
  /** Same shape as React's functional state update, so the screen's existing call sites keep working. */
  setPrefs(update: (cur: Readonly<Record<string, ChatPrefs>>) => Record<string, ChatPrefs>): void;
  setPermission(mode: PermissionMode): void;
  bumpSessions(): void;
}

/** Remembering picker choices for this many chats is plenty; the oldest entries are forgotten (bounded memory). */
export const MAX_REMEMBERED_PREFS = 200;

export function createChatUiStore(initialActiveId: string | null = null): ChatUiStore {
  let state: ChatUiState = { activeId: initialActiveId, prefs: {}, permission: "ask", sessionsRev: 0 };
  const listeners = new Set<() => void>();
  const set = (next: ChatUiState) => {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l();
  };
  return {
    getSnapshot: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setActiveId(id) {
      if (id === state.activeId) return;
      set({ ...state, activeId: id });
    },
    setPrefs(update) {
      const next = update(state.prefs);
      if (next === state.prefs) return;
      const keys = Object.keys(next);
      const bounded = keys.length > MAX_REMEMBERED_PREFS ? Object.fromEntries(keys.slice(keys.length - MAX_REMEMBERED_PREFS).map((k) => [k, next[k]!])) : next;
      set({ ...state, prefs: bounded });
    },
    setPermission(mode) {
      if (mode === state.permission) return;
      set({ ...state, permission: mode });
    },
    bumpSessions() {
      set({ ...state, sessionsRev: state.sessionsRev + 1 });
    },
  };
}
