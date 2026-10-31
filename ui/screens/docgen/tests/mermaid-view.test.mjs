// Component-level containment for mermaid fences (static markup: no effects run, so this is the state a user sees
// BEFORE installing, and the state of every diagram until the host confirms the runtime is installed).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadEntry, react, server } from "./helpers.mjs";

let E, h, html;
before(async () => {
  E = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});
const noop = () => {};
const runtime = {
  calls: [],
  status() { this.calls.push("status"); return Promise.resolve({ installed: false, version: "11.17.2", sizeBytes: 3572661 }); },
  install() { this.calls.push("install"); return Promise.resolve({ installed: false, version: "11.17.2", sizeBytes: 3572661 }); },
  read() { this.calls.push("read"); return Promise.reject(new Error("never on mount")); },
};
const props = (doc, over = {}) => ({ surface: "visual", run: { ...E.INITIAL_RUN, phase: "done", doc }, onCancel: noop, onRetry: noop, onRefine: noop, onSave: noop, onSaveAsNew: noop, onOpenSaved: noop, onDiscard: noop, onOpenExternal: noop, onOpenSettings: noop, onSignIn: noop, initialSections: 99, ...over });

const HOSTILE_DIAGRAM = [
  "graph TD",
  `%%{init: {"securityLevel":"loose"}}%%`,
  `A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]`,
  `click A callback "alert(1)"`,
  `click B href "javascript:alert(1)"`,
  `C["<foreignObject><iframe src=https://evil.example></iframe></foreignObject>"]`,
].join("\n");

test("MermaidView shows the source as escaped text and renders nothing before install", () => {
  const out = html(h(E.MermaidView, { source: HOSTILE_DIAGRAM, runtime }));
  assert.match(out, /mermaid \(diagram source\)/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /<script|<img|<iframe|<foreignObject|<svg|<object|<embed|<a /i);
  assert.doesNotMatch(out, /<[^>]*\son[a-z]+=/i, "no event-handler attribute on any tag");
  assert.deepEqual(runtime.calls, [], "static render never calls the host");
});

test("a mermaid fence in a Visual or Doc result goes through MermaidView when the runtime binding exists", () => {
  for (const surface of ["visual", "doc"]) {
    const out = html(h(E.ResultPanel, props("Intro\n\n```mermaid\n" + HOSTILE_DIAGRAM + "\n```\n\nOutro", { surface, mermaid: runtime })));
    assert.match(out, /dg-mermaid/);
    assert.match(out, /Intro/);
    assert.match(out, /Outro/);
    assert.doesNotMatch(out, /<script|<img|<iframe|<foreignObject|<svg|<object|<embed/i);
    assert.doesNotMatch(out, /contains a Mermaid diagram/, "the 'source only' notice is for builds without a renderer");
  }
});

test("other fences are untouched and a build without the binding keeps the source-only notice", () => {
  const other = html(h(E.ResultPanel, props("```js\nconsole.log(1)\n```", { mermaid: runtime })));
  assert.match(other, /class="lib-code"/);
  assert.doesNotMatch(other, /dg-mermaid/);
  const none = html(h(E.ResultPanel, props("```mermaid\ngraph TD\n A-->B\n```")));
  assert.doesNotMatch(none, /dg-mermaid/);
  assert.match(none, /contains a Mermaid diagram/);
  assert.match(none, /graph TD/);
});

test("a fence whose info string only starts with mermaid-like text is not treated as a diagram", () => {
  const out = html(h(E.ResultPanel, props("```mermaidx\ngraph TD\n```\n```text mermaid\nx\n```", { mermaid: runtime })));
  assert.doesNotMatch(out, /dg-mermaid/);
});
