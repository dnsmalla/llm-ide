// Read-only views over Host API v1 `read`: the chat list, one chat's history and the usage summary. No React here.
import type { HostLink } from "../host-api/connection.ts";
import type { HostApiResult } from "../host-api/types.generated.ts";
import type { MeetingItem, PlanItem } from "../sync/kinds.ts";

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
  meetings: MeetingItem[] | null; plans: PlanItem[] | null; // filled only by the offline sync tier (read/snapshot.ts)
}
export const initialReadState: ReadState = { sessions: [], nextOffset: null, open: null, usage: null, loading: false, error: null, meetings: null, plans: null };
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createReadController(link: HostLink) {
  let state = initialReadState;
  let ticket = 0; // the open chat's request generation: a reply for an older open() is dropped
  let moreBusy = false; // one "more" page at a time, so two quick clicks never append the same page twice
  const subs = new Set<() => void>();
  const set = (p: Partial<ReadState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };

  // `current` false = the reply belongs to a chat the user already left: drop its error too, not only its data.
  async function run<T>(go: () => Promise<T>, apply: (r: T) => Partial<ReadState> | null, current: () => boolean = () => true) {
    if (!link.capabilities.has("read")) return;
    set({ loading: true, error: null });
    try { const p = apply(await go()); set({ ...(p ?? {}), loading: false }); }
    catch (e) { set(current() ? { loading: false, error: messageOf(e) } : { loading: false }); }
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
    moreSessions: async () => {
      const offset = state.nextOffset;
      if (offset == null || moreBusy) return;
      moreBusy = true;
      try {
        await run(() => link.send("chat.sessions", { limit: PAGE, offset }).done, (r) => {
          const seen = new Set(state.sessions.map((x) => x.id));
          const sessions = [...state.sessions, ...r.sessions.filter((x) => !seen.has(x.id))].slice(0, MAX_SESSIONS);
          // At the memory cap there is nothing more to show, so "more" goes away.
          return { sessions, nextOffset: sessions.length >= MAX_SESSIONS ? null : r.nextOffset ?? null };
        });
      } finally { moreBusy = false; }
    },
    open: (id: string, title: string) => {
      const mine = ++ticket;
      return run(() => link.send("chat.history", { sessionId: id, limit: HISTORY_PAGE }).done,
        (r) => (mine === ticket ? { open: { id, title, messages: r.messages, nextBeforeSeq: r.nextBeforeSeq ?? null } } : null),
        () => mine === ticket);
    },
    older: () => {
      const o = state.open;
      const beforeSeq = o?.nextBeforeSeq;
      if (!o || beforeSeq == null) return Promise.resolve();
      const mine = ticket;
      return run(() => link.send("chat.history", { sessionId: o.id, beforeSeq, limit: HISTORY_PAGE }).done,
        (r) => (mine === ticket && state.open?.id === o.id
          ? { open: { ...o, messages: [...r.messages, ...o.messages].slice(-MAX_OPEN_MESSAGES), nextBeforeSeq: r.nextBeforeSeq ?? null } }
          : null),
        () => mine === ticket);
    },
    close: () => { ticket += 1; set({ open: null }); },
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}

export type ReadController = ReturnType<typeof createReadController>;
