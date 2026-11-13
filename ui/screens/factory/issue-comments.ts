// The comment the Factory posts on an issue after each step. The format and the safety rules live in the shared issue
// trail (loop/native/issue-trail.ts); this file only adds the Factory's roles.
import type { FactoryRole, RunMode } from "../loop/native/factory.ts";
import { stepCommentBody } from "../loop/native/issue-trail.ts";

export { issueTarget, safeTestCommand, verdictLine, type CommentItem, type IssueTarget } from "../loop/native/issue-trail.ts";

export interface StageCommentFacts {
  stageName: string; role: FactoryRole | null; ok: boolean; runId: string; mode: RunMode | string; iteration: number;
  changedFiles?: readonly string[] | null; testCommand?: string | null; verdict?: string | null;
}

export function stageCommentBody(f: StageCommentFacts): string {
  return stepCommentBody({ ...f, process: "Factory", mode: String(f.mode), verdictLabel: f.role === "intake" || f.role === "intakeGate" ? "Readiness" : "Review" });
}
