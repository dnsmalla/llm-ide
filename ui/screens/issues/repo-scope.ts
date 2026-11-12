// Which repositories the Issues board and the Gantt show. The user only adds repositories (Settings → Repositories);
// everything else is derived here: the provider is the repository's own, a single repository needs no picker, and
// "All repositories" appears only when there are several. Pure, so node tests it.
import type { RepoConfig } from "../settings/repo-config.ts";
import { repoSlug } from "./issues-model.ts";

export type Provider = "github" | "gitlab";

export interface RepoChoice {
  /** `provider NUL slug`: the same slug on both providers stays two choices. */
  key: string;
  provider: Provider;
  slug: string;
  label: string;
}

export const choiceKey = (provider: Provider, slug: string): string => `${provider}\u0000${slug}`;

/** The saved repositories of both providers, each once; rows without a readable owner/project are dropped. */
export function repoChoices(cfg: RepoConfig): RepoChoice[] {
  const out: RepoChoice[] = [];
  const seen = new Set<string>();
  for (const provider of ["github", "gitlab"] as const) {
    for (const r of cfg.saved[provider]) {
      const slug = repoSlug(r.url);
      const key = choiceKey(provider, slug);
      if (!slug.includes("/") || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, provider, slug, label: r.displayName.trim() || slug });
    }
  }
  return out;
}

export interface RepoScope {
  /** The one repository being shown, or null for "all". */
  selected: RepoChoice | null;
  /** Providers whose issues must be read for this view. */
  providers: Provider[];
  /** True when the user has something to choose (more than one repository). */
  picker: boolean;
}

/**
 * The view for a choice key. One saved repository is always selected (no picker). Several: the key, or all.
 * None saved: both providers are read, so issues imported earlier still show.
 */
export function resolveScope(choices: readonly RepoChoice[], selectedKey: string): RepoScope {
  if (choices.length === 1) return { selected: choices[0]!, providers: [choices[0]!.provider], picker: false };
  if (choices.length === 0) return { selected: null, providers: ["github", "gitlab"], picker: false };
  const selected = choices.find((c) => c.key === selectedKey) ?? null;
  const providers = selected ? [selected.provider] : (["github", "gitlab"] as const).filter((p) => choices.some((c) => c.provider === p));
  return { selected, providers, picker: true };
}

/** The saved repositories in this view that have no cached issue yet and were not tried this session. */
export function missingChoices(choices: readonly RepoChoice[], scope: RepoScope, issues: readonly { provider: string; repo: string }[], tried: ReadonlySet<string>): RepoChoice[] {
  const inView = scope.selected ? [scope.selected] : choices;
  const have = new Set(issues.map((i) => choiceKey(i.provider as Provider, i.repo)));
  return inView.filter((c) => !have.has(c.key) && !tried.has(c.key));
}

export type SyncRequest = (method: "POST", path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

export interface SyncOutcome {
  imported: number;
  /** One plain sentence per repository that could not be imported. */
  problems: string[];
}

const messageOf = (body: unknown): string => {
  const e = body && typeof body === "object" ? (body as { error?: { message?: unknown } }).error : null;
  return typeof e?.message === "string" ? e.message.slice(0, 200) : "";
};

/** Imports each repository's open and closed issues through the core (token from the vault); never throws. */
export async function syncRepos(request: SyncRequest, choices: readonly RepoChoice[]): Promise<SyncOutcome> {
  const out: SyncOutcome = { imported: 0, problems: [] };
  for (const c of choices) {
    try {
      const r = await request("POST", "/kb/connect-github-issues", { provider: c.provider, repo: c.slug, state: "all" });
      if (r.status === 200) {
        const n = r.body && typeof r.body === "object" ? (r.body as { count?: unknown }).count : null;
        out.imported += typeof n === "number" ? n : 0;
      } else {
        out.problems.push(`${c.slug}: ${r.status === 401 ? "sign in again" : messageOf(r.body) || `the import failed (${r.status})`}`);
      }
    } catch {
      out.problems.push(`${c.slug}: the core is not reachable right now`);
    }
  }
  return out;
}
