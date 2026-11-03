import { test } from "node:test";
import assert from "node:assert/strict";
import { addTemplate, loadTemplates, removeTemplate, saveTemplates } from "../native/prompt-templates.ts";

function storage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
}

test("named Auto Task templates round-trip, replace by name, and delete", () => {
  const s = storage();
  const a = addTemplate([], " Review ", "Check the code");
  assert.ok(a);
  assert.equal(a.saved.name, "Review");
  saveTemplates(a.list, s);
  assert.deepEqual(loadTemplates(s), a.list);
  const b = addTemplate(a.list, "review", "Check the code again");
  assert.ok(b);
  assert.equal(b.list.length, 1);
  assert.equal(b.list[0]?.prompt, "Check the code again");
  assert.deepEqual(removeTemplate(b.list, b.saved.id), []);
});

test("blank names/prompts and malformed storage are refused", () => {
  assert.equal(addTemplate([], "", "x"), null);
  assert.equal(addTemplate([], "x", "   "), null);
  const bad = { getItem: () => "{not json", setItem: () => undefined };
  assert.deepEqual(loadTemplates(bad), []);
});
