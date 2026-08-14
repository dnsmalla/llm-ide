---
name: code-review
description: >
  Token-efficient code review using memory-cached project context.
  Reviews current diff or a PR for bugs, security, and convention compliance.
when_to_use: >
  Trigger when user says "review this", "code review", provides a PR URL,
  asks "is this safe to merge", or wants to check changes before pushing.
user-invocable: true
argument-hint: "[PR URL or branch name, optional]"
allowed-tools:
  - Bash(gh *)
  - Bash(git *)
---

# Code Review

Review code changes for bugs, security issues, and project convention violations.

`$ARGUMENTS` may contain a PR URL, a branch name, or be empty (reviews the working-tree diff).

## Phase 0: Load Project Context from Memory

Check the project memory directory for cached context before doing any work.

1. Read files in `~/.claude/projects/<project>/memory/` that have `type: project` or `type: reference` in their frontmatter.
2. Look for memories about CLAUDE.md conventions, known false-positive patterns, and repo structure.
3. Collect relevant memories into a `CACHED_CONTEXT` variable (keep it under 500 words).
4. If no relevant memories exist, set `CACHED_CONTEXT` to empty.

This avoids spawning an agent just to gather project rules.

## Phase 1: Gather the Diff

Get the code changes to review based on what the user provided.

**If a PR URL or PR number was given:**

```bash
gh pr diff <pr> --color=never
gh pr view <pr> --json title,body,baseRefName,headRefName
```

**If a branch name was given:**

```bash
git diff main...<branch> --stat
git diff main...<branch>
```

**If nothing was given (review working-tree changes):**

```bash
git diff --cached --stat
git diff --stat
git diff --cached
git diff
```

**Read CLAUDE.md rules (only if nothing was cached in Phase 0):**

Find CLAUDE.md files in directories touched by the diff:

```bash
git diff --name-only | xargs -I{} dirname {} | sort -u | while read d; do
  [ -f "$d/CLAUDE.md" ] && cat "$d/CLAUDE.md"
done
```

Also check the root CLAUDE.md if it exists.

At this point you have: the diff, optionally a PR summary, and the project rules (from memory or fresh read).

## Phase 2: Review the Changes

Spawn one Agent with `model: haiku` to perform the review.

Give the agent:
- The diff
- The PR summary (if reviewing a PR)
- The project rules from CLAUDE.md
- The cached context from memory

Tell the agent to look for:
1. **Bugs** — logic errors, off-by-one errors, null dereferences, race conditions
2. **Security** — injection, auth bypass, secrets in code, OWASP top 10
3. **Convention violations** — only those explicitly stated in the project rules

Tell the agent to return findings as a JSON list where each finding has:
- `file` — the file path
- `line` — the line number
- `severity` — critical, important, or minor
- `category` — bug, security, or convention
- `description` — one sentence explaining the issue
- `suggestion` — one sentence describing the fix

Tell the agent these rules:
- Only flag issues introduced by this diff, not pre-existing ones
- Ignore formatting, imports, and type errors (linters catch those)
- Ignore style issues unless CLAUDE.md explicitly requires them
- When uncertain, leave the finding out
- Return at most 10 findings, sorted by severity

## Phase 3: Verify Findings

Skip this phase if the reviewer found no issues.

Spawn one Agent with `model: haiku` to verify each finding.

Give the agent the original diff, the findings list, and the project rules.

Tell the agent to mark each finding as REAL or FALSE POSITIVE. A finding is a false positive if:
- The issue existed before this diff
- A linter or type checker would catch it
- It is a stylistic nitpick not mentioned in the project rules
- The code is actually correct on closer reading
- The finding misunderstands what the code does

The agent should return only findings with confidence >= 75 (on a 0-100 scale).

## Phase 4: Present Results

**If reviewing a PR and the user asked to post a comment:**

Use `gh pr comment` to post a review comment on the PR:

```
### Code review

Found N issues:

1. **[severity]** description (`file:line`)
   Fix: suggestion

2. ...

Generated with Claude Code
```

**If reviewing local changes (no PR):**

Print the findings directly in the same format.

**If no findings survived verification:**

```
No issues found. Reviewed for bugs, security, and convention compliance.
```

## Phase 5: Save Learnings to Memory

After the review, update memory if something new was learned:

1. If CLAUDE.md rules were read fresh (not from cache), save a memory summarizing the key rules for this project so future reviews can skip re-reading.
2. If certain false positive patterns kept appearing, save a memory noting them so future reviews can filter them out faster.
3. If a new project convention was discovered, create or update the relevant memory file.

Write memories to `~/.claude/projects/<project>/memory/` using the standard frontmatter format with `type: project` or `type: feedback`.

## Notes

- This skill uses at most 2 agents (reviewer + verifier), both using Haiku
- Do not re-read CLAUDE.md if memory already has the rules cached
- Do not report more than 10 findings
- Do not include formatting or style issues unless CLAUDE.md explicitly requires them
- Do not post a comment on a PR without asking the user first
