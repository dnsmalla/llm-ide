// Pure view helpers for the review switches, kept out of the screen so the rules are testable without React.
import type { LoopEngineConfig, LoopStage } from "./model.ts";
import { effectiveReviewAfter } from "./review.ts";

export function reviewSwitch(stage: Pick<LoopStage, "kind" | "skillId" | "reviewAfter">): { eligible: boolean; on: boolean; isDefault: boolean } {
  return { eligible: stage.kind === "skill", on: effectiveReviewAfter(stage), isDefault: stage.reviewAfter == null };
}

/** Writes the key only when it differs from the default, so loop.json stays minimal and a later default change still applies. */
export function setReviewAfter(stage: LoopStage, on: boolean): void {
  const defaultOn = effectiveReviewAfter({ kind: stage.kind, skillId: stage.skillId, reviewAfter: undefined });
  if (on === defaultOn) delete stage.reviewAfter;
  else stage.reviewAfter = on;
}

export const REVIEW_MODE_OPTIONS: readonly { value: "auto" | "human"; label: string }[] = [
  { value: "auto", label: "Auto (AI reviews the change, then it ships)" },
  { value: "human", label: "Human (the run waits for your approval)" },
];

/** "auto" is the default and is stored as an absent key, matching how the engine and the template write it. */
export function setReviewMode(config: LoopEngineConfig, mode: "auto" | "human"): void {
  if (mode === "human") config.reviewMode = "human";
  else delete config.reviewMode;
}
