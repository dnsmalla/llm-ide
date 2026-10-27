// Bench record sink: every BENCH line goes through `emitBench`, which prints it via the Rust
// `bench` command and keeps a copy for the Bench tab's results table.
import { invoke } from "@tauri-apps/api/core";

export type BenchRecord = Record<string, string | number>;

let records: readonly BenchRecord[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Prints one measurement as `BENCH <json>` and records it for the table. */
export function emitBench(record: BenchRecord): Promise<void> {
  records = [...records, record];
  notify();
  return invoke("bench", { line: JSON.stringify(record) });
}

/** Records a measurement that was printed elsewhere (the Rust AX probe prints its own lines). */
export function addRecords(added: readonly BenchRecord[]): void {
  records = [...records, ...added];
  notify();
}

export function clearRecords(): void {
  records = [];
  notify();
}

export function getRecords(): readonly BenchRecord[] {
  return records;
}

/** Subscription for `useSyncExternalStore`. */
export function subscribeRecords(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Number of records so far; a step notes it at its start to find its own records later. */
export function recordCount(): number {
  return records.length;
}

/** Marks every record from `from` on as not valid (the window lost focus during its step). */
export function markInvalidFrom(from: number): void {
  records = records.map((r, i) => (i < from ? r : { ...r, valid: "false" }));
  notify();
}
