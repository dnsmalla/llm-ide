import { test } from "node:test";
import assert from "node:assert/strict";
import { DocGenStore, type StoreDeps } from "../store.ts";
import { fileItem } from "../sources.ts";
import { MAX_SELECTED_SOURCES, type DocCommand, type DocTemplate } from "../model.ts";
import { MemFs, readersFrom, okResult, tick } from "./fakes.ts";

const t = (name: string, surface: "doc" | "visual" = "doc", project = true): DocTemplate => ({ id: `id-${name}`, name, sections: ["A"], rawContent: "", isBuiltin: false, folderName: name.toLowerCase(), isProjectTemplate: project, surface });
const c = (name: string, surface: "doc" | "visual" = "doc"): DocCommand => ({ id: `cid-${name}`, name, instruction: `do ${name}`, rawContent: "", isBuiltin: false, folderName: name, isProjectCommand: true, surface });

function make(opts: { templates?: DocTemplate[]; commands?: DocCommand[]; surface?: "doc" | "visual"; registerError?: unknown } = {}) {
  const log: string[] = [];
  let templates = opts.templates ?? [t("Retro"), t("Sketch", "visual")];
  const commands = opts.commands ?? [c("Summarize"), c("Read", "visual")];
  const api = {
    async register() { log.push("register"); if (opts.registerError) throw opts.registerError; },
    async templates() { log.push("templates"); return { items: templates, truncated: false }; },
    async commands() { log.push("commands"); return { items: commands, truncated: false }; },
    async seed() { log.push("seed"); templates = [t("Seeded")]; return { written: 1 }; },
    async putTemplate(folder: string, x: { name: string; sections: string[]; surface: "doc" | "visual" }) { log.push(`put ${folder}`); return { ...t(x.name, x.surface), folderName: folder, sections: x.sections }; },
    async deleteTemplate(folder: string) { log.push(`delete ${folder}`); return true; },
    async generate() { return okResult("doc"); },
  };
  const fs = new MemFs();
  const deps: StoreDeps = { surface: opts.surface ?? "doc", makeApi: () => api as never, run: { readers: readersFrom({ "a.md": "alpha" }), fs }, idFor: async (r) => `id${r.length}` };
  return { store: new DocGenStore(deps), log, fs };
}

test("setProject registers, lists, and keeps only this surface's templates and commands", async () => {
  const d = make();
  assert.equal(d.store.getSnapshot().setup, "no_project");
  await d.store.setProject("/proj");
  const s = d.store.getSnapshot();
  assert.equal(s.setup, "ready");
  assert.deepEqual(s.templates.map((x) => x.name), ["Retro"]);
  assert.deepEqual(s.commands.map((x) => x.name), ["Summarize"]);
  assert.deepEqual(d.log.slice(0, 3), ["register", "templates", "commands"]);
  const v = make({ surface: "visual" });
  await v.store.setProject("/proj");
  assert.deepEqual(v.store.getSnapshot().templates.map((x) => x.name), ["Sketch"]);
});

test("an empty project is seeded once with the kit's defaults, then listed again", async () => {
  const d = make({ templates: [], commands: [] });
  await d.store.setProject("/proj");
  assert.ok(d.log.includes("seed"));
  assert.equal(d.log.filter((x) => x === "seed").length, 1);
  assert.deepEqual(d.store.getSnapshot().templates.map((x) => x.name), ["Seeded"]);
});

test("core failures become a ready-to-show failure; retry works", async () => {
  const d = make({ registerError: { status: 404, code: "feature_disabled" } });
  await d.store.setProject("/proj");
  assert.equal(d.store.getSnapshot().setup, "error");
  assert.match(d.store.getSnapshot().setupError!.message, /turned off/);
  assert.equal(d.store.getSnapshot().setupError!.action, "settings");
});

test("switching project resets selection, template choice and the run; same root is a no-op", async () => {
  const d = make();
  await d.store.setProject("/a");
  d.store.selectTemplate("id-Retro");
  d.store.addItems([fileItem("a.md", 5)]);
  d.store.setPrompt("p");
  assert.equal(d.store.getSnapshot().selection.size, 1);
  d.log.length = 0;
  await d.store.setProject("/a");
  assert.deepEqual(d.log, []);
  await d.store.setProject("/bb");
  const s = d.store.getSnapshot();
  assert.equal(s.selection.size, 0);
  assert.equal(s.templateId, null);
  assert.equal(s.prompt, "");
  await d.store.setProject(null);
  assert.equal(d.store.getSnapshot().setup, "no_project");
});

test("a stale load never overwrites a newer project's state", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const api = (name: string, slow: boolean) => ({
    register: async () => { if (slow) await gate; },
    templates: async () => ({ items: [t(name)], truncated: false }),
    commands: async () => ({ items: [], truncated: false }),
    seed: async () => ({ written: 0 }), generate: async () => okResult("x"), putTemplate: async () => null, deleteTemplate: async () => true,
  });
  const store = new DocGenStore({ surface: "doc", makeApi: (_id, root) => api(root === "/slow" ? "Slow" : "Fast", root === "/slow") as never, run: { readers: readersFrom({}), fs: new MemFs() }, idFor: async (r) => r.replace("/", "p") });
  const first = store.setProject("/slow");
  await tick();
  await store.setProject("/fast");
  release();
  await first;
  assert.deepEqual(store.getSnapshot().templates.map((x) => x.name), ["Fast"]);
});

test("command picking, custom text and selection rules", async () => {
  const d = make();
  await d.store.setProject("/p");
  d.store.selectCommand("cid-Summarize");
  assert.equal(d.store.getSnapshot().command, "do Summarize");
  d.store.setCommandText("do Summarize but shorter");
  assert.equal(d.store.getSnapshot().commandId, null, "editing makes it custom");
  d.store.selectTemplate("nope");
  assert.equal(d.store.getSnapshot().templateId, null);
  d.store.addItems([fileItem("a.md", 1)]);
  d.store.addItems([fileItem("a.md", 1)]);
  assert.equal(d.store.getSnapshot().selectionNote, "Those sources are already selected.");
  d.store.addItems(Array.from({ length: MAX_SELECTED_SOURCES + 5 }, (_, i) => fileItem(`x${i}`, 1)));
  assert.match(d.store.getSnapshot().selectionNote!, /Selection is full/);
  assert.equal(d.store.addPaste("  "), false);
  d.store.clearSelection();
  assert.equal(d.store.addPaste("hello"), true);
});

test("saveTemplate and deleteTemplate go through the core and update the list; failures are reported, built-ins are protected", async () => {
  const d = make();
  await d.store.setProject("/p");
  const saved = await d.store.saveTemplate({ folder: null, name: "Sprint Review", sections: ["A", "B"] });
  assert.equal(saved?.folderName, "sprint-review");
  assert.ok(d.log.includes("put sprint-review"));
  assert.ok(d.store.getSnapshot().templates.some((x) => x.name === "Sprint Review"));
  assert.equal(d.store.getSnapshot().templateId, saved!.id);
  assert.equal(await d.store.saveTemplate({ folder: null, name: "会議", sections: ["A"] }), null);
  assert.match(d.store.getSnapshot().templateError!.message, /letters or numbers/);
  assert.equal(await d.store.deleteTemplate(saved!), true);
  assert.ok(!d.store.getSnapshot().templates.some((x) => x.id === saved!.id));
  assert.equal(d.store.getSnapshot().templateId, null);
  assert.equal(await d.store.deleteTemplate(t("Kit", "doc", false)), false);
  assert.ok(!d.log.includes("delete kit"));
});

test("generate uses the chosen template, command, prompt and the selected sources end to end (fake core)", async () => {
  const d = make();
  await d.store.setProject("/p");
  d.store.selectTemplate("id-Retro");
  d.store.setPrompt("short");
  d.store.addItems([fileItem("a.md", 5)]);
  await d.store.generate();
  const s = d.store.run.getSnapshot();
  assert.equal(s.phase, "done");
  assert.equal(s.doc, "doc");
  await d.store.run.save();
  assert.match(d.store.run.getSnapshot().saved!.path, /^llm-doc\/generated\/retro-\d{8}\.md$/);
  assert.ok(d.fs.files.has(d.store.run.getSnapshot().saved!.path));
});
