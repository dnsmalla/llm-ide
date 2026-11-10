import { test } from "node:test";
import assert from "node:assert/strict";
import { taskPromptWithFocus } from "../../tasks/model.ts";
import { loadTaskState } from "../../tasks/store.ts";

function mem(initial) { const map = new Map(initial ? [["llmide.autoTasks.v1", initial]] : []); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; }

test("a stored copy of the retired Review Code default is not an override", () => {
  const retired = "Review the recent commits in this repository for bugs, security issues, and code style problems. This is a READ-ONLY review: do NOT edit, create, or delete any files, and do NOT commit or push. Print your findings as a summary to your output.";
  const stored = JSON.stringify({ masterEnabled: true, configs: { reviewCode: { enabled: true, prompt: retired } } });
  const s = loadTaskState("/p/a", mem(stored));
  assert.equal(s.configs["review.code"].promptOverride, null);
});

test("a user's focus edit replaces only the focus sentence and keeps the READ-ONLY frame", () => {
  const text = taskPromptWithFocus("review.code", "Check the payment code only.");
  assert.match(text, /READ-ONLY review/);
  assert.match(text, /Check the payment code only\./);
  assert.doesNotMatch(text, /most recent changes/);
});
