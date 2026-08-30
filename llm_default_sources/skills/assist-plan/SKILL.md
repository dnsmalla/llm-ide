---
name: assist-plan
description: Use when the user wants to build a plan collaboratively over several turns — rounds of clarifying questions with recommended answers, then a written plan — rather than a one-shot proposal. The grilling-first variant of the plan pipeline; contrast with brainstorming, which explores design paths instead of interrogating a stated one.
---

# Assist Plan

The collaborative planning pipeline: interrogate the idea until nothing is
silently assumed, then turn what survives into an implementation plan.

Four stages, in order. Each names the skill that owns it — this skill is the
sequence, not a re-description of any stage's process.

## 1. Grill

Run `grilling` (mattpocock/skills). Map the request as a design tree, work
the frontier in rounds, one numbered round per turn with a recommended
answer for every question, and let each round's answers push the frontier
outward.

This is the stage that makes assist-plan different from the default plan
pipeline: `brainstorming` opens up a design space and proposes approaches;
`grilling` takes the user's stated direction and hunts for what is
unexamined in it. Reach for assist-plan when the user already knows roughly
what they want and needs it stress-tested — "grill me", "ask me whatever you
need", "let's work through this together", "check in with me as we go".

Two of grilling's rules matter enough to repeat, because both are routinely
broken:

- **Facts are yours, decisions are theirs.** Anything you could look up, look
  up. Never spend a question on it.
- **One round per turn.** Every question whose prerequisites are already
  settled goes in this round, numbered; a question that depends on an answer
  still open in this round belongs to the next one.

You are done when the frontier is empty — every branch visited, nothing left
assumed — and the user confirms you have a shared understanding.

## 2. Write the plan

Hand off to `writing-plans` with the grilled understanding as the spec. Same
skill, same output contract as the default pipeline: file structure first,
bite-sized tasks, the required plan header.

## 3. Save

Save the finished plan. Inside LLM-IDE that is the `save-plan` tool, which
writes `llm-doc/plans/`; elsewhere, wherever the project's own conventions
put plans.

## 4. Execute

Hand off to `subagent-driven-development` when subagents are available, or
`executing-plans` when they are not.

## When NOT to use this

- The user wants a design explored rather than a stated one tested → the
  default plan pipeline (`brainstorming` → `writing-plans`).
- The user wants the plan produced in one pass and will review it at the end
  → `writing-plans` directly.
- There is no plan to make yet, only a bug → `systematic-debugging`.
