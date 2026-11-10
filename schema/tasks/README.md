# Task registry

The one catalog for work that Auto Tasks, Loop, Factory and the review surfaces can run. A task id is
stable; a label is copy. A task has exactly one runner kind:

- `agent` — a prompt in `prompts/<id>.md`, sent through the confined Loop agent.
- `shell` — one Loop stage (a host command or the deterministic regression sweep).
- `core-route` — a fixed core adapter (source sync, outcomes refresh, issue extraction).
- `desktop-action` — a host/Factory/Ship action the Node core cannot run.

`registry.json` holds `{ version, tasks }`; `templates.json` holds `starters` (the six Mac starter loops, verbatim)
and `templates` (the built-in recipes: sparse `stages`, or `configFrom` a starter). Stages reference task ids or a
raw shell/check stage; the generator fills the Loop's default fields. A prompt exists only for an `agent` runner and only under
`prompts/`. A `retired` or `alias` task has no runner; its aliases keep stored history readable.

## Editing

1. Add or change the task in `registry.json`.
2. For an `agent` task, add `prompts/<id>.md`.
3. Regenerate and check:

```bash
node scripts/gen-task-registry.mjs
node scripts/conformance-tasks.mjs
```

The generated files are checked in:

- `ui/screens/tasks/registry.generated.ts`, `ui/screens/tasks/prompts.generated.ts`
- `extension/core/task-registry.generated.mjs`, `extension/core/task-prompts.generated.mjs`

Never hand-edit a generated file. `node scripts/gen-task-registry.mjs --check` fails when one is stale;
`node scripts/conformance-tasks.mjs` also validates aliases, prompt hashes, bus mappings, feature keys,
template references and the `cd mac` guard. `make contract-gates` runs the conformance gate.

## Availability

`availability.status` is `available`, `unported`, `retired` or `alias`. An `unported` task names the
missing capability, never "Mac app". `ui/screens/tasks/model.ts` is the only place that turns the
registry plus the environment (features, repo, host, remote mode) into a runnable decision.
