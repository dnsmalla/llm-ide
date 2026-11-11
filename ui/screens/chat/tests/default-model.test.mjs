import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../shell/tests/helpers.mjs";

const { defaultModelForMode } = await load("../chat/route.ts");
const groups = [{ id: "g", label: "G", catalog: false, models: [
  { provider: "p", model: "gpt-5", label: "GPT-5" },
  { provider: "p", model: "haiku-4", label: "Haiku" },
] }];

test("Ask/Document/Review prefer a cheap model; Plan/Execute prefer the strong one", () => {
  assert.equal(defaultModelForMode(groups, "ask")?.model, "haiku-4");
  assert.equal(defaultModelForMode(groups, "document")?.model, "haiku-4");
  assert.equal(defaultModelForMode(groups, "review")?.model, "haiku-4");
  assert.equal(defaultModelForMode(groups, "plan")?.model, "gpt-5");
  assert.equal(defaultModelForMode(groups, "execute")?.model, "gpt-5");
  assert.equal(defaultModelForMode(groups, "auto")?.model, "gpt-5");
});

test("no models returns null; no name hint returns the provider's first", () => {
  assert.equal(defaultModelForMode([], "ask"), null);
  const plain = [{ id: "g", label: "G", catalog: false, models: [{ provider: "p", model: "x", label: "X" }] }];
  assert.equal(defaultModelForMode(plain, "ask")?.model, "x");
});
