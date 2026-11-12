---
title: Edit the Factory process
applies_to: desktop
---

# Edit the Factory process

## Goal

Change the steps a Factory run goes through for one project, without the risk of a typo silently changing what runs.

## Where the process lives

Each project keeps its Factory process in `system/factory-template.json`, next to `system/loop.json`. Open it in the
desktop app under **Factory → Process**. A project that has none gets it written from its current Factory loop the
first time the Factory runs or the Process tab opens.

The template is the source of truth. At the start of every Factory run its steps replace the Factory loop's steps in
`system/loop.json`, so edits made to the Factory loop on the Loop page are replaced at the next run.

## Format

```json
{
  "version": 1,
  "budget": { "maxIterations": 10, "maxCostUsd": 10, "wallClockMinutes": 120 },
  "stages": [
    { "role": "setup", "command": "npm ci" },
    { "role": "intake" },
    { "role": "intakeGate" },
    { "role": "plan" },
    { "role": "implement", "prompt": "Keep the change small and add a test." },
    { "role": "verify", "command": "auto" },
    { "role": "custom", "name": "Lint", "kind": "shellCommand", "command": "npm run lint", "severity": "advisory" },
    { "role": "review" },
    { "role": "reviewGate" }
  ]
}
```

| Role | What it is | You can change |
|------|------------|----------------|
| `setup` | Installs dependencies once per run | `command`, `name`, `enabled`, `severity`, `timeoutMinutes` |
| `intake`, `plan` | The Factory's own skill steps | `prompt`, `name`, `enabled`, `severity`, `timeoutMinutes` |
| `implement`, `review` | The Factory's own skill steps | `prompt`, `name`, `timeoutMinutes` |
| `intakeGate` | Reads the verdict Intake wrote | `name`, `enabled`, `severity`, `timeoutMinutes` |
| `verify`, `reviewGate` | Run the tests (`"auto"` = the detected test command) / read Review's verdict | `name`, `timeoutMinutes`; verify also `command` |
| `custom` | Your own step; see below | `name`, `enabled`, `severity`, `timeoutMinutes` and the fields of its kind |

A `custom` step has a `kind`:

- `shellCommand` runs `command`.
- `skill` runs `skill` (`doc-writer` or `skills/doc-writer`) with an optional `prompt`.
- `artifactCheck` passes when the file `verdictPath` (under `.factory/`, for example `.factory/LINT.md`) contains the
  line `verdictLine`, for example `Verdict: clean`. An earlier step writes that file. `.factory/READINESS.md` and
  `.factory/REVIEW.md` belong to the Factory's own gates.

`severity` is `blocking` (the default: a failure stops the run) or `advisory` (a failure is reported, the run goes on).

The built-in steps keep their fixed skill, verdict file and repair rules, so the Factory always recognises them.

A built-in step without `prompt` follows the built-in prompt, including its later updates. Once you set `prompt`, the
step keeps your text and no longer gets those updates; delete the `prompt` key to follow the default again.

## Rules

- `implement`, `verify`, `review` and `reviewGate` are required, appear once each, in that order, and cannot be turned
  off or made `advisory`. `reviewGate` is the last step.
- `setup`, `intake`, `intakeGate` and `plan` appear at most once; `intakeGate` needs `intake` before it.
- Step names are unique. A step without `name` uses the built-in name.
- Unknown keys are errors. Budgets: `maxIterations` 1–50, `maxCostUsd` 0–1000 (0 = no limit), `wallClockMinutes`
  1–1440; `timeoutMinutes` 1–240.

The full format is `schema/factory/template.v1.schema.json`; the app's validator is authoritative.

## First run after the switch

The first Factory run in a project without the file writes it from the project's current Factory loop. When a setting
of that loop cannot be written in the template, for example a step of another kind or an advisory Review, the file is
written anyway and that run stops, listing each step and why. Review the file under **Factory → Process**, then run
again; the next run uses the file.

## Errors

The Process tab checks the file as you type. Each problem shows its line, for example
`Line 12 stages[4].role unknown role "implemnt"`, and clicking it moves the cursor there. **Save** stays disabled until
there are no problems.

A file edited outside the app is checked again when a run starts. A file with problems stops the run before anything
happens, and the card says which lines to fix.

## Reset to default

**Reset to default…** shows what would change (lines marked − go, + come in) and then puts the default process in the
editor. Nothing is written until you press **Save**.
