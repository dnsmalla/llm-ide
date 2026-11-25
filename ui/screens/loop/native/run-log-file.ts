// Persists a Factory run's log in the project (`system/loop-runs/logs/<runId>.log`) so a run whose record failed can
// still be diagnosed after the in-memory log is gone. It lives outside the run's worktree on purpose: the worktree's
// `.factory/` is rebuilt for each run and never part of an MR, and the project's own `system/` survives a Discard.
// Fail-open: a write error never reaches the run.
import type { FsApi } from "../../explorer/fs";
import { ensureDir } from "./testmap.ts";

/** Only the tail is kept: the newest lines are the ones that explain how a run ended. */
export const RUN_LOG_MAX_BYTES = 256 * 1024;
/** Older log files beyond this many are removed when a new one is created. */
export const RUN_LOG_MAX_FILES = 50;
export const RUN_LOG_DIR = "system/loop-runs/logs";
const DEBOUNCE_MS = 1000;
const READ_MAX = 2_000_000;

export interface RunLogWriter {
  add(line: string): void;
  /** Writes what is pending and waits for every earlier write. Never rejects. */
  flush(): Promise<void>;
}

type LogFs = Pick<FsApi, "write"> & Partial<Pick<FsApi, "read" | "list" | "remove" | "create">>;

/** The last RUN_LOG_MAX_BYTES bytes of `text`, starting at a line start when it had to cut. */
export function tailBytes(text: string, max = RUN_LOG_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  const cut = new TextDecoder().decode(bytes.slice(bytes.length - max));
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl + 1 < cut.length ? cut.slice(nl + 1) : cut;
}

export function runLogPath(runId: string): string {
  return `${RUN_LOG_DIR}/${runId}.log`;
}

/** Existing log text of this run (a reuse run), else null; then makes room for the new file. All best effort. */
async function prepareFile(fs: LogFs, path: string): Promise<string | null> {
  try {
    if (typeof fs.create === "function") await ensureDir(fs as Parameters<typeof ensureDir>[0], RUN_LOG_DIR);
  } catch { /* the write below reports nothing either */ }
  let prior: string | null = null;
  try {
    const r = typeof fs.read === "function" ? await fs.read(path, READ_MAX) : null;
    if (r && r.status === "ok" && r.text) prior = r.text;
  } catch { /* a new log */ }
  if (prior === null) await prune(fs, path);
  return prior;
}

async function prune(fs: LogFs, keepPath: string): Promise<void> {
  try {
    if (typeof fs.list !== "function" || typeof fs.remove !== "function") return;
    // Oldest by last write, not by name: a resumed old run's log is live and must outlast newer-named ones.
    const files = (await fs.list(RUN_LOG_DIR)).entries
      .filter((e) => e.name.endsWith(".log") && `${RUN_LOG_DIR}/${e.name}` !== keepPath)
      .sort((x, y) => (x.mtime_ms ?? 0) - (y.mtime_ms ?? 0) || x.name.localeCompare(y.name));
    // The new file counts as one of the kept ones.
    const extra = files.length + 1 - RUN_LOG_MAX_FILES;
    for (const file of files.slice(0, Math.max(0, extra))) await fs.remove(`${RUN_LOG_DIR}/${file.name}`).catch(() => undefined);
  } catch { /* pruning is housekeeping */ }
}

export function createRunLogWriter(fs: LogFs, path: string, initial: readonly string[] = [], now: () => Date = () => new Date()): RunLogWriter {
  let prefix = "";
  let text = "";
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const append = (line: string) => {
    text += `${line}\n`;
    // Cheap guard so a huge run does not grow the buffer unbounded between exact byte cuts.
    if (text.length > RUN_LOG_MAX_BYTES * 2) text = tailBytes(text);
    dirty = true;
  };
  // The first thing in the chain: every write waits for the previous contents and the directory.
  let chain: Promise<unknown> = prepareFile(fs, path).then((prior) => {
    if (prior !== null) prefix = `${prior.endsWith("\n") ? prior : `${prior}\n`}--- resumed ${now().toISOString()} ---\n`;
  }).catch(() => undefined);
  const write = () => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    chain = chain.then(() => fs.write(path, tailBytes(prefix + text), { expected_hash: null, force: true })).catch(() => undefined);
  };
  for (const line of initial) append(line);
  return {
    add(line) {
      append(line);
      if (timer === null) {
        timer = setTimeout(write, DEBOUNCE_MS);
        (timer as { unref?: () => void }).unref?.();
      }
    },
    async flush() {
      if (timer !== null) clearTimeout(timer);
      write();
      await chain;
    },
  };
}
