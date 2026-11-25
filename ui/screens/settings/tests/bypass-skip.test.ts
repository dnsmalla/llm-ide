import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBypassSkip, BYPASS_SKIP_TEXT } from "../bypass-skip-model.ts";

test("the switch is labelled and the hint names the risk", () => {
  assert.equal(BYPASS_SKIP_TEXT.label, "Don't ask before Bypass");
  assert.match(BYPASS_SKIP_TEXT.hint, /change or delete files/);
  assert.match(BYPASS_SKIP_TEXT.hint, /Off by default/);
});

test("a declined host dialog keeps the switch off", async () => {
  const asked: boolean[] = [];
  const host = { setBypassSkipConfirm: async (on: boolean) => { asked.push(on); return false; } };
  assert.deepEqual(await applyBypassSkip(host, true, false), { value: false, error: null });
  assert.deepEqual(asked, [true]);
});

test("an accepted dialog shows on, and turning off shows off", async () => {
  assert.equal((await applyBypassSkip({ setBypassSkipConfirm: async () => true }, true, false)).value, true);
  assert.equal((await applyBypassSkip({ setBypassSkipConfirm: async () => false }, false, true)).value, false);
});

test("a host failure shows what the host holds, not what was asked for", async () => {
  const host = { setBypassSkipConfirm: async () => { throw { code: "declined_too_many", message: "Declined too many times; restart LLM-IDE to ask again." }; }, getBypassSkipConfirm: async () => false };
  assert.deepEqual(await applyBypassSkip(host, true, false), { value: false, error: "Declined too many times; restart LLM-IDE to ask again." });
  assert.equal((await applyBypassSkip({ setBypassSkipConfirm: async () => { throw new Error("x"); } }, true, false)).value, false);
});

test("without a host command nothing changes", async () => {
  assert.deepEqual(await applyBypassSkip({}, true, false), { value: false, error: null });
});
