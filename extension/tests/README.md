# Extension tests

Run: `cd extension && npm test` (or `node --experimental-strip-types --test tests/<file>`).

## Clock rule (no time bombs)

- Never mix a hard-coded date/timestamp with real-clock logic (`Date.now()`, `new Date()`, TTL/throttle/expiry
  windows). Either inject the clock end to end (`now` option; production code must use that one `now` for every
  freshness, TTL, throttle and stamp comparison) or derive the test's clock from `Date.now()` at runtime.
- Fixed dates are fine when they are only data (ordering, formatting) or when every consumer receives an injected `now`.
- Detector: `LLMIDE_TEST_CLOCK_SHIFT_DAYS=400 NODE_OPTIONS="--import $PWD/tests/support/clock-shift.mjs" npm test`
  shifts `Date.now()`/`new Date()` (negative = past). Expect noise: tests that compare JS time to SQLite
  `datetime('now')` or file mtimes, and the live HTTP contract test (child server is not shifted), fail by construction.
  Compare the failing-file set against a second shift (e.g. 2000) to spot real fixed-date dependence.
- `tests/clock-discipline.test.mjs` guards the known case (`extensions-index`).
