---
name: git-op
kind: write
confirmation: gitop-sheet
schema:
  op:
    type: string
    required: true
    enum: [status, log, diff, branch, add, commit, create_branch, checkout, pull_ff, push, merge, revert, reset, stash, clean, merge_to_main]
    description: the git operation to perform on the user's active repository.
  message:
    type: string
    required: false
    maxLength: 1000
    description: commit message (op=commit) — required when committing.
  branch:
    type: string
    required: false
    maxLength: 300
    description: branch name (op=create_branch/checkout/merge/merge_to_main). For merge/merge_to_main this is the SOURCE branch being merged.
  ref:
    type: string
    required: false
    maxLength: 300
    description: a commit/ref (op=revert/reset/diff/log) — e.g. HEAD, a SHA, or a branch.
  mode:
    type: string
    required: false
    enum: [soft, mixed, hard]
    description: reset mode (op=reset). Defaults to mixed; 'hard' is destructive and the Mac app warns explicitly.
  slug:
    type: string
    required: false
    maxLength: 60
    description: short kebab-case description of the change, used to name an auto-created branch (agent/<slug>) when committing while on the default branch.
---

# git-op

Act on the user's **active repository** with git. You PROPOSE the operation;
the Mac app shows the user a confirmation (auto-runs read-only ops) and runs it
locally. You never run git yourself.

## Branch-first workflow (REQUIRED)

The Mac app refuses to commit or push on the default branch (`main`/`master`).
So when the user wants changes (revert, edit, etc.):

1. `create_branch` (or rely on auto-branching — committing on `main` auto-creates
   `agent/<slug>`; pass a `slug`).
2. `commit` the change on that branch.
3. `push` the branch.
4. To integrate, prefer opening a PR/MR (use `create-gitlab-issue`/the review flow),
   or — only if the user explicitly asks to land it — `merge_to_main` (the single
   op allowed to push to `origin main`, confirmed loudly).

Never propose pushing directly to `main`; never propose `reset hard` or `clean`
unless the user explicitly asks and understands the loss.

## When to use

The user asks for a git action on their repo: "revert the last change", "commit
this on a branch", "merge feature-x", "what changed", "push my branch".

## Call shape

<<<TOOL_CALL>>>
{"name": "git-op", "arguments": {"op": "revert", "ref": "HEAD", "slug": "revert-caption-change"}}
<<<END_TOOL_CALL>>>

## Examples

- "what's changed?" → {"op": "status"}
- "revert the last commit" → {"op": "revert", "ref": "HEAD", "slug": "revert-last"}
- "commit this as 'fix caption'" → {"op": "commit", "message": "fix caption", "slug": "fix-caption"}
- "merge feature-x into main" → first {"op":"push"} the branch + suggest a PR; only on explicit request {"op": "merge_to_main", "branch": "feature-x"}
