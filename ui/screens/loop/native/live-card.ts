// The loop board's live card is read from the run manager's live runs (a run lives there, not in a screen). This file
// maps one live loop run to the card the board draws.
import { loopIdOfRun, type LiveRun } from "./run-manager.ts";

export interface LiveLoopCard {
  runId: string;
  loopId: string;
  stageName: string;
  startedAt: string;
  /** The model the running agent step uses; absent for shell steps and unknown routing. */
  model?: string | null;
  /** The run is waiting (for its project, or for Resume). */
  note: string | null;
  /** How far the run is through its steps, 0..1; null before the first one. */
  progress: number | null;
}

/** The loop's live card: its running (or held) run in this project, else null. A queued run has not started, so it has no card. */
export function liveLoopCard(runs: readonly LiveRun[], projectRoot: string, loopId: string): LiveLoopCard | null {
  const run = runs.find((r) => r.projectRoot === projectRoot && loopIdOfRun(r) === loopId && r.state !== "queued");
  if (!run) return null;
  const p = run.progress;
  return {
    runId: run.runId, loopId, stageName: p?.stageName ?? "", startedAt: run.startedAt ?? new Date(0).toISOString(), model: p?.model ?? null, note: run.note,
    progress: p && p.stageCount > 0 ? (p.stageName === null ? 0 : Math.min(1, (p.stageIndex + 1) / p.stageCount)) : null,
  };
}

/** The loop's runs still waiting for their turn (one loop run per project at a time). */
export function queuedLoopRuns(runs: readonly LiveRun[], projectRoot: string, loopId: string): number {
  return runs.filter((r) => r.projectRoot === projectRoot && loopIdOfRun(r) === loopId && r.state === "queued").length;
}

/** The live card's status line: `Running now` (or why it waits), plus the model while an agent step runs. */
export function liveCardNote(card: Pick<LiveLoopCard, "model"> & { note?: string | null }): string {
  const base = card.note ?? "Running now";
  return card.model ? `${base} · ${card.model}` : base;
}

/** Removes the localStorage slot older builds wrote. */
export function forgetLegacyLiveCard(): void {
  try { localStorage.removeItem("llmide.loopLive"); } catch { /* private mode */ }
}
