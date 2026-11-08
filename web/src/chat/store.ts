// The web chat as a pure reducer over Host API v1 events. Host text is data: clamped here, rendered as text by React.
import type { HostApiCapability, HostApiEventMap } from "../host-api/types.generated.ts";
import type { HostEvent } from "../host-api/connection.ts";

export const MAX_MESSAGES = 500;
export const MAX_REPLY_CHARS = 1_000_000;
const MAX_CONTENT = 100_000;

export type MessageStatus = "done" | "streaming" | "error" | "cancelled" | "interrupted";
export interface WebMessage { key: string; role: "user" | "assistant"; text: string; status: MessageStatus; error: string | null }
type Questions = HostApiEventMap["approval.request"]["questions"];
interface CardState { requestId: string; commandId: string; submitting: boolean; error: string | null }
export type WebApproval =
  | (CardState & { kind: "question"; questions: Questions })
  | (CardState & { kind: "tool"; toolName: string; summary: string | null; filePath: string | null; truncated: boolean });
export interface ChatState {
  messages: readonly WebMessage[];
  turn: string | null;
  approvals: readonly WebApproval[];
  notice: string | null;
  loaded: boolean;
  seq: number;
  capabilities: ReadonlySet<HostApiCapability> | null; // null until the controller reports them
}

export type ChatAction =
  | { type: "snapshot"; messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> }
  | { type: "sent"; commandId: string; text: string }
  | { type: "sendFailed"; commandId: string; message: string }
  | { type: "event"; event: HostEvent }
  | { type: "connectionLost" }
  | { type: "capabilities"; capabilities: ReadonlySet<HostApiCapability> }
  | { type: "approvalSubmitting"; requestId: string }
  | { type: "approvalFailed"; requestId: string; message: string }
  | { type: "approvalCleared"; requestId: string }
  | { type: "cleared" }
  | { type: "notice"; text: string | null };

export const initialChatState: ChatState = { messages: [], turn: null, approvals: [], notice: null, loaded: false, seq: 0, capabilities: null };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const cap = (m: WebMessage[]) => (m.length > MAX_MESSAGES ? m.slice(-MAX_MESSAGES) : m);
const lastIndex = <T>(a: readonly T[], p: (x: T) => boolean) => { for (let i = a.length - 1; i >= 0; i--) if (p(a[i])) return i; return -1; };
const isLive = (m: WebMessage) => m.role === "assistant" && m.status === "streaming";

function patchLive(s: ChatState, fn: (m: WebMessage) => WebMessage): ChatState {
  const i = lastIndex(s.messages, isLive);
  if (i < 0) return s;
  const messages = s.messages.slice();
  messages[i] = fn(messages[i]);
  return { ...s, messages };
}

function endTurn(s: ChatState, status: MessageStatus, error: string | null): ChatState {
  const turn = s.turn;
  return { ...patchLive(s, (m) => ({ ...m, status, error })), turn: null, approvals: s.approvals.filter((a) => a.commandId !== turn) };
}

const patchCard = (s: ChatState, requestId: string, patch: Partial<CardState>): ChatState =>
  ({ ...s, approvals: s.approvals.map((a) => (a.requestId === requestId ? { ...a, ...patch } : a)) });

export function reduce(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "snapshot": {
      let seq = s.seq;
      const msgs: WebMessage[] = a.messages.slice(-MAX_MESSAGES).map((m) => ({
        key: `m-${++seq}`, role: m.role === "user" ? "user" : "assistant", text: str(m.content, MAX_CONTENT), status: "done", error: null,
      }));
      if (s.turn) {
        const live = s.messages[lastIndex(s.messages, isLive)];
        const asked = s.messages[lastIndex(s.messages, (m) => m.role === "user")];
        // The host stores the user line when the turn starts and the reply only when it ends.
        if (asked && msgs.at(-1)?.text !== asked.text) msgs.push({ ...asked, key: `m-${++seq}` });
        if (live) msgs.push({ ...live, key: `m-${++seq}` });
      }
      // A successful snapshot is the proof a transient refusal (e.g. the pre-load team scope) is over.
      return { ...s, seq, messages: cap(msgs), loaded: true, notice: null };
    }
    case "sent": {
      const seq = s.seq + 2;
      return {
        ...s, seq, turn: a.commandId, notice: null,
        messages: cap([...s.messages,
          { key: `m-${seq - 1}`, role: "user", text: a.text, status: "done", error: null },
          { key: `m-${seq}`, role: "assistant", text: "", status: "streaming", error: null }]),
      };
    }
    case "sendFailed": return a.commandId === s.turn ? endTurn(s, "error", a.message) : s;
    case "connectionLost":
      return { ...(s.turn ? endTurn(s, "interrupted", "The connection closed; the host stopped this reply.") : s), approvals: [] };
    case "event": return onEvent(s, a.event);
    case "capabilities":
      return { ...s, capabilities: a.capabilities, approvals: s.approvals.filter((x) => a.capabilities.has(x.kind === "tool" ? "tool_approvals" : "approvals")) };
    case "approvalSubmitting": return patchCard(s, a.requestId, { submitting: true, error: null });
    case "approvalFailed": return patchCard(s, a.requestId, { submitting: false, error: a.message });
    case "approvalCleared": return { ...s, approvals: s.approvals.filter((x) => x.requestId !== a.requestId) };
    case "cleared": return { ...s, messages: [], approvals: [] };
    case "notice": return { ...s, notice: a.text };
  }
}

function onEvent(s: ChatState, e: HostEvent): ChatState {
  switch (e.command) {
    case "chat.delta":
      return e.replyTo !== null && e.replyTo === s.turn
        ? patchLive(s, (m) => ({ ...m, text: (m.text + str(e.payload.text, MAX_CONTENT)).slice(0, MAX_REPLY_CHARS) }))
        : s;
    case "chat.done":
      return e.payload.requestId === s.turn ? endTurn(s, e.payload.stopReason === "cancelled" ? "cancelled" : "done", null) : s;
    case "chat.error":
      return e.replyTo !== null && e.replyTo === s.turn ? endTurn(s, "error", str(e.payload.message, 2000) || "The reply failed.") : s;
    case "approval.request": {
      const p = e.payload;
      if (s.capabilities && !s.capabilities.has("approvals")) return s;
      if (p.commandId !== s.turn || !Array.isArray(p.questions) || s.approvals.some((x) => x.requestId === p.requestId)) return s;
      return { ...s, approvals: [...s.approvals, { kind: "question", requestId: p.requestId, commandId: p.commandId, questions: p.questions, submitting: false, error: null }] };
    }
    case "toolApproval.request": {
      const p = e.payload;
      if (s.capabilities && !s.capabilities.has("tool_approvals")) return s;
      if (p.commandId !== s.turn || s.approvals.some((x) => x.requestId === p.requestId)) return s;
      return { ...s, approvals: [...s.approvals, {
        kind: "tool", requestId: p.requestId, commandId: p.commandId, toolName: str(p.toolName, 200) || "tool",
        summary: typeof p.summary === "string" ? p.summary.slice(0, 2000) : null,
        filePath: typeof p.filePath === "string" ? p.filePath.slice(0, 2000) : null,
        truncated: p.truncated === true, submitting: false, error: null,
      }] };
    }
    case "approval.cleared": return { ...s, approvals: s.approvals.filter((x) => x.requestId !== e.payload.requestId) };
    case "host.capabilities": return s; // the controller dispatches "capabilities" from the connection's parsed set
  }
}
