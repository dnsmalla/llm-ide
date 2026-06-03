---
title: "0014. Quick Fix vs Guided code workflow"
status: accepted
date: 2026-05-20
---

# 0014. Quick Fix vs Guided code workflow

## Context

The Code Workflow sheet was designed as a five-step pipeline — Issue → Branch → Generate → Review → Push → Done — with the user clicking through every gate so they could intervene before any GitLab side-effect happened. That's the right shape for non-trivial changes where the AI's branch name, MR title, or diff need human review.

For trivial fixes (a typo, a single-line config tweak, "make this button say 'Save' instead of 'Submit'"), the same five gates feel like ceremony. The chat-side `trigger-review-code` tool already collapses much of the planning step; the user wants a single confirm-and-go for short plans, and the full Guided flow only when they explicitly opt in.

Two alternative shapes were considered:

1. **Toggle on the existing sheet.** A "Skip review gates" switch that runs all steps back-to-back. Cheap to build, but the sheet's UI is already tuned for step-by-step review — collapsing it inline produced a cramped, half-working layout in prototypes.
2. **Two modes from the "New Change…" menu.** Quick Fix gets its own single-screen sheet that runs the pipeline end-to-end with one confirmation; Guided keeps the existing multi-step sheet.

## Decision

Split into two entry points sharing the same `CodeWorkflowService` backend:

- **Quick Fix** — single-screen sheet. Shows the diff + branch name + MR title once the AI generates them; one button runs branch-create → push → MR-open → issue-close in sequence. Also reachable from the chat side panel via `trigger-review-code` when the plan is short enough.
- **Guided** — existing multi-step sheet with explicit gates between each step. Default for plans above a length threshold.
- Both share `CodeWorkflowService`. Quick Fix's `runEndToEnd()` composes the same step methods (`bootstrapFromExistingIssue`, `generateDiff`, `pushBranch`, `openMR`, `closeIssueIfNeeded`) Guided calls one-at-a-time.
- "Switch to Guided" button on the Quick Fix sheet hands off in-progress state to the Guided sheet, so the user can escalate mid-flow without losing work.

## Consequences

- **Positive:** trivial fixes ship in one click instead of five.
- **Positive:** Guided keeps the safety it was designed for — no behavioural regression for users who relied on the gates.
- **Positive:** shared service means bug fixes / new GitLab calls land in both flows at once.
- **Positive:** the chat → Quick Fix path closes the loop on short-plan tool-call follow-ups, removing the "now go open the workflow sheet" handoff step.
- **Negative:** two UIs to maintain. We mitigate with the shared service and shared sub-components (`CodeWorkflowSummaryCard`, `MRPreviewBlock`).
- **Negative:** "which one should I pick?" is a real user question. The plan-length heuristic + UI copy ("Quick Fix — for small changes") tries to answer it, but expect some confusion in the first release.