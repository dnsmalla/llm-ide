import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../shell/tests/helpers.mjs";

const m = await load("../chat/BudgetMeter.tsx");
const budget = (used, limit, level = "ok") => ({ used, limit, remaining: Math.max(0, limit - used), level });

test("budget label clamps and reports the percentage", () => {
  assert.equal(m.budgetLabel(budget(0, 1000)), "0% budget");
  assert.equal(m.budgetLabel(budget(420, 1000)), "42% budget");
  assert.equal(m.budgetLabel(budget(1200, 1000, "exceeded")), "100% budget");
  assert.equal(m.budgetLabel(budget(5, 0)), "0% budget");
});
