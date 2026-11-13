// Pure model behind the Factory's Review / Ship / Discard panel (spec A4). Node tests import it, so it imports only
// types from the shell (shell/core and shell/host do not load under node --test's strip-only mode).
import { DEFAULT_GITLAB_BASE, repoKeyOf, type RepoConfig, type RepoProvider } from "../../settings/repo-config.ts";
import { issueNumberOf, type FactoryRole, type WorkItem } from "./factory.ts";
import type { RunInfo } from "./worktree-run.ts";
import { isCiHookPath } from "./protected.ts";

/** The `POST /kb/loop/ship` body. `repo` is the provider slug (owner/name), never a path. */
export interface ShipBody { worktree: string; branch: string; provider: "github" | "gitlab"; repo: string; base: string; title: string; body: string; patchId: string; allowSecret?: boolean }
export type ShipResult = { ok: true; url: string; commit: string; reused: boolean; secretOverride?: { rule: string; file: string | null; line: number | null; hits?: { rule: string; file: string | null; line: number }[]; total?: number } } | { ok: false; code: string; message?: string; rule?: string; file?: string; line?: number; hits?: { rule: string; file: string | null; line: number }[]; total?: number };
export type ShipState = "shipped" | "secret" | "rejected" | "changed" | "error";
export interface WorktreeDiff { text: string; truncated: boolean; patchId: string; files: string[]; additions: number; deletions: number }
export interface DiffFile { path: string; lines: string[] }

const MAX_REVIEW_CHARS = 20_000;
const HOST_MAX_DIFF_FILES = 1000;

/**
 * Why a finished Factory run must stop for a person instead of opening its draft MR by itself, or null when it may ship.
 * A person reviews every diff at the MR, so the MR must show all of it; CI/hook files stay behind the run's own guard
 * (the server does not re-check them).
 */
export function autoShipBlock(diff: WorktreeDiff | null): string | null {
  if (!diff) return "The diff could not be read.";
  if (!diff.patchId || diff.files.length === 0) return "The run changed nothing, so there is nothing to ship.";
  // The host cuts the file list at MAX_DIFF_FILES (loop_worktree.rs) without setting `truncated`; a full list may hide paths.
  if (diff.truncated || diff.files.length >= HOST_MAX_DIFF_FILES) return "The diff is too large to show in full, so it is not shipped automatically. Open diff to look at it.";
  const ci = diff.files.filter(isCiHookPath);
  if (ci.length > 0) return `CI or hook files changed (${ci.slice(0, 3).join(", ")}${ci.length > 3 ? ", …" : ""}), so it is not shipped automatically.`;
  return null;
}

export type AutoShipKind = "passed" | "testsFailing" | "reviewRejected" | "incomplete";

/**
 * How a finished Factory run reaches its draft MR, or null when it must not open one by itself. The MR is the one place
 * a person reviews, so a failed run ships too, labelled; a cancel, an error, a guard block, an intake-only run and a
 * run waiting on an intake decision do not.
 */
export function autoShipKind(r: { mode: string; statusCode: string; needsDecision: boolean; failedRole: FactoryRole | null }): AutoShipKind | null {
  if (r.mode === "intakeOnly" || r.needsDecision) return null;
  if (r.statusCode === "success") return "passed";
  if (r.statusCode !== "failed") return null;
  if (r.failedRole === "verify") return "testsFailing";
  if (r.failedRole === "review" || r.failedRole === "reviewGate") return "reviewRejected";
  return "incomplete";
}

const KIND_PREFIX: Record<AutoShipKind, string> = { passed: "", testsFailing: "[Tests failing] ", reviewRejected: "[Review: changes requested] ", incomplete: "[Incomplete] " };

export function autoShipTitle(title: string, kind: AutoShipKind): string {
  return (KIND_PREFIX[kind] + title).slice(0, 200);
}

/** The line that opens the MR description of a run that did not pass, so the reviewer sees it first. */
export function autoShipNote(kind: AutoShipKind, failedStage: string | null): string {
  const at = failedStage ? ` (${failedStage.replace(/[\r\n`]/g, " ").slice(0, 80)})` : "";
  if (kind === "testsFailing") return `> **The Factory's tests failed${at}.** Opened for your review; check the failures before merging.`;
  if (kind === "reviewRejected") return `> **The review agent requested changes${at}.** Its report is below; close the MR or comment to rerun the Factory.`;
  if (kind === "incomplete") return `> **The run did not finish${at}.** This is its work so far; close the MR or comment to rerun the Factory.`;
  return "";
}

/** `kind` names the loop that ran ("Factory" by default; a non-Factory loop such as Refactoring passes its own name). */
export function shipRequest(info: RunInfo, item: WorkItem, repo: { provider: "github" | "gitlab"; slug: string; base: string }, review: string, patchId: string, kind = "Factory"): ShipBody {
  const title = item.title.replace(/\s+/g, " ").trim().slice(0, 200) || `${kind} run ${info.runId}`;
  const lines: string[] = [];
  const issue = item.source === "issue" ? issueNumberOf(item.id) : null;
  if (issue !== null) {
    const sameRepo = !item.repo || item.repo.toLowerCase() === repo.slug.toLowerCase();
    lines.push(`Refs ${sameRepo ? "" : item.repo}#${issue}`);
  } else if (item.source === "spec" && item.id) {
    lines.push(`Spec: \`${item.id}\``);
  }
  lines.push(
    "",
    `${kind} run \`${info.runId}\` on \`${info.branch}\`, started from \`${info.baseCommit.slice(0, 12)}\`.`,
    `Opened as a draft by the LLM-IDE ${kind === "Factory" ? "Factory." : `${kind} loop.`} Review it before merging.`,
    "",
    "## Review",
    "",
    review.trim() ? review.trim().slice(0, MAX_REVIEW_CHARS) : kind === "Factory" ? "(no review report)" : "(this loop has no review stage; review the diff)",
  );
  return { worktree: info.worktree, branch: info.branch, provider: repo.provider, repo: repo.slug, base: repo.base, title, body: lines.join("\n"), patchId };
}

export function shipState(result: ShipResult): ShipState {
  if (result.ok) return "shipped";
  if (result.code === "secret_detected") return "secret";
  if (result.code === "push_rejected") return "rejected";
  if (result.code === "diff_changed") return "changed";
  return "error";
}

/** User copy for a ship result. Never echoes the server message: it may quote the diff or a credential. */
export function shipCopy(result: ShipResult): string {
  switch (shipState(result)) {
    case "shipped": {
      const r = result as Extract<ShipResult, { ok: true }>;
      return r.reused ? `Pushed commit ${r.commit.slice(0, 7)}; the existing draft is updated: ${r.url}` : `Opened a draft: ${r.url}`;
    }
    case "secret": {
      const r = result as Extract<ShipResult, { ok: false }>;
      const rule = typeof r.rule === "string" && /^[A-Za-z0-9 /()-]{1,60}$/.test(r.rule) ? r.rule : null;
      const file = typeof r.file === "string" && /^[A-Za-z0-9._/-]{1,300}$/.test(r.file) && !r.file.startsWith("/") ? r.file : null;
      const line = typeof r.line === "number" && Number.isInteger(r.line) && r.line > 0 ? r.line : null;
      // No rule at all: the hit is in the request text, which the server reports without a file.
      if (typeof r.rule !== "string") return "Ship stopped: the title or description contains what looks like a credential. Nothing was pushed. Edit the text and ship again.";
      const where = rule ? ` (${rule}${file ? ` at ${file}${line ? `:${line}` : ""}` : ""})` : "";
      return `Ship stopped: the secret scan found what looks like a credential${where}. Nothing was pushed. Remove it in the worktree and ship again.`;
    }
    case "rejected":
      return "The remote rejected the push. No pull request or merge request was opened. Check branch protection and your git credentials, then ship again.";
    case "changed":
      return "The changes changed since you opened this review. Read the new diff, then ship again.";
    default: {
      const code = (result as Extract<ShipResult, { ok: false }>).code;
      return `Ship failed (${/^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "error"}). Nothing was merged.`;
    }
  }
}

/** The saved repository whose clone folder is the run's repo: its provider and owner/name slug. */
export function shipTarget(info: Pick<RunInfo, "repo">, config: RepoConfig): { provider: RepoProvider; slug: string } | null {
  const want = info.repo.trim().replace(/\/+$/, "");
  if (!want) return null;
  for (const provider of ["github", "gitlab"] as const) {
    for (const r of config.saved[provider]) {
      if (r.clonePath.trim().replace(/\/+$/, "") !== want) continue;
      const slug = repoKeyOf(provider, r.url);
      if (slug) return { provider, slug };
    }
  }
  return null;
}

/** Why Ship is not allowed for this provider (Settings → Repositories), or null. */
export function shipBlockedReason(config: RepoConfig, provider: RepoProvider): string | null {
  const ops = config.operations[provider];
  if (!ops.includes("push") || !ops.includes("createPR")) {
    return `Push and Create PR / MR must both be allowed for ${provider === "github" ? "GitHub" : "GitLab"} in Settings → Repositories.`;
  }
  if (provider === "gitlab" && config.gitlabBaseUrl.replace(/\/+$/, "") !== DEFAULT_GITLAB_BASE) {
    return "Ship supports gitlab.com only for now; this GitLab server is not supported yet.";
  }
  return null;
}

export function decodeWorktreeDiff(raw: unknown): WorktreeDiff {
  const o = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const patch = typeof o.patchId === "string" ? o.patchId : typeof o.patch_id === "string" ? o.patch_id : "";
  return {
    text: typeof o.text === "string" ? o.text : "",
    truncated: o.truncated === true,
    patchId: patch,
    files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string") : [],
    additions: typeof o.additions === "number" && Number.isFinite(o.additions) ? o.additions : 0,
    deletions: typeof o.deletions === "number" && Number.isFinite(o.deletions) ? o.deletions : 0,
  };
}

const PATCH_ID_RE = /^[0-9a-f]{64}$/;

/**
 * A4: the Review that passed read the diff whose id the record stored. When the worktree now has a different diff,
 * Ship is refused until the user re-runs Review (a send-back or a continue), so the ship request carries the id of
 * the diff Review actually approved. Null when there is nothing to compare (an older record, or a diff still loading).
 */
export function reviewedPatchIdWarning(reviewed: string | null | undefined, current: string | null | undefined): string | null {
  if (typeof reviewed !== "string" || !PATCH_ID_RE.test(reviewed)) return null;
  if (typeof current !== "string" || current === "") return null;
  if (current === reviewed) return null;
  return "The changes changed since Review passed. Re-run Review (send the run back or continue it), read the new verdict, then ship.";
}

/** Splits a `git diff` text at each `diff --git a/… b/…` header; text before any header is one "(changes)" entry. */
export function splitDiffByFile(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2] ?? header[1] ?? "", lines: [line] };
      files.push(current);
      continue;
    }
    if (!current) {
      if (line === "") continue;
      current = { path: "(changes)", lines: [] };
      files.push(current);
    }
    current.lines.push(line);
  }
  for (const f of files) {
    while (f.lines.length > 0 && f.lines[f.lines.length - 1] === "") f.lines.pop();
  }
  return files;
}

/** `loop_worktree_status` (host): what Discard would delete locally, and whether HEAD is already pushed. */
export interface WorktreeStatus { changedFiles: number; localCommits: number; pushed: boolean }

export function decodeWorktreeStatus(raw: unknown): WorktreeStatus | null {
  const o = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
  const changedFiles = n(o.changedFiles);
  const localCommits = n(o.localCommits);
  if (changedFiles === null || localCommits === null || typeof o.pushed !== "boolean") return null;
  return { changedFiles, localCommits, pushed: o.pushed };
}

/**
 * A7: Discard states exactly what it deletes. `request` is the open PR/MR the record knows about, if any: only the
 * local worktree and branch are removed, so the remote branch and the request itself stay (say so, never imply a close).
 */
export function discardWarning(status: WorktreeStatus | null, request: { provider: "github" | "gitlab" } | null = null): string {
  let local: string;
  if (!status) {
    local = "Every change in its worktree and branch is deleted.";
  } else {
    const files = status.changedFiles;
    const commits = status.localCommits;
    const fileText = `${files} changed file${files === 1 ? "" : "s"}`;
    const commitText = `${commits} commit${commits === 1 ? "" : "s"} that ${commits === 1 ? "was" : "were"} never pushed`;
    if (files > 0 && commits > 0) local = `${fileText} and ${commitText} will be deleted.`;
    else if (files > 0) local = `${fileText} will be deleted.`;
    else if (commits > 0) local = `${commitText} will be deleted.`;
    else local = status.pushed ? "Nothing unpushed will be lost." : "No local changes or commits will be lost.";
  }
  if (!request) return local;
  const kind = request.provider === "gitlab" ? "merge request" : "pull request";
  return `${local} The remote branch and the open ${kind} stay.`;
}

/** The HistoryView line classes: file headers (`+++`/`---`) are context, not additions or deletions. */
export function diffLineKind(line: string): "add" | "del" | "hunk" | "ctx" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "ctx";
}
