import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateFromDir,
  extractWikiLinks,
  extractHashtags,
  classify,
  containsWholeWord,
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
      // each chunk → doc via relatedTo
      const docId = graph.nodes.find((n) => n.kind === "memoryDoc")!.id;
      assert.equal(graph.edges.filter((e) => e.toId === docId && e.kind === "relatedTo").length, 2);
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
