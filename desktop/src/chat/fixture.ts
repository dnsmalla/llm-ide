// Deterministic recorded Agent v2 turn for the chat replay (Phase 0 T7).
//
// Shapes follow schema/agent-v2/fixtures (the server's own examples) and the order
// the server emits: init, mode_set, then the SDK stream (deltas and tool events),
// usage, context_usage, tasks, result. Every event also carries `seq` (0-based, dense):
// the real wire has no such field, so the client uses it only to detect drops and
// duplicates in the replay. The same seed always produces the same events.
import { mulberry32 } from "../graph/prng";

export const FIXTURE_SEED = 0x7e57c0de;
/** Text deltas in the fixture; the bench's expected count. */
export const FIXTURE_DELTAS = 2000;

export interface FixtureEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

// Fragments mix prose, markdown, code fences, CJK and emoji. Splitting happens on code
// points, so a delta can end between the two halves of an emoji's surrogate pair only if
// the source did — and it never does here.
const FRAGMENTS: readonly string[] = [
  "I'll read the decoder first. ",
  "The engine streams text as it arrives, ",
  "so the bubble grows with every delta. ",
  "**Bold claim:** the wire is camelCase. ",
  "*Emphasis* on the tool name `mapSdkMessage`. ",
  "日本語のテキストも同じ経路で届きます。",
  "中文字符与标点，，。 ",
  "한국어 텍스트 줄바꿈 테스트 ",
  "絵文字 🚀 and emoji 🧪 mixed in 👩‍💻 ",
  "\n\n## Findings\n\n",
  "\n- `tool_use_start` carries the block index\n",
  "- `usage` sums per message, see `TokenCostPolicy`\n",
  "- 1. ordered item with `inline code`\n",
  "\n```swift\nlet usage = AgentV2Usage(inputTokens: 10, outputTokens: 5)\nprint(usage.billableTokens)\n```\n\n",
  "```ts\nconst seq = event.seq; // 0..N-1\n```\n",
  "Plain sentence with an unterminated `inline ",
  "` code span closed later. ",
  "\n\n### Next step\n\n",
  "Read the file at `/repo/mac/Sources/LlmIdeMac/ClaudeLink/AgentV2Event.swift` now. ",
  "Quotes \"like this\" and an apostrophe's tail — dashes – and ellipses… ",
  "\n\n",
];

/** Text of `count` code points built from the fragments, deterministic per rng. */
function buildText(rng: () => number, codePoints: number): string[] {
  const out: string[] = [];
  let have = 0;
  while (have < codePoints) {
    const frag = FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)];
    const chars = Array.from(frag);
    out.push(frag);
    have += chars.length;
  }
  return out;
}

/** Splits `text` (code-point aware) into `parts` non-empty pieces of varied size, ~average-sized. */
function splitVaried(rng: () => number, text: string, parts: number): string[] {
  const chars = Array.from(text);
  if (chars.length < parts) throw new Error(`fixture text too short: ${chars.length} < ${parts} pieces`);
  const pieces: string[] = [];
  let at = 0;
  for (let i = 0; i < parts - 1; i++) {
    const left = parts - i;
    const remaining = chars.length - at;
    // Leave at least one code point for every piece still to come.
    const max = remaining - (left - 1);
    const avg = remaining / left;
    const size = Math.min(max, Math.max(1, 1 + Math.floor(rng() * (2 * avg - 1))));
    pieces.push(chars.slice(at, at + size).join(""));
    at += size;
  }
  pieces.push(chars.slice(at).join(""));
  return pieces;
}

const TOOL_CALLS: ReadonlyArray<{ name: string; input: Record<string, string>; result: string }> = [
  {
    name: "Read",
    input: { file_path: "/repo/mac/Sources/LlmIdeMac/ClaudeLink/AgentV2Event.swift" },
    result: "import Foundation\n\n// Decode layer for the v2 chat engine's SSE event stream\nenum AgentV2Event: Sendable, Equatable {}\n",
  },
  {
    name: "Grep",
    input: { pattern: "tool_args_delta", path: "/repo/extension/llm_agent/sdk" },
    result: "extension/llm_agent/sdk/events.mjs:72: if (d?.type === 'input_json_delta')\nextension/routes/agent-v2.mjs:440\n",
  },
  {
    name: "Bash",
    input: { command: "git -C /repo log --oneline -3", description: "Show recent commits" },
    result: "82042a93 feat(desktop): package the Node core\n828e2aff feat(desktop): xterm.js terminal 日本語\n3d7d37d8 feat(desktop): Monaco editor 🧪\n",
  },
];

const MSG_1 = "msg_01FixtureMessageOne";
const MSG_2 = "msg_01FixtureMessageTwo";

/** The server's closing order: result, then context_usage, then tasks. */
function closing(raw: Array<Record<string, unknown>>): void {
  raw.push({
    type: "result",
    subtype: "success",
    costUsd: 0.0417,
    numTurns: 3,
    durationMs: 18422,
    sessionId: "3f9a1c2e-7b40-4d11-9c33-8a2f6b5e0d17",
    stopReason: "end_turn",
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 10,
        outputTokens: 1822,
        cacheReadInputTokens: 80000,
        cacheCreationInputTokens: 8000,
        costUSD: 0.0417,
        contextWindow: 1000000,
      },
    },
    usage: { input_tokens: 10, output_tokens: 1822, cache_read_input_tokens: 80000, cache_creation_input_tokens: 8000 },
  });
  raw.push({
    type: "context_usage",
    totalTokens: 52410,
    maxTokens: 1000000,
    percentage: 5,
    categories: [
      { name: "System tools", kind: "used", tokens: 1809 },
      { name: "Messages", kind: "used", tokens: 50601 },
      { name: "Autocompact buffer", kind: "buffer", tokens: 33000 },
      { name: "Free space", kind: "free", tokens: 914590 },
    ],
  });
  raw.push({
    type: "tasks",
    tasks: [
      { id: "t1", title: "Add sse_replay module", status: "completed" },
      { id: "t2", title: "Render chat stream", status: "completed" },
      { id: "t3", title: "Bench drops and duplicates", status: "in_progress" },
    ],
    continueNeeded: false,
  });
}

function initEvents(raw: Array<Record<string, unknown>>): void {
  raw.push({
    type: "init",
    sessionId: "3f9a1c2e-7b40-4d11-9c33-8a2f6b5e0d17",
    claudeCodeVersion: "0.3.283",
    model: "claude-sonnet-5",
    tools: ["Read", "Glob", "Grep", "Bash", "mcp__llmide__read-file"],
    capabilities: ["streaming"],
    mcpServers: [{ name: "llmide", status: "connected" }],
  });
  raw.push({ type: "mode_set", mode: "execute" });
}

function usage(raw: Array<Record<string, unknown>>, messageId: string, output: number, cacheCreation: number): void {
  raw.push({
    type: "usage",
    messageId,
    inputTokens: 10,
    outputTokens: output,
    cacheReadTokens: 40000,
    cacheCreationTokens: cacheCreation,
  });
}

/**
 * The turn: 2000 deltas in four segments, three tool groups, three usage events. The first
 * message's usage arrives mid-stream; the second message's usage arrives twice (a partial
 * snapshot, then the final one), which the client must dedupe by messageId.
 * Closing order matches the server: result, context_usage, tasks.
 */
export function buildFixture(): FixtureEvent[] {
  const rng = mulberry32(FIXTURE_SEED);
  const raw: Array<Record<string, unknown>> = [];
  initEvents(raw);

  const segmentDeltas = FIXTURE_DELTAS / 4;
  const segmentCodePoints = [2000, 2200, 1800, 2400];
  for (let seg = 0; seg < 4; seg++) {
    const text = buildText(rng, segmentCodePoints[seg]).join("");
    for (const piece of splitVaried(rng, text, segmentDeltas)) {
      raw.push({ type: "delta", text: piece });
    }
    if (seg === 1) usage(raw, MSG_1, 412, 8000); // mid-stream: first message complete
    if (seg === 2) usage(raw, MSG_2, 700, 0); // second message, partial snapshot
    if (seg < 3) {
      const call = TOOL_CALLS[seg];
      const id = `toolu_0${seg + 1}FixtureReplay${seg}ABCDEF`;
      raw.push({ type: "tool_use_start", index: seg, id, name: call.name });
      for (const piece of splitVaried(rng, JSON.stringify(call.input), 3)) {
        raw.push({ type: "tool_args_delta", index: seg, partialJson: piece });
      }
      raw.push({ type: "tool_result", toolUseId: id, isError: false, text: call.result, truncated: false });
    }
  }
  usage(raw, MSG_2, 1412, 0); // final snapshot for the second message (replaces the partial)
  closing(raw);
  return raw.map((ev, seq) => ({ seq, ...ev }) as FixtureEvent);
}

/**
 * One long assistant message: about 50 000 code points in ~4 000 deltas, with paragraph
 * breaks, fences and CJK. Full-speed only; used for the long-message bench.
 */
export function buildLongFixture(): FixtureEvent[] {
  const rng = mulberry32(FIXTURE_SEED ^ 0x10000);
  const raw: Array<Record<string, unknown>> = [];
  initEvents(raw);
  const text = buildText(rng, 50000).join("");
  for (const piece of splitVaried(rng, text, 4000)) raw.push({ type: "delta", text: piece });
  usage(raw, MSG_1, 12000, 0);
  closing(raw);
  return raw.map((ev, seq) => ({ seq, ...ev }) as FixtureEvent);
}

/** Number of text deltas in a built fixture (what the bench compares against). */
export function countDeltas(events: readonly FixtureEvent[]): number {
  return events.filter((e) => e.type === "delta").length;
}
