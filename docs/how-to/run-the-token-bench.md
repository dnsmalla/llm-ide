# Run the token bench

The token bench (`scripts/token-bench.mjs`, Phase 1 P17) measures what a fixed set
of chat turns costs in tokens and time, and fails when a scenario gets more than
15 % worse in tokens (or 30 % slower) than the committed baseline. It is an
on-demand or nightly gate, not a push gate, because a real run spends tokens.

## What it runs

`schema/bench/scenarios.json` (version 2) defines seven scenarios: a greeting,
explain a file, one small edit, one plan step, a two-turn cache check, a
long-tool-results read (three ~10 KB files), and a five-turn chat that shows the
cache-read slope. Each scenario sample opens a new v2 chat. The bench reseeds its
temp workspace before every sample. It runs each scenario `--repeat` times (default
3) and compares medians.

The bench starts its own `extension/server.mjs` on a free port with a temp
database under `$TMPDIR`, so it never touches `kb/data.db` or port 3456. It
registers a throwaway user and removes the temp directory when it finishes. It
waits out the server's per-user turn limiter (HTTP 429) and retries.

For each turn it meters the turn's own usage rows (the main `/agent/v2/stream` row
and any `:internal` helper-model rows) through its turn-composition row. Per
scenario it reports billable tokens (input + output + 0.1 x cache read + 1.25 x
cache write), the raw counts, hops (API calls), time to first token, total time,
and the context split of the last turn. Per-turn detail goes into the results
JSON.

## Commands

```bash
make token-bench                          # REAL run; compares with schema/bench/token-baseline.json
node scripts/token-bench.mjs --baseline   # REAL run; writes the baseline (commit it deliberately)
make token-bench-fake                     # no model calls; the whole pipeline on a fake engine
```

Flags: `--model <id>` (default: the `fast` model in `schema/models/anthropic-models.json`),
`--repeat <n>` (default 3), `--baseline-file <path>`, `--out <path>` (results JSON;
default in `$TMPDIR`), `--threshold-tokens 15`, `--threshold-time 30`,
`--time-floor-ms 500`, `--time-advisory` (time is reported but never fails).

Exit codes:

- `0`: passed.
- `1`: a regression, or in a real run a tool scenario made no tool round trip.
- `2`: no baseline, a baseline that is not comparable, or an error.

A baseline is comparable only when its model, its fake flag, its scenario-set
version and its billing weights match the run. Anything else exits `2` with the
mismatch listed. A time regression counts only when it is also more than
`--time-floor-ms` slower, so jitter on quick turns does not fail the gate.

Ctrl-C or SIGTERM stops the child server and removes the temp directory. A stop
escalates to SIGKILL after 5 s.

## Environment isolation

The child server inherits your environment minus every `LLMIDE_*` variable; the
bench sets only its own. `HOME` is kept on purpose: the Claude CLI finds its login
through `HOME` (on macOS, the login keychain under `~/Library`), so a temporary
`HOME` would break authentication. `CLAUDE_CONFIG_DIR` is also left alone for the
same reason. Baselines are therefore **machine- and account-dependent**: commit a
baseline only from the machine and account that will run the gate.

## Fake mode

`--fake` starts the server with `LLMIDE_BENCH_FAKE=1` and the `--bench-fake` flag.
Both are required, and the server refuses the switch under `NODE_ENV=production`.
The server prints a loud banner to stderr while the switch is active. The Mac app
never passes the flag and strips `LLMIDE_BENCH_FAKE` from its child environment.
With the switch on, each turn goes to `extension/llm_agent/sdk/bench-fake-engine.mjs`,
which makes no model call and does not load the SDK. The numbers are synthetic and
deterministic, and the fake makes one API call per turn. So fake mode checks the
plumbing and the comparison logic only. The three tool scenarios warn in fake mode
and fail in a real run. `--baseline` refuses to run with `--fake`.

## Cost of a real run

Estimate, not measured. Per run there are 13 turns in 7 scenarios, each sample in
a new chat, and `--repeat 3` makes 21 chats and 39 turns in all. Each new chat
writes the prompt prefix to the cache once, roughly 35k tokens going by the
2026-09 measurement of a "hello" turn, at the cache-write rate. Tool turns add
hops that re-read the transcript from cache and carry about 10 KB per seed file.
That comes to roughly 1.2 to 2 M billable tokens per run on the cheapest model.
Read the dollar figure off the current rate card. Measure the first real run before
relying on this number. With `--repeat 1` the cost is about a third of that.

## Establishing the first baseline

The baseline is a decision, so it is not committed yet. Run `make token-bench` on
the machine and account you want to track, check the table, then run
`node scripts/token-bench.mjs --baseline` and commit `schema/bench/token-baseline.json`.
After any deliberate prompt, seed or scenario change, bump the scenario `version`
and re-baseline in the same commit.
