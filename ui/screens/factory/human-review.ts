// Human review: a person's Request changes note goes to the held run's worktree as `.factory/HUMAN-REVIEW.md`, then a
// humanReview run (the sendBack roles with the HUMAN-REVIEW prompt line) repairs, verifies and reviews it.
import { HUMAN_REVIEW_FILE } from "../loop/native/review.ts";
import { worktreePrefix, type SendBackFs, type StartRunFn } from "./send-back.ts";
import type { WorkItemRecord } from "./items.ts";

const MAX_NOTE = 4000;
function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
}

/** Writes the person's note into the run's worktree, replacing any earlier one (a new request supersedes the old). */
export async function prepareHumanReview(fs: SendBackFs, runRootPrefix: string, text: string): Promise<void> {
  const note = text.trim().slice(0, MAX_NOTE);
  if (!note) throw new Error("Write what should change before sending it back.");
  const path = `${runRootPrefix}/${HUMAN_REVIEW_FILE}`;
  const dir = path.slice(0, path.lastIndexOf("/"));
  // The person's own words are not untrusted data, so they are not fenced (unlike CI output or MR comments).
  const body = `# Human review\n\n${note}\n`;
  try { await fs.create(dir, "dir"); } catch (e) { if (codeOf(e) !== "exists") throw e; }
  let hash: string | null = null;
  try { hash = (await fs.read(path, 1_000_000)).hash; } catch (e) { if (codeOf(e) !== "not_found") throw e; }
  await fs.write(path, body, { expected_hash: hash });
}

/** Writes the note, then starts a humanReview run in the card's own worktree (never a new one). */
export async function requestChanges(deps: { fs: SendBackFs; start: StartRunFn; projectRoot: string }, item: WorkItemRecord, text: string): Promise<string> {
  const runId = item.runIds.at(-1);
  if (!runId) throw new Error("This card has no run to request changes on.");
  await prepareHumanReview(deps.fs, worktreePrefix(runId), text);
  return deps.start(deps.projectRoot, item, "humanReview", { runId });
}
