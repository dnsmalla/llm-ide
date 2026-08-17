---
name: assist-plan
description: Use when the user wants to build a plan collaboratively over several turns — asking clarifying questions in rounds, checking in section by section — rather than getting a one-shot proposal. Contrast with writing-plans/brainstorming, which are single-pass.
---

# Assist Plan

Turn a rough idea into a plan through repeated rounds of grounded questions
and section-by-section review, staying in the conversation with the user the
whole way rather than disappearing to produce one big document. Five phases,
in order:

1. **Get the summary**
2. **Ground and question**
3. **Draft paragraphs, human reviews**
4. **Expand**
5. **Finalize**

**Stateless by design.** There is no separate tracker for "which phase am I
on" — figure it out by re-reading the conversation so far. If the user's
last message was a round of questions you asked, you're between phase 2 (or
4) and the next step. If they just gave you a first message with no summary
yet, you're at phase 1. Always re-derive it; never assume you remember.

## Phase 1 — Get the summary

If the user hasn't given a summary of what they want yet, ask for one in a
sentence or two. Don't move on without it — everything downstream is
grounded against this summary, so a vague or missing one means asking vague
questions later.

## Phase 2 — Ground and question

Extract the concrete claims and assumptions embedded in the summary. Then:

- **Check them yourself first.** Read files, search the codebase, look at
  docs — anything you can find on your own, find it. Never ask the user for
  a fact you could look up. This mirrors `grilling`'s rule: facts are your
  job, decisions are theirs.
- **Ask only what's genuinely a decision** — something ambiguous or
  underspecified that only the user can resolve. Batch every question you
  can currently ask into **one round** (see Question Format below); don't
  drip them out one at a time across several turns, and don't ask a
  question whose answer depends on another question still open in this same
  round — that one waits for the next round.
- **Wait for the round's answers**, then rewrite the summary into an
  accurate, grounded version incorporating them.

## Phase 3 — Draft paragraphs, human reviews

Turn the grounded summary into a small number of clearly-scoped prose
paragraphs — the narrative design, not a task list yet. Present it and ask
whether it looks right before continuing. Scale each paragraph to its
complexity: a few sentences if it's straightforward, more if it's nuanced.

## Phase 4 — Expand

Look for a gap the paragraphs don't cover — edge cases, testing approach,
rollout, whatever's naturally missing — and add it as a new section. If that
raises new decisions, run another round of selection-based questions for
just that section, same format as Phase 2. Repeat this phase: new section,
new round, until nothing important is left unclear. You're done expanding
when a fresh look turns up nothing left to add or ask — `grilling` calls
this "the frontier is empty."

## Phase 5 — Finalize

Self-review before showing the user the final document:

- **Placeholder scan** — any "TBD", "TODO", or vague requirement? Fix it.
- **Internal consistency** — do any sections contradict each other?
- **Ambiguity check** — could anything be read two ways? Pick one and say
  so explicitly.

Fix issues inline, no need to re-review. Then ask the user for a final
review of the whole document — wait for their approval. Once they approve,
if you're running inside a tool/environment that has its own way of saving a
plan (e.g. llm-ide's `save-plan` tool), use that with a short title and the
finalized document as content. Otherwise, hand off to
`superpowers:writing-plans` (for a full implementation plan) or just save the
document where the user's own conventions expect it.

## Question Format

Every round is formatted like this (adapted from mattpocock/skills'
`grilling`):

```
❓ **Q1** — <question, including the choices it's a decision between>
➡️ <your recommended answer>

❓ **Q2** — <question 2>
➡️ <your recommended answer>
```

- **One round per turn.** Every question you can currently ask, together,
  numbered — not one question per message.
- **Always recommend a default.** Give the user a fast "yes, go with that"
  path instead of forcing them to compose an answer from scratch.
- **Selection-based over open-ended.** Phrase each question as a choice
  between named options where you can; reserve open-ended questions for
  when there genuinely isn't a short list of options.
- **Group by theme** once a round has more than a handful of questions
  (borrowed from `to-questionnaire`), most-important-first.

## When to use this instead of `writing-plans`/`brainstorming`

Use `assist-plan` when the Q&A-and-review loop itself is what the user
wants — they said something like "help me plan this properly", "let's work
through this together", "ask me whatever you need", "check in with me as we
go". Use plain `writing-plans`/`brainstorming` when they want you to just
produce the design/plan and they'll review it once at the end, not
collaborate through rounds of questions along the way.
