// A new template never writes into a folder that already holds one (the core's PUT would replace it). Editing keeps
// its own folder and is not blocked by this rule. Imported files take the same path as typed templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocGenStore, type StoreDeps } from "../store.ts";
import type { DocTemplate } from "../model.ts";
import { MemFs, readersFrom } from "./fakes.ts";

const t = (name: string, folder = name.toLowerCase()): DocTemplate => ({ id: `id-${folder}`, name, sections: ["A"], rawContent: "", isBuiltin: false, folderName: folder, isProjectTemplate: true, surface: "doc" });

function make(existing: DocTemplate[]) {
  const puts: string[] = [];
  const api = {
    async register() {},
    async templates() { return { items: existing, truncated: false }; },
    async commands() { return { items: [], truncated: false }; },
    async seed() { return { written: 0 }; },
    async putTemplate(folder: string, x: { name: string; sections: string[]; surface: "doc" | "visual" }) { puts.push(folder); return { ...t(x.name, folder), sections: x.sections }; },
    async deleteTemplate() { return true; },
    async generate() { throw new Error("unused"); },
  };
  const deps: StoreDeps = { surface: "doc", makeApi: () => api as never, run: { readers: readersFrom({}), fs: new MemFs() }, idFor: async () => "p1" };
  const store = new DocGenStore(deps);
  return { store, puts };
}

test("a new template whose folder already exists is refused with a clear message and nothing is written", async () => {
  const d = make([t("Retro")]);
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "Retro", sections: ["Wins"] });
  assert.equal(out, null);
  assert.deepEqual(d.puts, []);
  const err = d.store.getSnapshot().templateError;
  assert.ok(err);
  assert.match(err!.message, /already uses templates\/retro/);
  assert.match(err!.message, /Choose another name/);
  assert.equal(d.store.getSnapshot().templateBusy, false);
});

test("an imported Markdown template with a taken name is refused the same way", async () => {
  const d = make([t("Weekly review", "weekly-review")]);
  await d.store.setProject("/proj");
  assert.equal(await d.store.saveTemplate({ folder: null, name: "Weekly review", sections: ["One"] }), null);
  assert.deepEqual(d.puts, []);
});

test("a new template with a free name is created in its own folder", async () => {
  const d = make([t("Retro")]);
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "Sprint Notes", sections: ["Goals"] });
  assert.ok(out);
  assert.deepEqual(d.puts, ["sprint-notes"]);
  assert.equal(d.store.getSnapshot().templateError, null);
});

test("editing keeps its folder: the existing folder is not treated as a clash", async () => {
  const d = make([t("Retro")]);
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: "retro", name: "Retro", sections: ["Wins", "Risks"] });
  assert.ok(out);
  assert.deepEqual(d.puts, ["retro"]);
});

test("a clash that differs only by case is refused too (the core writes into the existing folder case-insensitively)", async () => {
  const d = make([t("Weekly Report", "Weekly-Report")]);
  await d.store.setProject("/proj");
  assert.equal(await d.store.saveTemplate({ folder: null, name: "weekly report", sections: ["One"] }), null);
  assert.deepEqual(d.puts, []);
});
