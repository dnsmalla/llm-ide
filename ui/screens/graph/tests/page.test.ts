import { test } from "node:test";
import assert from "node:assert/strict";
import { readGraphPage, storeGraphPage } from "../page.ts";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test("the Graph page defaults to System and round-trips Code graph", () => {
  const s = mem();
  assert.equal(readGraphPage(s as unknown as Storage), "system");
  storeGraphPage("code", s as unknown as Storage);
  assert.equal(readGraphPage(s as unknown as Storage), "code");
  storeGraphPage("system", s as unknown as Storage);
  assert.equal(readGraphPage(s as unknown as Storage), "system");
  s.setItem("llmide.graphPage", "nonsense");
  assert.equal(readGraphPage(s as unknown as Storage), "system");
});
