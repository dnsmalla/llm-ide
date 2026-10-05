# SDK adoption tests

Tests for Claude Agent SDK surface items the `sdk-adoption` loop marked `adopted` in `llm_agent/sdk/sdk-surface.json` live here, one `*.test.mjs` per adopted item or batch. It is the only test directory that loop's agent may write: in an SDK Adoption run the Mac app exempts `extension/tests/sdk-adopt/**` from the default protected test globs, while every other test (including `tests/sdk-surface*.test.mjs`) stays protected so the agent cannot weaken the checks that judge it. See `docs/explanation/claude-linker.md`, "Adopt".
