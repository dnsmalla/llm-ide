// Opens a finished Factory run's draft MR by itself, so the MR is the one place a person reviews. Unsafe or impossible
// ships stop for a person instead: the reason is recorded on the run and posted on the issue. Never throws.
import type { RepoConfig } from "../settings/repo-config.ts";
import type { WorkItem } from "../loop/native/factory.ts";
import type { RunInfo } from "../loop/native/worktree-run.ts";
import { autoShipBlock, autoShipNote, autoShipTitle, shipBlockedReason, shipCopy, shipRequest, shipTarget, type AutoShipKind, type ShipBody, type ShipResult, type WorktreeDiff } from "../loop/native/ship-model.ts";
import { stageCommentBody } from "./issue-comments.ts";

export interface AutoShipDeps {
  repoConfig(): RepoConfig;
  diff(runId: string): Promise<WorktreeDiff>;
  /** The branch the run's repo has checked out (the MR target), or null. */
  repoBranch(runId: string): Promise<string | null>;
  readText(path: string): Promise<string | null>;
  ship(body: ShipBody): Promise<ShipResult>;
  saveShip(entry: RunEntry, ship: { provider: "github" | "gitlab"; url: string; commit: string; reused: boolean }): Promise<boolean>;
  saveBlocked(entry: RunEntry, reason: string): Promise<boolean>;
  /** Posts on the run's issue (a no-op for a non-issue item or when commenting is off). */
  comment(text: string): Promise<void>;
  now(): Date;
}

export interface RunEntry { id: string; startedAt: string }
export interface AutoShipContext { info: RunInfo; item: WorkItem; entry: RunEntry; kind: AutoShipKind; failedStage: string | null; runPrefix: string }

const quiet = async <T>(p: () => Promise<T>): Promise<T | null> => { try { return await p(); } catch { return null; } };

export async function autoShipRun(d: AutoShipDeps, c: AutoShipContext): Promise<{ shipped: string } | { blocked: string }> {
  const note = (ok: boolean, line: string) => stageCommentBody({ stageName: "Ship", role: null, ok, runId: c.info.runId, mode: c.kind, iteration: 1 }).replace(/ — (passed|failed)/, ` — ${line}`);
  const stop = async (reason: string) => {
    await quiet(() => d.saveBlocked(c.entry, reason));
    await quiet(() => d.comment(`${note(false, "not shipped")}\n\n${reason}`));
    return { blocked: reason };
  };
  const config = d.repoConfig();
  const target = shipTarget(c.info, config);
  if (!target) return stop("This repository is not in Settings → Repositories with its clone folder, so no MR was opened.");
  const refused = shipBlockedReason(config, target.provider);
  if (refused) return stop(refused);
  const diff = await quiet(() => d.diff(c.info.runId));
  const block = autoShipBlock(diff);
  if (block || !diff) return stop(block ?? "The diff could not be read.");
  const base = (await quiet(() => d.repoBranch(c.info.runId))) ?? "main";
  const review = (await quiet(() => d.readText(`${c.runPrefix}/.factory/REVIEW.md`))) ?? "";
  const req = shipRequest(c.info, c.item, { provider: target.provider, slug: target.slug, base }, review, diff.patchId);
  const lead = autoShipNote(c.kind, c.failedStage);
  const body: ShipBody = { ...req, title: autoShipTitle(req.title, c.kind), body: (lead ? `${lead}\n\n${req.body}` : req.body).slice(0, 20_000) };
  const result = (await quiet(() => d.ship(body))) ?? { ok: false as const, code: "error" };
  if (!result.ok) return stop(shipCopy(result));
  await quiet(() => d.saveShip(c.entry, { provider: target.provider, url: result.url, commit: result.commit, reused: result.reused }));
  await quiet(() => d.comment(`${note(true, result.reused ? "draft MR updated" : "draft MR opened")}\n\n${result.url}`));
  return { shipped: result.url };
}
