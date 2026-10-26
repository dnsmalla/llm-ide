# Run the token bench

The token bench (`scripts/token-bench.mjs`, Phase 1 P17) measures what a fixed set
of chat turns costs in tokens and time, and fails when a scenario gets more than
15 % worse than the committed baseline. It is an on-demand or nightly gate, not a
push gate, because a real run spends tokens.

## What it runs

`schema/bench/scenarios.json` defines the scenarios: a greeting, explain one file,
one small edit, one plan step, and a two-turn scenario that checks cache reuse.
Each scenario opens a new v2 chat. The bench starts its own
`extension/server.mjs` on a free port with a temp database under `$TMPDIR`, so it
never touches `kb/data.db` or port 3456. It registers a throwaway user and removes
the temp directory when it finishes.

Per scenario it reports billable tokens (input + output + 0.1 x cache read +
1.25 x cache write), the raw counts, turns, hops, time to first token, total time,
and the context split of the last turn.

## Commands

```bash
make token-bench                     # REAL run; compares with schema/bench/token-baseline.json
node scripts/token-bench.mjs --baseline   # REAL run; writes the baseline (commit it deliberately)
make token-bench-fake                # no model calls; the whole pipeline on a fake engine
```

Flags: `--model <id>` (default: the `fast` model in `schema/models/anthropic-models.json`),
`--baseline-file <path>`, `--out <path>` (results JSON; default in `$TMPDIR`),
`--threshold-tokens 15`, `--threshold-time 15`, `--time-floor-ms 500`.

Exit codes: `0` passed, `1` a scenario regressed, `2` no baseline or an error.
A time regression counts only when it is also more than `--time-floor-ms` slower,
so sub-second jitter on quick turns does not fail the gate.

## Fake mode

`--fake` starts the server with `LLMIDE_BENCH_FAKE=1`. That makes the v2 route
hand each turn to `extension/llm_agent/sdk/bench-fake-engine.mjs`, which makes no
model call and does not load the Agent SDK. The numbers are synthetic and
deterministic, so fake mode checks the plumbing and the comparison logic only. It
is refused under `NODE_ENV=production`, and `--baseline` refuses to run with
`--fake`.

## Cost of a real run

Estimate, not measured: seven short turns on the cheapest model. Each new chat
writes the prompt prefix to the cache once, roughly 35k tokens going by the
2026-09 measurement of a "hello" turn. The rest is small. That comes to a few
hundred thousand raw tokens, or about 0.3 M billable tokens, which is well under
a dollar at Haiku list prices. Measure the first real run before relying on this
number.

## Establishing the first baseline

The baseline is a decision, so it is not committed yet. Run `make token-bench` on
the machine and account you want to track, check the table, then run
`node scripts/token-bench.mjs --baseline` and commit `schema/bench/token-baseline.json`.
After any deliberate prompt change, re-baseline in the same commit.
