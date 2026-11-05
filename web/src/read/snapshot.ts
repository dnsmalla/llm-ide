// The offline snapshot as a ReadState, so ReadPanel renders the same views as with the desktop on (Host API v1 reads).
import { initialReadState, type ReadState } from "./controller.ts";
import type { Snapshot } from "../sync/kinds.ts";

export function snapshotReadState(snap: Snapshot | null, openId: string | null): ReadState {
  const chats = snap?.kinds.chats?.items ?? [];
  const o = openId ? chats.find((c) => c.id === openId) : undefined;
  return {
    ...initialReadState,
    sessions: chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
    open: o ? { id: o.id, title: o.title, messages: o.messages, nextBeforeSeq: null } : null,
    usage: snap?.kinds.usage?.items[0]?.providers ?? null,
    meetings: snap?.kinds.meetings?.items ?? null,
    plans: snap?.kinds.plans?.items ?? null,
  };
}
