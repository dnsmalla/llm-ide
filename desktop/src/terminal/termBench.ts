// Terminal bench: `yes | head -1000000` through the real shell and pty, timed until the
// marker has been parsed by xterm (write callback), with the longest main-thread stall
// during the run. Emits BENCH lines via the same `bench` command as the other benches.
import type { Terminal } from "@xterm/xterm";
import { emitBench } from "../editor/editorBench";
import type { PtyHandle } from "./ptyClient";
import type { OutputPump } from "./outputPump";
import { startStallMonitor } from "./stall";

/** The marker is split in the typed command so the echoed command line never matches it. */
export const BENCH_COMMAND = "yes | head -1000000; echo __BENCH_DONE''__";
export const BENCH_MARKER = "__BENCH_DONE__";
/** Settle time after the first prompt output before the bench starts. */
const PROMPT_SETTLE_MS = 500;
/** Cap for the wait on the first output; a shell that never prints is an error. */
const FIRST_OUTPUT_CAP_MS = 30_000;

export interface TerminalReady {
  term: Terminal;
  handle: PtyHandle;
  /** Shell basename, the tab label. */
  shell: string;
  pump: OutputPump;
  visibleWaitMs: number;
  renderer: "webgl" | "dom";
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForFirstOutput(pump: OutputPump): Promise<void> {
  const start = performance.now();
  while (pump.firstOutputAt === null) {
    if (performance.now() - start > FIRST_OUTPUT_CAP_MS) throw new Error("shell printed nothing within 30 s");
    await sleep(20);
  }
}

/** Runs the bench on an open terminal with a live shell. Throws on failure. */
export async function runTerminalBench(ready: TerminalReady): Promise<void> {
  const { handle, pump } = ready;
  await emitBench({ name: "term_visible_wait_ms", value: round1(ready.visibleWaitMs), unit: "ms" });
  await emitBench({ name: "term_renderer", value: 0, unit: "renderer", renderer: ready.renderer });

  await waitForFirstOutput(pump);
  await sleep(PROMPT_SETTLE_MS);

  const bytesBefore = pump.bytes;
  const stopStall = startStallMonitor();
  const marked = new Promise<number>((resolve) => pump.watch(BENCH_MARKER, resolve));
  const t0 = performance.now();
  await handle.write(`${BENCH_COMMAND}\r`);
  const tEnd = await marked;
  const stall = stopStall();
  const bytes = pump.bytes - bytesBefore;

  await emitBench({ name: "term_1m_lines_ms", value: round1(tEnd - t0), unit: "ms", lines: 1000000 });
  await emitBench({ name: "term_max_stall_ms", value: stall.maxMs, unit: "ms" });
  await emitBench({ name: "term_stall_method", value: 0, unit: "method", method: stall.method });
  await emitBench({ name: "term_bytes", value: bytes, unit: "bytes" });
}
