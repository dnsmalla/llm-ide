---
name: reviewer
description: >
  Multi-agent PR code review. Launches 5 parallel agents to independently
  review changes for bugs, CLAUDE.md compliance, and historical context.
  Confidence-scored findings (threshold 80+) are posted as a PR comment.
when_to_use: >
  Trigger when user provides a PR URL and wants a thorough multi-agent review,
  says "review this PR", or invokes /reviewer.
user-invocable: true
argument-hint: "[PR URL or PR number]"
allowed-tools:
  - Bash(gh issue view:*)
  - Bash(gh search:*)
  - Bash(gh issue list:*)
  - Bash(gh pr comment:*)
  - Bash(gh pr diff:*)
  - Bash(gh pr view:*)
  - Bash(gh pr list:*)
---

# Multi-Agent PR Code Review

Provide a thorough code review for a given pull request using multiple independent agents with confidence scoring.

## Step 1: Eligibility Check

Use a Haiku agent to check if the pull request:
- (a) is closed
- (b) is a draft
- (c) does not need a code review (automated PR, or trivially correct)
- (d) already has a code review from you

If any of these apply, do not proceed.

## Step 2: Gather CLAUDE.md Files

Use a Haiku agent to list file paths (not contents) of relevant CLAUDE.md files: the root CLAUDE.md and any CLAUDE.md files in directories whose files the PR modified.

## Step 3: Summarize the Change

Use a Haiku agent to view the pull request and return a summary of the change.

## Step 4: Parallel Independent Review

Launch 5 parallel Sonnet agents to independently review the change. Each agent returns a list of issues with the reason each was flagged (CLAUDE.md adherence, bug, historical context, etc.):

1. **CLAUDE.md compliance** — Audit changes against CLAUDE.md guidance. Not all instructions apply during review.
2. **Bug scan** — Shallow scan for obvious bugs in the changes only. Focus on large bugs, skip nitpicks. Ignore likely false positives.
3. **Historical context** — Read git blame and history of modified code to identify bugs in light of that context.
4. **Prior PR comments** — Read previous PRs that touched these files and check for applicable comments.
5. **Code comment compliance** — Read code comments in modified files and verify the changes comply with their guidance.

## Step 5: Confidence Scoring

For each issue found in Step 4, launch a parallel Haiku agent that scores it 0-100:

- **0**: Not confident. False positive that doesn't survive light scrutiny, or pre-existing issue.
- **25**: Somewhat confident. Might be real, but could be false positive. Stylistic issues not explicitly in CLAUDE.md.
- **50**: Moderately confident. Verified real issue, but minor or unlikely in practice. Not very important relative to the PR.
- **75**: Highly confident. Double-checked, very likely real and will be hit in practice. Important to functionality, or directly mentioned in CLAUDE.md.
- **100**: Absolutely certain. Confirmed real, will happen frequently. Evidence directly confirms this.

For CLAUDE.md-related issues, the scorer must verify the CLAUDE.md actually calls out that issue.

Filter out any issues scoring below 80.

## Step 6: False Positive Guidance

These are false positives — do not flag them:

- Pre-existing issues not introduced by this PR
- Something that looks like a bug but isn't
- Pedantic nitpicks a senior engineer wouldn't call out
- Issues a linter, typechecker, or compiler would catch (imports, types, formatting)
- General quality issues (test coverage, documentation) unless required by CLAUDE.md
- Issues silenced in code (lint ignore comments)
- Intentional functionality changes related to the broader change
- Real issues on lines the user did not modify

## Step 7: Re-check Eligibility

Use a Haiku agent to repeat the eligibility check from Step 1 to confirm the PR is still eligible.

## Step 8: Post Comment

Use `gh pr comment` to post the review. Format:

```markdown
### Code review

Found N issues:

1. Brief description (CLAUDE.md says "...")

https://github.com/owner/repo/blob/FULL_SHA/path/file.ext#L10-L15

2. Brief description (bug due to file and snippet)

https://github.com/owner/repo/blob/FULL_SHA/path/file.ext#L20-L25

Generated with Claude Code
```

If no issues survive scoring:

```markdown
### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

Generated with Claude Code
```

## Link Format Rules

- Use full git SHA (not abbreviated)
- Format: `https://github.com/owner/repo/blob/FULL_SHA/path/file.ext#L10-L15`
- Provide at least 1 line of context before and after the issue line

## Notes

- Do not build or typecheck the app — CI handles that
- Use `gh` for all GitHub interaction, not web fetch
- Cite and link every issue with file paths and code references
- Keep the comment brief, no emojis
