// Phase 7 — open a GitHub PR with the codegen artifact as commits.
// Workflow:
//
//   1. Verify the repo path is a git work-tree on the expected branch.
//   2. Create branch `llmide/auto/<task-id>` from current HEAD.
//   3. Stage + commit the artifact files (which the apply step already
//      wrote under .llmide-auto/<task>/).
//   4. Push the branch to the configured `origin`.
//   5. Open a PR via the GitHub REST API.
//
// We deliberately use the local `git` CLI rather than a JS git library
// so the user sees real commits using their own git config (signed
// commits, hooks, gpg, etc.).  Any git failure is surfaced verbatim.

import { execFile } from 'child_process';
import path from 'path';
import { redactSecrets } from '../core/redact-secrets.mjs';
// Sanitize free-form text before splicing into the commit message / PR
// title/body.  Newlines are particularly dangerous: a multi-line value
// could inject fake commit trailers ("Co-authored-by:", "Signed-off-by:")
// or smuggle markdown that re-attributes the change.  sanitizeLine
// collapses all whitespace, strips C0 controls, and caps length — the
// same semantics the old local sanitizeSummary provided.
import { sanitizeLine as sanitizeSummary } from '../core/utils.mjs';

function execGit(repoPath, args, env = {}) {
  return new Promise((resolve, reject) => {
    // Explicit allowlist — never spread process.env into a child process.
    // Spreading would leak ANTHROPIC_API_KEY, LLMIDE_JWT_SECRET,
    // LLMIDE_VAULT_KEY, and any other secrets present in the server's
    // environment to an arbitrary git subprocess.
    const safeEnv = {
      PATH:         process.env.PATH  || '',
      HOME:         process.env.HOME  || '',
      TMPDIR:       process.env.TMPDIR || '',
      LANG:         process.env.LANG  || '',
      // git needs XDG_CONFIG_HOME / GIT_CONFIG_GLOBAL on some systems.
      ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
      ...(process.env.GIT_CONFIG_GLOBAL ? { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL } : {}),
      // SSH / GPG helpers — users may sign commits or push via SSH agent.
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      ...(process.env.GPG_TTY ? { GPG_TTY: process.env.GPG_TTY } : {}),
      // Caller can pass explicit overrides (e.g. GIT_AUTHOR_NAME for a
      // commit) — these are scoped and don't include server secrets.
      ...env,
    };
    // Drop any key the caller explicitly set to undefined/empty.
    for (const k of Object.keys(safeEnv)) {
      if (!safeEnv[k]) delete safeEnv[k];
    }
    execFile('git', args, {
      cwd: repoPath,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: safeEnv,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.slice(0, 2).join(' ')}: ${(stderr || error.message).slice(0, 400)}`));
        return;
      }
      resolve({ stdout: stdout.toString().trim(), stderr: stderr.toString().trim() });
    });
  });
}

async function inferDefaultBranch(repoPath) {
  // Fall back to "main" if symbolic-ref isn't set up.
  try {
    const r = await execGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return r.stdout.replace(/^origin\//, '') || 'main';
  } catch {
    return 'main';
  }
}

// Lightweight secret scanner for the staged diff. We only look at ADDED
// lines (diff lines starting with a single '+'); we return the NAME of the
// first rule that matched so the error message can be specific without ever
// echoing the secret value itself. This is a guardrail, not a vault — it is
// deliberately conservative (high-signal patterns) to avoid blocking on
// false positives, while still catching the obvious "an API key leaked into
// generated code" case.
// Keep the token shapes in sync with core/redact-secrets.mjs and
// guardrails/rules.mjs — this is the third copy of the same coverage set
// (it stays a local [name, regex] list because scanForSecrets needs the
// human-readable name for the block message). When a shape is added there,
// add it here too.
const SECRET_RULES = [
  ['AWS access key id',      /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token',           /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  // All GitLab token classes (glpat- PAT, glrt- runner, glcbt- CI job,
  // gldt- deploy, …), not just glpat-.
  ['GitLab token',           /\bgl(?:pat|oas|rt|cbt|ptt|ft|imt|agent|soat|dt|ffct)-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token',            /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Anthropic API key',      /\bsk-ant-[A-Za-z0-9-]{20,}\b/],
  // OpenAI project key — checked before the generic sk- rule, which can't
  // match it (the hyphen after "proj" breaks the generic [A-Za-z0-9] body).
  ['OpenAI project key',     /\bsk-proj-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI API key',         /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Google API key',         /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private key block',      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['generic bearer secret',  /(?:secret|token|password|passwd|api[_-]?key)["'\s:=]+[A-Za-z0-9/+_-]{20,}/i],
];

export function scanForSecrets(diffText) {
  if (!diffText) return null;
  for (const rawLine of diffText.split('\n')) {
    // Only inspect added lines; ignore diff metadata ('+++ b/file').
    if (rawLine[0] !== '+' || rawLine.startsWith('+++')) continue;
    const added = rawLine.slice(1);
    for (const [name, re] of SECRET_RULES) {
      if (re.test(added)) return name;
    }
  }
  return null;
}

function safeBranchName(taskId) {
  // GitHub branch names: avoid double slashes, ASCII whitespace, ~, ^, :,
  // ?, *, [, \.  Stay conservative.
  const slug = String(taskId || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
  return `llmide/auto/${slug}`;
}

export async function openPullRequest({
  repoPath, taskId, files = [], tests = [], summary, ghRepo, ghToken, baseBranch,
}) {
  if (!ghRepo || !ghToken) throw new Error('PR creation requires GitHub repo + token');
  if (!repoPath) throw new Error('repoPath required');
  if ((files.length + tests.length) === 0) throw new Error('No files to commit');

  // Defensive: make sure this is a git repo.  The status command exits
  // non-zero outside of one and the error bubbles up clearly.
  await execGit(repoPath, ['rev-parse', '--is-inside-work-tree']);

  const branch = safeBranchName(taskId);
  const base = baseBranch || await inferDefaultBranch(repoPath);

  // Refuse to clobber an existing branch with the same name — the user
  // can delete it locally and retry if they really want a fresh attempt.
  try {
    const exists = await execGit(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (exists.stdout) {
      // rev-parse succeeded → branch exists → block the operation.
      throw new Error(`Branch ${branch} already exists locally — delete or rename before retry.`);
    }
  } catch (err) {
    // rev-parse exits non-zero when the ref doesn't exist; that's what
    // we expect for a new branch.  Re-throw for everything else — in
    // particular re-throw the "already exists" error we just threw above,
    // and any hard git errors (repo corrupt, git not on PATH, etc.).
    if (!String(err.message).includes('unknown revision') &&
        !String(err.message).includes('Needed a single revision')) {
      throw err;
    }
  }

  // Refuse to create the branch if the working tree has uncommitted
  // changes that aren't in `.llmide-auto/`.  We only stage that
  // subdirectory, so any other dirty file would be left stranded on the
  // feature branch without being committed — surprising for the user.
  const statusResult = await execGit(repoPath, ['status', '--porcelain']);
  if (statusResult.stdout.trim()) {
    throw new Error(
      'Working tree has uncommitted changes — stash or commit them before opening a PR.\n' +
      `Dirty files:\n${statusResult.stdout.slice(0, 400)}`,
    );
  }

  // Run all git ops as a single transaction-style sequence so a failure
  // mid-flow leaves the repo on the new branch (recoverable) rather than
  // half-committed.
  await execGit(repoPath, ['checkout', '-b', branch, base]);

  // The apply step writes under `.llmide-auto/<task>/`; that's all
  // that should be staged.  We don't want to capture unrelated working-
  // tree changes the user may have lying around.
  const safeTask = String(taskId).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
  const stagePath = path.join('.llmide-auto', safeTask);
  await execGit(repoPath, ['add', '--', stagePath]);

  // Guardrail: the staged content is machine-generated from an LLM and is
  // about to be pushed to a remote we don't control. Scan the staged diff
  // for anything that looks like a credential BEFORE the push leaves the
  // box. Pushing a secret to a remote is effectively unrecoverable (it
  // lives in the remote's reflog/PR history even after a force-push), so we
  // fail closed and make the operator inspect rather than auto-publish.
  const stagedDiff = await execGit(repoPath, ['diff', '--cached', '--unified=0']);
  const secretHit = scanForSecrets(stagedDiff.stdout);
  if (secretHit) {
    // Leave the branch + staged changes in place for inspection; just
    // refuse to commit/push. Never echo the matched secret value back.
    throw new Error(
      `Refusing to push: staged changes appear to contain a secret (${secretHit}). ` +
      `Inspect the staged diff under ${stagePath} and remove the credential before retrying.`,
    );
  }

  const safeSummary60 = sanitizeSummary(summary, 60);
  const safeSummary80 = sanitizeSummary(summary, 80);
  const safeSummary200 = sanitizeSummary(summary, 200);
  const commitMsg = `auto: ${safeSummary60 || `apply ${safeTask}`}\n\nGenerated by LLM IDE for task ${safeTask}.\nFiles: ${files.length} src + ${tests.length} test.`;
  await execGit(repoPath, ['commit', '-m', commitMsg]);

  await execGit(repoPath, ['push', '-u', 'origin', branch]);

  // Open the PR via REST.
  const prBody = [
    `Generated by LLM IDE for task \`${safeTask}\`.`,
    safeSummary200 ? `\n${safeSummary200}` : '',
    `\nFiles changed: ${files.length} source · ${tests.length} test.`,
    `\nReview the changes under \`.llmide-auto/${safeTask}/\` and decide whether to integrate them into the main tree.`,
  ].join('');
  const r = await fetch(`https://api.github.com/repos/${ghRepo}/pulls`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${ghToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'llm-ide-extension',
    },
    body: JSON.stringify({
      title: `auto: ${safeSummary80 || safeTask}`,
      head: branch,
      base,
      body: prBody,
      draft: true,                    // always open as draft so the user reviews before merging
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    // Redact before surfacing — GitHub 401/403 bodies can echo token fragments.
    const text = redactSecrets((await r.text())).slice(0, 400);
    throw new Error(`GitHub PR API ${r.status}: ${text}`);
  }
  const pr = await r.json();
  return {
    branch,
    base,
    pr: { url: pr.html_url, number: pr.number, state: pr.state, draft: pr.draft },
  };
}
