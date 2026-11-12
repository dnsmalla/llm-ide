---
title: Factory board demo data
applies_to: desktop
---

# Factory board demo data

## Goal

See what each column of the Factory board looks like, and run the regression test that pins it.

## What the board is

Factory turns issues, specs and free text into cards that move through the **process**. The board's lanes are
**Backlog**, then one lane per enabled step of the process (Factory → Process, in order), then **MR open** and
**Done**. Editing the process changes the lanes.

A card sits in the step it is running, or in the step where it stopped (a failed gate sits in the step it checks).
Its status is a badge on the card. The lane and the badge are derived from the item's last run, its worktree and the
PR/MR status; they are never stored on the card.

A demo fixture has one card per status. With the steps Plan, Implement, Verify, Test gaps, Doc review and Review:

| Card | Lane | Status badge | What the card offers |
|------|------|--------------|----------------------|
| Demo 101 | Backlog | Inbox | Start · Run intake · Discard |
| Demo 102 | Plan | Needs decision | Run intake · Discard; answer form |
| Free text idea | Plan (the step it is running) | Working | live progress and last log line |
| Demo 104 | Verify (where it failed) | Needs you | Resume · Open diff · Discard |
| Demo 105 | MR open | Ready to ship | Open diff · Ship · Discard |
| Demo 106 | MR open | Shipped (CI running) | Open PR/MR · Open diff |
| Demo 107 | Done | Done | Open PR/MR · Discard |

## Run the test

The same fixture is a regression test: one item per status, with assertions for lanes, actions, notes and ship state.

```bash
cd desktop
node --test --experimental-strip-types ../ui/screens/factory/tests/demo-board.test.mjs
```

The test is [`ui/screens/factory/tests/demo-board.test.mjs`](https://github.com/dnsmalla/llm-ide/blob/main/ui/screens/factory/tests/demo-board.test.mjs).
