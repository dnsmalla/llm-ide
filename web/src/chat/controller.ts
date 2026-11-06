// Binds a HostLink (the connection, or a fake in tests) to the chat reducer. No React here.
import type { SendExtras } from "./compose.ts";
import type { HostLink } from "../host-api/connection.ts";
import { initialChatState, reduce, type ChatAction, type ChatState } from "./store.ts";

export const MAX_SEND_CHARS = 100_000; // chat.send.text maxLength
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createChatController(link: HostLink, { historyLimit = 200 }: { historyLimit?: number } = {}) {
  let state: ChatState = initialChatState;
  const subs = new Set<() => void>();
  const dispatch = (a: ChatAction) => { state = reduce(state, a); for (const fn of subs) fn(); };
  let resyncing: Promise<void> | null = null;

  const resync = (): Promise<void> => (resyncing ??= (async () => {
    dispatch({ type: "capabilities", capabilities: link.capabilities });
    try {
      const r = await link.send("chat.snapshot", { limit: historyLimit }).done;
      dispatch({ type: "snapshot", messages: r.messages });
      dispatch({ type: "capabilities", capabilities: link.capabilities });
    } catch (e) {
      dispatch({ type: "notice", text: messageOf(e) });
    } finally {
      resyncing = null;
    }
  })());

  const answer = async (requestId: string, go: (commandId: string) => Promise<unknown>, ok: (r: any) => boolean) => {
    const card = state.approvals.find((x) => x.requestId === requestId);
    if (!card || card.submitting) return;
    dispatch({ type: "approvalSubmitting", requestId });
    try {
      if (!ok(await go(card.commandId))) return dispatch({ type: "approvalFailed", requestId, message: "The host did not accept this answer. Try again." });
      dispatch({ type: "approvalCleared", requestId });
    }
    catch (e) { dispatch({ type: "approvalFailed", requestId, message: messageOf(e) }); }
  };

  dispatch({ type: "capabilities", capabilities: link.capabilities });
  const offs = [
    link.onEvent((event) => {
      dispatch({ type: "event", event });
      if (event.command === "host.capabilities") dispatch({ type: "capabilities", capabilities: link.capabilities });
    }),
    link.onResync(() => { void resync(); }),
    link.onState((s) => { if (s.kind === "reconnecting" || s.kind === "idle" || s.kind === "failed") dispatch({ type: "connectionLost" }); }),
  ];

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    resync,
    async send(text: string, extra: SendExtras = {}): Promise<boolean> {
      const t = text.trim();
      if (!t || state.turn) return false;
      if (t.length > MAX_SEND_CHARS) { dispatch({ type: "notice", text: "Keep a message under 100,000 characters." }); return false; }
      const { id, done } = link.send("chat.send", { text: t, ...extra });
      dispatch({ type: "sent", commandId: id, text: t });
      try {
        const r = await done;
        if (r.accepted) return true;
        dispatch({ type: "sendFailed", commandId: id, message: "The host did not accept the message." });
      } catch (e) { dispatch({ type: "sendFailed", commandId: id, message: messageOf(e) }); }
      return false;
    },
    async newChat(): Promise<boolean> {
      if (state.turn) return false;
      try { await link.send("chat.new", {}).done; dispatch({ type: "cleared" }); return true; }
      catch (e) { dispatch({ type: "notice", text: messageOf(e) }); return false; }
    },
    async cancel() {
      if (!state.turn) return;
      try { await link.send("chat.cancel", {}).done; } catch (e) { dispatch({ type: "notice", text: messageOf(e) }); }
    },
    async clearHistory() {
      if (state.turn) return;
      try { if ((await link.send("chat.history.clear", {}).done).cleared) dispatch({ type: "cleared" }); }
      catch (e) { dispatch({ type: "notice", text: messageOf(e) }); }
    },
    answerQuestion: (requestId: string, answers: Record<string, string>) =>
      answer(requestId, (commandId) => link.send("approvals.answer", { requestId, commandId, answers }).done, (r) => r.accepted === true),
    // v1 has no decline: stopping the reply is the honest equivalent (the host clears the question).
    declineQuestion: (requestId: string) => answer(requestId, () => link.send("chat.cancel", {}).done, (r) => r.cancelled === true),
    answerTool: (requestId: string, decision: "allow_once" | "deny") =>
      answer(requestId, (commandId) => link.send("toolApprovals.answer", { requestId, commandId, decision }).done, (r) => r.accepted === true),
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}

export type ChatController = ReturnType<typeof createChatController>;
