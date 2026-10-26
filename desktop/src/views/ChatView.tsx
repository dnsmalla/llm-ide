import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "../chat/chat.css";
import { EMPTY_CHAT, FrameBatcher, SeqTracker, applyBatch, startTurn, turnUsage, type ChatModel, type Message, type Part, type TextPart, type ToolStep, type UsageInfo } from "../chat/chatModel";
import { buildFixture, type FixtureEvent } from "../chat/fixture";
import { replayEvents, type ReplayOptions } from "../chat/replay";
import { runChatBench, notifyFinalRendered, type CommitSample, type TurnStats } from "../chat/chatBench";
import { Markdown } from "../chat/markdown";
import { StatusBanner } from "../design/components/StatusBanner";
import { emitBench } from "../editor/editorBench";

/** Autobench hard limit: the three benches (burst, paced at 20 ms/event, long) fit well inside it. */
const WATCHDOG_MS = 300_000;
const PROMPT = "Replay the recorded turn: read the decoder and summarise the wire events.";
const COMMIT_MARK = "chat-commit-start";
const COMMIT_MEASURE = "chat-commit";

// Module-level guards: StrictMode runs effects twice in development.
let benchStarted = false;
let watchdogStarted = false;

/** A sealed (closed) markdown block: its text never changes, so the memo skips it on every commit. */
const SealedBlock = memo(function SealedBlock({ text }: { text: string }) {
  return <Markdown text={text} />;
});

/** Text part: sealed blocks are memoised; only the open tail is parsed per commit. */
const TextPartView = memo(function TextPartView({ part }: { part: TextPart }) {
  const tail = part.open + part.line;
  return (
    <>
      {part.sealed.map((text, i) => (
        <SealedBlock key={i} text={text} />
      ))}
      {tail !== "" && <Markdown text={tail} />}
    </>
  );
});

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolStep }) {
  const state = tool.result === null ? "running" : tool.result.isError ? "error" : "done";
  return (
    <details className="chat-tool" data-state={state}>
      <summary>
        <span className="chat-tool-name">{tool.name}</span>
        <span className="chat-tool-state">{state}</span>
      </summary>
      <div className="chat-tool-body">
        <div className="chat-tool-label">Input</div>
        <pre className="ui-md-code">{prettyArgs(tool.args)}</pre>
        {tool.result && (
          <>
            <div className="chat-tool-label">Result{tool.result.truncated ? " (truncated)" : ""}</div>
            <pre className="ui-md-code">{tool.result.text}</pre>
          </>
        )}
      </div>
    </details>
  );
});

function prettyArgs(raw: string): string {
  if (raw === "") return "(streaming)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // still streaming: partial JSON is shown as it arrives
  }
}

const UserBubble = memo(function UserBubble({ text }: { text: string }) {
  return (
    <div className="chat-row chat-row-user">
      <div className="chat-bubble-user">{text}</div>
    </div>
  );
});

function UsageFooter({ usage }: { usage: UsageInfo }) {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <div className="chat-usage">
      turn usage: input {n(usage.inputTokens)} · output {n(usage.outputTokens)} · cache read {n(usage.cacheReadTokens)} · cache
      write {n(usage.cacheCreationTokens)}
    </div>
  );
}

const AssistantParts = memo(function AssistantParts({ parts }: { parts: Part[] }) {
  return (
    <div className="chat-row chat-row-assistant">
      <div className="chat-assistant">
        {parts.map((p, i) =>
          p.kind === "text" ? <TextPartView key={i} part={p} /> : <ToolRow key={p.id || i} tool={p} />,
        )}
      </div>
    </div>
  );
});

function MessageView({ message }: { message: Message }) {
  if (message.role === "user") return <UserBubble text={message.text} />;
  return <AssistantParts parts={message.parts} />;
}

/** The turn in flight: its stats collect commit samples from the layout effect. */
const activeTurn: { current: TurnStats | null; pending: { chars: number } | null } = { current: null, pending: null };

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Wire-stream turn view: user bubble, assistant text (markdown), tool rows, usage. */
export function ChatView() {
  const [model, setModel] = useState<ChatModel>(EMPTY_CHAT);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const turnCount = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  // One turn. Events are queued and committed by FrameBatcher (at most every 33 ms, 96 events
  // each); the promise resolves once the queue is empty, before its last commit has painted.
  const runTurn = useCallback(async (userText: string, events: readonly FixtureEvent[], options: ReplayOptions): Promise<TurnStats> => {
    runningRef.current = true;
    setRunning(true);
    turnCount.current += 1;
    const turnId = `turn${turnCount.current}`;
    setModel((m) => startTurn(m, userText, turnId, events.length));
    const tracker = new SeqTracker(events.length);
    const stats: TurnStats = {
      tracker,
      streamCount: 0,
      channelCount: 0,
      parseTotalMs: 0,
      parseMaxMs: 0,
      flushes: 0,
      commits: [] as CommitSample[],
      deltaChars: 0,
    };
    activeTurn.current = stats;
    const batcher = new FrameBatcher<FixtureEvent>((batch) => {
      for (const ev of batch) if (ev.type === "delta") stats.deltaChars += String(ev.text ?? "").length;
      performance.mark(COMMIT_MARK);
      activeTurn.pending = { chars: stats.deltaChars };
      setModel((m) => applyBatch(m, batch));
    });
    try {
      const run = await replayEvents(events, tracker, (ev) => batcher.push(ev), options);
      Object.assign(stats, run);
      while (batcher.pending > 0) await nextFrame();
      stats.flushes = batcher.flushes;
      return stats;
    } finally {
      batcher.cancel();
      runningRef.current = false;
      setRunning(false);
    }
  }, []);

  // After each commit: record its duration (performance.measure from the apply mark), and
  // signal the bench once the turn's final event is in the committed model.
  useLayoutEffect(() => {
    const pending = activeTurn.pending;
    if (pending && activeTurn.current) {
      const measure = performance.measure(COMMIT_MEASURE, COMMIT_MARK);
      activeTurn.current.commits.push({ ms: measure.duration, chars: pending.chars });
      activeTurn.pending = null;
      performance.clearMarks(COMMIT_MARK);
      performance.clearMeasures(COMMIT_MEASURE);
    }
    if (model.turnTotal > 0 && model.lastSeq === model.turnTotal - 1) notifyFinalRendered();
  }, [model]);

  // Keep the newest content in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [model.applied]);

  // LLMIDE_POC_AUTOBENCH=chat: the three benches, then exit through bench_done. Outside the
  // try, so a normal launch never reaches the exit call.
  useEffect(() => {
    if (benchStarted) return;
    benchStarted = true;
    void (async () => {
      const mode = await invoke<string | null>("autobench_mode").catch(() => null);
      if (mode !== "chat") return;
      try {
        await runChatBench(runTurn);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await emitBench({ name: "chat_error", value: 0, unit: "error", message }).catch(() => undefined);
      } finally {
        await invoke("bench_done").catch(() => undefined);
      }
    })();
  }, [runTurn]);

  // Watchdog: in chat autobench mode, a hang becomes a chat_error and an exit.
  useEffect(() => {
    if (watchdogStarted) return;
    watchdogStarted = true;
    void invoke<string | null>("autobench_mode")
      .catch(() => null)
      .then((mode) => {
        if (mode !== "chat") return;
        setTimeout(() => {
          void emitBench({ name: "chat_error", value: 0, unit: "error", message: `watchdog: bench not finished after ${WATCHDOG_MS} ms` })
            .catch(() => undefined)
            .finally(() => void invoke("bench_done").catch(() => undefined));
        }, WATCHDOG_MS);
      });
  }, []);

  // Plain-launch replay: the burst fixture at full speed.
  const replayButton = useCallback(() => {
    void runTurn(PROMPT, buildFixture(), {}).catch(() => undefined);
  }, [runTurn]);

  const usage = turnUsage(model);
  const context = model.context;
  return (
    <section className="chat-view">
      <header className="chat-bar">
        <span className="chat-bar-title">Chat</span>
        {model.mode && <span className="chat-bar-meta">mode {model.mode}</span>}
        {model.model && <span className="chat-bar-meta">{model.model}</span>}
        <span className="chat-bar-spacer" />
        <button type="button" className="chat-replay" disabled={running} onClick={replayButton}>
          Replay recorded turn
        </button>
      </header>
      <div className="chat-scroll" ref={scroller}>
        {model.messages.length === 0 && (
          <div className="chat-empty">Replays a recorded Agent v2 stream from a local Rust server.</div>
        )}
        {model.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {usage && <UsageFooter usage={usage} />}
        {model.error && <StatusBanner severity="error" message={model.error} />}
      </div>
      <footer className="chat-footer">
        {context
          ? `context ${context.percentage}% of ${context.maxTokens.toLocaleString("en-US")} tokens (${context.totalTokens.toLocaleString("en-US")} used)`
          : "context: not reported yet"}
        {model.result && ` · ${model.result.stopReason ?? "done"} in ${model.result.durationMs ?? "?"} ms`}
      </footer>
    </section>
  );
}
