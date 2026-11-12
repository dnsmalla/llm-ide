// The Mac's Repositories card (Features/SourceControl/Views/RepoSettingsSection.swift) for the desktop:
// GitLab/GitHub tabs, a write-only token per provider, the per-provider automation allow-list and the saved
// repository list. Tokens go to the core vault (`github.token` / `gitlab.token`, never rendered back); everything
// else is local app config (the Mac keeps it in AppConfig/UserDefaults), stored here in localStorage behind one key.
//
// Pure and defensive: a malformed or older blob reads as the defaults, and every array is clamped.
export type RepoProvider = "gitlab" | "github";

export type RepoOp =
  | "sync" | "push" | "createBranch" | "autoCommit"
  | "createIssue" | "editIssue" | "commentIssue" | "closeIssue" | "createPR";

export const REPO_PROVIDERS: readonly { id: RepoProvider; label: string; tokenKey: string; placeholder: string }[] = [
  { id: "gitlab", label: "GitLab", tokenKey: "gitlab.token", placeholder: "glpat-xxxxxxxxxxxxxxxxxxxx" },
  { id: "github", label: "GitHub", tokenKey: "github.token", placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx" },
];

/** The Mac's `RepoOperation.groups`; display only, the stored model is a set of ids. */
export const REPO_OP_GROUPS: readonly { title: string; ops: readonly { id: RepoOp; label: string }[] }[] = [
  { title: "Sync", ops: [{ id: "sync", label: "Pull / Re-sync" }] },
  { title: "Code writes", ops: [{ id: "push", label: "Push" }, { id: "createBranch", label: "Create branch" }, { id: "autoCommit", label: "Auto-commit AI changes" }] },
  { title: "Issues", ops: [
    { id: "createIssue", label: "Create issue" },
    { id: "editIssue", label: "Edit issue (labels, assignee, milestone…)" },
    { id: "commentIssue", label: "Comment on issue" },
    { id: "closeIssue", label: "Close / reopen issue" },
  ] },
  { title: "PR / MR", ops: [{ id: "createPR", label: "Create PR / MR" }] },
];

export const ALL_REPO_OPS: readonly RepoOp[] = REPO_OP_GROUPS.flatMap((g) => g.ops.map((o) => o.id));

export const DEFAULT_GITLAB_BASE = "https://gitlab.com";
const KEY = "llmide.repos.config";
const MAX_REPOS = 50;
const MAX_URL = 500;
const MAX_NAME = 120;
const MAX_PATH = 4096;

export interface SavedRepo {
  id: string;
  displayName: string;
  url: string;
  clonePath: string;
  active: boolean;
}

export interface RepoConfig {
  /** The primary provider when both tokens are saved; null = no preference. */
  primary: RepoProvider | null;
  gitlabBaseUrl: string;
  operations: Record<RepoProvider, RepoOp[]>;
  saved: Record<RepoProvider, SavedRepo[]>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

export function defaultRepoConfig(): RepoConfig {
  return {
    primary: null,
    gitlabBaseUrl: DEFAULT_GITLAB_BASE,
    operations: { gitlab: [...ALL_REPO_OPS], github: [...ALL_REPO_OPS] },
    saved: { gitlab: [], github: [] },
  };
}

function decodeRepos(v: unknown): SavedRepo[] {
  if (!Array.isArray(v)) return [];
  const out: SavedRepo[] = [];
  let activeSeen = false;
  for (const row of v) {
    if (!isRecord(row)) continue;
    const url = text(row.url, MAX_URL);
    const name = text(row.displayName, MAX_NAME);
    const clonePath = text(row.clonePath, MAX_PATH);
    const active = row.active === true && !activeSeen;
    if (active) activeSeen = true;
    out.push({ id: text(row.id, 80) || newId(), displayName: name, url, clonePath, active });
    if (out.length >= MAX_REPOS) break;
  }
  // There is always at most one active row; a blob with none activates the first (the Mac's delete rule).
  if (!activeSeen && out.length) out[0]!.active = true;
  return out;
}

/** Reads the stored config; any problem yields the defaults (all operations allowed, no repos). */
export function decodeRepoConfig(raw: unknown): RepoConfig {
  const d = defaultRepoConfig();
  if (!isRecord(raw)) return d;
  const primary = raw.primary === "gitlab" || raw.primary === "github" ? raw.primary : null;
  const base = normalizeBase(text(raw.gitlabBaseUrl, MAX_URL) || DEFAULT_GITLAB_BASE);
  const savedRaw = isRecord(raw.saved) ? raw.saved : {};
  const ops = (p: RepoProvider): RepoOp[] => {
    const list = isRecord(raw.operations) && Array.isArray(raw.operations[p]) ? raw.operations[p] : null;
    if (!list) return [...ALL_REPO_OPS];
    const want = new Set(list.filter((x): x is RepoOp => typeof x === "string" && (ALL_REPO_OPS as readonly string[]).includes(x)));
    // Unknown ids are dropped; a stored empty list stays empty (all automation off is a real choice).
    return ALL_REPO_OPS.filter((op) => want.has(op));
  };
  return {
    primary,
    gitlabBaseUrl: base,
    operations: { gitlab: ops("gitlab"), github: ops("github") },
    saved: {
      gitlab: decodeRepos(savedRaw.gitlab),
      github: decodeRepos(savedRaw.github),
    },
  };
}

/** Empties both saved-repository lists (the Mac's gitLabSavedProjects / gitHubSavedRepos reset). Returns how many were dropped. */
export function clearSavedRepos(storage: Storage | undefined = globalThis.localStorage): number {
  const c = readRepoConfig(storage);
  const dropped = c.saved.gitlab.length + c.saved.github.length;
  if (dropped > 0) writeRepoConfig({ ...c, saved: { gitlab: [], github: [] } }, storage);
  return dropped;
}

/** localStorage is optional (SSR/tests); a write failure leaves the in-memory value to the caller. */
export function readRepoConfig(storage: Storage | undefined = globalThis.localStorage): RepoConfig {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? decodeRepoConfig(JSON.parse(raw)) : defaultRepoConfig();
  } catch {
    return defaultRepoConfig();
  }
}

export function writeRepoConfig(c: RepoConfig, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(c));
  } catch {
    // Storage full/unavailable: the component keeps the change for this session.
  }
}

/** The active saved clone's absolute path when it lives inside `projectRoot`; otherwise the project root. */
export function terminalCwd(projectRoot: string | null): string | null {
  if (!projectRoot) return null;
  const root = projectRoot.replace(/\/+$/, "");
  try {
    const c = readRepoConfig();
    const repo = [...c.saved.github, ...c.saved.gitlab].find((r) => r.active && r.clonePath.trim() !== "");
    const path = repo?.clonePath.trim();
    return path && path.startsWith(`${root}/`) ? path : projectRoot;
  } catch {
    return projectRoot;
  }
}

/** Trim, drop trailing slashes, default when empty. The path is kept (GitLab under a subpath is valid). */
export function normalizeBase(raw: string): string {
  const t = raw.trim();
  const trimmed = t.replace(/\/+$/, "");
  return trimmed || DEFAULT_GITLAB_BASE;
}

/** `owner/repo` or an http(s) URL with a path; null when valid. Never used to fetch anything. */
export function validateRepoUrl(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return "Enter a repository URL or owner/repo.";
  if (/\s/.test(t)) return "A repository URL cannot contain spaces.";
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return u.pathname.replace(/^\/+|\/+$/g, "") ? null : "The URL needs an owner/repo path.";
    } catch {
      return "That is not a valid URL.";
    }
  }
  // GitLab projects can sit in nested groups (group/sub/project, up to 20 segments); the clone checks the provider's own limit.
  if (/^[\w.-]+(\/[\w.-]+){1,19}$/.test(t)) return null;
  return "Use https://host/owner/repo or owner/repo.";
}

/** The `owner/repo` a URL or slug names; null when there is no owner and repo pair to import from. */
export function repoSlugOf(raw: string): string | null {
  const m = /^(?:https?:\/\/[^/]+\/)?([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(raw.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The full path a URL or shorthand names (`owner/repo`, or a GitLab `group/sub/project`); null when there are fewer than two segments. */
export function repoPathOf(raw: string): string | null {
  const m = /^(?:https?:\/\/[^/]+\/)?([^?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(raw.trim());
  const segs = m ? m[1]!.split("/") : [];
  return segs.length >= 2 && segs.length <= 20 && segs.every((x) => x !== "") ? segs.join("/") : null;
}

/**
 * Whether a repository should be cloned (and its issues imported) when its URL field loses focus: a finished, valid
 * owner/repo that is not cloned yet. A repository that already has a clone path is never re-attempted on blur.
 */
export function shouldProvision(repo: Pick<SavedRepo, "url" | "clonePath">): boolean {
  if (repo.clonePath.trim() !== "") return false;
  return validateRepoUrl(repo.url) === null && repoPathOf(repo.url) !== null;
}

export function newId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    return `r${Date.now().toString(36)}`;
  }
}

function copy(c: RepoConfig): RepoConfig {
  return {
    ...c,
    operations: { gitlab: [...c.operations.gitlab], github: [...c.operations.github] },
    saved: { gitlab: c.saved.gitlab.map((r) => ({ ...r })), github: c.saved.github.map((r) => ({ ...r })) },
  };
}

export function addSavedRepo(c: RepoConfig, provider: RepoProvider): RepoConfig {
  if (c.saved[provider].length >= MAX_REPOS) return c;
  const n = copy(c);
  n.saved[provider].push({ id: newId(), displayName: "", url: "", clonePath: "", active: n.saved[provider].length === 0 });
  return n;
}

export function updateSavedRepo(c: RepoConfig, provider: RepoProvider, id: string, patch: Partial<Pick<SavedRepo, "displayName" | "url" | "clonePath">>): RepoConfig {
  const n = copy(c);
  const row = n.saved[provider].find((r) => r.id === id);
  if (!row) return c;
  if (patch.displayName !== undefined) row.displayName = patch.displayName.slice(0, MAX_NAME);
  if (patch.url !== undefined) row.url = patch.url.slice(0, MAX_URL);
  if (patch.clonePath !== undefined) row.clonePath = patch.clonePath.slice(0, MAX_PATH);
  return n;
}

export function setActiveRepo(c: RepoConfig, provider: RepoProvider, id: string): RepoConfig {
  const n = copy(c);
  for (const r of n.saved[provider]) r.active = r.id === id;
  return n;
}

export function removeSavedRepo(c: RepoConfig, provider: RepoProvider, id: string): RepoConfig {
  const n = copy(c);
  const row = n.saved[provider].find((r) => r.id === id);
  if (!row) return c;
  n.saved[provider] = n.saved[provider].filter((r) => r.id !== id);
  if (row.active && n.saved[provider].length) n.saved[provider][0]!.active = true;
  return n;
}

export function setPrimary(c: RepoConfig, provider: RepoProvider | null): RepoConfig {
  return { ...c, primary: provider };
}

export function setAllowedOps(c: RepoConfig, provider: RepoProvider, ops: readonly RepoOp[]): RepoConfig {
  const want = new Set(ops);
  const n = copy(c);
  n.operations[provider] = ALL_REPO_OPS.filter((op) => want.has(op));
  return n;
}

export function toggleAllowedOp(c: RepoConfig, provider: RepoProvider, op: RepoOp, on: boolean): RepoConfig {
  const have = c.operations[provider];
  return setAllowedOps(c, provider, on ? [...have, op] : have.filter((x) => x !== op));
}

/** The Mac's row title: the display name, else the repo name from the URL, else "Untitled repository". */
export function repoTitle(r: SavedRepo): string {
  if (r.displayName.trim()) return r.displayName.trim();
  const m = /^(?:https?:\/\/[^/]+\/)?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(r.url.trim());
  return m?.[1] ?? "Untitled repository";
}
