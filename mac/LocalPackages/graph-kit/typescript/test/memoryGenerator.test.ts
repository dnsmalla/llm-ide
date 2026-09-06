import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateFromDir,
  extractWikiLinks,
  extractHashtags,
  classify,
  containsWholeWord,
  strippingFencedBlocks,
  docIdentity,
} from "../src/text/memoryGenerator.js";
import { generateIndex } from "../src/indexGenerator.js";

function withTempVault(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gk-mem-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("chunks by heading and links chunks to their doc", () => {
  withTempVault(
    {
      "notes.md": "# Alpha\nbody about alpha\n\n## Beta\nbody about beta\n",
    },
    (dir) => {
      const { graph, chunks, docCount } = generateFromDir(dir);
      assert.equal(docCount, 1);
      // 1 doc node + 2 chunk nodes
      assert.equal(graph.nodes.filter((n) => n.kind === "memoryDoc").length, 1);
      assert.equal(chunks.length, 2);
      assert.deepEqual(chunks.map((c) => c.title).sort(), ["Alpha", "Beta"]);
      // The doc `contains` each of its chunks — parent→child, matching the
      // code track's file→symbol convention and the Swift implementation.
      // This used to be `chunk → doc` as `relatedTo`, which made a document's
      // backbone indistinguishable from title-match noise, so any consumer
      // filtering edges by strength left every chunk isolated.
      const docId = graph.nodes.find((n) => n.kind === "memoryDoc")!.id;
      assert.equal(
        graph.edges.filter((e) => e.fromId === docId && e.kind === "contains").length,
        2,
      );
      assert.equal(
        graph.edges.filter((e) => e.toId === docId && e.kind === "relatedTo").length,
        0,
        "containment must not be emitted as relatedTo",
      );
    },
  );
});

test("wiki-links create references edges between chunks", () => {
  withTempVault(
    {
      "a.md": "# Topic A\nSee [[Topic B]] for details.\n",
      "b.md": "# Topic B\nThe other topic.\n",
    },
    (dir) => {
      const { graph } = generateFromDir(dir);
      const a = graph.nodes.find((n) => n.title === "Topic A")!;
      const b = graph.nodes.find((n) => n.title === "Topic B")!;
      assert.ok(
        graph.edges.some((e) => e.fromId === a.id && e.toId === b.id && e.kind === "references"),
        "expected a references edge from Topic A to Topic B",
      );
    },
  );
});

test("frontmatter type sets chunk kind", () => {
  withTempVault(
    { "d.md": "---\ntype: decision\ntags: [arch, db]\n---\n# Use Postgres\nWe chose Postgres.\n" },
    (dir) => {
      const { chunks } = generateFromDir(dir);
      const chunk = chunks.find((c) => c.title === "Use Postgres")!;
      assert.equal(chunk.kind, "noteDecision");
      assert.deepEqual(chunk.tags, ["arch", "db"]);
    },
  );
});

test("heading heuristic classifies a question chunk", () => {
  assert.equal(classify("Open Question", ""), "noteQuestion");
  assert.equal(classify("How to deploy", ""), "notePlaybook");
  assert.equal(classify("Random", "- [ ] do a thing\n"), "noteTask");
  assert.equal(classify("Random", "nothing special"), null);
});

test("extractors and whole-word matching", () => {
  assert.deepEqual(extractWikiLinks("a [[Foo]] and [[Bar|alias]] b"), ["Foo", "Bar"]);
  assert.deepEqual(extractHashtags("text #alpha and (#beta) not #1"), ["alpha", "beta"]);
  assert.equal(containsWholeWord("the postgres database", "postgres"), true);
  assert.equal(containsWholeWord("postgresql", "postgres"), false);
});

test("generateIndex renders stats and containers", () => {
  withTempVault({ "notes.md": "# Alpha\nbody\n\n## Beta\nmore\n" }, (dir) => {
    const { graph } = generateFromDir(dir);
    const md = generateIndex(graph, { title: "Memory Index" });
    assert.match(md, /# Memory Index/);
    assert.match(md, /\*\*Nodes:\*\*/);
    assert.match(md, /## Containers/);
  });
});

test("skips vendor and build directories (node_modules, dist, build, vendor, coverage)", () => {
  withTempVault(
    {
      "real.md": "# Real\nproject doc\n",
      "node_modules/pkg/README.md": "# Vendor\nshould not be indexed\n",
      "apps/web/node_modules/lib/CHANGELOG.md": "# Vendor nested\nskip me\n",
      "dist/out.md": "# Dist\nskip\n",
      "build/notes.md": "# Build\nskip\n",
      "vendor/doc.md": "# Vendored\nskip\n",
      "coverage/report.md": "# Coverage\nskip\n",
      "docs/guide.md": "# Guide\nkeep me\n",
    },
    (dir) => {
      const { graph, docCount } = generateFromDir(dir);
      assert.equal(docCount, 2);
      const titles = graph.nodes.filter((n) => n.kind === "memoryDoc").map((n) => n.title).sort();
      assert.deepEqual(titles, ["guide", "real"]);
    },
  );
});

// --------------------------------------------------------------------------
// Swift parity: `graph-only` and `related-modules`
//
// These two frontmatter keys drive real behaviour on the Swift side —
// `graphOnly` keeps a doc out of the agent-facing memory artifacts, and
// `relatedModules` is what the merge step turns into documents/EXTRACTED
// doc→code edges. The port dropped both, and because Swift's decoder defaults
// them (`false` / `[]`) a plugin emitting chunks without them degraded
// SILENTLY: no error, just zero declared-module edges and graph-only docs
// leaking into memory artifacts.
// --------------------------------------------------------------------------

test("frontmatter graph-only and related-modules reach every chunk", () => {
  withTempVault(
    {
      "spec.md":
        "---\ntype: note\ngraph-only: true\nrelated-modules: [kb, src/app]\n---\n" +
        "# Title\n\nBody one.\n\n## Sub\n\nBody two.\n",
    },
    (dir) => {
      const { chunks } = generateFromDir(dir);
      assert.ok(chunks.length >= 2, "expected a chunk per heading");
      for (const chunk of chunks) {
        assert.equal(chunk.graphOnly, true, `graphOnly on ${chunk.title}`);
        assert.deepEqual(chunk.relatedModules, ["kb", "src/app"]);
      }
    },
  );
});

test("related-modules accepts a YAML block sequence", () => {
  withTempVault(
    { "a.md": "---\nrelated-modules:\n  - kb/db.mjs\n  - ./routes\n---\n# T\n\nBody.\n" },
    (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      // Case and authoring form are preserved here; normalising `./routes` to a
      // repo-relative prefix is the merge step's job, as it is in Swift.
      assert.deepEqual(chunk!.relatedModules, ["kb/db.mjs", "./routes"]);
    },
  );
});

test("graph-only accepts the YAML boolean spellings Swift accepts", () => {
  for (const [raw, expected] of [["true", true], ["yes", true], ["1", true],
                                 ["false", false], ["no", false], ["maybe", false]] as const) {
    withTempVault({ "a.md": `---\ngraph-only: ${raw}\n---\n# T\n\nBody.\n` }, (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      assert.equal(chunk!.graphOnly, expected, `graph-only: ${raw}`);
    });
  }
});

test("absent frontmatter keys default the way Swift defaults them", () => {
  withTempVault({ "a.md": "# T\n\nBody.\n" }, (dir) => {
    const [chunk] = generateFromDir(dir).chunks;
    assert.equal(chunk!.graphOnly, false);
    assert.deepEqual(chunk!.relatedModules, []);
  });
});

// --------------------------------------------------------------------------
// Swift parity: fenced code blocks are not scanned
//
// Swift strips fences before extracting wikilinks, hashtags, and before the
// whole-word title fallback. The port scanned raw bodies, so a `[[Foo]]` or
// `#bar` quoted inside a code sample manufactured edges and tags the document
// never meant. Caught by scripts/conformance-memory.mjs.
// --------------------------------------------------------------------------

test("wikilinks and hashtags inside fenced blocks are ignored", () => {
  withTempVault(
    {
      "real.md": "# Real\n\nA target chunk.\n",
      "doc.md":
        "# Doc\n\nSee [[Real]] here.\n\n## Sample\n\n```\n[[Ghost]] and #ghosttag\n```\n\nTail.\n",
    },
    (dir) => {
      const { chunks } = generateFromDir(dir);
      const sample = chunks.find((c) => c.title === "Sample")!;
      assert.deepEqual(sample.wikiLinks, [], "fenced [[Ghost]] must not be a link");
      assert.ok(!sample.tags.includes("ghosttag"), "fenced #ghosttag must not be a tag");
      // The unfenced link on the same document still works.
      const doc = chunks.find((c) => c.title === "Doc")!;
      assert.deepEqual(doc.wikiLinks, ["Real"]);
    },
  );
});

test("strippingFencedBlocks handles both fence markers", () => {
  assert.equal(strippingFencedBlocks("a\n```\nhidden\n```\nb"), "a\nb");
  assert.equal(strippingFencedBlocks("a\n~~~\nhidden\n~~~\nb"), "a\nb");
  assert.equal(strippingFencedBlocks("no fences here"), "no fences here");
});

// --------------------------------------------------------------------------
// Swift parity: doc ids hash the REAL path
//
// Swift derives the id from `URL.path`, which is symlink-resolved. Resolving
// only `..`/`.` made the two implementations id the same file differently
// whenever a symlink sat in the tree — on macOS `/var` -> `/private/var` is
// enough — silently breaking every join on node ids.
// --------------------------------------------------------------------------

test("doc identity resolves symlinks", () => {
  withTempVault({ "a.md": "# A\n\nBody.\n" }, (dir) => {
    const linkDir = mkdtempSync(join(tmpdir(), "gk-link-"));
    const link = join(linkDir, "linked");
    try {
      symlinkSync(dir, link);
      const direct = docIdentity(join(dir, "a.md"));
      const viaLink = docIdentity(join(link, "a.md"));
      assert.equal(viaLink.docID, direct.docID, "same file must get the same id");
      assert.equal(viaLink.abs, direct.abs);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Swift parity: fences gate CHUNKING, not just extraction
//
// A `#` line inside a code fence is sample text. Treated as a heading it
// creates a chunk in one implementation and not the other — and because chunk
// ids hash the heading path, that changes node identity, not just content.
// --------------------------------------------------------------------------

test("a heading-looking line inside a fence does not split a chunk", () => {
  withTempVault(
    { "a.md": "# Real\n\nBefore.\n\n```\n# Not A Real Heading\n```\n\nAfter.\n" },
    (dir) => {
      const { chunks } = generateFromDir(dir);
      assert.equal(chunks.length, 1, "the fenced heading must not open a chunk");
      assert.deepEqual(chunks[0]!.headingPath, ["Real"]);
      assert.ok(chunks[0]!.body.includes("# Not A Real Heading"),
                "fenced text stays in the body");
    },
  );
});

// --------------------------------------------------------------------------
// Swift parity: frontmatter indentation means continuation
//
// Matching a trimmed line promoted keys nested under another mapping to top
// level, so a `schema:` block containing `graph-only: true` made this
// implementation withhold a document that Swift kept. Skill and agent files
// carry exactly that shape.
// --------------------------------------------------------------------------

test("keys nested under another mapping are not read as top level", () => {
  withTempVault(
    {
      "a.md":
        "---\ntype: note\nschema:\n  graph-only: true\n  tags: [sneaky]\n---\n# T\n\nBody.\n",
    },
    (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      assert.equal(chunk!.graphOnly, false, "nested graph-only must not apply to the doc");
      assert.ok(!chunk!.tags.includes("sneaky"), "nested tags must not apply to the doc");
    },
  );
});

test("a non-indented block sequence yields an empty list, as in Swift", () => {
  withTempVault(
    { "a.md": "---\nrelated-modules:\n- kb/db.mjs\n---\n# T\n\nBody.\n" },
    (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      assert.deepEqual(chunk!.relatedModules, []);
    },
  );
});

test("the document text after a frontmatter fence is trimmed", () => {
  // The trim applies to the document body, not to each chunk: a chunk
  // legitimately begins with the newline that followed its heading. What it
  // removes is the trailing newline the closing fence left behind, which is
  // what made every frontmatter-bearing chunk differ from Swift's.
  withTempVault({ "a.md": "---\ntype: note\n---\n# T\n\nBody.\n" }, (dir) => {
    const [chunk] = generateFromDir(dir).chunks;
    assert.equal(chunk!.body, "\nBody.");
  });
});

// --------------------------------------------------------------------------
// Swift parity: frontmatter keys are case-SENSITIVE
//
// Swift stores keys verbatim and looks up only the documented spellings.
// Lowercasing the key here made this implementation honour `GRAPH-ONLY:` and
// `graphonly:` that Swift ignores — the same doc-suppression divergence the
// ported parser exists to close, reintroduced by the port itself.
// --------------------------------------------------------------------------

test("only the documented key spellings are honoured", () => {
  for (const key of ["GRAPH-ONLY", "Graph-Only", "graphonly", "GraphOnly"]) {
    withTempVault({ "a.md": `---\n${key}: true\n---\n# T\n\nBody.\n` }, (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      assert.equal(chunk!.graphOnly, false, `${key} must not be honoured`);
    });
  }
  // Both documented spellings still work.
  for (const key of ["graph-only", "graphOnly"]) {
    withTempVault({ "a.md": `---\n${key}: true\n---\n# T\n\nBody.\n` }, (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      assert.equal(chunk!.graphOnly, true, `${key} must be honoured`);
    });
  }
});

test("related-modules and type follow the same case rule", () => {
  withTempVault(
    { "a.md": "---\nType: note\nRelated-Modules: [kb]\n---\n# T\n\nBody.\n" },
    (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      assert.deepEqual(chunk!.relatedModules, [], "Related-Modules is not a recognised key");
    },
  );
  withTempVault(
    { "a.md": "---\nrelatedModules: [kb]\n---\n# T\n\nBody.\n" },
    (dir) => {
      const [chunk] = generateFromDir(dir).chunks;
      assert.deepEqual(chunk!.relatedModules, ["kb"], "camelCase spelling is documented");
    },
  );
});
