// Per-chat state: a pure reducer over agent/v2 events and UI actions. No DOM, no network.
//
// Big-chat rules built in here:
//  * Streaming text is split into SEALED blocks (closed paragraphs/fences, never changed again) and an
//    open tail, so the renderer re-parses only the tail and history messages keep object identity.
//  * Only the last message object is replaced per applied batch; every older message is shared.
//  * Memory is bounded: tool output kept in state is capped (TOOL_STATE_CAP), the in-memory message
//    window is capped (MAX_MESSAGES_IN_MEMORY, oldest dropped on append and `hasMoreOlder` set).
import type { AgentEvent, ApprovalSuggestion, Question, TaskItem } from "./events";

export const TOOL_STATE_CAP = 20_000;
export const TOOL_ARGS_CAP = 8_000;
export const MAX_MESSAGES_IN_MEMORY = 1_500;
export const MAX_NOTICES_PER_MESSAGE = 20;
export const MAX_QUEUE = 20;

export interface TextPart {
  kind: "text";
  sealed: readonly string[];
  open: string;
  line: string;
  openHasContent: boolean;
  inFence: boolean;
}
export interface ToolPart {
  kind: "tool";
  index: number;
  id: string;
  name: string;
  args: string;
  argsTruncated: boolean;
  result: { text: string; isError: boolean; truncated: boolean; totalChars: number } | null;
}
export type Part = TextPart | ToolPart;

export interface Notice {
  kind: string;
  level: "info" | "warning" | "error";
  text: string;
  /** Count of consecutive identical notices (retry loops). */
  count: number;
  /** Shown to the user: warning/error, plus `workspace_trust`. `info` is bookkeeping. */
  visible: boolean;
}

export type MessageStatus = "streaming" | "done" | "aborted" | "error";

export interface UserMessage { role: "user"; id: string; text: string; seq?: number }
export interface AssistantMessage {
  role: "assistant";
  id: string;
  seq?: number;
  parts: Part[];
  notices: Notice[];
  status: MessageStatus;
}
export type Message = UserMessage | AssistantMessage;

export type Phase = "idle" | "streaming" | "aborting" | "error";

export interface ChatError { code: string; message: string; retryable: boolean }

export interface PendingApproval {
  requestId: string;
  kind: "ToolApproval" | "AskUserQuestion";
  toolName?: string;
  argsSummary?: string | null;
  args?: Record<string, unknown> | null;
  /** The rule "always allow" would store (absent = Allow once only). */
  suggestion?: ApprovalSuggestion | null;
  questions?: Question[];
}

/** The latest `workspace_trust` notice: the project folder is untrusted and what was withheld (names only). */
export interface WorkspaceTrustState {
  path: string;
  text: string;
  skipped: Array<{ kind: string; name: string; file: string; withheld: boolean }>;
}

export interface SessionBudget { used: number; limit: number; remaining: number; level: string }

export interface ChatState {
  sessionId: string;
  messages: Message[];
  /** Older messages exist on the server than are loaded. */
  hasMoreOlder: boolean;
  /** Lowest `seq` loaded (the paging cursor), or null. */
  oldestSeq: number | null;
  phase: Phase;
  error: ChatError | null;
  /** Mode the server resolved for the running/last turn (`mode_set`). */
  resolvedMode: string | null;
  model: string | null;
  context: { totalTokens: number; maxTokens: number; percentage: number } | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null;
  tasks: TaskItem[];
  pendingApprovals: PendingApproval[];
  /** The SDK session id off `init`: a decision is POSTed against it (the server checks tenancy on it). */
  sdkSessionId: string | null;
  workspaceTrust: WorkspaceTrustState | null;
  budget: SessionBudget | null;
  queue: string[];
  turnSeq: number;
  /** Events applied in the current turn (observability / tests). */
  applied: number;
  /** Unknown or malformed events seen in the current turn. */
  ignored: number;
}

export function initialState(sessionId: string): ChatState {
  return {
    sessionId, messages: [], hasMoreOlder: false, oldestSeq: null, phase: "idle", error: null, resolvedMode: null, model: null,
    context: null, usage: null, tasks: [], pendingApprovals: [], sdkSessionId: null, workspaceTrust: null, budget: null, queue: [], turnSeq: 0, applied: 0, ignored: 0,
  };
}

export type Action =
  | { type: "load"; messages: Message[]; hasMoreOlder: boolean }
  | { type: "prepend"; messages: Message[]; hasMoreOlder: boolean }
  | { type: "reattach"; id: string }
  | { type: "reattach_cancel" }
  | { type: "marker"; kind: string; level: "info" | "warning" | "error"; text: string }
  | { type: "replay_ended" }
  | { type: "send"; id: string; text: string; /** Retry: drop the failed turn's bubbles first. */ replaceFailed?: boolean }
  | { type: "events"; events: readonly AgentEvent[]; malformed?: number }
  | { type: "stream_end" }
  | { type: "abort_requested" }
  | { type: "aborted" }
  | { type: "transport_error"; code: string; message: string; retryable: boolean }
  | { type: "dequeue" }
  | { type: "drop_queued"; index: number }
  | { type: "clear_error" }
  /** S-G: a decision was accepted by the core (the card goes; `approval_resolved` is then a no-op). */
  | { type: "approval_answered"; requestId: string }
  /** S-G: the folder was trusted; clears the banner only if the notice still names this path. */
  | { type: "trust_granted"; path: string };

// --- text -----------------------------------------------------------------------------------

const FENCE_OPEN = /^\s{0,3}```\s*[\w+.#-]*\s*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;

export function emptyText(): TextPart {
  return { kind: "text", sealed: [], open: "", line: "", openHasContent: false, inFence: false };
}

/** A fully known text (history) as one sealed block. */
export function textPartOf(content: string): TextPart {
  return { kind: "text", sealed: content ? [content] : [], open: "", line: "", openHasContent: false, inFence: false };
}

/** Appends streamed text; seals a block at each blank line outside a fence. */
export function appendText(part: TextPart, delta: string): TextPart {
  let sealed = part.sealed, open = part.open, line = part.line, openHasContent = part.openHasContent, inFence = part.inFence;
  let rest = delta, nl: number;
  while ((nl = rest.indexOf("\n")) !== -1) {
    const done = line + rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    line = "";
    open += done + "\n";
    if (inFence) {
      if (FENCE_CLOSE.test(done)) inFence = false;
    } else if (FENCE_OPEN.test(done)) {
      inFence = true; openHasContent = true;
    } else if (done.trim() === "") {
      if (openHasContent) { sealed = [...sealed, open]; open = ""; openHasContent = false; }
    } else {
      openHasContent = true;
    }
  }
  line += rest;
  return { kind: "text", sealed, open, line, openHasContent, inFence };
}

/** All text of a part, in order. */
export function textOf(part: TextPart): string {
  return part.sealed.join("") + part.open + part.line;
}

/** Plain text of an assistant message (what is persisted). */
export function assistantText(m: AssistantMessage): string {
  return m.parts.filter((p): p is TextPart => p.kind === "text").map(textOf).join("\n\n").trim();
}

// --- reducer --------------------------------------------------------------------------------

const lastAssistantIndex = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
  return -1;
};

function noticeOf(ev: Extract<AgentEvent, { type: "notice" }>): Notice {
  return { kind: ev.kind, level: ev.level, text: ev.text, count: 1, visible: ev.level !== "info" || ev.kind === "workspace_trust" };
}

function capText(text: string, cap: number): { text: string; clipped: boolean } {
  return text.length > cap ? { text: text.slice(0, cap), clipped: true } : { text, clipped: false };
}

function startTurn(s: ChatState, id: string, text: string): ChatState {
  const all: Message[] = [
    ...s.messages,
    { role: "user", id: `${id}-u`, text },
    { role: "assistant", id: `${id}-a`, parts: [], notices: [], status: "streaming" },
  ];
  const over = all.length > MAX_MESSAGES_IN_MEMORY;
  const messages = over ? all.slice(all.length - MAX_MESSAGES_IN_MEMORY) : all;
  const oldest = messages.find((m) => m.seq !== undefined)?.seq ?? s.oldestSeq;
  return {
    ...s, messages, hasMoreOlder: s.hasMoreOlder || over, oldestSeq: over ? oldest : s.oldestSeq,
    phase: "streaming", error: null, turnSeq: s.turnSeq + 1, applied: 0, ignored: 0, pendingApprovals: [], resolvedMode: null,
  };
}

/** Removes the trailing live user+assistant pair when that turn failed or was stopped (the retry replaces it). */
function dropFailedTurn(s: ChatState): ChatState {
  const n = s.messages.length;
  const a = s.messages[n - 1], u = s.messages[n - 2];
  if (n >= 2 && a.role === "assistant" && a.seq === undefined && (a.status === "error" || a.status === "aborted") && u.role === "user" && u.seq === undefined) {
    return { ...s, messages: s.messages.slice(0, n - 2) };
  }
  return s;
}

function finishLast(messages: Message[], status: MessageStatus): Message[] {
  const i = lastAssistantIndex(messages);
  if (i < 0) return messages;
  const m = messages[i] as AssistantMessage;
  if (m.status !== "streaming") return messages;
  const copy = messages.slice();
  copy[i] = { ...m, status };
  return copy;
}

export function reduce(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "load": {
      const oldest = action.messages.find((m) => m.seq !== undefined)?.seq ?? null;
      return { ...state, messages: action.messages, hasMoreOlder: action.hasMoreOlder, oldestSeq: oldest };
    }
    case "prepend": {
      if (action.messages.length === 0) return { ...state, hasMoreOlder: action.hasMoreOlder };
      const merged = [...action.messages, ...state.messages];
      const oldest = merged.find((m) => m.seq !== undefined)?.seq ?? state.oldestSeq;
      return { ...state, messages: merged, hasMoreOlder: action.hasMoreOlder, oldestSeq: oldest };
    }
    case "send": {
      if (state.phase === "streaming" || state.phase === "aborting") {
        if (state.queue.length >= MAX_QUEUE) return state;
        return { ...state, queue: [...state.queue, action.text] };
      }
      return startTurn(action.replaceFailed ? dropFailedTurn(state) : state, action.id, action.text);
    }
    case "reattach": {
      // A turn running on the core that this client did not start (webview reload): a streaming reply bubble, no user bubble.
      if (state.phase === "streaming" || state.phase === "aborting") return state;
      const all: Message[] = [...state.messages, { role: "assistant", id: `${action.id}-a`, parts: [], notices: [], status: "streaming" }];
      const over = all.length > MAX_MESSAGES_IN_MEMORY;
      const messages = over ? all.slice(all.length - MAX_MESSAGES_IN_MEMORY) : all;
      const oldest = messages.find((m) => m.seq !== undefined)?.seq ?? state.oldestSeq;
      return {
        ...state, messages, hasMoreOlder: state.hasMoreOlder || over, oldestSeq: over ? oldest : state.oldestSeq,
        phase: "streaming", error: null, turnSeq: state.turnSeq + 1, applied: 0, ignored: 0, pendingApprovals: [], resolvedMode: null,
      };
    }
    case "reattach_cancel": {
      // The turn was gone by the time we attached: remove the empty bubble the attach added.
      if (state.phase !== "streaming") return state;
      const n = state.messages.length;
      const a = state.messages[n - 1];
      const messages = n > 0 && a.role === "assistant" && a.seq === undefined && a.parts.length === 0 ? state.messages.slice(0, n - 1) : state.messages;
      return { ...state, messages, phase: "idle", pendingApprovals: [] };
    }
    case "marker": {
      const at = lastAssistantIndex(state.messages);
      if (at < 0) return state;
      const m = state.messages[at] as AssistantMessage;
      if (m.notices.length >= MAX_NOTICES_PER_MESSAGE) return state;
      const messages = state.messages.slice();
      messages[at] = { ...m, notices: [...m.notices, { kind: action.kind, level: action.level, text: action.text, count: 1, visible: true }] };
      return { ...state, messages };
    }
    case "replay_ended":
      // The replay closed without a terminal event (its tail was dropped): the reply is as complete as it will get.
      if (state.phase !== "streaming") return state;
      return { ...state, phase: "idle", messages: finishLast(state.messages, "done"), pendingApprovals: [] };
    case "events":
      return applyEvents(state, action.events, action.malformed ?? 0);
    case "stream_end": {
      // The stream closed. A terminal event (result/error) already set the phase; anything else is a drop.
      if (state.phase !== "streaming") return state;
      return {
        ...state, phase: "error", messages: finishLast(state.messages, "error"),
        error: { code: "STREAM_ENDED", message: "The stream ended before the turn finished.", retryable: true },
      };
    }
    case "abort_requested":
      return state.phase === "streaming" ? { ...state, phase: "aborting" } : state;
    case "aborted":
      return { ...state, phase: "idle", messages: finishLast(state.messages, "aborted"), pendingApprovals: [], queue: [] };
    case "transport_error":
      return {
        ...state, phase: "error", messages: finishLast(state.messages, "error"), pendingApprovals: [],
        error: { code: action.code, message: action.message, retryable: action.retryable },
      };
    case "dequeue":
      return { ...state, queue: state.queue.slice(1) };
    case "drop_queued":
      return { ...state, queue: state.queue.filter((_, i) => i !== action.index) };
    case "approval_answered":
      return state.pendingApprovals.some((a) => a.requestId === action.requestId)
        ? { ...state, pendingApprovals: state.pendingApprovals.filter((a) => a.requestId !== action.requestId) } : state;
    case "trust_granted":
      return state.workspaceTrust && state.workspaceTrust.path === action.path ? { ...state, workspaceTrust: null } : state;
    case "clear_error":
      return state.phase === "error" ? { ...state, phase: "idle", error: null } : { ...state, error: null };
  }
}

function applyEvents(state: ChatState, batch: readonly AgentEvent[], malformed: number): ChatState {
  if (batch.length === 0 && malformed === 0) return state;
  // Late events after an abort or a terminal state are dropped: the turn is over for the UI.
  if (state.phase === "idle" || state.phase === "error") return state;
  const messages = state.messages.slice();
  const at = lastAssistantIndex(messages);
  let target: AssistantMessage | null = null;
  if (at >= 0) {
    const m = messages[at] as AssistantMessage;
    target = { ...m, parts: m.parts.slice(), notices: m.notices.slice() };
    messages[at] = target;
  }
  const next: ChatState = { ...state, messages, applied: state.applied + batch.length, ignored: state.ignored + malformed };

  for (const ev of batch) {
    switch (ev.type) {
      case "init":
        if (ev.model) next.model = ev.model;
        if (ev.sessionId) next.sdkSessionId = ev.sessionId;
        break;
      case "mode_set":
        next.resolvedMode = ev.mode;
        break;
      case "delta":
        if (target) {
          const tail = target.parts[target.parts.length - 1];
          if (tail && tail.kind === "text") target.parts[target.parts.length - 1] = appendText(tail, ev.text);
          else target.parts.push(appendText(emptyText(), ev.text));
        }
        break;
      case "tool_use_start":
        target?.parts.push({ kind: "tool", index: ev.index, id: ev.id ?? "", name: ev.name ?? "tool", args: "", argsTruncated: false, result: null });
        break;
      case "tool_args_delta":
        if (target) {
          for (let i = target.parts.length - 1; i >= 0; i--) {
            const p = target.parts[i];
            if (p.kind === "tool" && p.index === ev.index && p.result === null) {
              const c = capText(p.args + ev.partialJson, TOOL_ARGS_CAP);
              target.parts[i] = { ...p, args: c.text, argsTruncated: p.argsTruncated || c.clipped };
              break;
            }
          }
        }
        break;
      case "tool_result":
        if (target) {
          const i = target.parts.findIndex((p) => p.kind === "tool" && p.id === ev.toolUseId);
          if (i >= 0) {
            const p = target.parts[i] as ToolPart;
            const c = capText(ev.text, TOOL_STATE_CAP);
            target.parts[i] = { ...p, result: { text: c.text, isError: ev.isError, truncated: ev.truncated || c.clipped, totalChars: ev.text.length } };
          }
        }
        break;
      case "usage":
        next.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheReadTokens: ev.cacheReadTokens, cacheCreationTokens: ev.cacheCreationTokens };
        break;
      case "context_usage":
        next.context = { totalTokens: ev.totalTokens, maxTokens: ev.maxTokens, percentage: ev.percentage };
        break;
      case "tasks":
      case "tasks_progress":
        next.tasks = ev.tasks;
        break;
      case "notice": {
        if (ev.kind === "workspace_trust" && ev.data && typeof ev.data === "object") {
          const d = ev.data as Record<string, unknown>;
          if (typeof d.path === "string" && d.trusted !== true) {
            const skipped = Array.isArray(d.skipped) ? d.skipped.flatMap((x) => {
              const o = x as Record<string, unknown> | null;
              return o && typeof o.kind === "string" && typeof o.name === "string"
                ? [{ kind: o.kind, name: o.name, file: typeof o.file === "string" ? o.file : "", withheld: o.withheld === true }] : [];
            }).slice(0, 50) : [];
            next.workspaceTrust = { path: d.path, text: ev.text, skipped };
          }
        }
        if (ev.kind === "session_budget" && ev.data && typeof ev.data === "object") {
          const d = ev.data as Record<string, unknown>;
          if (typeof d.used === "number" && typeof d.limit === "number") {
            next.budget = { used: d.used, limit: d.limit, remaining: typeof d.remaining === "number" ? d.remaining : Math.max(0, d.limit - d.used), level: String(d.level ?? "") };
          }
        }
        if (target) {
          const n = noticeOf(ev);
          const last = target.notices[target.notices.length - 1];
          if (last && last.kind === n.kind && last.text === n.text) target.notices[target.notices.length - 1] = { ...last, count: last.count + 1 };
          else if (target.notices.length < MAX_NOTICES_PER_MESSAGE) target.notices.push(n);
        }
        break;
      }
      case "approval_request":
        if (!next.pendingApprovals.some((a) => a.requestId === ev.requestId)) {
          next.pendingApprovals = [...next.pendingApprovals, ev.kind === "ToolApproval"
            ? { requestId: ev.requestId, kind: ev.kind, toolName: ev.toolName, argsSummary: ev.argsSummary, args: ev.args, suggestion: ev.suggestion ?? null }
            : { requestId: ev.requestId, kind: ev.kind, questions: ev.questions }];
        }
        break;
      case "approval_resolved":
        next.pendingApprovals = next.pendingApprovals.filter((a) => a.requestId !== ev.requestId);
        break;
      case "result":
        next.phase = "idle";
        next.pendingApprovals = [];
        if (target && target.status === "streaming") target.status = "done";
        break;
      case "error":
        next.phase = "error";
        next.pendingApprovals = [];
        next.error = { code: ev.code, message: ev.message, retryable: ev.retryable };
        if (target && target.status === "streaming") target.status = "error";
        break;
      case "memory":
      case "sdk":
        break;
    }
    if (next.phase !== "streaming" && next.phase !== "aborting") break; // events after a terminal one are ignored
  }
  return next;
}
