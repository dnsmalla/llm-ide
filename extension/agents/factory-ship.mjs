// Factory Ship (Software Factory Phase A): the one place a Factory run's worktree is
// committed, scanned for secrets, pushed, and turned into a DRAFT PR/MR. Called only by
// POST /kb/loop/ship (routes/loop-agent.mjs) after a user click; the agent never pushes.
//
// `.factory/` (TASK.md, PLAN.md, REVIEW.md, READINESS.md) is the run's own scratch space and
// is never committed. Provider calls go to fixed hosts with no redirects, and a provider's
// own answer text never reaches an error message (it can echo token fragments).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';
import { sanitizeLine } from '../core/utils.mjs';
import { scanForSecrets } from './github-pr.mjs';

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const FACTORY_BRANCH_RE = /^factory\/[A-Za-z0-9_-]{1,64}$/;
const FACTORY_DIR = '.factory';
// `.factory/` is never committed or reviewed: the run's own reports. The list is mirrored by
// desktop/src-tauri/src/loop_worktree.rs::EXCLUDES and pinned by schema/factory/staged-patch.json.
export const STAGED_PATCH_EXCLUDES = Object.freeze([':(exclude,icase).factory', ':(exclude,icase,glob)**/.factory/**']);
const EXCLUDE_FACTORY = STAGED_PATCH_EXCLUDES[0];
const PUSH_TIMEOUT_MS = 120_000;
const PROVIDER_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_BYTES = 1024 * 1024;
export const SHIP_LIMITS = Object.freeze({ title: 200, body: 20_000, repo: 200, base: 200 });
const API = Object.freeze({
  github: { name: 'GitHub', host: 'api.github.com', base: 'https://api.github.com', web: 'https://github.com/' },
  gitlab: { name: 'GitLab', host: 'gitlab.com', base: 'https://gitlab.com/api/v4', web: 'https://gitlab.com/' },
});
// Same shapes as routes/issue-writes.mjs REPO_SHAPE.
const REPO_SHAPE = Object.freeze({
  github: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  gitlab: /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,19}$/,
});

function shipError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Copied from github-pr.mjs execGit: an explicit allowlist, never process.env (it carries the
// server's secrets). GIT_TERMINAL_PROMPT=0: a push that needs credentials fails instead of
// waiting for a terminal nobody is watching.
function gitEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || '',
    LANG: process.env.LANG || '',
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    ...(process.env.GIT_CONFIG_GLOBAL ? { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL } : {}),
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    ...(process.env.GPG_TTY ? { GPG_TTY: process.env.GPG_TTY } : {}),
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
  for (const key of Object.keys(env)) {
    if (!env[key]) delete env[key];
  }
  return env;
}

// Hooks and fsmonitor are OFF for every git call here. The agent can edit files in the worktree, including a
// repo-relative hooks folder (for example `core.hooksPath=.husky`), and a hook would then run agent-written code
// inside the core process at Ship time. `-c` options go before the subcommand.
const SAFE_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

// The host's `git::base_args()` (desktop/src-tauri/src/git.rs) for the one call whose BYTES are hashed into the
// patch id: a config difference (quotepath, an external diff driver, submodule settings, attributes) would change
// those bytes, so the core and the host would compute different ids for the same tree. Mirrored exactly here and
// pinned by schema/factory/staged-patch.json.
// eslint-disable-next-line no-control-regex
const PATCH_SAFE_GIT_CONFIG = Object.freeze([
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.quotepath=false',
  '-c', 'core.sshCommand=false', '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'gc.auto=0',
  '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null', '-c', 'submodule.recurse=false',
  '-c', 'protocol.allow=never', '-c', 'status.submoduleSummary=false', '-c', 'maintenance.auto=false',
  '-c', 'diff.ignoreSubmodules=dirty',
]);

/** The `git add` args that stage a worktree (the host's staged_patch starts the same way). */
export function stagedAddArgs() {
  return ['add', '-A', '--', '.', ...STAGED_PATCH_EXCLUDES];
}

/** The `git diff` args whose stdout bytes are hashed into the run's patch id; `{base}` is the run's base commit. */
export function stagedDiffArgs(base, binary = true) {
  return ['diff', '--cached', '--no-ext-diff', '--no-textconv', ...(binary ? ['--binary'] : []), base, '--', '.', ...STAGED_PATCH_EXCLUDES];
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Never rejects: callers branch on `code`. stdout is raw, because a `-z` list must keep its bytes.
function runGit(cwd, args, { env = {}, timeoutMs = 60_000, config = SAFE_GIT_CONFIG, raw = false } = {}) {
  return new Promise((resolve) => {
    execFile('git', [...config, ...args], {
      cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: gitEnv(env), encoding: raw ? 'buffer' : 'utf8',
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: raw ? (Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0)) : String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** True when `repo` is a GitHub `owner/name` or a GitLab project path (no `.`/`..` segment). */
export function validShipRepo(provider, repo) {
  if (!Object.hasOwn(REPO_SHAPE, provider) || typeof repo !== 'string' || repo.length > SHIP_LIMITS.repo) return false;
  return REPO_SHAPE[provider].test(repo) && !repo.split('/').some((seg) => seg === '.' || seg === '..');
}

/** True when `url` is on the provider's own web origin (what the UI may open). */
export function isProviderWebUrl(provider, url) {
  return Object.hasOwn(API, provider) && typeof url === 'string' && url.startsWith(API[provider].web);
}

/**
 * True when `root` (already realpath-validated) is `<project>/system/loop-worktrees/<run id>`,
 * is a linked worktree (`.git` is a FILE), and `branch` is `factory/<run id>`.
 */
export function isFactoryWorktree(root, branch) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return false;
  const runId = path.basename(root);
  const parent = path.dirname(root);
  if (!RUN_ID_RE.test(runId) || path.basename(parent) !== 'loop-worktrees') return false;
  if (path.basename(path.dirname(parent)) !== 'system' || branch !== `factory/${runId}`) return false;
  try {
    return fs.lstatSync(path.join(root, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * True when the worktree's `origin` is `repo` on the provider's own host (github.com / gitlab.com; https, ssh:// or
 * scp-style `git@host:path`), compared case-insensitively. The push goes to `origin` while the PR/MR goes to the
 * `repo` the webview named, so a mismatch would push to one repository and open a request on another.
 */
export async function originMatchesRepo(worktree, provider, repo) {
  if (!Object.hasOwn(API, provider) || !validShipRepo(provider, repo)) return false;
  const r = await runGit(worktree, ['remote', 'get-url', '--push', 'origin']);
  if (r.code !== 0) return false;
  const m = /^(?:https:\/\/(?:[^@/]+@)?([^/]+)\/|ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@/\s]+@([^:/]+):)(.+?)(?:\.git)?\/?$/.exec(r.stdout.trim());
  if (!m) return false;
  const host = (m[1] || m[2] || m[3] || '').toLowerCase();
  return host === API[provider].host.replace(/^api\./, '') && m[4].toLowerCase() === repo.toLowerCase();
}

/**
 * The rule name when the PR/MR title or body would carry a secret, else null. Each line is scanned as an added diff
 * line (scanForSecrets only reads those), so the same rules apply as for the pushed diff.
 */
export function scanShipText(title, body) {
  // '+ ' (not '+'): scanForSecrets skips lines starting with '+++', so a text line starting with '++' would
  // otherwise be read as diff metadata and never scanned.
  const added = `${title}\n${body}`.split('\n').map((l) => `+ ${l}`).join('\n');
  return scanForSecrets(added);
}

/** Inserts a zero-width space after every `@` so the provider does not notify the person or team it names. */
export function neutraliseMentions(text) {
  return String(text ?? '').replaceAll('@', '@\u200b');
}

/**
 * The commit a run started from: the oldest reflog entry of its branch ("branch: Created from <base>"), exactly as
 * the host's loop_worktree::base_of does. A later Ship commit does not move it. Falls back to HEAD when reflogs are off.
 */
async function baseCommitOf(worktree, branch) {
  const log = await runGit(worktree, ['reflog', 'show', '--format=%H', `refs/heads/${branch}`]);
  if (log.code === 0) {
    const lines = log.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const oldest = lines[lines.length - 1];
    if (oldest && /^[0-9a-f]{40,64}$/.test(oldest)) return oldest;
  }
  return (await runGit(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
}

/** The staged patch bytes against `base`, with the exact git arguments the host hashes. Throws `commit_failed`. */
async function stagedPatchBytes(worktree, base) {
  const patch = await runGit(worktree, stagedDiffArgs(base, true), { config: PATCH_SAFE_GIT_CONFIG, raw: true });
  if (patch.code !== 0) throw shipError('commit_failed', 'The staged changes could not be read.');
  return patch.stdout;
}

/**
 * The run's patch id: sha256 of the staged `--binary` patch against its base commit, `.factory/` excluded — the same
 * value the host's `loop_worktree_diff` returns as `patchId`. Stages first (one shared index state), like the host.
 */
export async function stagedPatchId(worktree, base) {
  const add = await runGit(worktree, stagedAddArgs(), { config: PATCH_SAFE_GIT_CONFIG });
  if (add.code !== 0) throw shipError('commit_failed', 'The changes could not be staged.');
  return sha256Hex(await stagedPatchBytes(worktree, base));
}

/** The checked ship body, or `{ error }` naming what is wrong. Pure; a value over a limit is refused. */
export function parseShipBody(raw) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (typeof b.worktree !== 'string' || !b.worktree) return { error: 'worktree is required' };
  if (typeof b.branch !== 'string' || !FACTORY_BRANCH_RE.test(b.branch)) return { error: 'branch must be factory/<run id>' };
  if (b.provider !== 'github' && b.provider !== 'gitlab') return { error: 'provider must be github or gitlab' };
  if (!validShipRepo(b.provider, b.repo)) return { error: 'repo must be owner/name (GitHub) or a GitLab project path' };
  if (typeof b.base !== 'string' || !b.base || b.base.length > SHIP_LIMITS.base) return { error: 'base is required' };
  // The reviewed diff's id. It is required: without it Ship cannot prove it pushes what the user read.
  if (typeof b.patchId !== 'string' || !/^[0-9a-f]{64}$/.test(b.patchId)) return { error: 'patchId must be 64 lowercase hex characters' };
  const title = sanitizeLine(typeof b.title === 'string' ? b.title : '', SHIP_LIMITS.title);
  if (!title) return { error: 'title is required' };
  const text = b.body == null ? '' : b.body;
  if (typeof text !== 'string' || text.length > SHIP_LIMITS.body) {
    return { error: `body must be text of at most ${SHIP_LIMITS.body} characters` };
  }
  return { worktree: b.worktree, branch: b.branch, provider: b.provider, repo: b.repo, base: b.base, title, body: text, patchId: b.patchId };
}

/**
 * Commit everything in the worktree except `.factory/`, then push the branch to `origin`.
 *
 * Throws `{ code }`: `invalid_worktree` (not on `branch`), `diff_changed` (the staged patch id is not the reviewed
 * `patchId`; nothing is committed and the index is reset), `secret_detected` (the staged diff matched scanForSecrets;
 * nothing is committed and the index is reset), `commit_failed`, `push_rejected` (the local commit stays; a re-ship
 * pushes it). With nothing new to commit it pushes the current HEAD again (the re-ship after a failed push). A commit
 * records its patch id in `factory.patchid.<sha>`, so a re-ship of that exact commit is accepted even when the client's
 * id is the one the user reviewed before the commit existed.
 */
export async function commitAndPush({ worktree, branch, message, author = null, patchId }) {
  if (typeof branch !== 'string' || !FACTORY_BRANCH_RE.test(branch)) {
    throw shipError('invalid_worktree', 'The branch must be factory/<run id>.');
  }
  const head = await runGit(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== branch) {
    throw shipError('invalid_worktree', 'The worktree is not on its Factory branch.');
  }
  if (typeof patchId !== 'string' || !/^[0-9a-f]{64}$/.test(patchId)) {
    throw shipError('diff_changed', 'The reviewed diff id is missing; read the diff again, then ship.');
  }
  const subject = sanitizeLine(String(message ?? ''), SHIP_LIMITS.title) || `factory: ${branch}`;
  const base = await baseCommitOf(worktree, branch);
  if ((await runGit(worktree, stagedAddArgs(), { config: PATCH_SAFE_GIT_CONFIG })).code !== 0) {
    throw shipError('commit_failed', 'The changes could not be staged.');
  }
  // The one rule this route adds: it must push the diff the user read, not whatever is in the worktree now.
  const current = sha256Hex(await stagedPatchBytes(worktree, base));
  if (current !== patchId) {
    // Re-ship after a commit this route already made (for example a rejected push): if HEAD holds that commit, the
    // tree has not changed since it, and the id recorded for it is the reviewed one, the reviewed diff is what ships.
    const headSha = (await runGit(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    const recorded = headSha && headSha !== base
      ? (await runGit(worktree, ['config', '--get', `factory.patchid-${headSha}`])).stdout.trim()
      : '';
    const clean = await runGit(worktree, ['diff', '--cached', '--quiet', 'HEAD', '--', '.', ...STAGED_PATCH_EXCLUDES]);
    if (!(recorded === patchId && clean.code === 0)) {
      await runGit(worktree, ['reset', '-q']);
      throw shipError('diff_changed', 'The changes changed since you opened this review. Read the new diff, then ship again.');
    }
  }
  const names = await runGit(worktree, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--', '.', EXCLUDE_FACTORY]);
  // --text: a binary file's bytes are scanned as text too, so a token inside one is not skipped. --no-textconv: a
  // repo-configured textconv driver must not rewrite (and hide) what the scan sees.
  const diff = await runGit(worktree, ['diff', '--cached', '--text', '--no-textconv', '--unified=0', '--no-color', '--no-ext-diff', '--', '.', EXCLUDE_FACTORY]);
  if (names.code !== 0 || diff.code !== 0) {
    // Fail closed: a diff that cannot be read cannot be scanned.
    await runGit(worktree, ['reset', '-q']);
    throw shipError('commit_failed', 'The changes could not be scanned for secrets.');
  }
  // `:(exclude,icase)` covers any case; the `glob` exclude covers `.factory` at any depth. Filter again in JS,
  // case-insensitively at any depth, so a path the pathspec somehow lists is still never committed or scanned.
  const isFactoryPath = (p) => p.split('/').some((seg) => seg.toLowerCase() === FACTORY_DIR);
  const paths = names.stdout.split('\0').filter((p) => p && !isFactoryPath(p));
  if (paths.length > 0) {
    const hit = scanForSecrets(diff.stdout);
    if (hit) {
      await runGit(worktree, ['reset', '-q']);
      // The rule NAME only, never the matched text.
      throw shipError('secret_detected', `The changes appear to contain a secret (${hit}). Remove it, then Ship again.`);
    }
    const signing = await runGit(worktree, ['config', '--bool', '--get', 'commit.gpgsign']);
    const signArgs = signing.stdout.trim() === 'true' ? [] : ['-c', 'commit.gpgsign=false'];
    const env = author?.name && author?.email
      ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email }
      : {};
    // A pathspec commit: only these paths, never whatever else is in the index. Literal, so a
    // file name like ":(top)x" is not read as pathspec magic.
    const commit = await runGit(worktree, [...signArgs, '--literal-pathspecs', 'commit', '-q', '--no-verify', '-m', subject, '--', ...paths], { env });
    if (commit.code !== 0) {
      await runGit(worktree, ['reset', '-q']);
      throw shipError('commit_failed', 'git commit failed.');
    }
  }
  const sha = (await runGit(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  // Remember which diff this commit is, before the push: a rejected push keeps the commit, and its re-ship must
  // recognise the reviewed id instead of refusing it as stale.
  await runGit(worktree, ['config', `factory.patchid-${sha}`, current]);
  const push = await runGit(worktree, ['push', '--no-verify', '-u', 'origin', branch], { timeoutMs: PUSH_TIMEOUT_MS });
  if (push.code !== 0) throw shipError('push_rejected', 'The remote refused the push. No pull or merge request was opened.');
  return { commit: sha, pushed: true };
}

// One provider call: fixed host, no redirects (fixedHostFetch refuses a 3xx), 1 MiB cap.
// Errors are fixed text; the provider's answer is never read on failure.
async function providerJson(provider, url, init) {
  const api = API[provider];
  let res;
  try {
    res = await fixedHostFetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) },
      { hosts: [api.host], maxBytes: MAX_PROVIDER_BYTES });
  } catch {
    throw shipError('provider_error', `${api.name} could not be reached.`);
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw shipError('provider_error', `${api.name} answered ${res.status}.`);
  }
  try {
    return await res.json();
  } catch {
    throw shipError('provider_error', `${api.name} sent an unreadable answer.`);
  }
}

const githubHeaders = (token) => ({
  Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${token}`, 'User-Agent': 'llm-ide-desktop',
});
const gitlabHeaders = (token) => ({ 'PRIVATE-TOKEN': token, 'User-Agent': 'llm-ide-desktop' });

/** The open PR (GitHub) / MR (GitLab) whose source branch is `branch`, as its web URL, or null. */
export async function findOpenRequest(provider, repo, branch, token) {
  if (!validShipRepo(provider, repo)) throw shipError('provider_error', 'Invalid repository.');
  let url;
  let headers;
  if (provider === 'github') {
    const owner = repo.split('/')[0];
    url = `${API.github.base}/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`;
    headers = githubHeaders(token);
  } else {
    url = `${API.gitlab.base}/projects/${encodeURIComponent(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`;
    headers = gitlabHeaders(token);
  }
  const list = await providerJson(provider, url, { method: 'GET', headers });
  const key = provider === 'github' ? 'html_url' : 'web_url';
  const hit = Array.isArray(list) ? list.find((item) => isProviderWebUrl(provider, item?.[key])) : null;
  return hit ? hit[key] : null;
}

/** Open a DRAFT merge request on gitlab.com. */
export async function createDraftMr({ glProject, glToken, title, source, target, body }) {
  if (!validShipRepo('gitlab', glProject)) throw shipError('provider_error', 'Invalid GitLab project path.');
  // `draft: true` plus the "Draft: " title prefix GitLab has always honoured.
  const draftTitle = /^draft:/i.test(title) ? title : `Draft: ${title}`;
  const data = await providerJson('gitlab', `${API.gitlab.base}/projects/${encodeURIComponent(glProject)}/merge_requests`, {
    method: 'POST',
    headers: { ...gitlabHeaders(glToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_branch: source, target_branch: target, title: draftTitle, description: body, draft: true }),
  });
  return { url: data?.web_url, iid: data?.iid };
}
