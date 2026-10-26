// Chat bench: three runs through the Rust channel path, each with the stall monitor running
// and the timer ending when the final event of the turn has been committed and painted.
//   burst  - the 2 021-event turn at full speed (commit cadence, drops, dupes)
//   paced  - the same turn at 20 ms per event (~50 events/s): stalls and commit cost per
//            position in the message, to expose any O(n^2) growth
//   long   - a ~50 000 code point message at full speed
// Used only in LLMIDE_POC_AUTOBENCH=chat.
import { emitBench, percentile, waitVisibleAndPainted } from "../editor/editorBench";
import { startStallMonitor } from "../terminal/stall";
import type { SeqTracker } from "./chatModel";
import { buildFixture, buildLongFixture, type FixtureEvent } from "./fixture";
import type { ReplayRun, ReplayOptions } from "./replay";

const round1 = (n: number) => Math.round(n * 10) / 10;
export const PACED_DELAY_MS = 20;

export interface CommitSample {
  /** Time the commit took: apply start to layout effect, from performance.measure. */
  ms: number;
  /** Cumulative delta characters applied up to and including this commit. */
  chars: number;
}

export interface TurnStats extends ReplayRun {
  tracker: SeqTracker;
  flushes: number;
  commits: CommitSample[];
  /** Total delta characters in the turn. */
  deltaChars: number;
}

export interface TurnRunner {
  (userText: string, events: readonly FixtureEvent[], options: ReplayOptions): Promise<TurnStats>;
}

/** Resolver for "the final event of the turn is painted"; armed by the bench, fired by ChatView. */
let finalWaiter: ((at: number) => void) | null = null;

/** Arms the waiter and returns a promise for the paint time of the turn's final commit. */
export function armFinalWaiter(): Promise<number> {
  return new Promise((resolve) => {
    finalWaiter = resolve;
  });
}

/** Called by ChatView after the commit that applies the turn's last event; resolves after that frame paints. */
export function notifyFinalRendered(): void {
  const waiter = finalWaiter;
  if (!waiter) return;
  finalWaiter = null;
  requestAnimationFrame(() => requestAnimationFrame(() => waiter(performance.now())));
}

interface RunResult {
  stats: TurnStats;
  renderMs: number;
  stall: { maxMs: number; method: "longtask" | "drift" };
}

async function timedRun(runTurn: TurnRunner, events: readonly FixtureEvent[], options: ReplayOptions): Promise<RunResult> {
  const rendered = armFinalWaiter();
  const stopStall = startStallMonitor();
  const t0 = performance.now();
  const stats = await runTurn("Replay the recorded turn: read the decoder and summarise the wire events.", events, options);
  const at = await rendered;
  const stall = stopStall();
  return { stats, renderMs: at - t0, stall };
}

/** Median of a list (0 when empty). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

async function emitCounts(prefix: string, stats: TurnStats, fixtureEvents: number): Promise<void> {
  const t = stats.tracker;
  await emitBench({ name: `${prefix}fixture_events`, value: fixtureEvents, unit: "events" });
  await emitBench({ name: `${prefix}events_total`, value: t.received, unit: "events" });
  await emitBench({ name: `${prefix}events_dropped`, value: t.dropped, unit: "events" });
  await emitBench({ name: `${prefix}events_duplicated`, value: t.duplicated, unit: "events" });
  await emitBench({ name: `${prefix}events_unexpected`, value: t.unexpected + t.reordered, unit: "events" });
  await emitBench({ name: `${prefix}stream_count`, value: stats.streamCount, unit: "events" });
}

async function emitCommits(prefix: string, samples: readonly number[]): Promise<void> {
  const sorted = [...samples].sort((a, b) => a - b);
  await emitBench({ name: `${prefix}commit_p95_ms`, value: round1(sorted.length ? percentile(sorted, 0.95) : 0), unit: "ms" });
  await emitBench({ name: `${prefix}commit_max_ms`, value: round1(sorted.length ? sorted[sorted.length - 1] : 0), unit: "ms" });
}

/** Burst run: the full turn at full speed. */
async function runBurst(runTurn: TurnRunner): Promise<void> {
  const events = buildFixture();
  const { stats, renderMs, stall } = await timedRun(runTurn, events, {});
  await emitCounts("chat_", stats, events.length);
  await emitBench({ name: "chat_render_ms", value: round1(renderMs), unit: "ms" });
  await emitBench({ name: "chat_render_batches", value: stats.flushes, unit: "commits" });
  await emitBench({ name: "chat_max_stall_ms", value: stall.maxMs, unit: "ms" });
  await emitBench({ name: "chat_stall_method", value: 0, unit: "method", method: stall.method });
  await emitCommits("chat_", stats.commits.map((c) => c.ms));
  await emitBench({ name: "chat_parse_total_ms", value: round1(stats.parseTotalMs), unit: "ms" });
  await emitBench({ name: "chat_parse_max_ms", value: round1(stats.parseMaxMs), unit: "ms" });
}

/** Paced run: 20 ms per event; commit cost compared at the start and end of the message. */
async function runPaced(runTurn: TurnRunner): Promise<void> {
  const events = buildFixture();
  const { stats, renderMs, stall } = await timedRun(runTurn, events, { delayMs: PACED_DELAY_MS });
  const prefix = "chat_paced_";
  await emitCounts(prefix, stats, events.length);
  await emitBench({ name: `${prefix}render_ms`, value: round1(renderMs), unit: "ms" });
  await emitBench({ name: `${prefix}max_stall_ms`, value: stall.maxMs, unit: "ms" });
  await emitCommits(prefix, stats.commits.map((c) => c.ms));
  const total = stats.deltaChars;
  const first = stats.commits.filter((c) => c.chars <= total * 0.1).map((c) => c.ms);
  const last = stats.commits.filter((c) => c.chars >= total * 0.9).map((c) => c.ms);
  await emitBench({ name: `${prefix}commit_first_ms`, value: round1(median(first)), unit: "ms", commits: first.length });
  await emitBench({ name: `${prefix}commit_last_ms`, value: round1(median(last)), unit: "ms", commits: last.length });
}

/** Long run: one ~50 000 code point message at full speed. */
async function runLong(runTurn: TurnRunner): Promise<void> {
  const events = buildLongFixture();
  const { stats, renderMs, stall } = await timedRun(runTurn, events, {});
  const prefix = "chat_long_";
  await emitCounts(prefix, stats, events.length);
  await emitBench({ name: `${prefix}chars`, value: stats.deltaChars, unit: "chars" });
  await emitBench({ name: `${prefix}render_ms`, value: round1(renderMs), unit: "ms" });
  await emitBench({ name: `${prefix}max_stall_ms`, value: stall.maxMs, unit: "ms" });
  await emitCommits(prefix, stats.commits.map((c) => c.ms));
}

/** Runs the three benches in order. Throws on failure; the caller reports and exits. */
export async function runChatBench(runTurn: TurnRunner): Promise<void> {
  const visibleWaitMs = await waitVisibleAndPainted();
  await emitBench({ name: "chat_visible_wait_ms", value: round1(visibleWaitMs), unit: "ms" });
  await runBurst(runTurn);
  await runPaced(runTurn);
  await runLong(runTurn);
}
