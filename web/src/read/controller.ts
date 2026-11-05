// Read-only views over Host API v1 `read`: the chat list, one chat's history and the usage summary. No React here.
import type { HostLink } from "../host-api/connection.ts";
import type { HostApiResult } from "../host-api/types.generated.ts";

export const MAX_SESSIONS = 500;
export const MAX_OPEN_MESSAGES = 2000;
const PAGE = 50;
const HISTORY_PAGE = 100;

type Sessions = HostApiResult<"chat.sessions">["sessions"];
type Lines = HostApiResult<"chat.history">["messages"];
type Providers = HostApiResult<"usage.get">["providers"];
export interface OpenChat { id: string; title: string; messages: Lines; nextBeforeSeq: number | null }
export interface ReadState {
  sessions: Sessions; nextOffset: number | null; open: OpenChat | null; usage: Providers | null; loading: boolean; error: string | null;
}
export const initialReadState: ReadState = { sessions: [], nextOffset: null, open: null, usage: null, loading: false, error: null };
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createReadController(link: HostLink) {
  let state = initialReadState;
  let ticket = 0; // the open chat's request generation: a reply for an older open() is dropped
  const subs = new Set<() => void>();
  const set = (p: Partial<ReadState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };

  async function run<T>(go: () => Promise<T>, apply: (r: T) => Partial<ReadState> | null) {
    if (!link.capabilities.has("read")) return;
    set({ loading: true, error: null });
    try { const p = apply(await go()); set({ ...(p ?? {}), loading: false }); }
    catch (e) { set({ loading: false, error: messageOf(e) }); }
  }

  const refresh = async () => {
    await Promise.all([
      run(() => link.send("chat.sessions", { limit: PAGE }).done, (r) => ({ sessions: r.sessions, nextOffset: r.nextOffset ?? null })),
      run(() => link.send("usage.get", {}).done, (r) => ({ usage: r.providers })),
    ]);
  };
  const offs = [link.onResync(() => { void refresh(); })];

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    refresh,
    moreSessions: () => {
      const offset = state.nextOffset;
      if (offset == null) return Promise.resolve();
      return run(() => link.send("chat.sessions", { limit: PAGE, offset }).done,
        (r) => ({ sessions: [...state.sessions, ...r.sessions].slice(0, MAX_SESSIONS), nextOffset: r.nextOffset ?? null }));
    },
    open: (id: string, title: string) => {
      const mine = ++ticket;
      return run(() => link.send("chat.history", { sessionId: id, limit: HISTORY_PAGE }).done,
        (r) => (mine === ticket ? { open: { id, title, messages: r.messages, nextBeforeSeq: r.nextBeforeSeq ?? null } } : null));
    },
    older: () => {
      const o = state.open;
      if (!o || o.nextBeforeSeq == null) return Promise.resolve();
      const mine = ticket;
      return run(() => link.send("chat.history", { sessionId: o.id, beforeSeq: o.nextBeforeSeq!, limit: HISTORY_PAGE }).done,
        (r) => (mine === ticket && state.open?.id === o.id
          ? { open: { ...o, messages: [...r.messages, ...o.messages].slice(-MAX_OPEN_MESSAGES), nextBeforeSeq: r.nextBeforeSeq ?? null } }
          : null));
    },
    close: () => { ticket += 1; set({ open: null }); },
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}

export type ReadController = ReturnType<typeof createReadController>;
