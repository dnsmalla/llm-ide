import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("markdown"); });
const render = (text, props = {}) => renderToStaticMarkup(h(c.Markdown, { text, ...props }));

test("safeHref allows http, https, mailto only", () => {
  assert.equal(c.safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(c.safeHref("http://example.com"), "http://example.com/");
  assert.equal(c.safeHref("mailto:a@b.co"), "mailto:a@b.co");
  for (const bad of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>",
    "vbscript:x", "file:///etc/passwd", "tauri://localhost", "ipc://x", "//evil.com", "/relative", "https://good.com@evil.com", "https://", "",
    "https://exa mple.com", "https:\\\\evil.com", "https://x.com/" + "a".repeat(3000),
  ]) assert.equal(c.safeHref(bad), null, JSON.stringify(bad));
});

test("script, iframe, img and event-handler text is rendered as text, never as elements", () => {
  const out = render('<script>alert(1)</script>\n\n<iframe src="https://evil"></iframe>\n\n<img src=x onerror=alert(1)>\n\n<a href="javascript:alert(1)" onclick="x()">hi</a>');
  assert.ok(!/<script|<iframe|<img/.test(out), out);
  assert.ok(!out.includes("href=\"javascript"), out);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("markdown images are never loaded: alt text only", () => {
  const out = render("![logo](https://evil.example/track.png) and ![](x)");
  assert.ok(!out.includes("<img") && !out.includes("evil.example"), out);
  assert.match(out, /\[image: logo\]/);
});

test("links: safe ones call the host opener, unsafe ones keep only the label", () => {
  const ok = render("[docs](https://example.com/x)", { onOpenLink: () => {} });
  assert.match(ok, /<a href="https:\/\/example.com\/x" rel="noopener noreferrer"/);
  const bad = render("[click](javascript:alert(1)) [file](file:///etc/passwd)", { onOpenLink: () => {} });
  assert.ok(!bad.includes("<a "), bad);
  assert.match(bad, /click/);
  const inert = render("[docs](https://example.com)");
  assert.ok(!inert.includes("<a "), "without a host opener links are inert text");
});

test("fenced code keeps its content verbatim, with a labelled copy button when the host can copy", () => {
  const out = render("```js\nconst a = '<b>';\n```", { onCopy: () => {} });
  assert.match(out, /<pre[^>]*><code>const a = &#x27;&lt;b&gt;&#x27;;<\/code><\/pre>/);
  assert.match(out, /aria-label="Copy code"/);
  assert.ok(!render("```js\nx\n```").includes("Copy code"));
});

test("an unclosed fence (a stream mid-code) runs to the end", () => {
  const blocks = c.parseBlocks("text\n\n```py\nprint(1)\nprint(2)");
  assert.equal(blocks.at(-1).kind, "code");
  assert.equal(blocks.at(-1).text, "print(1)\nprint(2)");
});

test("tables, lists, headings, quotes, rules, emphasis", () => {
  const out = render("# T\n\n| a | b |\n|---|---|\n| 1 | **2** |\n\n- x\n- y\n\n1. one\n\n> q\n\n---\n\n*em* and `code`");
  for (const re of [/<h3>T<\/h3>/, /<th scope="col">a<\/th>/, /<td><strong>2<\/strong><\/td>/, /<ul><li>x<\/li><li>y<\/li><\/ul>/, /<ol><li>one<\/li><\/ol>/, /<blockquote>q<\/blockquote>/, /<hr\/>/, /<em>em<\/em>/, /<code>code<\/code>/]) assert.match(out, re);
});

test("pathological input stays bounded", () => {
  const t = Date.now();
  c.parseBlocks(("[" .repeat(20000)) + "\n" + "*".repeat(20000) + "\n" + "`".repeat(5000));
  c.parseBlocks("a".repeat(500000));
  assert.ok(Date.now() - t < 2000);
});

// --- hostile input: parse cost is bounded ------------------------------------------------------------------

const timed = (fn) => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r]; };
const BUDGET_MS = 1500; // generous for slow CI; the unbounded versions take tens of seconds to minutes

test("hostile text parses within a time budget: bracket floods, unclosed links, backticks, stars, whitespace lines", () => {
  const MB = 1024 * 1024;
  const cases = {
    "[ flood": "[".repeat(MB),
    "![ flood": "![".repeat(MB / 2),
    "unclosed links": "[a](".repeat(MB / 4),
    "unclosed links with label text": "[abc](http://x".repeat(MB / 14),
    "backticks": "`a ".repeat(MB / 3),
    "stars": "*a ".repeat(MB / 3),
    "bold openers": "**a ".repeat(MB / 4),
    "underscores": "_a ".repeat(MB / 3),
    "table sep + spaces": `| a |\n-${" ".repeat(MB)}x\n`,
    "fence + spaces": "```" + " ".repeat(MB) + "x\n",
    "rule + spaces": "---" + " ".repeat(MB) + "x",
    "many paragraphs": "a\n\n".repeat(MB / 3),
  };
  for (const [name, text] of Object.entries(cases)) {
    const [ms] = timed(() => c.parseBlocks(text));
    assert.ok(ms < BUDGET_MS, `${name}: ${Math.round(ms)} ms`);
  }
});

test("hostile input stays correct: normal markdown after the budget is spent is still safe text, links stay allowlisted", () => {
  const blocks = c.parseBlocks("[".repeat(100_000) + "\n\n[ok](https://example.com) and [bad](javascript:alert(1))");
  const links = JSON.stringify(blocks).match(/"kind":"link","href":"[^"]*"/g) ?? [];
  assert.ok(links.every((l) => /"href":"https?:/.test(l)), "no unsafe link element, whatever the budget did");
  const small = c.parseBlocks("[ok](https://example.com) **b** *i* `c`");
  assert.deepEqual(small[0].inlines.map((x) => x.kind), ["link", "text", "strong", "text", "em", "text", "code"]);
});
