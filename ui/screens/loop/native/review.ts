import type { LoopEngineConfig, LoopStage } from "./model.ts";

// Where the AI step review lives. The skill is shipped with the central kit; the files are Factory-owned so a
// run's review trail sits beside its other run state and is never mistaken for user source.
export const STEP_REVIEW_SKILL = "skills/step-review";
export const STEP_REVIEW_DIR = ".factory/reviews";
export const STEP_REVIEWS_FILE = ".factory/STEP-REVIEWS.md";
export const HUMAN_REVIEW_FILE = ".factory/HUMAN-REVIEW.md";

export type ReviewMode = "auto" | "human";

// Skills that only read the repo or write planning/docs output. Reviewing them costs a model call for nothing.
const REVIEW_OFF_SKILLS: ReadonlySet<string> = new Set([
  "factory-intake", "writing-plans", "factory-review", "plan-director", "plan-structure-index",
  "doc-structure-index", "refactor-planner", "doc-writer", "step-review",
]);

function normalizeSkillName(skillId: string): string {
  return skillId.startsWith("skills/") ? skillId.slice("skills/".length) : skillId;
}

/**
 * Whether a stage is AI-reviewed after it passes. An explicit reviewAfter always wins; otherwise only skill
 * stages are reviewed, and an unknown skill defaults ON because it may write code and a missed review is the
 * costlier mistake. Shell and check stages have no AI-authored diff to review, so they default OFF.
 */
export function effectiveReviewAfter(stage: Pick<LoopStage, "kind" | "skillId" | "reviewAfter">): boolean {
  if (typeof stage.reviewAfter === "boolean") return stage.reviewAfter;
  if (stage.kind !== "skill" || stage.skillId === null) return false;
  return !REVIEW_OFF_SKILLS.has(normalizeSkillName(stage.skillId));
}

export function reviewModeOf(config: Pick<LoopEngineConfig, "reviewMode">): ReviewMode {
  return config.reviewMode === "human" ? "human" : "auto";
}

/** The per-step review file for a stage; the id is sanitized so a user-chosen id cannot escape the folder. */
export function stepReviewPath(stageId: string): string {
  return `${STEP_REVIEW_DIR}/${stageId.replace(/[^a-z0-9-]/g, "-")}.md`;
}

/**
 * The reviewer's verdict, read only from the last non-empty line so a verdict quoted earlier in the review text
 * cannot be mistaken for the final one. Anything other than the exact phrase is no verdict.
 */
export function parseStepVerdict(text: string | null): "approve" | "changes" | null {
  if (text === null) return null;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === "Verdict: approve") return "approve";
  if (last === "Verdict: changes") return "changes";
  return null;
}
