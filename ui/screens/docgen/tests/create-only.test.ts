// Create-only writes (API 106): a NEW template or command is PUT with createOnly true, and a 409 TEMPLATE_EXISTS /
// COMMAND_EXISTS moves to the next free name (bounded). Editing never sends createOnly. An older core ignores the flag
// (answers 200) and the client-side free-name guess still applies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocGenStore, type StoreDeps } from "../store.ts";
import { createDocsApi } from "../docs-api.ts";
import { describeFailure } from "../errors.ts";
import type { DocCommand, DocTemplate, Surface } from "../model.ts";
import { MemFs, readersFrom } from "./fakes.ts";

const t = (name: string, folder = name.toLowerCase(), surface: Surface = "doc"): DocTemplate => ({ id: `id-${folder}`, name, sections: ["A"], rawContent: "", isBuiltin: false, folderName: folder, isProjectTemplate: true, surface });
const c = (name: string, folder = name.toLowerCase()): DocCommand => ({ id: `cid-${folder}`, name, instruction: "do", rawContent: "", isBuiltin: false, folderName: folder, isProjectCommand: true, surface: "doc" });

type PutArgs = { folder: string; createOnly?: boolean; name: string };
const conflict = (code: string) => Object.assign(new Error(code), { status: 409, code });

/** A core double: `taken` folders answer 409 when createOnly is sent; `listed` is what the list shows. */
function make(opts: { listed?: DocTemplate[]; commands?: DocCommand[]; taken?: string[]; code?: string; old?: boolean } = {}) {
  const puts: PutArgs[] = [];
  const taken = new Set((opts.taken ?? []).map((f) => f.toLowerCase()));
  const api = {
    async register() { return { id: 'p1' }; },
    async templates() { return { items: opts.listed ?? [], truncated: false }; },
    async commands() { return { items: opts.commands ?? [], truncated: false }; },
    async seed() { return { written: 0 }; },
    async putTemplate(folder: string, x: { name: string; sections: string[]; surface: Surface; createOnly?: boolean }) {
      puts.push({ folder, createOnly: x.createOnly, name: x.name });
      if (x.createOnly && !opts.old && taken.has(folder.toLowerCase())) throw conflict(opts.code ?? "TEMPLATE_EXISTS");
      return { ...t(x.name, folder, x.surface), sections: x.sections };
    },
    async putCommand(folder: string, x: { name: string; instruction: string; surface: Surface; createOnly?: boolean }) {
      puts.push({ folder, createOnly: x.createOnly, name: x.name });
      if (x.createOnly && !opts.old && taken.has(folder.toLowerCase())) throw conflict(opts.code ?? "COMMAND_EXISTS");
      return { ...c(x.name, folder) };
    },
    async deleteTemplate() { return true; },
    async deleteCommand() { return true; },
    async generate() { throw new Error("unused"); },
  };
  const deps: StoreDeps = { surface: "doc", makeApi: () => api as never, run: { readers: readersFrom({}), fs: new MemFs() }, idFor: async () => "p1" };
  const store = new DocGenStore(deps);
  return { store, puts };
}

test("a new template with a free name is one PUT, with createOnly true", async () => {
  const d = make();
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "Sprint Notes", sections: ["Goals"] });
  assert.equal(out?.folderName, "sprint-notes");
  assert.deepEqual(d.puts, [{ folder: "sprint-notes", createOnly: true, name: "Sprint Notes" }]);
});

test("a 409 TEMPLATE_EXISTS the list did not show moves to the next free name, then saves", async () => {
  const d = make({ taken: ["retro"] });
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "Retro", sections: ["A"] });
  assert.equal(out?.folderName, "retro-2");
  assert.deepEqual(d.puts.map((p) => p.folder), ["retro", "retro-2"]);
  assert.ok(d.puts.every((p) => p.createOnly === true));
  assert.equal(d.store.getSnapshot().templateError, null);
});

test("a template taken for 50 attempts in a row answers a plain error and no more PUTs", async () => {
  const taken = ["retro", ...Array.from({ length: 60 }, (_, i) => `retro-${i + 2}`)];
  const d = make({ taken });
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "Retro", sections: ["A"] });
  assert.equal(out, null);
  assert.equal(d.puts.length, 50);
  assert.match(d.store.getSnapshot().templateError!.message, /Too many templates already use the name retro/);
  assert.equal(d.store.getSnapshot().templateBusy, false);
});

test("editing sends no createOnly, keeps its folder, and is never renamed or blocked", async () => {
  const d = make({ listed: [t("Retro")], taken: ["retro"] });
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: "retro", name: "Retro", sections: ["Wins"] });
  assert.ok(out);
  assert.deepEqual(d.puts, [{ folder: "retro", createOnly: undefined, name: "Retro" }]);
  assert.equal(d.store.getSnapshot().templateError, null);
});

test("an older core ignores createOnly and answers 200: the save succeeds with the first guess", async () => {
  const d = make({ listed: [t("Retro")], old: true, taken: ["retro-2"] });
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "Retro", sections: ["A"] });
  assert.equal(out?.folderName, "retro-2");
  assert.deepEqual(d.puts.map((p) => p.folder), ["retro-2"]);
});

test("case variants: a listed folder that differs only by case is skipped by the first guess, and the 409 is case-insensitive", async () => {
  const d = make({ listed: [t("Weekly Report", "Weekly-Report")], taken: ["WEEKLY-REPORT-2"] });
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "weekly report", sections: ["One"] });
  assert.equal(out?.folderName, "weekly-report-3");
  assert.deepEqual(d.puts.map((p) => p.folder), ["weekly-report-2", "weekly-report-3"]);
});

test("a 409 with an unknown code is not retried: one PUT, and its own plain message", async () => {
  const d = make({ taken: ["retro"], code: "RESERVED_FOLDER" });
  await d.store.setProject("/proj");
  const out = await d.store.saveTemplate({ folder: null, name: "Retro", sections: ["A"] });
  assert.equal(out, null);
  assert.deepEqual(d.puts.map((p) => p.folder), ["retro"]);
  assert.equal(d.store.getSnapshot().templateError!.message, describeFailure({ status: 409, code: "RESERVED_FOLDER" }).message);
});

test("a new command is created with createOnly and moves to the next free name on COMMAND_EXISTS", async () => {
  const d = make({ taken: ["summarize"] });
  await d.store.setProject("/proj");
  const out = await d.store.saveCommand({ folder: null, name: "Summarize", instruction: "Short." });
  assert.equal(out?.folderName, "summarize-2");
  assert.deepEqual(d.puts, [
    { folder: "summarize", createOnly: true, name: "Summarize" },
    { folder: "summarize-2", createOnly: true, name: "Summarize" },
  ]);
});

test("an edited command sends no createOnly and is written to its own folder", async () => {
  const d = make({ commands: [c("Summarize")], taken: ["summarize"] });
  await d.store.setProject("/proj");
  const out = await d.store.saveCommand({ folder: "summarize", name: "Summarize", instruction: "Longer." });
  assert.equal(out?.folderName, "summarize");
  assert.deepEqual(d.puts, [{ folder: "summarize", createOnly: undefined, name: "Summarize" }]);
});

test("the error mapping has plain wording for the two create-only codes", () => {
  assert.match(describeFailure({ status: 409, code: "TEMPLATE_EXISTS" }).message, /already exists/);
  assert.match(describeFailure({ status: 409, code: "COMMAND_EXISTS" }).message, /already exists/);
});

test("the docs API sends createOnly only when asked, and the edit body is unchanged", async () => {
  const seen: Array<{ path: string; body: unknown }> = [];
  const client = {
    async request(path: string, opts: { body?: unknown }) {
      seen.push({ path, body: opts.body });
      return path.includes("/commands/") ? { command: { id: "x", name: "N", instruction: "i", folderName: "n", surface: "doc" } } : { template: { id: "x", name: "N", sections: [], folderName: "n", surface: "doc" } };
    },
  };
  const api = createDocsApi(client as never, "pabc", "/r");
  await api.putTemplate("n", { name: "N", sections: ["A"], surface: "doc", createOnly: true });
  await api.putTemplate("n", { name: "N", sections: ["A"], surface: "doc" });
  await api.putCommand("n", { name: "N", instruction: "i", surface: "doc", createOnly: true });
  await api.putCommand("n", { name: "N", instruction: "i", surface: "doc" });
  assert.deepEqual(seen[0]!.body, { name: "N", sections: ["A"], surface: "doc", rewrite: true, createOnly: true });
  assert.deepEqual(seen[1]!.body, { name: "N", sections: ["A"], surface: "doc", rewrite: true });
  assert.deepEqual(seen[2]!.body, { name: "N", instruction: "i", surface: "doc", createOnly: true });
  assert.deepEqual(seen[3]!.body, { name: "N", instruction: "i", surface: "doc" });
});
