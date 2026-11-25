import { host, isHostAvailable } from "../shell/host.ts";

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

/**
 * The host's copy of the list (`repo-config.json` in the desktop data dir). The host copy is the source of truth in the
 * desktop app: webview storage is lost when the webview is reset or when dev and packaged builds use other origins.
 */
export interface RepoConfigHostIo {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

const desktopHostIo: RepoConfigHostIo = {
  load: () => host.repoConfigLoad(),
  save: (json) => host.repoConfigSave(json),
};

// `undefined` = the desktop host when it is present (the normal case); tests install a fake, `null` turns it off.
let hostIoOverride: RepoConfigHostIo | null | undefined;

export function setRepoConfigHostIo(io: RepoConfigHostIo | null | undefined): void {
  hostIoOverride = io;
}

function activeHostIo(): RepoConfigHostIo | null {
  if (hostIoOverride !== undefined) return hostIoOverride;
  return isHostAvailable() ? desktopHostIo : null;
}

export function writeRepoConfig(c: RepoConfig, storage: Storage | undefined = globalThis.localStorage): void {
  const json = JSON.stringify(c);
  try {
    storage?.setItem(KEY, json);
  } catch {
    // Storage full/unavailable: the component keeps the change for this session.
  }
  // Fire-and-forget: a failed host write keeps the webview copy, which is what the screens read in this session.
  const io = activeHostIo();
  if (io) void io.save(json).catch(() => undefined);
}

/**
 * Forget path: empties the host copy together with localStorage. An empty object reads back as the defaults,
 * so a later start does not bring the cleared list back from the host file.
 */
export function clearRepoConfigHostFile(): void {
  const io = activeHostIo();
  if (io) void io.save("{}").catch(() => undefined);
}

export type RepoConfigHydration = "restored" | "migrated" | "unchanged";

function isJsonObject(text: string): boolean {
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
}

function readLocalRaw(storage: Storage | undefined): string | null {
  try {
    return storage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Start-up: makes the host copy visible to the screens. A host copy that exists and is valid is written into
 * localStorage. With no host copy yet, a list saved only in the webview is copied to the host once (the migration
 * from the old localStorage-only version). An unreadable host copy is left alone, and so is the local one.
 */
export async function hydrateRepoConfig(
  storage: Storage | undefined = globalThis.localStorage,
  io: RepoConfigHostIo | null = activeHostIo(),
): Promise<RepoConfigHydration> {
  if (!io) return "unchanged";
  let hostJson: string | null;
  try {
    hostJson = await io.load();
  } catch {
    // Refused or malformed on the host: keep the webview copy, and do not overwrite the host file with it either.
    return "unchanged";
  }
  if (hostJson !== null && isJsonObject(hostJson)) {
    try {
      storage?.setItem(KEY, hostJson);
    } catch {
      // Storage unavailable: the screens read the defaults this session; the host copy is still the source of truth.
    }
    return "restored";
  }
  const local = readLocalRaw(storage);
  if (local !== null && isJsonObject(local)) {
    try {
      await io.save(local);
      return "migrated";
    } catch {
      return "unchanged";
    }
  }
  return "unchanged";
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

/** The key issues are imported and matched under: GitLab keeps its full nested-group path, GitHub is owner/repo. */
export function repoKeyOf(provider: RepoProvider, raw: string): string | null {
  return provider === "gitlab" ? repoPathOf(raw) : repoSlugOf(raw);
}

/**
 * Whether a repository should be cloned (and its issues imported) when its URL field loses focus: a finished, valid
 * owner/repo that is not cloned yet. A repository that already has a clone path is never re-attempted on blur.
 */
/**
 * The clone path this computer recorded for a repository. Ssh mode ignores it: the Mac path is not a path on the
 * server, and a server clone never writes one.
 */
export function recordedClonePath(repo: Pick<SavedRepo, "clonePath">, sshMode: boolean): string {
  return sshMode ? "" : repo.clonePath.trim();
}

/**
 * Whether a finished URL should be cloned on blur. Ssh mode asks the server instead of trusting a Mac path, so an
 * "already exists" answer from the server is the only "already cloned" signal there.
 */
export function shouldProvision(repo: Pick<SavedRepo, "url" | "clonePath">, sshMode = false): boolean {
  if (recordedClonePath(repo, sshMode) !== "") return false;
  return validateRepoUrl(repo.url) === null && repoPathOf(repo.url) !== null;
}

/** The folder a clone lands in: the repository's last path segment (GitLab: group/sub/project clones into code/project). */
export function cloneFolderName(repo: Pick<SavedRepo, "url" | "displayName">): string | null {
  const path = repoPathOf(repo.url);
  if (path) return path.split("/").pop()!;
  const name = repo.displayName.trim();
  return name ? name.replace(/[^A-Za-z0-9._-]+/g, "-") : null;
}

/** Where a clone goes: the recorded local path (local mode only), else code/<folder> under the project's code/ folder. */
export function cloneDestinationOf(
  repo: Pick<SavedRepo, "url" | "displayName" | "clonePath">,
  codeDir: string | null,
  sshMode: boolean,
): string | null {
  const recorded = recordedClonePath(repo, sshMode);
  if (recorded) return recorded;
  const name = cloneFolderName(repo);
  return codeDir && name ? `${codeDir}/${name}` : null;
}

/**
 * A grant is sent only where the clone will go. The server clones GitHub from github.com and GitLab from gitlab.com
 * alone, so a GitLab token saved for a self-hosted instance must not be granted; a malformed base gets none either.
 */
export function grantHostAllowed(provider: RepoProvider, gitlabBaseUrl: string): boolean {
  if (provider === "github") return true;
  try {
    const url = new URL(normalizeBase(gitlabBaseUrl));
    return url.protocol === "https:" && url.host === "gitlab.com";
  } catch {
    return false;
  }
}

/**
 * The server clone grant for one clone. Only SSH mode asks, and only when no token is typed or remembered: a typed
 * token wins and never reaches the core. The core answers `{grant}` (null without a saved token). A failed request
 * is not fatal: the clone then runs anonymously, and a private repository reports its auth failure as before.
 */
export async function resolveCloneGrant(
  args: { ssh: boolean; token: string; provider: RepoProvider; gitlabBaseUrl?: string },
  requestGrant: (provider: RepoProvider) => Promise<unknown>,
): Promise<string | null> {
  if (!args.ssh || args.token.trim() || !grantHostAllowed(args.provider, args.gitlabBaseUrl ?? DEFAULT_GITLAB_BASE)) return null;
  try {
    const body = await requestGrant(args.provider);
    const grant = body && typeof body === "object" ? (body as { grant?: unknown }).grant : null;
    return typeof grant === "string" && grant.length > 0 ? grant : null;
  } catch {
    return null;
  }
}

/**
 * Records a finished clone. Local mode keeps the path for the Loop, Factory and Review; a server clone leaves the
 * saved repository alone so the Mac path that local mode uses is not overwritten.
 */
export function applyCloneResult(c: RepoConfig, provider: RepoProvider, id: string, clonedPath: string, sshMode: boolean): RepoConfig {
  return sshMode ? c : updateSavedRepo(c, provider, id, { clonePath: clonedPath });
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

/**
 * The host text git uses for a GitLab base URL, or null when the host would refuse it: case-insensitive https, lowercase
 * host, no trailing dot, `:443` dropped, port 1-65535. Keep in step with `normalize_host` in git_credential.rs.
 */
export function credentialHostOf(base: string): string | null {
  const m = /^https:\/\/([^/?#]*)/i.exec(base.trim());
  if (!m) return null;
  const [host, port, ...extra] = m[1].split(":");
  if (extra.length > 0 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || host.endsWith(".")) return null;
  const lower = host.toLowerCase();
  if (port === undefined) return lower;
  if (!/^[0-9]+$/.test(port)) return null;
  const n = Number(port);
  if (n < 1 || n > 65535) return null;
  return n === 443 ? lower : `${lower}:${n}`;
}

/** What the host reported for the git credential step; `null` when the step did not run (remote mode, old host). */
export type GitCredentialOutcome = { stored: boolean; reason?: string } | Error | null;

const withoutTrailingStops = (text: string): string => text.replace(/[.\s]+$/, "");

/**
 * The status line after Save token (`saved: true`) or Clear token (`"cleared"`). The vault step already succeeded
 * when this runs, so a git problem is worded as a warning, never as a failed save.
 */
export function gitCredentialStatus(saved: true | "cleared", outcome: GitCredentialOutcome, provider: RepoProvider, host: string): string {
  const label = provider === "gitlab" ? "GitLab" : "GitHub";
  const skipped = outcome === null || (!(outcome instanceof Error) && (outcome.reason === "ssh" || outcome.reason === "remote"));
  if (saved === "cleared") {
    if (outcome instanceof Error) return `Token cleared from LLM-IDE, but git could not remove it: ${withoutTrailingStops(outcome.message)}.`;
    if (skipped) return "Token cleared. Saved repositories kept.";
    if (outcome.stored) return "Token cleared from LLM-IDE and from git.";
    if (outcome.reason === "left_in_place") return `Token cleared from LLM-IDE. The git login for ${host} was not saved by LLM-IDE, so it was left in place.`;
    if (outcome.reason === "not_removed") return `Token cleared from LLM-IDE, but git still holds a login for ${host}. Remove it in your keychain or credential helper.`;
    return "Token cleared. Saved repositories kept.";
  }
  if (skipped) return "Token saved.";
  if (outcome instanceof Error) return `Token saved for the ${label} API, but git could not store it: ${withoutTrailingStops(outcome.message)}.`;
  if (outcome.stored && outcome.reason === "replaced_existing") {
    return `Token saved. An existing git login for ${host} was replaced; git clone, pull and push now use this token.`;
  }
  if (outcome.stored) return `Token saved. Git clone, pull and push will use it for ${host}.`;
  if (outcome.reason === "not_stored") {
    return `Token saved for the ${label} API. Git has no working credential helper that kept it, so clone, pull and push need your own git login.`;
  }
  if (outcome.reason === "git_missing") return `Token saved for the ${label} API. Git was not found, so clone, pull and push are unavailable.`;
  return "Token saved.";
}
