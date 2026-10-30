# Your checklist: bench runs and manual app checks

Written 2026-10-30, after the end-to-end build of live-then-archive and agent-kit K1 (Phases 0-7). Everything below needs you (a real login, a real app, real money or plan limits). Nothing here is run by the agents.

## A. Bench plan (token-affecting changes are OFF until you decide)

Run from the repo root (`/Users/dinsmallade/llm-ide`) in a normal terminal (not the Claude sandbox). Authentication uses your `claude` CLI login through `HOME`; baselines are machine- and account-dependent, so use the Mac and account you will actually use. With the CLI login there is no per-token bill, but runs count against your plan's usage limits. Full reference: `docs/how-to/run-the-token-bench.md`.

1. **Plumbing check, free** (no model calls): `make token-bench-fake`
2. **Cheap real sanity run** (about a third of a full run's cost per repeat; use `--repeat 1`):
   `node scripts/token-bench.mjs --only greeting,repo-search,auto-mode --repeat 1`
   Check: tokens are plausible, tools made round trips, `mcp-two-servers` (if you add it) shows both stub servers in the `init` event.
3. **Baselines** (one real run each; commit deliberately; the script overwrites the file):
   - Fast model: `node scripts/token-bench.mjs --baseline` then commit `schema/bench/token-baseline.json`
   - Sonnet-class: `node scripts/token-bench.mjs --baseline --model <id from schema/models/anthropic-models.json> --baseline-file schema/bench/token-baseline-sonnet.json`
4. **Noise check:** run the same scenario set twice, `--repeat 5 --out a.json` and `--out b.json`, then `node scripts/token-bench.mjs --compare a.json b.json`. Expect `no-result` or `flat`; a real difference here means the bench is too noisy to judge changes.
5. **A/B each token-affecting switch** (control then variant, same model, same `--repeat 5`, same sitting):
   ```bash
   node scripts/token-bench.mjs --repeat 5 --out a.json
   node scripts/token-bench.mjs --repeat 5 --env LLMIDE_V2_COMPACT_PROMPT=1 --out b.json
   node scripts/token-bench.mjs --compare a.json b.json
   ```
   Keep a change only if tokens or time improve beyond the spread and nothing regresses past the gate (+15% tokens, +30% time, +20% hops). Especially watch `repo-search` for the compact prompt (it once cost +55%).
   Switches that exist today: `LLMIDE_V2_COMPACT_PROMPT=1`, `LLMIDE_V2_AUTOCOMPACT_WINDOW=<n>`, `LLMIDE_ROUTER=on`, `LLMIDE_ROUTER_CAP=on`, `LLMIDE_ROUTER_COMPRESS=on`, `LLMIDE_ROUTER_LEARN=on`, `LLMIDE_V2_ADOPT_FALLBACK_MODEL=1`. The lean-configuration switches (drop Bash in execute, git instructions, cache TTL, tool search) are built in the next phase (roadmap X1) and added to this list then.
6. **Router scenarios** (compression, handoff, cap):
   `node scripts/token-bench.mjs --only switch-handoff --env LLMIDE_ROUTER=on`
   `node scripts/token-bench.mjs --only capped-session --env LLMIDE_ROUTER=on --env LLMIDE_ROUTER_CAP=on`
   `node scripts/token-bench.mjs --only compress-long-tools --env LLMIDE_ROUTER=on --env LLMIDE_ROUTER_COMPRESS=on`
7. Send me the result JSON paths or the `--compare` output; I decide defaults only on measured deltas and flip a switch to on-by-default in its own reviewed commit.

Cost note: the repo has no measured dollar cost. The how-to's estimate is 1.2 to 2 M billable tokens per full run on the cheapest model at `--repeat 3`, 1.6 to 2.5 times that for the 33-turn scenario set. Measure the first run before relying on it.

## B. Manual app checks (about 30 minutes)

Before you start: quit any server on port 3456 (`lsof -nP -iTCP:3456 -sTCP:LISTEN`, then `kill <pid>`), then `open /Users/dinsmallade/llm-ide/mac/LlmIdeMac.app`. Your data is already in `~/Library/Application Support/llm-ide/system/`. Safe mode: `defaults write com.llmide.macapp lta.mode shadow` (or the Settings → Agent history control).

1. **Basics:** meetings list, chats, settings, the OS page, the Storage hub, Settings → Agent history all load.
2. **Providers (Settings):** your DeepSeek key appears as a connection (migrated from the built-in key; the old key is kept). Press Test; the model list loads.
3. **DeepSeek chat:** in a chat, open the model picker; DeepSeek models show a "tools" badge or not. If the router is off you see "Turn on the session router (applies at next backend start)": press it, restart the app, pick a DeepSeek model, send a plain message in Ask mode. Tools stay off until you press "Allow tools on provider models".
4. **Chat cap control:** the header chip opens a popover: set a small limit, send messages until it stops with "limit reached" and a one-click raise; raise and continue. Quit and reopen the chat: the cap and used count are kept.
5. **Plugin / MCP / LLM-source screens:** the Library sidebar sections (plugins, LLM sources, MCP) open as before; add/remove dialogs work; the refresh button reloads everything.
6. **Quit-and-relaunch (needs `lta.mode` = On in Settings → Agent history, restart once):**
   1. Make about 20 chats with at least one turn each, a couple on Agent v2, and one chat in the Chrome extension; leave one chat mid-turn.
   2. Cmd-Q: it closes within about 6 seconds; the unsaved-drafts dialog still comes first if you have edits.
   3. Relaunch, wait about 10 seconds: every chat opens with full history; the extension chat appears as an archived quick chat.
   4. Delete a chat with the backend stopped, quit, relaunch: it stays deleted.
   5. Sign out and sign in as another user (if you have one): the first user's chats are hidden; sign back in and they return. A "Claim older chats" button appears only if you have chats from before this version.
   6. Force-quit during a quit (Activity Monitor), relaunch: nothing lost; with the backend stopped before relaunch the start sweep retries until it comes up.
   7. Settings → Agent history shows no conflicts or incomplete archives (or lists them with "Archive as is" / "Keep on server").
7. **Extension:** the side-panel chat works as a live client ("Mac app not running" appears when the app is closed); nothing is stored locally; an old extension build shows the "update the app/extension" 410 message.

Tell me which steps fail, or "all fine". Any problem: switch back to `lta.mode` Shadow (nothing is deleted in shadow).

## C. Decisions still open (see docs/superpowers/ROADMAP.md, "Waiting on you")

Q19 (notes without `platform` are invisible in Library), Q16 (search latency at 50k notes), knowledge-kit Q1-Q14 (unanswered), ledger step B go/no-go. Meeting work waits until you use meetings.
