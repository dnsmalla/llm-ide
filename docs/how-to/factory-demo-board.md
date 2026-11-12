---
title: Factory board demo data
applies_to: desktop
---

# Factory board demo data

## Goal

See what each column of the Factory board looks like, and run the regression test that pins it.

## What the board is

Factory turns issues, specs and free text into cards that move through seven columns. The column is derived from the
item's last run, its worktree and the PR/MR status. It is never stored on the card.

A demo fixture has one card per column:

| Column | Demo card | What the card offers | Result |
|--------|-----------|----------------------|--------|
| Inbox | Demo 101 | Start · Run intake · Discard | no run yet |
| Needs decision | Demo 102 | Run intake · Discard; answer form | Intake stopped for a decision |
| Working | Free text idea | live progress and last log line | run is live |
| Needs you | Demo 104 | Resume · Open diff · Discard | last run failed |
| Ready to ship | Demo 105 | Open diff · Ship · Discard | run passed, no PR/MR |
| Shipped | Demo 106 | Open PR/MR · Open diff | PR open, CI running |
| Done | Demo 107 | Open PR/MR · Discard | PR merged |

## Run the test

The same fixture is a regression test: one item per column, with assertions for actions, notes and ship state.

```bash
cd desktop
node --test --experimental-strip-types ../ui/screens/factory/tests/demo-board.test.mjs
```

The test is [`ui/screens/factory/tests/demo-board.test.mjs`](https://github.com/dnsmalla/llm-ide/blob/main/ui/screens/factory/tests/demo-board.test.mjs).
