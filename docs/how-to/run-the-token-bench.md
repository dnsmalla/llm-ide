# Run the token bench

The token bench (`scripts/token-bench.mjs`, Phase 1 P17) measures what a fixed set
of chat turns costs in tokens and time, and fails when a scenario gets more than
15 % worse in tokens (or 30 % slower) than the committed baseline. It is an
on-demand or nightly gate, not a push gate, because a real run spends tokens.

## What it runs

`schema/bench/scenarios.json` (version 3) defines thirteen scenarios. The first seven
(version 2, unchanged, so a version-2 baseline still covers them; the file lists
`compatibleWith: [2]`) are: a greeting,
explain a file, one small edit, one plan step, a two-turn cache check, a
long-tool-results read (three ~10 KB files), and a five-turn chat that shows the
cache-read slope. Each scenario sample opens a new v2 chat. The bench reseeds its
Version 3 adds six: `repo-search` (a read-only multi-hop search, where a leaner
prompt once cost 55 % more), `auto-mode` (mode `auto`, so the mode classifier runs;
in `--fake` it is sent as `ask`, because the real classifier is a paid call),
`mode-switch` (two turns, `ask` then `execute`), `cache-slope-12` (twelve turns),
`mcp-two-servers` (two stub stdio MCP servers from
`scripts/bench-fixtures/fake-mcp-server.mjs`, registered for the bench user while the
scenario runs; the registry goes to a temp directory, never your real plugins directory)
and `ended-chat-continue` (the SDK session is deleted before turn 3 and that turn is
sent fresh with the chat's history, as the Mac does after a restart). Whether the SDK
subprocess really loads the two stub servers was not verified offline: check
`mcpServers` in a real run's `init` event before trusting that scenario.
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

Flags: `--env KEY=VAL` (repeatable, see below), `--only id,id` (run a subset; not with
`--baseline`), `--compare a.json b.json` (see below), `--model <id>` (default: the `fast` model in `schema/models/anthropic-models.json`),
`--repeat <n>` (default 3), `--baseline-file <path>`, `--out <path>` (results JSON;
default in `$TMPDIR`), `--threshold-tokens 15`, `--threshold-time 30`,
`--time-floor-ms 500`, `--threshold-hops 20` (`--compare` only), `--time-advisory`
(time is reported but never fails).

Exit codes:

- `0`: passed.
- `1`: a regression, or in a real run a tool scenario made no tool round trip.
- `2`: no baseline, a baseline that is not comparable, or an error.

A baseline is comparable only when its model, its fake flag, its scenario-set
version (or a version the scenario file lists in `compatibleWith`), its `--env`
overrides and its billing weights match the run. Anything else exits `2` with the
mismatch listed. A time regression counts only when it is also more than
`--time-floor-ms` slower, so jitter on quick turns does not fail the gate.

Ctrl-C or SIGTERM stops the child server and removes the temp directory. A stop
escalates to SIGKILL after 5 s.

## A/B a flag: `--env` and `--compare`

The committed baseline is a regression gate, not an A/B instrument. To judge one
change, run the control and the variant back to back (same model, same `--repeat`,
preferably 5, in one sitting) and compare the two results files:

```bash
node scripts/token-bench.mjs --repeat 5 --out a.json                      # control
node scripts/token-bench.mjs --repeat 5 --env LLMIDE_V2_COMPACT_PROMPT=1 --out b.json
node scripts/token-bench.mjs --compare a.json b.json
```

`--env KEY=VAL` sets one variable in the child server after the `LLMIDE_*` strip. Only
`LLMIDE_*` and `CLAUDE_CODE_*` names (upper case) are accepted. `CLAUDE_CODE_*` values
reach the SDK subprocess; `LLMIDE_*` ones are read by the server only (the SDK
subprocess drops them). Names the bench owns or that would break its isolation are
refused: the port, host, DB, agent DB, data dir, backup dir, log file, plugin dir,
secrets, remote-bind switches and `LLMIDE_BENCH_FAKE`. A run records its overrides in
the results (`env`), and a baseline made with different overrides is "not comparable"
(exit 2).

`--compare` runs no server. It prints, per scenario, billable tokens, hops, time to
first token and total time as `before -> after (delta, spread) verdict`. The spread is
the larger of the two files' sample ranges. Verdicts: `no-result` (the delta is no
larger than the spread, so noise explains it), `regression` (past a gate: tokens +15 %,
time +30 % and over the floor, hops +20 %), `worse` or `better` (a real change of at
least 5 %), `flat`. Exit 1 if any scenario shows a `regression`, 2 if the files are not
comparable (model, fake flag, scenario version or weights differ). Results files from
before this feature carry no samples; the report says "no samples" and the gate alone
decides.

Classifier and per-turn memory-extraction calls do not carry the turn's request id, so
the turn's own rows never include them. The bench counts every other ledger row of the
user written during a sample (plus a 2.5 s settle in real runs) as
`helperBillableTokens` and `helperCalls`, shown beside the billable tokens and never
added to them, so the committed baseline stays comparable.

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

Estimate, not measured. The 7 version-2 scenarios have 13 turns; version 3 has 13
scenarios and 33 turns (`--repeat 3`: 39 chats, 99 turns), roughly 2.5 times the turns
(the added turns are mostly cheap short ones, so expect 1.6 to 2.5 times the cost).
Each sample is in a new chat. Each new chat
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
