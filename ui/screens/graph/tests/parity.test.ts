// Mac parity for the graph screen: the files-only default and the Symbols toggle, the code / doc split, the
// node-kind palette, and focus in the store. Pure logic: no WebGL, no host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runJob } from "../layout-job.ts";
import { countOnes, defaultFilters, docSplit, FILES_ONLY_KINDS, isDocKind, nodeMask, setSymbolsShown, symbolKinds, symbolsShown, initialFilters } from "../filters.ts";
import { kindColor } from "../colors.ts";
import { edgeFocusDim, nodeTone } from "../visibility.ts";
import { GraphStore } from "../store.ts";
import { loadWasmBytes } from "./wasm-helper.ts";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");

async function graph(text: string) {
  const r = await runJob(text, { loadWasm: loadWasmBytes });
  return { model: r.model, layout: r.layout };
}

test("Symbols default on: opening a code graph hides no kind; turning Symbols off keeps the files-only view", async () => {
  const { model, layout } = await graph(fixture("merge-code"));
  const f = defaultFilters(model);
  assert.equal(f.hiddenKinds.size, 0);
  assert.equal(symbolsShown(model, f), true);
  assert.ok(symbolKinds(model).includes("function"), "function is a symbol kind");
  assert.equal(FILES_ONLY_KINDS.has("file"), true);
  const filesOnly = { ...f, hiddenKinds: new Set(symbolKinds(model)) };
  const shown = countOnes(nodeMask(model, layout, filesOnly));
  assert.ok(shown < countOnes(nodeMask(model, layout, f)), "Symbols off hides the symbol nodes");
  assert.ok(shown > 0, "files are still drawn");
});

test("Symbols toggle: on shows every symbol kind, off hides them again, and other hidden kinds are left alone", async () => {
  const { model } = await graph(fixture("merge-code"));
  const base = { ...initialFilters(), hiddenKinds: new Set(["file"]) };
  const on = setSymbolsShown(model, base, true);
  assert.equal(on.has("function"), false);
  assert.equal(on.has("file"), true, "a user-hidden file kind stays hidden");
  const off = setSymbolsShown(model, { ...base, hiddenKinds: on }, false);
  assert.equal(off.has("function"), true);
  assert.equal(off.has("file"), true);
  assert.equal(symbolsShown(model, { ...base, hiddenKinds: on }), true);
});

test("InfiniteBrain graphs have no symbol kinds (so no Symbols toggle) and count every node as doc", async () => {
  const { model } = await graph(fixture("memory"));
  assert.deepEqual(symbolKinds(model), []);
  const split = docSplit(model);
  assert.equal(split.doc, model.n);
  assert.equal(split.code, 0);
  assert.equal(isDocKind("noteDecision"), true);
  assert.equal(isDocKind("file"), false);
});

test("code graphs report a code split with no docs", async () => {
  const { model } = await graph(fixture("merge-code"));
  assert.deepEqual(docSplit(model), { code: model.n, doc: 0 });
});

test("node-kind colours are the Mac's CGPalette values; unknown kinds read as other", () => {
  assert.equal(kindColor("file"), "#007aff");
  assert.equal(kindColor("noteDecision"), "#ff3b30");
  assert.equal(kindColor("memoryChunk"), "#00c7be");
  assert.equal(kindColor("notARealKind"), kindColor("other"));
});

test("store: focus is bounds-checked, cleared by a new graph, and filters reset to the all-kinds default", async () => {
  const text = fixture("merge-code");
  const engine = {
    cancel() {},
    async load(t: string) {
      const r = await runJob(t, { loadWasm: loadWasmBytes });
      return { kind: "done" as const, entry: { model: r.model, layout: r.layout, notices: r.notices }, cached: false };
    },
  };
  const s = new GraphStore({ invoke: async () => text, engine });
  await s.load("/p");
  const n = s.getSnapshot().entry!.model.n;
  assert.equal(s.getSnapshot().focus, -1);
  assert.equal(s.getSnapshot().filters.hiddenKinds.has("function"), false, "opens with symbols shown");
  s.setFocus(1);
  assert.equal(s.getSnapshot().focus, 1);
  s.setFocus(n);
  assert.equal(s.getSnapshot().focus, -1, "out of range clears");
  s.setFocus(0.5);
  assert.equal(s.getSnapshot().focus, -1, "non-integer clears");
  s.setFocus(0);
  s.setFilters({ hiddenKinds: new Set(["function"]) });
  await s.reload();
  assert.equal(s.getSnapshot().focus, -1, "a reload clears focus");
  assert.equal(s.getSnapshot().filters.hiddenKinds.has("function"), false, "a reload restores the all-kinds default");
  assert.equal(s.getSnapshot().filters.hiddenKinds.size, defaultFilters(s.getSnapshot().entry!.model).hiddenKinds.size);
});

// Review fixes (independent review of the parity pass).
test("every UA kind colour is the Mac's Color(red:green:blue:) value; article is (0.4, 0.6, 0.2)", () => {
  const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  const mac: Record<string, [number, number, number]> = {
    function: [0.2, 0.6, 0.9], classType: [0.6, 0.2, 0.8], config: [0.5, 0.5, 0.5], service: [0.0, 0.7, 0.5],
    table: [0.8, 0.5, 0.1], endpoint: [0.9, 0.3, 0.3], pipeline: [0.3, 0.5, 0.9], schemaNode: [0.7, 0.4, 0.1],
    resource: [0.1, 0.5, 0.3], domain: [0.9, 0.6, 0.1], flow: [0.4, 0.8, 0.8], step: [0.6, 0.8, 0.4],
    article: [0.4, 0.6, 0.2], entity: [0.8, 0.2, 0.6], topic: [0.2, 0.4, 0.8], claim: [0.9, 0.4, 0.2],
    skill: [0.35, 0.75, 0.65], agent: [0.85, 0.45, 0.75],
  };
  for (const [k, [r, g, b]] of Object.entries(mac)) assert.equal(kindColor(k), hex(r, g, b), k);
});

test("every graph opens with everything shown, never as an empty canvas", () => {
  const symbolsOnly = { nodeKinds: ["function", "classType"] } as unknown as Parameters<typeof defaultFilters>[0];
  assert.equal(defaultFilters(symbolsOnly).hiddenKinds.size, 0);
  const entities = { nodeKinds: ["entity", "topic", "claim"] } as unknown as Parameters<typeof defaultFilters>[0];
  assert.equal(defaultFilters(entities).hiddenKinds.size, 0);
  const mixed = { nodeKinds: ["file", "function"] } as unknown as Parameters<typeof defaultFilters>[0];
  assert.equal(defaultFilters(mixed).hiddenKinds.size, 0);
});

test("focus wins over selection, as in the Mac's nodeAlpha / edgeAlpha", () => {
  // focused 0, its neighbourhood {0, 1}; selected 5 lies outside it
  assert.equal(nodeTone(5, 5, false, 0, false), "dim", "a selected node outside the focus is dimmed");
  assert.equal(nodeTone(1, 5, false, 0, true), "base", "a focus neighbour stays bright while something else is selected");
  assert.equal(nodeTone(0, 0, false, 0, true), "select", "double-click selects and focuses the same node");
  assert.equal(nodeTone(1, 0, true, 0, true), "neighbour");
  assert.equal(nodeTone(0, -1, false, 0, true), "focus");
  assert.equal(nodeTone(3, -1, false, -1, false), "base");
  assert.equal(nodeTone(3, 2, false, -1, false), "dim", "selection alone still dims the rest");
  assert.equal(edgeFocusDim(5, 6, 0), true);
  assert.equal(edgeFocusDim(0, 6, 0), false);
  assert.equal(edgeFocusDim(5, 6, -1), false);
});
