// Send back: CI failures and PR/MR review comments go to the same worktree as `.factory/FEEDBACK.md`, then a sendBack
// run repairs, verifies and reviews. Send back is a button; a closed or commented MR reworks by itself (`rework`).
import type { FsApi } from "../explorer/fs";
import { feedbackMarkdown, neutralizeFences } from "../loop/native/factory.ts";
import type { RunMode } from "../loop/native/run-manager.ts";
import type { ShipStatus } from "./columns.ts";
import type { WorkItemRecord } from "./items.ts";

export type StartRunFn = (projectRoot: string, item: WorkItemRecord, mode: RunMode, opts?: { runId?: string }) => string;
/** Reports a user's correction of a finished run to the improvement log; the caller decides where it goes. */
export type UserSignalFn = (s:
  | { kind: "sent_back" | "human_review"; runId: string; payload: { note: string; comments?: { author: string; body: string }[]; ciFailed?: boolean } }
  | { kind: "output_edited"; runId: string; payload: { extraCommits: string[] } }) => void;
export type SendBackFs = Pick<FsApi, "read" | "write" | "create">;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NOTE = 4000;
function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
}

const MAX_COMMENT = 4000;
const MAX_COMMENTS_TOTAL = 20000;
/** Each body capped; when the total is over the cap the oldest comments are dropped (the list is oldest first). */
export function capComments(comments: readonly { author: string; body: string }[]): { author: string; body: string }[] {
  const out: { author: string; body: string }[] = [];
  let total = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body.slice(0, MAX_COMMENT);
    if (total + body.length > MAX_COMMENTS_TOTAL) break;
    total += body.length;
    out.unshift({ author: comments[i].author, body });
  }
  return out;
}

/** Project-relative root of a run's worktree (Phase A: `<project>/system/loop-worktrees/<run_id>`). */
export function worktreePrefix(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
  return `system/loop-worktrees/${runId}`;
}

/** The ShipStatus in the shape feedbackMarkdown takes. CI output is passed only when CI failed. */
export function feedbackInput(status: ShipStatus): Parameters<typeof feedbackMarkdown>[0] {
  return {
    ci: status.ci === "failed" ? { state: status.ci, summary: status.ciSummary ?? "" } : null,
    comments: status.comments.map((c) => ({ author: c.author, body: c.body, at: c.at })),
  };
}

/** Writes `.factory/FEEDBACK.md` in the run's worktree: the user's note first, then the fenced provider data. */
export async function prepareSendBack(fs: SendBackFs, runRootPrefix: string, status: ShipStatus, userNote: string): Promise<void> {
  const dir = `${runRootPrefix}/.factory`;
  const path = `${dir}/FEEDBACK.md`;
  const note = userNote.trim().slice(0, MAX_NOTE);
  // The user's own note is not untrusted data: it is placed first and not fenced. Provider text is fenced by feedbackMarkdown.
  const head = note ? `# Feedback\n\n## Note from the user\n\n${note}\n\n` : "# Feedback\n\n";
  const text = head + feedbackMarkdown(feedbackInput(status));
  try { await fs.create(dir, "dir"); } catch (e) { if (codeOf(e) !== "exists") throw e; }
  let hash: string | null = null;
  try { hash = (await fs.read(path, 1_000_000)).hash; } catch (e) { if (codeOf(e) !== "not_found") throw e; }
  await fs.write(path, text, { expected_hash: hash });
}

/** Writes the feedback, then starts a sendBack run in the card's own worktree (never a new one). */
export async function sendBack(deps: { fs: SendBackFs; start: StartRunFn; projectRoot: string; onUserSignal?: UserSignalFn }, item: WorkItemRecord, status: ShipStatus, userNote: string): Promise<string> {
  const runId = item.runIds.at(-1);
  if (!runId) throw new Error("This card has no run to send back to.");
  await prepareSendBack(deps.fs, worktreePrefix(runId), status, userNote);
  try {
    deps.onUserSignal?.({ kind: "sent_back", runId, payload: { note: userNote.trim().slice(0, MAX_NOTE), comments: capComments(status.comments), ciFailed: status.ci === "failed" } });
  } catch { /* a signal never blocks the send-back */ }
  return deps.start(deps.projectRoot, item, "sendBack", { runId });
}

/** `.factory/DECISIONS.md`: the user's answer to a needs-decision, appended and dated, fenced as data. */
export async function prepareAnswer(fs: SendBackFs, runRootPrefix: string, answer: string): Promise<void> {
  const text = neutralizeFences(answer.trim().slice(0, MAX_NOTE));
  if (!text) throw new Error("An empty answer cannot continue the run.");
  const dir = `${runRootPrefix}/.factory`;
  const path = `${dir}/DECISIONS.md`;
  try { await fs.create(dir, "dir"); } catch (e) { if (codeOf(e) !== "exists") throw e; }
  let previous = "";
  let hash: string | null = null;
  try { const r = await fs.read(path, 1_000_000); previous = r.text ?? ""; hash = r.hash; } catch (e) { if (codeOf(e) !== "not_found") throw e; }
  const block = `\n## ${new Date().toISOString()}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
  await fs.write(path, (previous || "# Decisions\n") + block, { expected_hash: hash });
}

/** Writes the answer, then starts a continue run in the same worktree. */
export async function answerDecision(deps: { fs: SendBackFs; start: StartRunFn; projectRoot: string }, item: WorkItemRecord, answer: string): Promise<string> {
  const runId = item.runIds.at(-1);
  if (!runId) throw new Error("This card has no run to continue.");
  await prepareAnswer(deps.fs, worktreePrefix(runId), answer);
  return deps.start(deps.projectRoot, item, "continue", { runId });
}

/** The MR was rejected (closed, or commented on): write its feedback, then rerun the card's worktree from the first step. */
export async function rework(deps: { fs: SendBackFs; start: StartRunFn; projectRoot: string }, item: WorkItemRecord, status: ShipStatus, reason: "closed" | "comments"): Promise<string> {
  const runId = item.runIds.at(-1);
  if (!runId) throw new Error("This card has no run to rework.");
  const note = reason === "closed"
    ? "The MR was closed without merging. Start over from the issue, taking any comments below into account."
    : "The MR got review comments. Start over from the issue and address them.";
  await prepareSendBack(deps.fs, worktreePrefix(runId), status, note);
  return deps.start(deps.projectRoot, item, "rework", { runId });
}
