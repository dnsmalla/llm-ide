// Pure helpers for the verify loopback: a failed Verify (or a review asking for changes) sends the run back to the code
// stage that wrote the change, instead of handing the failure to a generic repair agent. Kept out of runner.ts, which is
// already large; only types are imported from there, so there is no runtime cycle.
import type { LoopStage } from "./model.ts";
import { effectiveReviewAfter } from "./review.ts";

/** Status code of a run that used up its rounds (or budget) without passing; a warning state, never shipped. */
export const LOOPBACK_STOPPED_CODE = "stopped.limit";

export type LoopbackReason = "tests" | "review" | "limit";

export interface LoopbackSummary { rounds: number; maxRounds: number; reason: LoopbackReason; findings: string; stopped: boolean }
/** What a code stage is told when it is re-run after a failed round. */
export interface LoopbackContext { round: number; maxRounds: number; findings: string }
export interface FindingsEntry { round: number; source: "tests" | "review"; text: string }
export interface LoopbackGroup { codeStages: LoopStage[]; verifyIds: string[]; closerId: string }

/** The most rounds any loop gets, whatever its iteration setting (a lower setting still wins). */
export const LOOPBACK_MAX_ROUNDS = 3;
/** Consecutive rounds with the same failure that mean the code stage is not making progress. */
export const LOOPBACK_IDENTICAL_STOP = 2;

const FINDINGS_MAX_CHARS = 12_000;
const RECORD_FINDINGS_MAX_CHARS = 4000;
const SIGNATURE_MAX_CHARS = 2000;

export function isCodeWritingStage(stage: LoopStage): boolean {
  return stage.kind === "skill" && effectiveReviewAfter(stage);
}

function isVerifyStage(stage: LoopStage): boolean {
  return stage.kind === "shellCommand" && stage.severity === "blocking" && !stage.runOnce;
}

/**
 * Pair each block of consecutive code-writing stages with the blocking shell checks that follow it. The last check is the
 * "closer": it runs the step review, so the whole step is judged once the checks pass. A code stage with no check after it
 * yields no group and keeps the old in-place review. `stages` is the already-enabled list, in order.
 */
export function loopbackGroups(stages: readonly LoopStage[]): LoopbackGroup[] {
  const groups: LoopbackGroup[] = [];
  let index = 0;
  while (index < stages.length) {
    if (!isCodeWritingStage(stages[index])) { index += 1; continue; }
    const codeStages: LoopStage[] = [];
    while (index < stages.length && isCodeWritingStage(stages[index])) codeStages.push(stages[index++]);
    const verifyIds: string[] = [];
    while (index < stages.length && !isCodeWritingStage(stages[index])) {
      if (isVerifyStage(stages[index])) verifyIds.push(stages[index].id);
      index += 1;
    }
    if (verifyIds.length > 0) groups.push({ codeStages, verifyIds, closerId: verifyIds[verifyIds.length - 1] });
  }
  return groups;
}

export function groupOfVerify(groups: readonly LoopbackGroup[], stageId: string): LoopbackGroup | null {
  return groups.find((group) => group.verifyIds.includes(stageId)) ?? null;
}

export function groupOfCode(groups: readonly LoopbackGroup[], stageId: string): LoopbackGroup | null {
  return groups.find((group) => group.codeStages.some((stage) => stage.id === stageId)) ?? null;
}

/** Every round's findings, oldest first; when over the cap the newest are kept because they are what the code stage must fix. */
export function findingsText(entries: readonly FindingsEntry[], maxChars = FINDINGS_MAX_CHARS): string {
  const text = entries.map((entry) => `Round ${entry.round} (${entry.source})\n${entry.text}`).join("\n\n");
  if (text.length <= maxChars) return text;
  return "…" + text.slice(text.length - (maxChars - 1));
}

export function stoppedSummary(rounds: number, reason: "tests" | "review", unchanged = false): string {
  const what = reason === "tests" ? "tests still failing" : "review still requests changes";
  return `Stopped after ${rounds} ${rounds === 1 ? "round" : "rounds"}: ${what}${unchanged ? " (no change since the previous round)" : ""}`;
}

/** Two rounds with the same signature made no progress, so the loop can stop early instead of spending the remaining rounds. */
export function failureSignature(source: "tests" | "review", text: string): string {
  // Digits are replaced because timings, counts and timestamps differ on every run of the same failure.
  const normalised = text.trim().replace(/\d+/g, "#");
  return `${source}:${normalised.slice(0, SIGNATURE_MAX_CHARS)}`;
}

/** Spread into a run record; nothing is written for a run that never looped back, so old readers see no new key. */
export function loopbackRecord(summary: LoopbackSummary | undefined): { loopback?: LoopbackSummary } {
  if (!summary) return {};
  return { loopback: { ...summary, findings: summary.findings.slice(0, RECORD_FINDINGS_MAX_CHARS) } };
}

export function loopbackLogLine(summary: LoopbackSummary): string {
  const outcome = summary.stopped ? "stopped" : "resolved";
  return `Loopback ${outcome}: round ${summary.rounds} of ${summary.maxRounds} (${summary.reason})`;
}
