// An imported .md template keeps its whole body (the instructions, code fences, front matter, CRLF), not only the
// title and the ## headings. The core stores rawContent verbatim, so the import stamps the surface marker itself
// (as the Mac does) and nothing else in the file changes. Reading the stored file back equals the source, minus the
// marker line that the stamp adds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DocGenStore, type StoreDeps } from "../store.ts";
import type { DocTemplate, Surface } from "../model.ts";
import { stampSurfaceMarker, templateImportText, TEMPLATE_FILE_MAX_BYTES } from "../template-file.ts";
import { MemFs, readersFrom } from "./fakes.ts";

const DOC_MARKER = "<!-- llmide:doc-template -->";
const VISUAL_MARKER = "<!-- llmide:doc-template surface=visual -->";

// CRLF file with front matter, instructions, a fenced block that holds a "## " line, and a real section.
const SOURCE = [
  "---\r\ntitle: Weekly\r\n---\r\n",
  "# Weekly review\r\n\r\n",
  "Instructions: be brief.\r\nDo not invent numbers.\r\n\r\n",
  "```md\n## Not a section\n```\r\n\r\n",
  "## Wins\r\nBody text.\r\n",
].join("");

const t = (name: string, folder: string, surface: Surface = "doc"): DocTemplate => ({ id: `id-${folder}`, name, sections: ["A"], rawContent: "", isBuiltin: false, folderName: folder, isProjectTemplate: true, surface });

/** A core double that keeps what each PUT stored and answers the list from it, as the real core does. */
function make(existing: DocTemplate[] = []) {
  const stored = new Map<string, { name: string; rawContent?: string; surface: Surface }>();
  const bodies: Array<{ folder: string; rawContent?: string }> = [];
  const api = {
    async register() { return { id: 'p1' }; },
    async templates() {
      const items = [...existing, ...[...stored].map(([folder, v]) => ({ ...t(v.name, folder, v.surface), rawContent: v.rawContent ?? "" }))];
      return { items, truncated: false };
    },
    async commands() { return { items: [], truncated: false }; },
    async seed() { return { written: 0 }; },
    async putTemplate(folder: string, x: { name: string; sections: string[]; surface: Surface; rawContent?: string }) {
      bodies.push({ folder, rawContent: x.rawContent });
      stored.set(folder, { name: x.name, rawContent: x.rawContent, surface: x.surface });
      return { ...t(x.name, folder, x.surface), rawContent: x.rawContent ?? "" };
    },
    async deleteTemplate() { return true; },
    async generate() { throw new Error("unused"); },
  };
  const deps: StoreDeps = { surface: "doc", makeApi: () => api as never, run: { readers: readersFrom({}), fs: new MemFs() }, idFor: async () => "p1" };
  return { store: new DocGenStore(deps), bodies, stored };
}

const stripMarker = (text: string, marker: string) => text.replace(`${marker}\r\n\r\n`, "");

test("the stamp inserts the marker after the title and keeps every other byte, including CRLF and fenced text", () => {
  const out = stampSurfaceMarker(SOURCE, "doc");
  assert.equal(out, SOURCE.replace("# Weekly review\r\n\r\n", `# Weekly review\r\n\r\n${DOC_MARKER}\r\n\r\n`));
  assert.equal(stripMarker(out, DOC_MARKER), SOURCE);
});

test("a Visual import stamps the visual marker; an existing marker is replaced, not duplicated", () => {
  const visual = stampSurfaceMarker(SOURCE, "visual");
  assert.ok(visual.includes(VISUAL_MARKER));
  assert.equal(stripMarker(visual, VISUAL_MARKER), SOURCE);
  const restamped = stampSurfaceMarker(visual, "doc");
  assert.equal(restamped.split("llmide:doc-template").length - 1, 1, "one marker line only");
  assert.ok(restamped.includes(DOC_MARKER));
});

test("with no title line the marker goes at the top, and a text without line breaks still works", () => {
  assert.equal(stampSurfaceMarker("just instructions\n", "doc"), `${DOC_MARKER}\n\njust instructions\n`);
  assert.equal(stampSurfaceMarker("# Only", "doc"), `# Only\n\n${DOC_MARKER}`);
});

test("an import over the 256 KB cap is refused once the marker is added (the core would refuse the stored file)", () => {
  const fits = "# T\n## A\n" + "x".repeat(TEMPLATE_FILE_MAX_BYTES - 9);
  assert.equal(new TextEncoder().encode(fits).length, TEMPLATE_FILE_MAX_BYTES);
  const r = templateImportText(fits, "doc");
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /256 KB/);
  assert.equal(templateImportText("# T\n## A\nbody\n", "doc").kind, "ok");
});

test("importing a file stores the whole body; reading it back equals the source minus the marker", async () => {
  const d = make();
  await d.store.setProject("/proj");
  const saved = await d.store.saveTemplate({ folder: null, name: "Weekly review", sections: ["Wins"], rawContent: SOURCE });
  assert.ok(saved);
  assert.equal(d.bodies.length, 1);
  const sent = d.bodies[0]!.rawContent!;
  assert.equal(sent, stampSurfaceMarker(SOURCE, "doc"));
  assert.equal(stripMarker(sent, DOC_MARKER), SOURCE);
  assert.match(sent, /Instructions: be brief\./);
  assert.match(sent, /```md\n## Not a section\n```/);
});

test("a Visual-menu import is stored as a visual template (the marker travels with the body)", async () => {
  const d = make();
  d.store.dispose();
  const visual = new DocGenStore({ surface: "visual", makeApi: () => ({
    register: async () => ({ id: 'p' }), templates: async () => ({ items: [], truncated: false }), commands: async () => ({ items: [], truncated: false }),
    seed: async () => ({ written: 0 }), generate: async () => { throw new Error("unused"); }, deleteTemplate: async () => true,
    putTemplate: async (folder: string, x: { rawContent?: string; surface: Surface }) => { d.bodies.push({ folder, rawContent: x.rawContent }); return t("X", folder, x.surface); },
  }) as never, run: { readers: readersFrom({}), fs: new MemFs() }, idFor: async () => "p1" });
  await visual.setProject("/proj");
  await visual.saveTemplate({ folder: null, name: "Chart brief", sections: ["Data"], rawContent: SOURCE });
  assert.ok(d.bodies.at(-1)!.rawContent!.includes(VISUAL_MARKER));
});

test("the picker's import passes the whole file to the store (not only the parsed name and sections)", () => {
  const code = readFileSync(fileURLToPath(new URL("../TemplateManager.tsx", import.meta.url)), "utf8");
  assert.match(code, /onSave\(\{ folder: null, name: t\.name, sections: t\.sections, rawContent: r\.text \}\)/);
});
