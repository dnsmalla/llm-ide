import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEntry, react, server } from "./helpers.mjs";

let E, h, html;
before(async () => {
  E = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, "..", f), "utf8");
const noop = () => {};
const tpl = (n, extra = {}) => ({ id: n, name: n, sections: ["Summary"], rawContent: "", isBuiltin: false, folderName: n.toLowerCase(), isProjectTemplate: true, surface: "doc", ...extra });

function resultProps(run, over = {}) {
  return { surface: "doc", run: { ...E.INITIAL_RUN, ...run }, onCancel: noop, onRetry: noop, onRefine: noop, onSave: noop, onSaveAsNew: noop, onOpenSaved: noop, onDiscard: noop, onOpenExternal: noop, onOpenSettings: noop, onSignIn: noop, initialSections: 99, ...over };
}

test("reveal: a saved document gets a Reveal button only when the host can reveal", () => {
  const saved = { phase: "done", doc: "# x", saved: { path: "llm-doc/generated/x.md", hash: "h", size: 1, stem: "x" }, dirty: false };
  const desktop = html(h(E.ResultPanel, resultProps(saved, { onReveal: noop })));
  assert.match(desktop, />Reveal</);
  assert.match(desktop, />Open in Explorer</);
  const web = html(h(E.ResultPanel, resultProps(saved)));
  assert.doesNotMatch(web, />Reveal</);
  const unsaved = html(h(E.ResultPanel, resultProps({ phase: "done", doc: "# x" }, { onReveal: noop })));
  assert.doesNotMatch(unsaved, />Reveal</);
});

test("reveal: the Visual image preview has a Reveal action wired to the host through the source env", () => {
  const code = src("SourcePanel.tsx");
  assert.match(code, /\{env\.reveal && <button type="button" className="dg-btn" onClick=\{\(\) => env\.reveal!\(preview\.path\)\}>Reveal<\/button>\}/);
  const section = src("section.tsx");
  assert.match(section, /invokeHost\("reveal_in_os", \{ relPath: rel \}\)/);
  assert.match(section, /const rel = safeRelativePath\(path\);/);
});

test("unreadable source rows: a warning with an accessible name only when the source's key was in the last run", () => {
  const warn = html(h(E.UnreadMark, { sourceKey: "file:scan.pdf", unreadable: ["file:scan.pdf"] }));
  assert.match(warn, /role="img" aria-label="Could not read this file" title="Could not read this file"/);
  assert.equal(html(h(E.UnreadMark, { sourceKey: "file:ok.md", unreadable: ["file:scan.pdf"] })), "");
  assert.equal(html(h(E.UnreadMark, { sourceKey: "file:ok.md", unreadable: undefined })), "");
});

test("two sources with the same name: only the one the run could not read gets the warning", () => {
  const unreadable = ["file:a/notes.md"];
  assert.notEqual(html(h(E.UnreadMark, { sourceKey: "file:a/notes.md", unreadable })), "");
  assert.equal(html(h(E.UnreadMark, { sourceKey: "file:b/notes.md", unreadable })), "");
});

test("unreadable markers are wired to both the Files and Notes rows with the run's names", () => {
  const code = src("SourcePanel.tsx");
  assert.match(code, /<UnreadMark sourceKey=\{key\} unreadable=\{unreadable\} \/>/);
  assert.match(code, /<UnreadMark sourceKey=\{`note:\$\{r\.rel\}`\} unreadable=\{unreadable\} \/>/);
  assert.match(src("DocGenScreen.tsx"), /<SourcePanel env=\{p\.env\} unreadable=\{run\.skippedKeys\}/);
});

test("template location: an edited project template says where it is saved", () => {
  const props = { templates: [tpl("Mine"), tpl("Kit", { isProjectTemplate: false, folderName: null })], busy: false, error: null, onSave: async () => null, onDelete: async () => true, onClose: noop };
  const edit = html(h(E.TemplateManager, { ...props, initialEditing: "Mine" }));
  assert.match(edit, /Saved as <code>templates\/mine\/template\.md<\/code>/);
  const builtin = html(h(E.TemplateManager, { ...props, initialEditing: "Kit" }));
  assert.doesNotMatch(builtin, /template\.md/);
  const fresh = html(h(E.TemplateManager, { ...props, initialEditing: "new" }));
  assert.doesNotMatch(fresh, /template\.md/);
});

test("template import: the file button appears only where the host can pick a file", () => {
  const props = { templates: [tpl("Mine")], busy: false, error: null, onSave: async () => null, onDelete: async () => true, onClose: noop };
  assert.match(html(h(E.TemplateManager, { ...props, pickFile: async () => ({ kind: "cancelled" }) })), />Import \.md file</);
  assert.doesNotMatch(html(h(E.TemplateManager, props)), />Import \.md file</);
  assert.match(html(h(E.TemplateManager, props)), />Import Markdown</);
});

test("template import: a file error is announced in the dialog", () => {
  const src2 = src("TemplateManager.tsx");
  assert.match(src2, /\{fileError && <StatusBanner severity="error" message=\{<>\{fileError\}<\/>\} \/>\}/);
  assert.match(src2, /await onSave\(\{ folder: null, name: t\.name, sections: t\.sections, rawContent: r\.text \}\);/);
});

test("the Doc Gen screen passes the host picker and reveal only on the desktop", () => {
  const section = src("section.tsx");
  assert.match(section, /pickTemplateFile=\{available \? \(\) => pickTemplateFile\(invokeHost\) : undefined\}/);
});
