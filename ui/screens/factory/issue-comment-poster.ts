// Posts the per-step issue comment for a finished Factory stage. Every lookup and the post itself may fail; a comment
// is a courtesy, so nothing here ever throws into the run.
import { factoryRole } from "../loop/native/factory.ts";
import type { LoopStage } from "../loop/native/model.ts";
import { issueTarget, stageCommentBody, verdictLine, type CommentItem } from "./issue-comments.ts";

export interface PosterDeps {
  request(path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** The run's changed paths (worktree vs. its base, `.factory/` excluded), or null when unreadable. */
  diffFiles(runId: string): Promise<string[] | null>;
  readText(path: string): Promise<string | null>;
  /** Settings → Repositories allows "Comment on issue" for this provider. */
  allowed(provider: "github" | "gitlab"): boolean;
}

export interface StageEvent { item: CommentItem; runId: string; mode: string; stage: LoopStage; ok: boolean; iteration: number; runPrefix: string }

// Setup installs the environment; the gates only restate the verdict the Intake/Review comment already carries.
const SILENT = new Set(["setup", "intakeGate", "reviewGate"]);
const PLACEHOLDER = /^<[^>]+>$/;

const quiet = async <T>(p: () => Promise<T>): Promise<T | null> => { try { return await p(); } catch { return null; } };

/** Posts `text` on the item's issue when it is one and commenting is allowed. True when posted; never throws. */
export async function postIssueText(d: Pick<PosterDeps, "request" | "allowed">, item: CommentItem, text: string): Promise<boolean> {
  const target = issueTarget(item);
  if (!target || !d.allowed(target.provider)) return false;
  const res = await quiet(() => d.request("/kb/issues/comment", { ...target, body: text }));
  return res !== null && res.status >= 200 && res.status < 300;
}

/** True when the comment was posted. */
export async function postStageComment(d: PosterDeps, e: StageEvent): Promise<boolean> {
  const target = issueTarget(e.item);
  const role = factoryRole(e.stage);
  if (!target || (role !== null && SILENT.has(role)) || (e.stage.kind === "shellCommand" && e.stage.runOnce) || !d.allowed(target.provider)) return false;
  const changedFiles = role === "implement" ? await quiet(() => d.diffFiles(e.runId)) : null;
  const command = role === "verify" && typeof e.stage.command === "string" && !PLACEHOLDER.test(e.stage.command.trim()) ? e.stage.command : null;
  const report = role === "review" ? "REVIEW.md" : role === "intake" ? "READINESS.md" : null;
  const text = report ? await quiet(() => d.readText(`${e.runPrefix}/.factory/${report}`)) : null;
  const body = stageCommentBody({ stageName: e.stage.name, role, ok: e.ok, runId: e.runId, mode: e.mode, iteration: e.iteration, changedFiles, testCommand: command, verdict: text ? verdictLine(text) : null });
  const res = await quiet(() => d.request("/kb/issues/comment", { ...target, body }));
  return res !== null && res.status >= 200 && res.status < 300;
}
