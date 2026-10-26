// Replay transport for the chat fixtures. Rust serves the recorded events on a loopback
// port (sse_replay_start) and reads that stream itself (sse_channel_stream), forwarding
// each `data:` payload over a Tauri Channel. The webview never opens the HTTP socket, so
// the CSP connect-src and the core's CORS allowlist are not involved.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { FixtureEvent } from "./fixture";
import type { SeqTracker } from "./chatModel";

/** How long to wait for channel messages still in flight after the stream command returns. */
const SETTLE_CAP_MS = 5_000;

export interface ReplayOptions {
  /** Server-side pause between events; 0 replays at full speed. */
  delayMs?: number;
}

export interface ReplayRun {
  /** Events the Rust reader forwarded (the stream command's own count). */
  streamCount: number;
  /** Events the webview received over the channel. */
  channelCount: number;
  /** Total and worst time spent in JSON.parse across all channel messages. */
  parseTotalMs: number;
  parseMaxMs: number;
}

/**
 * Replays `events` through the Rust server and channel. `onEvent` receives each event whose
 * seq is new (duplicates are counted by the tracker and not forwarded).
 */
export async function replayEvents(
  events: readonly FixtureEvent[],
  tracker: SeqTracker,
  onEvent: (ev: FixtureEvent) => void,
  options: ReplayOptions = {},
): Promise<ReplayRun> {
  const port = await invoke<number>("sse_replay_start", {
    eventsJson: JSON.stringify(events),
    delayMs: options.delayMs ?? 0,
  });
  let parseTotalMs = 0;
  let parseMaxMs = 0;
  try {
    const channel = new Channel<string>();
    channel.onmessage = (raw: string) => {
      const t = performance.now();
      const ev = JSON.parse(raw) as FixtureEvent;
      const took = performance.now() - t;
      parseTotalMs += took;
      parseMaxMs = Math.max(parseMaxMs, took);
      if (tracker.observe(ev.seq)) onEvent(ev);
    };
    const streamCount = await invoke<number>("sse_channel_stream", { port, onEvent: channel });
    // Channel messages and the command result travel separately; wait for the tail.
    const started = performance.now();
    while (tracker.received < streamCount && performance.now() - started < SETTLE_CAP_MS) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { streamCount, channelCount: tracker.received, parseTotalMs, parseMaxMs };
  } finally {
    await invoke("sse_replay_stop").catch(() => undefined);
  }
}
