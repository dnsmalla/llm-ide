// Chat state for the streamed Agent v2 turn: a pure reducer over wire events, a seq tracker
// that counts drops and duplicates, and a time-sliced batcher that bounds how often and how
// much is applied per commit.
import type { FixtureEvent } from "./fixture";

export interface ToolResult {
  text: string;
  isError: boolean;
  truncated: boolean;
}

export interface ToolStep {
  kind: "tool";
  index: number;
  id: string;
  name: string;
  args: string;
  result: ToolResult | null;
}

/**
 * Assistant text split into sealed blocks (closed paragraphs and fences, never changed
 * again) and an open tail (`open` + `line`). Only the tail is re-parsed per commit.
 */
export interface TextPart {
  kind: "text";
  sealed: readonly string[];
  /** Completed lines of the open block, each ending in "\n". */
  open: string;
  /** The incomplete last line. */
  line: string;
  /** The open block holds a non-blank line (so a blank line can seal it). */
  openHasContent: boolean;
  /** Inside a fenced code block: blank lines do not seal. */
  inFence: boolean;
}

export type Part = TextPart | ToolStep;

export interface UserMessage {
  role: "user";
  id: string;
  text: string;
}

export interface AssistantMessage {
  role: "assistant";
  id: string;
  parts: Part[];
}

export type Message = UserMessage | AssistantMessage;

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ContextInfo {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}

export interface TaskInfo {
  id: string;
  title: string;
  status: string;
}

export interface ResultInfo {
  subtype: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  stopReason: string | null;
}

export interface ChatModel {
  messages: Message[];
  mode: string | null;
  model: string | null;
  /** Usage snapshot per messageId (a message's usage can repeat; the latest replaces). */
  usageByMessage: ReadonlyMap<string, UsageInfo>;
  context: ContextInfo | null;
  tasks: TaskInfo[];
  result: ResultInfo | null;
  error: string | null;
  /** Monotonic count of applied (non-duplicate) events. */
  applied: number;
  /** Seq of the last applied event, and the turn's event count (-1 before a turn). */
  lastSeq: number;
  turnTotal: number;
}

export const EMPTY_CHAT: ChatModel = {
  messages: [],
  mode: null,
  model: null,
  usageByMessage: new Map(),
  context: null,
  tasks: [],
  result: null,
  error: null,
  applied: 0,
  lastSeq: -1,
  turnTotal: 0,
};

/** Sum of the turn's usage, one snapshot per messageId. */
export function turnUsage(model: ChatModel): UsageInfo | null {
  if (model.usageByMessage.size === 0) return null;
  const total: UsageInfo = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const u of model.usageByMessage.values()) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheReadTokens += u.cacheReadTokens;
    total.cacheCreationTokens += u.cacheCreationTokens;
  }
  return total;
}

/** Starts a turn: the user's bubble and an empty assistant message the events fill. */
export function startTurn(model: ChatModel, userText: string, turnId: string, turnTotal: number): ChatModel {
  return {
    ...model,
    messages: [
      ...model.messages,
      { role: "user", id: `${turnId}-u`, text: userText },
      { role: "assistant", id: `${turnId}-a`, parts: [] },
    ],
    usageByMessage: new Map(),
    result: null,
    error: null,
    lastSeq: -1,
    turnTotal,
  };
}

// Fence rules match the markdown parser exactly, so a sealed block never splits a fence.
const FENCE_OPEN = /^```\s*[\w+.-]*\s*$/;
const FENCE_CLOSE = /^```\s*$/;

/** Adds delta text to a text part, sealing a block at each blank line outside a fence. */
export function appendText(part: TextPart, delta: string): TextPart {
  let sealed = part.sealed;
  let open = part.open;
  let line = part.line;
  let openHasContent = part.openHasContent;
  let inFence = part.inFence;
  let rest = delta;
  let nl: number;
  while ((nl = rest.indexOf("\n")) !== -1) {
    const done = line + rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    line = "";
    open += done + "\n";
    if (inFence) {
      if (FENCE_CLOSE.test(done)) inFence = false;
    } else if (FENCE_OPEN.test(done)) {
      inFence = true;
      openHasContent = true;
    } else if (done.trim() === "") {
      if (openHasContent) {
        sealed = [...sealed, open];
        open = "";
        openHasContent = false;
      }
    } else {
      openHasContent = true;
    }
  }
  line += rest;
  return { kind: "text", sealed, open, line, openHasContent, inFence };
}

function emptyText(): TextPart {
  return { kind: "text", sealed: [], open: "", line: "", openHasContent: false, inFence: false };
}

/**
 * Applies a batch of events in arrival order. Copies the message list and the assistant
 * message once per batch, then mutates those copies, so a commit of many deltas costs one
 * allocation per touched part rather than one per delta.
 */
export function applyBatch(model: ChatModel, batch: readonly FixtureEvent[]): ChatModel {
  if (batch.length === 0) return model;
  const messages = model.messages.slice();
  let last = messages.length - 1;
  while (last >= 0 && messages[last].role !== "assistant") last--;
  const target = last >= 0 ? { ...(messages[last] as AssistantMessage), parts: (messages[last] as AssistantMessage).parts.slice() } : null;
  if (target && last >= 0) messages[last] = target;
  const next: ChatModel = { ...model, messages, applied: model.applied + batch.length, lastSeq: batch[batch.length - 1].seq };

  for (const ev of batch) {
    switch (ev.type) {
      case "init":
        next.model = typeof ev.model === "string" ? ev.model : null;
        break;
      case "mode_set":
        next.mode = typeof ev.mode === "string" ? ev.mode : null;
        break;
      case "delta":
        if (target) {
          const tail = target.parts[target.parts.length - 1];
          const text = String(ev.text ?? "");
          if (tail && tail.kind === "text") {
            target.parts[target.parts.length - 1] = appendText(tail, text);
          } else {
            target.parts.push(appendText(emptyText(), text));
          }
        }
        break;
      case "tool_use_start":
        if (target) {
          target.parts.push({
            kind: "tool",
            index: Number(ev.index ?? 0),
            id: String(ev.id ?? ""),
            name: String(ev.name ?? "tool"),
            args: "",
            result: null,
          });
        }
        break;
      case "tool_args_delta":
        if (target) {
          const tool = findOpenTool(target, Number(ev.index ?? 0));
          if (tool) {
            const idx = target.parts.indexOf(tool);
            target.parts[idx] = { ...tool, args: tool.args + String(ev.partialJson ?? "") };
          }
        }
        break;
      case "tool_result":
        if (target) {
          const idx = target.parts.findIndex((p) => p.kind === "tool" && p.id === ev.toolUseId);
          if (idx >= 0) {
            const tool = target.parts[idx] as ToolStep;
            target.parts[idx] = {
              ...tool,
              result: { text: String(ev.text ?? ""), isError: ev.isError === true, truncated: ev.truncated === true },
            };
          }
        }
        break;
      case "usage": {
        // One snapshot per messageId: a repeated message id replaces its earlier snapshot.
        const key = typeof ev.messageId === "string" && ev.messageId ? ev.messageId : `anon-${next.applied}`;
        const usages = new Map(next.usageByMessage);
        usages.set(key, pickUsage(ev));
        next.usageByMessage = usages;
        break;
      }
      case "context_usage":
        next.context = {
          totalTokens: Number(ev.totalTokens ?? 0),
          maxTokens: Number(ev.maxTokens ?? 0),
          percentage: Number(ev.percentage ?? 0),
        };
        break;
      case "tasks":
      case "tasks_progress":
        next.tasks = Array.isArray(ev.tasks) ? (ev.tasks as TaskInfo[]) : next.tasks;
        break;
      case "result":
        next.result = {
          subtype: (ev.subtype as string | null) ?? null,
          costUsd: (ev.costUsd as number | null) ?? null,
          numTurns: (ev.numTurns as number | null) ?? null,
          durationMs: (ev.durationMs as number | null) ?? null,
          stopReason: (ev.stopReason as string | null) ?? null,
        };
        break;
      case "error":
        next.error = String(ev.message ?? "agent v2 turn failed");
        break;
      default:
        // memory, approval_*, sdk, unknown: observed by the bench, not rendered here.
        break;
    }
  }
  return next;
}

function findOpenTool(target: AssistantMessage, index: number): ToolStep | null {
  for (let i = target.parts.length - 1; i >= 0; i--) {
    const p = target.parts[i];
    if (p.kind === "tool" && p.index === index && p.result === null) return p;
  }
  return null;
}

function pickUsage(ev: FixtureEvent): UsageInfo {
  return {
    inputTokens: Number(ev.inputTokens ?? 0),
    outputTokens: Number(ev.outputTokens ?? 0),
    cacheReadTokens: Number(ev.cacheReadTokens ?? 0),
    cacheCreationTokens: Number(ev.cacheCreationTokens ?? 0),
  };
}

/**
 * Tracks which fixture seqs have arrived. A seq seen twice is a duplicate and is not
 * applied again; a seq below the highest seen so far is reordered; any seq never seen
 * by the end is dropped.
 */
export class SeqTracker {
  private readonly seen: Uint8Array;
  private highest = -1;
  received = 0;
  duplicated = 0;
  unexpected = 0;
  reordered = 0;
  unique = 0;

  constructor(readonly total: number) {
    this.seen = new Uint8Array(total);
  }

  /** Records an arrival; returns true only for a first-time, in-range seq. */
  observe(seq: unknown): boolean {
    this.received += 1;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq >= this.total) {
      this.unexpected += 1;
      return false;
    }
    if (this.seen[seq]) {
      this.duplicated += 1;
      return false;
    }
    if (seq < this.highest) this.reordered += 1;
    this.highest = Math.max(this.highest, seq);
    this.seen[seq] = 1;
    this.unique += 1;
    return true;
  }

  /** Fixture events that never arrived. */
  get dropped(): number {
    return this.total - this.unique;
  }
}

/** Commit cadence: at most one commit per this many ms, so a burst is time-sliced. */
export const COMMIT_INTERVAL_MS = 33;
/** Events applied per commit at most; the rest carry over to the next commit. */
export const COMMIT_EVENT_CAP = 96;

/**
 * Time-slices pushed events into commits: at most one commit per COMMIT_INTERVAL_MS, at
 * most COMMIT_EVENT_CAP events each, the remainder carried over. `apply` runs the commit.
 */
export class FrameBatcher<T> {
  private queue: T[] = [];
  private frame: number | null = null;
  private lastCommit = -Infinity;
  flushes = 0;

  constructor(private readonly apply: (batch: T[]) => void) {}

  push(item: T): void {
    this.queue.push(item);
    this.schedule();
  }

  private schedule(): void {
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.onFrame());
  }

  private onFrame(): void {
    this.frame = null;
    if (this.queue.length === 0) return;
    if (performance.now() - this.lastCommit < COMMIT_INTERVAL_MS) {
      this.schedule();
      return;
    }
    this.commit();
    this.schedule();
  }

  private commit(): void {
    const n = Math.min(COMMIT_EVENT_CAP, this.queue.length);
    const batch = this.queue.slice(0, n);
    this.queue = this.queue.slice(n);
    this.lastCommit = performance.now();
    this.flushes += 1;
    this.apply(batch);
  }

  get pending(): number {
    return this.queue.length;
  }

  cancel(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.queue = [];
  }
}
