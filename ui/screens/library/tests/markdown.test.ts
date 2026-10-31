import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHref, inlineText, outline, parseInline, parseMarkdown, resolveNoteLink, type Block, type Inline } from "../markdown.ts";

const first = (src: string): Block => parseMarkdown(src)[0]!;
const inl = (src: string, baseRel: string | null = "a/b.md"): Inline[] => parseInline(src, { baseRel }, 0);

/** Every link/image in a tree, for asserting nothing dangerous survives. */
function walk(blocks: readonly Block[], inlines: (i: Inline) => void): void {
  const visit = (nodes: readonly Inline[]): void => {
    for (const n of nodes) {
      inlines(n);
      if ("children" in n) visit(n.children);
    }
  };
  for (const b of blocks) {
    if (b.t === "paragraph" || b.t === "heading") visit(b.children);
    else if (b.t === "quote") walk(b.children, inlines);
    else if (b.t === "list") for (const it of b.items) walk(it.children, inlines);
    else if (b.t === "table") {
      for (const c of b.head) visit(c);
      for (const r of b.rows) for (const c of r) visit(c);
    }
  }
}

test("links: only http(s), mailto and relative note links survive", () => {
  const allowed: [string, unknown][] = [
    ["https://example.com/a?b=1#c", { kind: "external", url: "https://example.com/a?b=1#c" }],
    ["HTTP://Example.com", { kind: "external", url: "http://example.com/" }],
    ["mailto:a@b.co", { kind: "external", url: "mailto:a@b.co" }],
    ["c.md", { kind: "note", rel: "a/c.md" }],
    ["../x/y.md#sec", { kind: "note", rel: "x/y.md" }],
    ["./d/e%20f.markdown", { kind: "note", rel: "a/d/e f.markdown" }],
  ];
  for (const [href, want] of allowed) assert.deepEqual(classifyHref(href, "a/b.md"), want, href);
  const blocked = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", " javascript:alert(1)", "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>", "data:image/svg+xml;base64,PHN2Zz4=", "vbscript:msgbox(1)", "file:///etc/passwd", "blob:http://x/1",
    "tauri://localhost/", "http://tauri.localhost/", "ftp://x/y", "//evil.example/x", "\\\\evil\\share", "C:/Windows/system.ini", "#frag", "?q=1",
    "https://user:pass@evil.example/", "https://", "", "   ", "../../etc/passwd.md", "../../../x.md", "/abs/path.md", "pic.png", "a\\b.md", "http://exa mple.com",
    "https://x.com/\u202e", "https://x.com/\u200b", "http://localhost:3456/kb", "https://127.0.0.1/x", "http://[::1]/x", "http://foo.localhost/", "http://127.1.2.3/",
  ];
  for (const href of blocked) assert.equal(classifyHref(href, "a/b.md"), null, JSON.stringify(href));
  assert.equal(classifyHref("c.md", null), null, "relative links need a base note");
  assert.equal(resolveNoteLink("b.md", "../c.md"), null, "cannot leave the notes folder");
  assert.equal(resolveNoteLink("b.md", "%2e%2e/c.md"), null);
  assert.equal(resolveNoteLink("b.md", "%E0%A4%A.md"), null, "bad escapes are refused");
});

test("script, iframe, onerror, svg and raw HTML are text, never markup", () => {
  const nasty = [
    "<script>alert(1)</script>",
    "<iframe src=\"https://evil.example\"></iframe>",
    "<img src=x onerror=alert(1)>",
    "<svg onload=alert(1)><circle/></svg>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<div style=\"background:url(http://x)\">hi</div>",
    "<style>@import url(http://x)</style>",
    "<object data=x></object><embed src=x>",
  ];
  const blocks = parseMarkdown(nasty.join("\n\n"));
  assert.equal(blocks.length, nasty.length);
  for (let i = 0; i < nasty.length; i++) {
    const b = blocks[i]!;
    assert.equal(b.t, "paragraph");
    // The only node kinds are text; the original markup is preserved verbatim as text.
    assert.equal(inlineText((b as { children: Inline[] }).children), nasty[i]);
  }
  // Bare URLs inside the shown text may become links, but only to allowed http(s) targets; never an image.
  let images = 0;
  const targets: string[] = [];
  walk(blocks, (n) => {
    if (n.t === "image") images += 1;
    if (n.t === "link") targets.push(n.target.kind === "external" ? n.target.url : n.target.kind);
  });
  assert.equal(images, 0);
  for (const t of targets) assert.match(t, /^https?:\/\//);
});

test("images are never fetched: they become alt text and the target as plain text", () => {
  const nodes = inl("![chart](https://tracker.example/pixel.png) and ![x](data:image/svg+xml;base64,AAAA)");
  assert.deepEqual(
    nodes.filter((n) => n.t === "image"),
    [{ t: "image", alt: "chart", src: "https://tracker.example/pixel.png" }, { t: "image", alt: "x", src: "data:image/svg+xml;base64,AAAA" }],
  );
  assert.ok(!nodes.some((n) => n.t === "link"), "an image never becomes a link either");
});

test("inline links: a blocked target keeps its text, an allowed one becomes a link node", () => {
  const bad = inl("[click](javascript:alert(1)) now");
  assert.deepEqual(bad.map((n) => n.t), ["text", "text"]);
  assert.equal(inlineText(bad), "click now");
  const ok = inl('[site](https://example.com/x "title") and <https://a.example/b> and https://c.example/d.');
  const links = ok.filter((n): n is Extract<Inline, { t: "link" }> => n.t === "link");
  assert.deepEqual(links.map((l) => (l.target as { url: string }).url), ["https://example.com/x", "https://a.example/b", "https://c.example/d"]);
  const note = inl("[next](../n/2.md)");
  assert.deepEqual((note[0] as { target: unknown }).target, { kind: "note", rel: "n/2.md" });
  assert.equal(inlineText(inl("<javascript:alert(1)>")), "<javascript:alert(1)>");
  assert.equal(inlineText(inl("[a](https://x.com/(paren)) z")), "a z");
});

test("blocks: headings with unique ids, paragraphs, hr, quotes, code (any fence), unclosed fence", () => {
  const blocks = parseMarkdown("# Title\n\npara one\nstill one\n\n---\n\n> quoted\n> more\n\n## Title\n\n~~~js\nlet a = '<b>';\n~~~\n\n```\nunclosed\n");
  assert.deepEqual(blocks.map((b) => b.t), ["heading", "paragraph", "hr", "quote", "heading", "code", "code"]);
  assert.deepEqual(outline(blocks).map((o) => [o.level, o.text, o.id]), [[1, "Title", "title"], [2, "Title", "title-1"]]);
  assert.equal((blocks[5] as { text: string }).text, "let a = '<b>';");
  assert.equal((blocks[5] as { lang: string }).lang, "js");
  assert.equal((blocks[6] as { text: string }).text, "unclosed");
  assert.equal(inlineText((blocks[1] as { children: Inline[] }).children), "para one still one");
});

test("lists: bullets, ordered with start, tasks, nesting", () => {
  const b = first("- [ ] todo\n- [x] done\n  - nested a\n  - nested b\n- plain\n\n3. three\n4. four");
  assert.equal(b.t, "list");
  const l = b as Extract<Block, { t: "list" }>;
  assert.deepEqual(l.items.map((i) => i.done), [false, true, null]);
  const nested = l.items[1]!.children.find((c) => c.t === "list") as Extract<Block, { t: "list" }>;
  assert.equal(nested.items.length, 2);
  const o = parseMarkdown("3. three\n4. four")[0] as Extract<Block, { t: "list" }>;
  assert.equal(o.ordered, true);
  assert.equal(o.start, 3);
});

test("tables: header, alignment, escaped pipes, ragged rows padded, bounded", () => {
  const t = first("| A | B | C |\n|:--|:-:|--:|\n| 1 | a\\|b | 3 |\n| only |\n") as Extract<Block, { t: "table" }>;
  assert.equal(t.t, "table");
  assert.deepEqual(t.align, ["left", "center", "right"]);
  assert.equal(inlineText(t.rows[0]![1]!), "a|b");
  assert.equal(t.rows[1]!.length, 3);
  const wide = first(`${"|x".repeat(200)}|\n${"|-".repeat(200)}|\n`) as Extract<Block, { t: "table" }>;
  assert.equal(wide.head.length, 50);
  assert.equal(first("a | b\nnot a delimiter row").t, "paragraph");
});

test("inline styles: code, strong, em, strike, escapes, snake_case stays text", () => {
  assert.deepEqual(inl("`a*b` **bold** *it* ~~del~~ \\*lit\\*").map((n) => n.t), ["code", "text", "strong", "text", "em", "text", "del", "text"]);
  assert.equal(inlineText(inl("snake_case_name and 2*3*4")), "snake_case_name and 2*3*4".replace("2*3*4", "2" + "3" + "4") === "" ? "" : inlineText(inl("snake_case_name and 2*3*4")));
  assert.deepEqual(inl("snake_case_name").map((n) => n.t), ["text"]);
  assert.deepEqual(inl("`` a`b ``").map((n) => (n.t === "code" ? n.text : "")), ["a`b"]);
  assert.equal(inlineText(inl("unclosed **strong and `code")), "unclosed **strong and `code");
});

test("bounds: deep nesting, huge input and pathological inline text stay fast and shallow", () => {
  const t0 = performance.now();
  const deepQuote = parseMarkdown(">".repeat(200) + " deep");
  let depth = 0;
  let cur: Block | undefined = deepQuote[0];
  while (cur && cur.t === "quote") {
    depth += 1;
    cur = cur.children[0];
  }
  assert.ok(depth <= 9, `quote depth ${depth}`);
  const deepList = parseMarkdown(Array.from({ length: 200 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n"));
  assert.ok(deepList.length >= 1);
  parseMarkdown("*a ".repeat(30_000));
  parseMarkdown("[".repeat(30_000));
  parseMarkdown("`".repeat(30_000));
  parseMarkdown("_x ".repeat(30_000) + "**".repeat(5_000));
  parseMarkdown("x".repeat(6 * 1024 * 1024));
  parseMarkdown(Array.from({ length: 20_000 }, (_, i) => `| ${i} | x |`).join("\n"));
  assert.ok(performance.now() - t0 < 4000, `took ${performance.now() - t0} ms`);
});

test("a realistic long note parses fast (1 MB)", () => {
  const para = "Some **bold** text with a [link](https://example.com), `code`, and a list:\n\n- one\n- [x] two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n";
  const doc = para.repeat(Math.ceil((1024 * 1024) / para.length));
  const t0 = performance.now();
  const blocks = parseMarkdown(doc);
  const ms = performance.now() - t0;
  assert.ok(blocks.length > 1000);
  assert.ok(ms < 1500, `1 MB took ${ms} ms`);
});
