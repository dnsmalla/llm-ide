// Time-bomb detector: preload with NODE_OPTIONS="--import ./tests/support/clock-shift.mjs" and
// LLMIDE_TEST_CLOCK_SHIFT_DAYS=N to run any test with the real clock shifted N days (negative = past).
// Date.now()/new Date() move; explicit dates and injected `now` values do not, so a test that mixes a
// fixed date with real-clock logic fails under a shift. Not loaded by default (see tests/README.md).
const days = Number(process.env.LLMIDE_TEST_CLOCK_SHIFT_DAYS || 0);
if (Number.isFinite(days) && days !== 0) {
  const shift = days * 86_400_000;
  const Real = Date;
  const realNow = Real.now.bind(Real);
  class ShiftedDate extends Real {
    constructor(...a) { if (a.length === 0) super(realNow() + shift); else super(...a); }
    static now() { return realNow() + shift; }
  }
  globalThis.Date = ShiftedDate;
}
