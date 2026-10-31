// Mermaid rendering containment, pure-logic part: source pre-filter, SVG sanitiser, message protocol, frame document,
// the frame's boot script (run in a vm against a fake mermaid), queue and timeout, host binding decode.
// What only a real window can verify is listed in desktop/PACKAGING.md ("Mermaid diagram renderer").
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { prefilterMermaid, isMermaidLang, MAX_SOURCE_BYTES, MAX_SOURCE_LINES } from "../mermaid/source.ts";
import { sanitizeSvg, isSafeCss, MAX_SVG_BYTES } from "../mermaid/svg-sanitize.ts";
import { parseFrameMessage, renderMessage, cleanMessage } from "../mermaid/protocol.ts";
import { BOOT_JS, buildSrcdoc, frameCsp, sha256Base64 } from "../mermaid/frame.ts";
import { RenderQueue, withTimeout } from "../mermaid/queue.ts";
import { decodeRuntimeBytes, normalizeStatus, hostMermaidRuntime } from "../mermaid/binding.ts";

// ---------------------------------------------------------------- source pre-filter

test("isMermaidLang matches the fence info string", () => {
  for (const ok of ["mermaid", "Mermaid", " mermaid ", "mermaid title=x"]) assert.ok(isMermaidLang(ok), ok);
  for (const bad of ["", "text", "mermaids", "js mermaid", "xmermaid"]) assert.ok(!isMermaidLang(bad), bad);
});

test("a plain diagram passes through unchanged", () => {
  const src = "graph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]";
  const r = prefilterMermaid(src);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.source, src);
    assert.deepEqual(r.removed, []);
  }
});

const INIT_FIXTURES: Record<string, string> = {
  "init loose": `%%{init: {"securityLevel":"loose"}}%%\ngraph TD\n A-->B`,
  "initialize": `%%{initialize: {"securityLevel":"loose"}}%%\ngraph TD\n A-->B`,
  "config": `%%{config: {"securityLevel":"loose"}}%%\ngraph TD\n A-->B`,
  "multi-line": `%%{\n init: {\n "securityLevel": "loose"\n }\n}%%\ngraph TD\n A-->B`,
  "mid-document": `graph TD\n A-->B\n%%{init: {"securityLevel":"loose"}}%%\n B-->C`,
  "spliced": `%%{in%%{x}%%it: {"securityLevel":"loose"}}%%\ngraph TD\n A-->B`,
  "spliced twice": `%%{i%%{n%%{y}%%i}%%t: {"securityLevel":"loose"}}%%\ngraph TD\n A-->B`,
  "unterminated": `%%{init: {"securityLevel":"loose"}\ngraph TD\n A-->B`,
  "theme vars": `%%{init: {"theme":"base","themeVariables":{"fontFamily":"x"}}}%%\ngraph TD\n A-->B`,
  "front matter config": `---\nconfig:\n  securityLevel: loose\n---\ngraph TD\n A-->B`,
  "front matter after blank": `\n\n---\nconfig:\n  securityLevel: loose\n---\ngraph TD\n A-->B`,
  "front matter twice": `---\nconfig:\n  securityLevel: loose\n---\n---\nconfig:\n  securityLevel: loose\n---\ngraph TD\n A-->B`,
  "crlf": `%%{init: {"securityLevel":"loose"}}%%\r\ngraph TD\r\n A-->B`,
};
for (const [name, src] of Object.entries(INIT_FIXTURES)) {
  test(`config injection is stripped: ${name}`, () => {
    const r = prefilterMermaid(src);
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) {
      assert.ok(!r.source.includes("%%{"), r.source);
      if (!name.startsWith("spliced")) assert.ok(!/securityLevel|loose/i.test(r.source), r.source);
      assert.ok(!/^\s*---/.test(r.source));
      assert.match(r.source, /graph TD/);
      assert.ok(r.removed.length > 0);
    }
  });
}

test("click and callback lines are removed, including after a semicolon", () => {
  const r = prefilterMermaid(`graph TD\n  A-->B\n  click A callback "alert(1)"\n  click B href "javascript:alert(1)"\n  A-->C; click C call evil()\n  callback X`);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(!/click|callback|javascript|alert|evil/i.test(r.source), r.source);
    assert.match(r.source, /A-->B/);
    assert.match(r.source, /A-->C/);
  }
});

test("size, line, NUL, type and empty limits fail closed", () => {
  assert.equal(prefilterMermaid("a".repeat(MAX_SOURCE_BYTES + 1)).ok, false);
  assert.equal(prefilterMermaid("é".repeat(MAX_SOURCE_BYTES / 2 + 1)).ok, false, "bytes, not characters");
  assert.equal(prefilterMermaid("graph TD\n".repeat(MAX_SOURCE_LINES + 1)).ok, false);
  assert.equal(prefilterMermaid("graph TD\0A-->B").ok, false);
  assert.equal(prefilterMermaid(undefined).ok, false);
  assert.equal(prefilterMermaid({}).ok, false);
  assert.equal(prefilterMermaid("   \n ").ok, false);
  assert.equal(prefilterMermaid("%%{init: {}}%%").ok, false, "empty once the directive is gone");
  assert.equal(prefilterMermaid("a".repeat(MAX_SOURCE_BYTES)).ok, true);
});

test("hostile labels are left for the renderer's strict mode and the sanitiser, but never reach HTML here", () => {
  const src = `graph TD\n A["<script>alert(1)</script>"]-->B["<img src=x onerror=alert(1)>"]\n C["![x](https://evil.example/p.png)"]`;
  const r = prefilterMermaid(src);
  assert.ok(r.ok); // text is data; it travels by postMessage, never into HTML
});

// ---------------------------------------------------------------- SVG sanitiser

const BENIGN = `<svg id="mmd1" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" role="graphics-document document" aria-roledescription="flowchart-v2">
<style>#mmd1{font-family:"trebuchet ms",verdana;font-size:16px;fill:#333}@keyframes dash{to{stroke-dashoffset:0}}#mmd1 .node rect{fill:#ececff;stroke:#9370db}</style>
<g><marker id="mmd1_arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="arrowMarkerPath"/></marker></g>
<g class="nodes"><g class="node default" id="flowchart-A-0" transform="translate(50, 30)"><rect class="basic label-container" style="fill:#fff;stroke:url(#grad)" x="-30" y="-15" width="60" height="30"/><g class="label"><text y="0" text-anchor="middle"><tspan x="0" dy="1em">Start &amp; go</tspan></text></g></g></g>
<defs><linearGradient id="grad"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
<path d="M10 10 L50 50" marker-end="url(#mmd1_arrow)" fill="none"/><use href="#flowchart-A-0"/>
</svg>`;

test("a benign mermaid-style SVG is kept (structure, style, markers, gradients, fragment refs)", () => {
  const r = sanitizeSvg(BENIGN);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.dropped, 0);
  for (const frag of ["<svg ", 'xmlns="http://www.w3.org/2000/svg"', "<style>", "@keyframes dash", "<marker ", 'marker-end="url(#mmd1_arrow)"', "<linearGradient", 'stroke:url(#grad)', "<tspan", "Start &amp; go", '<use href="#flowchart-A-0"/>', 'viewBox="0 0 200 100"']) {
    assert.ok(r.svg.includes(frag), `${frag} in ${r.svg}`);
  }
});

const wrap = (inner: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`;

const INERT: Record<string, string> = {
  "script element": wrap(`<script>alert(1)</script><rect width="1"/>`),
  "script with cdata-ish text": wrap(`<script>//<![CDATA[ alert(1) //]]></script>`),
  "onload on root": wrap(`<rect/>`, ` onload="alert(1)"`),
  "onclick on g": wrap(`<g onclick="alert(1)"><rect/></g>`),
  "onerror on image": wrap(`<image href="x" onerror="alert(1)"/>`),
  "foreignObject with html": wrap(`<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></div></foreignObject>`),
  "foreignObject iframe": wrap(`<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>`),
  "image remote": wrap(`<image href="https://evil.example/p.png" width="10" height="10"/>`),
  "image xlink data": wrap(`<image xlink:href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"/>`),
  "a javascript href": wrap(`<a xlink:href="javascript:alert(1)"><text>x</text></a>`),
  "a javascript href plain": wrap(`<a href="javascript:alert(1)"><rect/></a>`),
  "use remote": wrap(`<use href="https://evil.example/x.svg#a"/>`),
  "use data": wrap(`<use xlink:href="data:image/svg+xml,<svg id='a' onload='alert(1)'/>#a"/>`),
  "entity javascript": wrap(`<a href="jav&#x61;script:alert(1)"><rect/></a>`),
  "entity tab javascript": wrap(`<a href="jav&#x09;ascript:alert(1)"><rect/></a>`),
  "style url remote": wrap(`<style>rect{fill:url(https://evil.example/a)}</style>`),
  "style import": wrap(`<style>@import url(https://evil.example/x.css);</style>`),
  "style import bare": wrap(`<style>@import "https://evil.example/x.css";</style>`),
  "style font-face": wrap(`<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style>`),
  "style escape": wrap(`<style>rect{fill:\\75rl(https://evil.example/a)}</style>`),
  "style expression": wrap(`<style>rect{width:expression(alert(1))}</style>`),
  "style attr url": wrap(`<rect style="fill:url('https://evil.example/leak')"/>`),
  "style attr javascript": wrap(`<rect style="background:url(javascript:alert(1))"/>`),
  "style attr import": wrap(`<rect style="@import 'x'"/>`),
  "fill url remote": wrap(`<rect fill="url(https://evil.example/a#b)"/>`),
  "marker-end data": wrap(`<path marker-end="url(data:image/svg+xml,x)"/>`),
  "animate href": wrap(`<a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a>`),
  "set onbegin": wrap(`<set attributeName="onmouseover" to="alert(1)" onbegin="alert(1)"/>`),
  "animate onbegin": wrap(`<rect><animate onbegin="alert(1)" attributeName="x" dur="1s"/></rect>`),
  "iframe element": wrap(`<iframe src="https://evil.example"></iframe>`),
  "object embed": wrap(`<object data="https://evil.example/x"></object><embed src="https://evil.example/x"/>`),
  "nested svg onload": wrap(`<svg onload="alert(1)"><rect/></svg>`),
  "uppercase script": wrap(`<SCRIPT>alert(1)</SCRIPT>`),
  "uppercase handler": wrap(`<rect ONCLICK="alert(1)" OnLoad="alert(1)"/>`),
  "single quotes handler": wrap(`<rect onclick='alert(1)'/>`),
  "unknown element with children": wrap(`<evil onclick="x"><script>alert(1)</script><rect/></evil>`),
  "switch": wrap(`<switch><foreignObject/><text>x</text></switch>`),
  "filter with feImage": wrap(`<filter id="f"><feImage href="https://evil.example/a"/></filter><rect filter="url(#f)"/>`),
  "mask": wrap(`<mask id="m"><image href="https://evil.example/a"/></mask>`),
  "pattern with image": wrap(`<pattern id="p"><image href="https://evil.example/a"/></pattern>`),
  "attribute with markup": wrap(`<rect class="a&gt;&lt;script&gt;"/>`),
  "id with quote": wrap(`<rect id="a&quot; onload=&quot;alert(1)"/>`),
  "text html entity": wrap(`<text>&lt;script&gt;alert(1)&lt;/script&gt;</text>`),
  "xmlns trick": wrap(`<rect xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)"/>`),
  "data attribute": wrap(`<rect data-x="javascript:alert(1)" data-y="<script>"/>`),
  "href fragment with js": wrap(`<use href="#a;javascript:alert(1)"/>`),
};
for (const [name, svg] of Object.entries(INERT)) {
  test(`hostile SVG is inert: ${name}`, () => {
    const r = sanitizeSvg(svg);
    if (!r.ok) return; // refusing outright is also inert
    const out = r.svg;
    assert.doesNotMatch(out, /<script|<iframe|<object|<embed|<foreignObject|<image|<animate|<set\b|<filter|<mask|<pattern|<switch|<evil/i, out);
    assert.doesNotMatch(out, /\son[a-z]+\s*=/i, out);
    assert.doesNotMatch(out, /javascript:|vbscript:|data:|@import|expression\(|\\/i, out);
    assert.doesNotMatch(out, /https?:\/\/(?!www\.w3\.org\/(2000\/svg|1999\/xlink))/i, out);
    assert.doesNotMatch(out, /<a[\s>]|<\/a>/i, out);
    // The only markup characters inside text/attributes are escaped.
    const body = out.replace(/<\/?[A-Za-z][^>]*>/g, "");
    assert.ok(!body.includes("<") && !body.includes(">"), body);
    // The output re-sanitises to itself (idempotent): nothing dangerous can be introduced by re-serialising.
    const again = sanitizeSvg(out);
    assert.ok(again.ok);
    if (again.ok) assert.equal(again.svg, out);
  });
}

test("script-looking TEXT stays text (escaped), never markup", () => {
  const r = sanitizeSvg(wrap(`<text><tspan>javascript:alert(1)</tspan></text><title>&lt;img src=x onerror=alert(1)&gt;</title>`));
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.svg.includes("<title>&lt;img src=x onerror=alert(1)&gt;</title>"));
    assert.ok(!r.svg.includes("<img"));
  }
});

test("hostile inputs that ARE parsed drop only the dangerous part and keep the rest", () => {
  const r = sanitizeSvg(wrap(`<g onclick="alert(1)" class="ok"><rect width="3"/></g><script>x</script><text>keep</text>`));
  assert.ok(r.ok);
  if (r.ok) {
    assert.match(r.svg, /<g class="ok"><rect width="3"\/><\/g>/);
    assert.match(r.svg, /<text>keep<\/text>/);
    assert.ok(r.dropped >= 2);
  }
});

test("the content of an <a> is kept but the link is not", () => {
  const r = sanitizeSvg(wrap(`<a href="https://evil.example"><rect width="3"/></a>`));
  assert.ok(r.ok);
  if (r.ok) assert.match(r.svg, /<rect width="3"\/>/);
});

test("fragment references survive, other hrefs do not", () => {
  const r = sanitizeSvg(wrap(`<use xlink:href="#a"/><use href="#b"/><use href="b.svg#c"/><use href="//evil.example/x"/>`));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal((r.svg.match(/<use /g) ?? []).length, 2);
    assert.match(r.svg, /xlink:href="#a"/);
  }
});

const MALFORMED: Record<string, string> = {
  "not a string": undefined as unknown as string,
  "empty": "",
  "no root": "hello",
  "text before root": `x<svg xmlns="http://www.w3.org/2000/svg"/>`,
  "text after root": `<svg xmlns="http://www.w3.org/2000/svg"/>x`,
  "two roots": `<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>`,
  "wrong root": `<html><svg/></html>`,
  "doctype": `<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>`,
  "entity decl inside": `<svg xmlns="http://www.w3.org/2000/svg"><!ENTITY x "y"></svg>`,
  "cdata": `<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[<script>alert(1)</script>]]></svg>`,
  "xml prolog": `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`,
  "processing instruction": `<svg xmlns="http://www.w3.org/2000/svg"><?php x ?></svg>`,
  "unterminated comment": `<svg xmlns="http://www.w3.org/2000/svg"><!-- x</svg>`,
  "unterminated tag": `<svg xmlns="http://www.w3.org/2000/svg"><rect `,
  "unterminated attr": `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1/></svg>`,
  "unquoted attr": `<svg xmlns="http://www.w3.org/2000/svg"><rect width=1/></svg>`,
  "slash attr trick": `<svg/onload=alert(1)>`,
  "mismatched": `<svg xmlns="http://www.w3.org/2000/svg"><g></rect></svg>`,
  "unclosed": `<svg xmlns="http://www.w3.org/2000/svg"><g>`,
  "close with attrs": `<svg xmlns="http://www.w3.org/2000/svg"></svg onload="x">`,
  "unterminated style": `<svg xmlns="http://www.w3.org/2000/svg"><style>a{}</svg>`,
};
for (const [name, svg] of Object.entries(MALFORMED)) {
  test(`malformed SVG is refused: ${name}`, () => assert.equal(sanitizeSvg(svg).ok, false));
}

test("a comment hiding a tag is dropped, not parsed", () => {
  const r = sanitizeSvg(wrap(`<!-- <script>alert(1)</script> --><rect/>`));
  assert.ok(r.ok);
  if (r.ok) assert.doesNotMatch(r.svg, /script|--/);
});

test("depth, element and size caps", () => {
  assert.equal(sanitizeSvg(wrap("<g>".repeat(150) + "</g>".repeat(150))).ok, false, "too deep");
  assert.equal(sanitizeSvg(wrap("<g/>".repeat(100_001))).ok, false, "too many elements");
  assert.equal(sanitizeSvg(wrap(`<text>${"a".repeat(MAX_SVG_BYTES)}</text>`)).ok, false, "too large");
  assert.equal(sanitizeSvg(wrap("<g>".repeat(90) + "</g>".repeat(90))).ok, true);
});

test("isSafeCss", () => {
  for (const ok of ["fill:#fff;stroke:url(#a)", "a{b:c}@keyframes x{to{opacity:1}}", "fill:url('#a')", "font-family:'trebuchet ms',verdana"]) assert.ok(isSafeCss(ok), ok);
  for (const bad of ["fill:url(http://x)", "fill:url(//x)", "fill:url( x )", "@import 'x'", "a{b:\\75rl(x)}", "a{b:expression(1)}", "a<b", "background:url(data:x)", "a{behavior:url(#x)} b{background:image-set('x' 1x)}", "@font-face{}", "x\u0000y"]) assert.ok(!isSafeCss(bad), bad);
});

// ---------------------------------------------------------------- protocol

test("frame messages are parsed strictly", () => {
  assert.deepEqual(parseFrameMessage({ type: "ready" }), { type: "ready" });
  assert.deepEqual(parseFrameMessage({ type: "result", id: 3, svg: "<svg/>" }), { type: "result", id: 3, svg: "<svg/>" });
  assert.deepEqual(parseFrameMessage({ type: "error", id: 3, message: "bad\u0007\nthing" }), { type: "error", id: 3, message: "bad thing" });
  assert.deepEqual(parseFrameMessage({ type: "fatal", message: "x" }), { type: "fatal", message: "x" });
  for (const bad of [null, undefined, 1, "ready", [], { type: "other" }, { type: "result", id: "3", svg: "x" }, { type: "result", id: -1, svg: "x" }, { type: "result", id: 1.5, svg: "x" }, { type: "result", id: 1, svg: 5 }, { type: "result", id: 1, svg: "x".repeat(MAX_SVG_BYTES + 1) }, { type: "error", id: 1, message: {} }, { type: "fatal" }, { type: "render", id: 1, source: "x", theme: "dark" }]) {
    assert.equal(parseFrameMessage(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("frame error text is capped and plain", () => {
  assert.equal(cleanMessage("x".repeat(1000)).length, 300);
  assert.equal(cleanMessage("\u0000\u001f"), "The diagram could not be rendered.");
  assert.deepEqual(renderMessage(1, "graph TD", "dark"), { type: "render", id: 1, source: "graph TD", theme: "dark" });
});

// ---------------------------------------------------------------- frame document

test("the srcdoc carries a locked CSP with exactly the two script hashes and inlines the runtime verbatim", async () => {
  const runtime = '"use strict";globalThis.mermaid={render(){}};';
  const rh = await sha256Base64(runtime);
  const bh = await sha256Base64(BOOT_JS);
  const doc = buildSrcdoc(runtime, rh, bh);
  const csp = frameCsp(rh, bh);
  assert.ok(doc.includes(`content="${csp}"`));
  assert.ok(csp.includes("default-src 'none'") && csp.includes("connect-src 'none'") && csp.includes("frame-src 'none'") && csp.includes("base-uri 'none'") && csp.includes("form-action 'none'"));
  assert.ok(csp.includes("img-src data:") && csp.includes("font-src data:"));
  assert.deepEqual(csp.match(/'sha256-[^']+'/g), [`'sha256-${rh}'`, `'sha256-${bh}'`]);
  assert.ok(!/unsafe-eval|unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline|blob:|\*/.test(csp.replace("style-src 'unsafe-inline'", "")), csp);
  assert.ok(doc.includes(`<script>${runtime}</script><script>${BOOT_JS}</script>`));
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<script>"), "CSP precedes every script");
  // Nothing about a diagram is in the document.
  assert.ok(!doc.includes("graph TD"));
});

test("the srcdoc builder refuses a runtime that could break out of its script element, and bad hashes", async () => {
  const rh = await sha256Base64("x");
  const bh = await sha256Base64(BOOT_JS);
  for (const bad of ["a</script><script>alert(1)", "a</SCRIPT >", "<!--<script>", "<script", "x</ScRiPt"]) assert.throws(() => buildSrcdoc(bad, rh, bh), /inlined safely/, bad);
  assert.throws(() => buildSrcdoc("x", "short", bh), /hash/);
  assert.throws(() => buildSrcdoc("x", rh, 'a"b'), /hash/);
  // `<!--` alone (the real runtime has it inside strings) is fine without a `<script`.
  assert.doesNotThrow(() => buildSrcdoc("var s='<!-- x';", rh, bh));
});

test("the boot script has no script close tag and pins strict mode", () => {
  assert.doesNotMatch(BOOT_JS, /<\/?script/i);
  assert.match(BOOT_JS, /securityLevel: "strict"/);
  assert.match(BOOT_JS, /htmlLabels: false/);
  assert.match(BOOT_JS, /startOnLoad: false/);
  assert.match(BOOT_JS, /flowchart: \{ htmlLabels: false \}/);
  assert.doesNotMatch(BOOT_JS, /eval|Function\(|innerHTML|document\.write|fetch|XMLHttpRequest|import\(|location/);
});

function bootHarness(opts: { level?: () => string; render?: (id: string, text: string) => unknown } = {}) {
  const posted: unknown[] = [];
  const listeners: ((ev: { source: unknown; data: unknown }) => void)[] = [];
  const parent = { postMessage: (m: unknown, target: string) => void posted.push(JSON.parse(JSON.stringify({ m, target }))) };
  const calls: { init: Record<string, unknown>[]; render: string[][] } = { init: [], render: [] };
  const mermaid = {
    initialize: (c: Record<string, unknown>) => void calls.init.push(c),
    mermaidAPI: { getConfig: () => ({ securityLevel: opts.level ? opts.level() : "strict" }) },
    render: (id: string, text: string) => {
      calls.render.push([id, text]);
      return opts.render ? opts.render(id, text) : Promise.resolve({ svg: "<svg/>" });
    },
  };
  const win = { addEventListener: (_t: string, fn: (ev: { source: unknown; data: unknown }) => void) => void listeners.push(fn) };
  const ctx = vm.createContext({ window: win, parent, globalThis: undefined as unknown, Promise, String, Error });
  (ctx as Record<string, unknown>).globalThis = { mermaid };
  vm.runInContext(BOOT_JS, ctx);
  const send = (data: unknown, source: unknown = parent) => listeners.forEach((l) => l({ source, data }));
  return { posted, calls, send, parent, listeners };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test("boot: announces ready, initialises strict with a locked config, answers a render", async () => {
  const h = bootHarness();
  assert.deepEqual(h.posted[0], { m: { type: "ready" }, target: "*" });
  h.send({ type: "render", id: 7, source: "graph TD\nA-->B", theme: "dark" });
  await settle();
  const cfg = h.calls.init[0] as Record<string, unknown>;
  assert.equal(cfg.securityLevel, "strict");
  assert.equal(cfg.startOnLoad, false);
  assert.equal(cfg.htmlLabels, false);
  assert.equal(cfg.theme, "dark");
  assert.equal(JSON.stringify(cfg.flowchart), '{"htmlLabels":false}');
  for (const k of ["securityLevel", "startOnLoad", "htmlLabels", "theme", "themeVariables", "secure", "maxTextSize", "flowchart"]) assert.ok((cfg.secure as string[]).includes(k), k);
  assert.deepEqual(h.calls.render, [["mmd7", "graph TD\nA-->B"]]);
  assert.deepEqual(h.posted[1], { m: { type: "result", id: 7, svg: "<svg/>" }, target: "*" });
});

test("boot: ignores messages from other sources, bad shapes and bad themes", async () => {
  const h = bootHarness();
  h.send({ type: "render", id: 1, source: "x", theme: "dark" }, { other: true });
  h.send({ type: "render", id: "1", source: "x", theme: "dark" });
  h.send({ type: "render", id: 1, source: 5, theme: "dark" });
  h.send({ type: "render", id: 1, source: "x", theme: "forest" });
  h.send({ type: "render", id: 1, source: "x", theme: { toString() { return "dark"; } } });
  h.send({ type: "other" });
  h.send(null);
  await settle();
  assert.equal(h.calls.init.length, 0);
  assert.equal(h.calls.render.length, 0);
  assert.equal(h.posted.length, 1);
});

test("boot: refuses to render when the security level is not strict, before or after the render", async () => {
  const before = bootHarness({ level: () => "loose" });
  before.send({ type: "render", id: 1, source: "x", theme: "default" });
  await settle();
  assert.equal(before.calls.render.length, 0);
  assert.equal((before.posted[1] as { m: { type: string } }).m.type, "error");

  let n = 0;
  const after = bootHarness({ level: () => (n++ === 0 ? "strict" : "loose") });
  after.send({ type: "render", id: 2, source: "x", theme: "default" });
  await settle();
  const last = after.posted[after.posted.length - 1] as { m: { type: string; id: number } };
  assert.equal(last.m.type, "error");
  assert.equal(last.m.id, 2);
  assert.ok(!after.posted.some((p) => (p as { m: { type: string } }).m.type === "result"));
});

test("boot: a render error becomes an error message and the next render still works; one at a time", async () => {
  let fail = true;
  let release: (v: unknown) => void = () => undefined;
  const h = bootHarness({ render: () => (fail ? Promise.reject(new Error("Parse error on line 2")) : new Promise((r) => (release = r))) });
  h.send({ type: "render", id: 1, source: "bad", theme: "dark" });
  await settle();
  assert.deepEqual(h.posted[1], { m: { type: "error", id: 1, message: "Parse error on line 2" }, target: "*" });
  fail = false;
  h.send({ type: "render", id: 2, source: "ok", theme: "dark" });
  h.send({ type: "render", id: 3, source: "ignored while busy", theme: "dark" });
  await settle();
  assert.equal(h.calls.render.length, 2);
  release({ svg: "<svg/>" });
  await settle();
  assert.deepEqual(h.posted[2], { m: { type: "result", id: 2, svg: "<svg/>" }, target: "*" });
});

test("boot: a missing runtime is reported as fatal", () => {
  const posted: unknown[] = [];
  const ctx = vm.createContext({ window: { addEventListener() {} }, parent: { postMessage: (m: unknown) => posted.push(m) }, globalThis: {}, Promise, String, Error });
  (ctx as Record<string, unknown>).globalThis = {};
  vm.runInContext(BOOT_JS, ctx);
  assert.equal((posted[0] as { type: string }).type, "fatal");
});

// ---------------------------------------------------------------- queue and timeout

test("the queue runs at most `concurrency` jobs, in order, and releases on failure", async () => {
  const q = new RenderQueue(1);
  const order: string[] = [];
  let release: () => void = () => undefined;
  const a = q.run(async () => {
    order.push("a-start");
    await new Promise<void>((r) => (release = r));
    order.push("a-end");
    return 1;
  });
  const b = q.run(async () => {
    order.push("b");
    throw new Error("boom");
  });
  const c = q.run(async () => {
    order.push("c");
    return 3;
  });
  await settle();
  assert.deepEqual(order, ["a-start"]);
  assert.equal(q.active, 1);
  assert.equal(q.pending, 2);
  release();
  assert.equal(await a, 1);
  await assert.rejects(b, /boom/);
  assert.equal(await c, 3);
  assert.deepEqual(order, ["a-start", "a-end", "b", "c"]);
  assert.equal(q.active, 0);
});

test("the queue with 2 slots runs two at once; an aborted waiting job never runs", async () => {
  const q = new RenderQueue(2);
  let running = 0;
  let peak = 0;
  const rel: (() => void)[] = [];
  const job = () =>
    q.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => rel.push(r));
      running -= 1;
    });
  const jobs = [job(), job()];
  const signal = { aborted: false };
  let ran = false;
  const waiting = q.run(async () => void (ran = true), signal);
  await settle();
  assert.equal(peak, 2);
  signal.aborted = true;
  rel.forEach((r) => r());
  await Promise.all(jobs);
  await assert.rejects(waiting, /cancelled/);
  assert.equal(ran, false);
  assert.equal(q.active, 0);
});

test("withTimeout rejects, runs the cleanup, and a late result is ignored", async () => {
  let cleaned = false;
  const slow = new Promise<number>((r) => setTimeout(() => r(1), 50));
  await assert.rejects(withTimeout(slow, 5, () => (cleaned = true)), /too long/);
  assert.equal(cleaned, true);
  assert.equal(await withTimeout(Promise.resolve(2), 50, () => assert.fail("no timeout")), 2);
  await assert.rejects(withTimeout(Promise.reject(new Error("x")), 50, () => assert.fail("no timeout")), /x/);
});

// ---------------------------------------------------------------- host binding

test("host status is normalised defensively", () => {
  assert.deepEqual(normalizeStatus({ installed: true, version: "1.2.3", sizeBytes: 10 }), { installed: true, version: "1.2.3", sizeBytes: 10 });
  assert.deepEqual(normalizeStatus(null), { installed: false, version: "", sizeBytes: 0 });
  assert.deepEqual(normalizeStatus({ installed: "yes", version: 3, sizeBytes: -1 }), { installed: false, version: "", sizeBytes: 0 });
});

test("runtime bytes decode only from plausible binary shapes, as strict UTF-8", () => {
  const bytes = new TextEncoder().encode("var a=1;");
  assert.equal(decodeRuntimeBytes(bytes.buffer), "var a=1;");
  assert.equal(decodeRuntimeBytes(bytes), "var a=1;");
  assert.equal(decodeRuntimeBytes(Array.from(bytes)), "var a=1;");
  for (const bad of ["text", 5, null, {}, new Uint8Array(0), [1, 2, 300], [1.5], new Uint8Array([0xff, 0xfe])]) assert.throws(() => decodeRuntimeBytes(bad));
});

test("the host binding calls exactly the three commands", async () => {
  const seen: string[] = [];
  const api = hostMermaidRuntime((async (cmd: string) => {
    seen.push(cmd);
    return cmd === "mermaid_runtime_read" ? new TextEncoder().encode("x").buffer : { installed: true, version: "1.0.0", sizeBytes: 1 };
  }) as never);
  assert.equal((await api.status()).installed, true);
  assert.equal((await api.install()).installed, true);
  assert.equal(await api.read(), "x");
  assert.deepEqual(seen, ["mermaid_runtime_status", "mermaid_runtime_install", "mermaid_runtime_read"]);
});
