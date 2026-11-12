// Binds a HostLink (the connection, or a fake in tests) to the chat reducer. No React here.
import type { SendExtras } from "./compose.ts";
import type { HostLink } from "../host-api/connection.ts";
import { HOST_API_LIMITS } from "../host-api/types.generated.ts";
import { initialChatState, reduce, type ChatAction, type ChatState } from "./store.ts";

export const MAX_SEND_CHARS = 100_000; // chat.send.text maxLength
const FRAME_OVERHEAD_BYTES = 1024; // the envelope around the payload: version, id, type, command, ts
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export interface ChatControllerOptions {
  historyLimit?: number;
  /** The project every project-scoped frame names; null/absent keeps the v1 team behavior. */
  projectId?: () => string | null;
  /**
   * Resolves once the project list has answered. The first snapshot and a send typed before the picker
   * loads wait for it, so they name the selected project instead of running under the team grant.
   */
  scopeReady?: () => Promise<void>;
  /** Called for a refused frame so the project picker can show the host's reason. */
  onProjectRefused?: (e: unknown) => void;
}

export function createChatController(link: HostLink, { historyLimit = 200, projectId, scopeReady, onProjectRefused }: ChatControllerOptions = {}) {
  let state: ChatState = initialChatState;
  const subs = new Set<() => void>();
  const dispatch = (a: ChatAction) => { state = reduce(state, a); for (const fn of subs) fn(); };
  // The turn this controller is waiting on, and a Stop pressed while the socket was down.
  let turnProject: string | null = null;
  let pendingCancel: { requestId: string; project: string | null } | null = null;
  let linkKind = "ready"; // tracked from onState; a link that never reports is taken as ready
  let resuming: Promise<void> | null = null;
  let resyncing: Promise<void> | null = null;
  let resyncQueued = false; // a project change landed while a snapshot was in flight: run once more with the new id
  // A selection change fired by the first projects.list is not a reason for a second snapshot: the resync
  // waiting on that same list already reads the new selection. Once primed, every change queues a resync.
  let scopePrimed = !scopeReady;
  const pid = () => projectId?.() ?? null;
  const waitForScope = async () => {
    if (!scopeReady) return;
    try { await scopeReady(); } catch { /* a failed list keeps the previous/team scope */ }
  };

  const resync = (): Promise<void> => {
    if (resyncing) { if (scopePrimed) resyncQueued = true; return resyncing; }
    return (resyncing = (async () => {
      try {
        do {
          resyncQueued = false;
          dispatch({ type: "capabilities", capabilities: link.capabilities });
          if (scopeReady) { await waitForScope(); scopePrimed = true; }
          const project = pid();
          try {
            const r = await link.send("chat.snapshot", project ? { limit: historyLimit, projectId: project } : { limit: historyLimit }).done;
            dispatch({ type: "snapshot", messages: r.messages });
            dispatch({ type: "capabilities", capabilities: link.capabilities });
          } catch (e) {
            dispatch({ type: "notice", text: messageOf(e) });
            onProjectRefused?.(e);
          }
        } while (resyncQueued);
      } finally {
        resyncing = null;
      }
    })());
  };

  // After a reconnect: reattach the detached turn (or send the Stop that was pressed offline), else plain resync.
  const resumeTurn = (): Promise<void> => {
    if (resuming) return resuming;
    const requestId = pendingCancel?.requestId ?? (state.waiting ? state.turn : null);
    if (!requestId) return resync();
    const project = pendingCancel ? pendingCancel.project : turnProject;
    const cancelling = pendingCancel;
    return (resuming = (async () => {
      try {
        const r = await link.send("chat.resume", project ? { requestId, projectId: project } : { requestId }).done;
        pendingCancel = null;
        if (cancelling) {
          if (r.state === "running") { try { await link.send("chat.cancel", project ? { projectId: project } : {}).done; } catch (e) { dispatch({ type: "notice", text: messageOf(e) }); } }
          return await resync();
        }
        if (r.state === "running") return dispatch({ type: "resumed", text: r.text ?? "", truncated: r.truncated === true });
        if (r.state === "done") return dispatch({ type: "resumeFinal", text: r.text ?? null, status: r.stopReason === "cancelled" ? "cancelled" : "done", error: null });
        if (r.state === "error") return dispatch({ type: "resumeFinal", text: r.text ?? null, status: "error", error: (r.message ?? "").slice(0, 2000) || "The reply failed." });
        await fallback(); // unknown: another device, expired, or an old host
      } catch (e) {
        // Dropped again while resuming: the next ready retries. Anything else (unknown_command on an old host) is not resumable.
        if (linkKind !== "ready") return;
        pendingCancel = null;
        await fallback();
      }
    })().finally(() => { resuming = null; }));
  };
  // Not resumable: finish the turn from history. The host stores the reply when the turn ends.
  const fallback = async () => {
    dispatch({ type: "resumeFinal", text: null, status: "interrupted", error: null });
    await resync();
    const last = state.messages.at(-1);
    if (last?.role === "user") dispatch({ type: "notice", text: "The reply could not be recovered. Ask again if it is missing." });
  };

  const answer = async (requestId: string, go: (commandId: string, project: string | null) => Promise<unknown>, ok: (r: any) => boolean) => {
    const card = state.approvals.find((x) => x.requestId === requestId);
    if (!card || card.submitting) return;
    dispatch({ type: "approvalSubmitting", requestId });
    try {
      if (!ok(await go(card.commandId, pid()))) return dispatch({ type: "approvalFailed", requestId, message: "The host did not accept this answer. Try again." });
      dispatch({ type: "approvalCleared", requestId });
    }
    catch (e) { dispatch({ type: "approvalFailed", requestId, message: messageOf(e) }); onProjectRefused?.(e); }
  };

  dispatch({ type: "capabilities", capabilities: link.capabilities });
  const offs = [
    link.onEvent((event) => {
      dispatch({ type: "event", event });
      if (event.command === "host.capabilities") dispatch({ type: "capabilities", capabilities: link.capabilities });
    }),
    link.onResync(() => { void resumeTurn(); }),
    link.onState((s) => {
      linkKind = s.kind;
      if (s.kind === "reconnecting") dispatch({ type: "connectionLost" });
      else if (s.kind === "idle" || s.kind === "failed") { pendingCancel = null; dispatch({ type: "connectionClosed" }); }
    }),
  ];

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    resync,
    async send(text: string, extra: SendExtras = {}): Promise<boolean> {
      const t = text.trim();
      if (!t || state.turn) return false;
      if (t.length > MAX_SEND_CHARS) { dispatch({ type: "notice", text: "Keep a message under 100,000 characters." }); return false; }
      // A message typed before projects.list replied still names the selected project (L4).
      if (scopeReady) { await waitForScope(); if (state.turn) return false; } // another send won the wait
      const project = pid();
      const payload = { text: t, ...extra, ...(project ? { projectId: project } : {}) };
      // The connection refuses an oversize frame too, but only after the line is shown as sent; say it up front.
      if (new TextEncoder().encode(JSON.stringify(payload)).length + FRAME_OVERHEAD_BYTES > HOST_API_LIMITS.maxFrameBytes) {
        dispatch({ type: "notice", text: "This message with its attachments is larger than 1 MiB. Remove a file or shorten it." });
        return false;
      }
      const { id, done } = link.send("chat.send", payload);
      turnProject = project;
      dispatch({ type: "sent", commandId: id, text: t });
      try {
        const r = await done;
        if (r.accepted) return true;
        dispatch({ type: "sendFailed", commandId: id, message: "The host did not accept the message." });
      } catch (e) { dispatch({ type: "sendFailed", commandId: id, message: messageOf(e) }); onProjectRefused?.(e); }
      return false;
    },
    async newChat(): Promise<boolean> {
      if (state.turn) return false;
      const project = pid();
      try { await link.send("chat.new", project ? { projectId: project } : {}).done; dispatch({ type: "cleared" }); return true; }
      catch (e) { dispatch({ type: "notice", text: messageOf(e) }); onProjectRefused?.(e); return false; }
    },
    async cancel() {
      if (!state.turn) return;
      const project = pid();
      if (state.waiting) { pendingCancel = { requestId: state.turn, project: turnProject }; dispatch({ type: "stoppedLocally" }); return; }
      try { await link.send("chat.cancel", project ? { projectId: project } : {}).done; } catch (e) { dispatch({ type: "notice", text: messageOf(e) }); onProjectRefused?.(e); }
    },
    async clearHistory() {
      if (state.turn) return;
      const project = pid();
      try { if ((await link.send("chat.history.clear", project ? { projectId: project } : {}).done).cleared) dispatch({ type: "cleared" }); }
      catch (e) { dispatch({ type: "notice", text: messageOf(e) }); onProjectRefused?.(e); }
    },
    answerQuestion: (requestId: string, answers: Record<string, string>) =>
      answer(requestId, (commandId, project) =>
        link.send("approvals.answer", { requestId, commandId, answers, ...(project ? { projectId: project } : {}) }).done, (r) => r.accepted === true),
    // v1 has no decline: stopping the reply is the honest equivalent (the host clears the question).
    declineQuestion: (requestId: string) => answer(requestId, (_, project) =>
      link.send("chat.cancel", project ? { projectId: project } : {}).done, (r) => r.cancelled === true),
    answerTool: (requestId: string, decision: "allow_once" | "deny") =>
      answer(requestId, (commandId, project) =>
        link.send("toolApprovals.answer", { requestId, commandId, decision, ...(project ? { projectId: project } : {}) }).done, (r) => r.accepted === true),
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}

export type ChatController = ReturnType<typeof createChatController>;
