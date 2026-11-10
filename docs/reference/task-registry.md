# Task registry

`schema/tasks/registry.json` is the one place a task's id, label, prompt reference, runner, read-only policy,
schedule policy and feature gate are written down. Auto Tasks, Loop, Factory, Ship and the review screens read the
generated copies; none of them keeps its own task table.

Schema and rules: `schema/tasks/README.md` (the authoring guide). This page is the reference: what the parts mean and
what is still a known limit.

## Shape of a task

| Field | Meaning |
|---|---|
| `id` | Stable identifier (`review.code`, `loop.regression`). Stored history and the bus use it. |
| `label` | Copy only; a label may change without breaking history. |
| `runner.kind` | `agent` (prompt sent through the confined Loop agent), `shell`, `core-route`, or `desktop-action`. Exactly one. |
| `runner.prompt` | Only for `agent`: `prompts/<id>.md`. Other kinds have no prompt. |
| `availability` | `available`, `unported` (names the missing capability), `retired` (no runner) or `alias` (points at `aliasOf`). |
| `aliases` | Old names that still resolve, so stored runs and config keep working. |
| `schedule` | `backend` (`desktop`, `bus`, or `none`), and `schedulable`. |
| `readOnly`, `requiresRepo`, `requiresLocalHost`, `features` | The gates the one availability function applies. |
| `revision` | Bumped when the prompt text changes; Loop stages show it. |

## Generation and checks

```bash
node scripts/gen-task-registry.mjs            # regenerate the checked-in copies
node scripts/gen-task-registry.mjs --check    # fails when a generated file was hand-edited or is stale
node scripts/conformance-tasks.mjs            # aliases, prompt hashes, bus mappings, feature keys, template refs
```

The generated files are `ui/screens/tasks/registry.generated.ts`, `ui/screens/tasks/prompts.generated.ts`,
`extension/core/task-registry.generated.mjs`, `extension/core/task-prompts.generated.mjs`, and the Loop's
`ui/screens/loop/native/templates.generated.ts` and `defaults.generated.ts`. Never edit them by hand.
`make contract-gates` runs the conformance gate.

## No prompt outside `schema/tasks/prompts`

A task prompt lives once, in `schema/tasks/prompts/`. No other source file may repeat the first 40 characters of
one. `ui/screens/tasks/tests/no-duplicates.test.mjs` enforces this for `ui/screens` and `extension/routes`. Excluded
on purpose: generated modules (`*.generated.*`) and `tests/fixtures/` directories, which carry prompt text by design.
`conformance-tasks.mjs` also fails when two prompt files have the same text.

The Factory stage prompts are read from the registry too, but the Factory recipe itself is still built in
`ui/screens/loop/native/factory.ts` and appended in `templates.ts`. That is by design.

## Aliases and retired tasks

- `resolveTaskId` follows one `aliasOf` hop at most. An alias never chains to another alias.
- Retired tasks (`knowledge.update`, `docs.generate`) have no runner and no prompt. They stay in the registry so old
  history keeps its label. Pickers list only available and unported tasks.
- `issues.update` (alias of `issues.from_notes`, formerly Update Issues) resolves to Sources → Issue.
- Ledger suffixes in the usage ledger map through the same registry (`scripts/auto-task-usage.mjs`, tested by
  `extension/tests/auto-task-usage.test.mjs`).

## Scheduling and the D17 rule

- A task with `schedule.backend: "none"` (it writes a tracker or code) is never scheduled. It runs only when a person
  presses Run. The schedule status line says "Manual only".
- Built-in schedules are per project and fire from the one desktop scheduler while the app is open. A missed slot is
  not backfilled.
- A migrated schedule of a task whose runner changed starts switched off (`scheduleActive: false`).

## Known limits

- **Factory stages carry no `promptRef`.** A registry prompt change does not reach an existing Factory loop. New
  Factory loops read the current prompt.
- **`loop.refactor_apply` and `loop.refactor_conform` are registered `available`.** The Loop still refuses an enabled
  batch stage, because batch rollback is not ported to the desktop. The registry should mark them `unported` with that
  reason; until it does, the gate lives in `ui/screens/loop/native/store.ts` (`batchRollbackReason`).
- **`loopEngineering` has no registry entry.** The Loop screen owns that run; the usage ledger reports it under its
  legacy name.
- **The Loop's own schedule is a second scheduler.** Loop stages schedule from the Loop page and fire only while it is
  open. Moving them to the task scheduler is a separate design decision.
- **Custom Implement mode still says "Mac app only"** (`ui/screens/autotasks/native/custom.ts`). Custom tasks are
  not registry tasks.
