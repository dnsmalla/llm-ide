// Pure model behind the Factory's Review / Ship / Discard panel (spec A4). Node tests import it, so it imports only
// types from the shell (shell/core and shell/host do not load under node --test's strip-only mode).
import { DEFAULT_GITLAB_BASE, repoSlugOf, type RepoConfig, type RepoProvider } from "../../settings/repo-config.ts";
import type { WorkItem } from "./factory.ts";
import type { RunInfo } from "./worktree-run.ts";

/** The `POST /kb/loop/ship` body. `repo` is the provider slug (owner/name), never a path. */
export interface ShipBody { worktree: string; branch: string; provider: "github" | "gitlab"; repo: string; base: string; title: string; body: string }
export type ShipResult = { ok: true; url: string; commit: string; reused: boolean } | { ok: false; code: string; message?: string };
export type ShipState = "shipped" | "secret" | "rejected" | "error";
export interface WorktreeDiff { text: string; truncated: boolean; patchId: string; files: string[] }
export interface DiffFile { path: string; lines: string[] }

const MAX_REVIEW_CHARS = 20_000;

export function shipRequest(info: RunInfo, item: WorkItem, repo: { provider: "github" | "gitlab"; slug: string; base: string }, review: string): ShipBody {
  const title = item.title.replace(/\s+/g, " ").trim().slice(0, 200) || `Factory run ${info.runId}`;
  const lines: string[] = [];
  if (item.source === "issue" && item.id && /^\d+$/.test(item.id)) {
    const sameRepo = !item.repo || item.repo.toLowerCase() === repo.slug.toLowerCase();
    lines.push(`Refs ${sameRepo ? "" : item.repo}#${item.id}`);
  } else if (item.source === "spec" && item.id) {
    lines.push(`Spec: \`${item.id}\``);
  }
  lines.push(
    "",
    `Factory run \`${info.runId}\` on \`${info.branch}\`, started from \`${info.baseCommit.slice(0, 12)}\`.`,
    "Opened as a draft by the LLM-IDE Factory after its tests and review passed. Review it before merging.",
    "",
    "## Review",
    "",
    review.trim() ? review.trim().slice(0, MAX_REVIEW_CHARS) : "(no review report)",
  );
  return { worktree: info.worktree, branch: info.branch, provider: repo.provider, repo: repo.slug, base: repo.base, title, body: lines.join("\n") };
}

export function shipState(result: ShipResult): ShipState {
  if (result.ok) return "shipped";
  if (result.code === "secret_detected") return "secret";
  if (result.code === "push_rejected") return "rejected";
  return "error";
}

/** User copy for a ship result. Never echoes the server message: it may quote the diff or a credential. */
export function shipCopy(result: ShipResult): string {
  switch (shipState(result)) {
    case "shipped": {
      const r = result as Extract<ShipResult, { ok: true }>;
      return r.reused ? `Pushed commit ${r.commit.slice(0, 7)}; the existing draft is updated: ${r.url}` : `Opened a draft: ${r.url}`;
    }
    case "secret":
      return "Ship stopped: the secret scan found what looks like a credential in the changes. Nothing was pushed. Remove it in the worktree and ship again.";
    case "rejected":
      return "The remote rejected the push. No pull request or merge request was opened. Check branch protection and your git credentials, then ship again.";
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
      const slug = repoSlugOf(r.url);
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
  };
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

/** The HistoryView line classes: file headers (`+++`/`---`) are context, not additions or deletions. */
export function diffLineKind(line: string): "add" | "del" | "hunk" | "ctx" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "ctx";
}
