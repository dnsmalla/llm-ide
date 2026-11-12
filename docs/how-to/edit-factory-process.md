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

## The default process

A new project, or one whose Factory loop was never edited, starts with:

Set up → Plan → Implement → Structure verify → Verify → Test gaps → Doc review → Review → Review gate

- **Structure verify** checks the code without running it: `npm run lint` when `package.json` has a lint script, else
  `npx tsc --noEmit` when there is a `tsconfig.json`, else `ruff check .` when Ruff is configured. It blocks the run.
  When nothing is detected it stays off; give it a `command` (or keep `"auto"` and add a lint script) to turn it on.
- **Test gaps** adds tests for behaviour the run changed and has none; **Doc review** updates the documentation of that
  behaviour. Both are advisory: a failure is reported and the MR still opens.
- Implement and Test gaps (`skills/test-gap-writer`) may write test files; every other step that writes a test or
  build-config file is reverted and stops the run. CI and hook files are protected for every step. Custom skill steps
  never write under `.factory/`.
- There is no Intake step: the issue is expected to be prepared already, and the person reviews at the MR. **Run
  intake** on a card says so instead of running.

### Add Intake back

Put these two steps first (before `plan`):

```json
{ "role": "intake" },
{ "role": "intakeGate" },
```

Intake then writes `.factory/READINESS.md`, and the Intake gate stops a run that is not ready for a decision.

## Format

```json
{
  "version": 1,
  "budget": { "maxIterations": 10, "maxCostUsd": 10, "wallClockMinutes": 120 },
  "stages": [
    { "role": "setup", "command": "npm ci" },
    { "role": "plan" },
    { "role": "implement", "prompt": "Keep the change small and add a test." },
    { "role": "custom", "name": "Structure verify", "kind": "shellCommand", "command": "auto" },
    { "role": "verify", "command": "auto" },
    { "role": "custom", "name": "Test gaps", "kind": "skill", "skill": "test-gap-writer", "severity": "advisory" },
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

- `shellCommand` runs `command`; `"auto"` means the detected structure check (lint, TypeScript or Ruff), and the step
  stays off while none is detected.
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
- A custom `skill` step cannot sit between `review` and `reviewGate`: the gate reads Review's report, and an agent step
  in between could change it. A shell or verdict check there is fine.
- Unknown keys are errors. Budgets: `maxIterations` 1–50, `maxCostUsd` 0–1000 (0 = no limit), `wallClockMinutes`
  1–1440; `timeoutMinutes` 1–240.

The full format is `schema/factory/template.v1.schema.json`; the app's validator is authoritative.

## First run after the switch

The first Factory run in a project without the file writes it from the project's current Factory loop. When a setting
of that loop cannot be written in the template, for example a step of another kind or an advisory Review, the file is
written anyway and that run stops, listing each step and why. Review the file under **Factory → Process**, then run
again; the next run uses the file.

## Which steps a re-run uses

A full run, and a restart after a rejected MR, run every step. **Send back** runs Implement, Verify, Review and the
Review gate; **Finish checks** runs Verify, Review and the Review gate. Both also keep your blocking custom checks
(shell and verdict steps such as Structure verify) and skip custom skill steps such as Test gaps and Doc review.

## Errors

The Process tab checks the file as you type. Each problem shows its line, for example
`Line 12 stages[4].role unknown role "implemnt"`, and clicking it moves the cursor there. **Save** stays disabled until
there are no problems.

A file edited outside the app is checked again when a run starts. A file with problems stops the run before anything
happens, and the card says which lines to fix.

## Reset to default

**Reset to default…** shows what would change (lines marked − go, + come in) and then puts the default process in the
editor. Nothing is written until you press **Save**.
