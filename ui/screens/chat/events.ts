// Typed decoder for the agent/v2 SSE vocabulary (schema/agent-v2/agent-v2.schema.json) and an
// incremental SSE framer. Pure: no DOM, no network. Unknown event types are ignored (the older
// Mac does the same); a KNOWN type with a wrong shape is reported as malformed, never applied.

export interface TaskItem { id: string; title: string; status: string }
export interface ContextCategory { name: string; kind: string; tokens: number }
export interface QuestionOption { label: string; description?: string; preview?: string }
export interface Question { question: string; header?: string; multiSelect: boolean; options: QuestionOption[] }

export type AgentEvent =
  | { type: "init"; sessionId: string | null; model: string | null; claudeCodeVersion: string | null; tools: string[]; capabilities: string[] }
  | { type: "delta"; text: string }
  | { type: "tool_use_start"; index: number; id: string | null; name: string | null }
  | { type: "tool_args_delta"; index: number; partialJson: string }
  | { type: "tool_result"; toolUseId: string | null; isError: boolean; text: string; truncated: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { type: "memory"; sessionFacts: number; chars: number; approxTokens: number }
  | { type: "context_usage"; totalTokens: number; maxTokens: number; percentage: number; categories: ContextCategory[] }
  | { type: "result"; subtype: string | null; costUsd: number | null; numTurns: number | null; durationMs: number | null; sessionId: string | null; stopReason: string | null }
  | { type: "sdk"; sdkType: string | null }
  | { type: "notice"; kind: string; level: "info" | "warning" | "error"; text: string; data: unknown }
  | { type: "approval_request"; requestId: string; kind: "ToolApproval"; toolName: string; argsSummary: string | null; args: Record<string, unknown> | null }
  | { type: "approval_request"; requestId: string; kind: "AskUserQuestion"; questions: Question[] }
  | { type: "approval_resolved"; requestId: string; outcome: string }
  | { type: "mode_set"; mode: string }
  | { type: "tasks"; tasks: TaskItem[]; continueNeeded: boolean }
  | { type: "tasks_progress"; tasks: TaskItem[] }
  | { type: "error"; code: string; message: string; retryable: boolean };

export type AgentEventType = AgentEvent["type"];

export type DecodeResult =
  | { ok: true; event: AgentEvent }
  | { ok: false; reason: "unknown_type" | "malformed" | "not_object"; type?: string };

export const KNOWN_EVENT_TYPES: readonly AgentEventType[] = [
  "init", "delta", "tool_use_start", "tool_args_delta", "tool_result", "usage", "memory", "context_usage",
  "result", "sdk", "notice", "approval_request", "approval_resolved", "mode_set", "tasks", "tasks_progress", "error",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);
const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

function tasksOf(v: unknown): TaskItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: TaskItem[] = [];
  for (const t of v) {
    if (!isObj(t) || !str(t.id) || !str(t.title) || !str(t.status)) return null;
    out.push({ id: t.id, title: t.title, status: t.status });
  }
  return out;
}

function questionsOf(v: unknown): Question[] | null {
  if (!Array.isArray(v)) return null;
  const out: Question[] = [];
  for (const q of v) {
    if (!isObj(q) || !str(q.question) || !Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const o of q.options) {
      if (!isObj(o) || !str(o.label)) return null;
      options.push({
        label: o.label,
        ...(str(o.description) ? { description: o.description } : {}),
        ...(str(o.preview) ? { preview: o.preview } : {}),
      });
    }
    out.push({ question: q.question, ...(str(q.header) ? { header: q.header } : {}), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

function categoriesOf(v: unknown): ContextCategory[] | null {
  if (!Array.isArray(v)) return null;
  const out: ContextCategory[] = [];
  for (const c of v) {
    if (!isObj(c) || !str(c.name) || !num(c.tokens)) return null;
    out.push({ name: c.name, kind: str(c.kind) ? c.kind : "used", tokens: c.tokens });
  }
  return out;
}

/** Decodes one parsed `data:` payload. */
export function decodeEvent(raw: unknown): DecodeResult {
  if (!isObj(raw)) return { ok: false, reason: "not_object" };
  const type = raw.type;
  if (!str(type) || !(KNOWN_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: "unknown_type", type: str(type) ? type : undefined };
  }
  const bad = (): DecodeResult => ({ ok: false, reason: "malformed", type });
  const good = (event: AgentEvent): DecodeResult => ({ ok: true, event });
  switch (type as AgentEventType) {
    case "init":
      if (!strOrNull(raw.sessionId) || !strOrNull(raw.model)) return bad();
      return good({
        type: "init", sessionId: raw.sessionId, model: raw.model,
        claudeCodeVersion: strOrNull(raw.claudeCodeVersion) ? raw.claudeCodeVersion : null,
        tools: strArray(raw.tools) ? raw.tools : [], capabilities: strArray(raw.capabilities) ? raw.capabilities : [],
      });
    case "delta":
      return str(raw.text) ? good({ type: "delta", text: raw.text }) : bad();
    case "tool_use_start":
      if (!num(raw.index) || !strOrNull(raw.id) || !strOrNull(raw.name)) return bad();
      return good({ type: "tool_use_start", index: raw.index, id: raw.id, name: raw.name });
    case "tool_args_delta":
      return num(raw.index) && str(raw.partialJson) ? good({ type: "tool_args_delta", index: raw.index, partialJson: raw.partialJson }) : bad();
    case "tool_result":
      if (!strOrNull(raw.toolUseId) || !str(raw.text)) return bad();
      return good({ type: "tool_result", toolUseId: raw.toolUseId, isError: raw.isError === true, text: raw.text, truncated: raw.truncated === true });
    case "usage":
      if (![raw.inputTokens, raw.outputTokens, raw.cacheReadTokens, raw.cacheCreationTokens].every(num)) return bad();
      return good({
        type: "usage", inputTokens: raw.inputTokens as number, outputTokens: raw.outputTokens as number,
        cacheReadTokens: raw.cacheReadTokens as number, cacheCreationTokens: raw.cacheCreationTokens as number,
      });
    case "memory":
      if (![raw.sessionFacts, raw.chars, raw.approxTokens].every(num)) return bad();
      return good({ type: "memory", sessionFacts: raw.sessionFacts as number, chars: raw.chars as number, approxTokens: raw.approxTokens as number });
    case "context_usage": {
      const categories = categoriesOf(raw.categories);
      if (![raw.totalTokens, raw.maxTokens, raw.percentage].every(num) || !categories) return bad();
      return good({ type: "context_usage", totalTokens: raw.totalTokens as number, maxTokens: raw.maxTokens as number, percentage: raw.percentage as number, categories });
    }
    case "result":
      return good({
        type: "result",
        subtype: strOrNull(raw.subtype) ? raw.subtype : null,
        costUsd: numOrNull(raw.costUsd) ? raw.costUsd : null,
        numTurns: numOrNull(raw.numTurns) ? raw.numTurns : null,
        durationMs: numOrNull(raw.durationMs) ? raw.durationMs : null,
        sessionId: strOrNull(raw.sessionId) ? raw.sessionId : null,
        stopReason: strOrNull(raw.stopReason) ? raw.stopReason : null,
      });
    case "sdk":
      return good({ type: "sdk", sdkType: strOrNull(raw.sdkType) ? raw.sdkType : null });
    case "notice":
      if (!str(raw.kind) || !str(raw.text)) return bad();
      return good({
        type: "notice", kind: raw.kind, text: raw.text, data: raw.data ?? null,
        level: raw.level === "warning" || raw.level === "error" ? raw.level : "info",
      });
    case "approval_request": {
      if (!str(raw.requestId)) return bad();
      if (raw.kind === "AskUserQuestion") {
        const questions = questionsOf(raw.questions);
        return questions ? good({ type: "approval_request", requestId: raw.requestId, kind: "AskUserQuestion", questions }) : bad();
      }
      if (raw.kind === "ToolApproval" && str(raw.toolName)) {
        return good({
          type: "approval_request", requestId: raw.requestId, kind: "ToolApproval", toolName: raw.toolName,
          argsSummary: strOrNull(raw.argsSummary) ? raw.argsSummary : null, args: isObj(raw.args) ? raw.args : null,
        });
      }
      return bad();
    }
    case "approval_resolved":
      return str(raw.requestId) && str(raw.outcome) ? good({ type: "approval_resolved", requestId: raw.requestId, outcome: raw.outcome }) : bad();
    case "mode_set":
      return str(raw.mode) ? good({ type: "mode_set", mode: raw.mode }) : bad();
    case "tasks": {
      const tasks = tasksOf(raw.tasks);
      return tasks ? good({ type: "tasks", tasks, continueNeeded: raw.continueNeeded === true }) : bad();
    }
    case "tasks_progress": {
      const tasks = tasksOf(raw.tasks);
      return tasks ? good({ type: "tasks_progress", tasks }) : bad();
    }
    case "error":
      return str(raw.code) && str(raw.message) ? good({ type: "error", code: raw.code, message: raw.message, retryable: raw.retryable === true }) : bad();
  }
}

/** Largest single SSE event payload accepted (a runaway or hostile stream cannot grow the buffer). */
export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;

/**
 * Incremental SSE framer: feed text chunks (any split), get the `data:` payload of each complete
 * event. Handles CRLF, multi-line data, comments, and ignores other fields.
 */
export class SseFramer {
  private buf = "";
  private data: string[] = [];
  /** True once an event exceeded MAX_SSE_EVENT_BYTES (the stream should be aborted). */
  overflow = false;

  push(chunk: string): string[] {
    this.buf += chunk;
    if (this.buf.length > MAX_SSE_EVENT_BYTES) { this.overflow = true; this.buf = ""; this.data = []; return []; }
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buf.indexOf("\n", start);
      if (nl === -1) break;
      let line = this.buf.slice(start, nl);
      start = nl + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.data.length) { out.push(this.data.join("\n")); this.data = []; }
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(line.charAt(5) === " " ? 6 : 5));
      }
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Flushes a final event not terminated by a blank line. */
  end(): string[] {
    const out: string[] = [];
    if (this.buf.startsWith("data:")) this.data.push(this.buf.slice(this.buf.charAt(5) === " " ? 6 : 5));
    if (this.data.length) out.push(this.data.join("\n"));
    this.buf = ""; this.data = [];
    return out;
  }
}

/** Parses and decodes one `data:` payload string. */
export function decodePayload(payload: string): DecodeResult {
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return { ok: false, reason: "malformed" }; }
  return decodeEvent(raw);
}
