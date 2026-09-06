#!/usr/bin/env node
// Cross-implementation conformance gate for the doc track (InfiniteBrain).
//
// Runs BOTH memory generators over one corpus and diffs what they produced:
//
//   Swift        swift run -c release graph-engine-lab --emit-memory <corpus> <out>
//   TypeScript   node bin/graph-kit.js memory <corpus> --out <out>
//
// Why: `schema/fixtures/*.json` only prove a graph decodes and round-trips.
// They cannot catch the two implementations DISAGREEING — which is exactly how
// the TypeScript port came to silently drop `graph-only` and `related-modules`
// while passing every test it had. Swift's decoder defaults both fields, so a
// divergent plugin produces no error, just a quietly worse graph.
//
// Node ids are comparable by construction: both sides derive a doc id as
// `doc:` + sha256(absolute path)[:16], and a chunk id as
// `<docID>::<sha256(headingPath.join("/"))[:16]>:<index>`.
//
// Usage:  node scripts/conformance-memory.mjs [corpusDir]
// Exit 0 when the implementations agree, 1 otherwise.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Field separator: a control character that cannot occur in a path, id or
 *  title, so concatenated fields never accidentally compare equal across a
 *  field boundary. Rendered as " | " in the report. */
const SEP = "\u0001";

/**
 * A corpus exercising the features that actually differed historically.
 *
 * Every entry earns its place by having caught a real divergence — a corpus
 * that does not exercise a behaviour makes the gate PASS on a broken one, which
 * is how the first version of this file reported agreement while three
 * divergences (fenced headings, nested frontmatter mappings, un-indented block
 * sequences) were live, and a body mismatch sat inside the corpus itself.
 */
const DEFAULT_CORPUS = {
  "plain.md": "# Plain\n\nA body with no frontmatter.\n\n## Nested\n\nMore text.\n",
  "tagged.md":
    "---\ntype: note\ntags: [alpha, beta]\n---\n# Tagged\n\nBody with #gamma inline.\n",
  // graph-only/related-modules reaching chunks at all; also the body-trim
  // difference, since it carries frontmatter.
  "graph-only.md":
    "---\ngraph-only: true\nrelated-modules: [kb, src/app]\n---\n" +
    "# Graph Only\n\nShould be graphed but kept out of memory artifacts.\n",
  // Indented block sequence — the form that DOES yield a list on both sides.
  "modules-block.md":
    "---\nrelated-modules:\n  - kb/db.mjs\n  - ./routes\n---\n# Modules Block\n\nBody.\n",
  // Un-indented block sequence. Valid YAML, but the line parser treats a
  // non-indented line as a new key, so BOTH sides must yield an empty list.
  "modules-flat.md":
    "---\nrelated-modules:\n- kb/db.mjs\n- ./routes\n---\n# Modules Flat\n\nBody.\n",
  // Nested mapping: `graph-only` here belongs to `schema:`, not the document.
  // Promoting it to top level made one side withhold the doc from artifacts.
  "nested-frontmatter.md":
    "---\ntype: note\nschema:\n  graph-only: true\n  tags: [sneaky]\n---\n" +
    "# Nested\n\nBody.\n",
  // Key spellings. Only `graph-only`/`graphOnly` and `related-modules`/
  // `relatedModules` are recognised — case-folding the key made this side
  // accept `GRAPH-ONLY:` and `graphonly:` that Swift ignores, so one engine
  // suppressed a document the other published.
  "key-case.md":
    "---\nType: note\nGRAPH-ONLY: true\nRelated-Modules: [kb]\ngraphonly: true\n---\n" +
    "# Key Case\n\nEvery key here is a spelling neither side should honour.\n",
  // Fenced content must affect neither link/tag extraction nor CHUNKING: a `#`
  // line inside a fence is sample text, and treating it as a heading changes
  // node identity because chunk ids hash the heading path.
  "links.md":
    "# Links\n\nSee [[Plain]] and [[Tagged]] for context.\n\n" +
    "## Fenced\n\n```\n[[NotALink]] and #notatag\n# Not A Real Heading\n```\n\nTail.\n",
};

function buildCorpus(dir) {
  for (const [name, body] of Object.entries(DEFAULT_CORPUS)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

/** Compare only what both sides claim to agree on, normalised. */
function project(payload) {
  const nodes = (payload.nodes ?? [])
    .map((n) => [n.id, n.kind, n.title].join(SEP))
    .sort();
  const edges = (payload.edges ?? [])
    .map((e) => [e.fromId, e.toId, e.kind, e.confidence].join(SEP))
    .sort();
  const chunks = (payload.chunks ?? [])
    .map((c) =>
      [
        c.id,
        // Swift encodes `docURL`, TypeScript `docPath`; the app's decoder
        // accepts either spelling, so identity here is the id, not the path.
        c.kind,
        `graphOnly=${c.graphOnly === true}`,
        `tags=${(c.tags ?? []).join(",")}`,
        `wikiLinks=${(c.wikiLinks ?? []).join(",")}`,
        `relatedModules=${(c.relatedModules ?? []).join(",")}`,
        `headingPath=${(c.headingPath ?? []).join("/")}`,
        // Body is compared, not just metadata. Omitting it hid a live
        // divergence: one side trimmed the text after the frontmatter fence and
        // the other did not, so three of seven chunks differed while this gate
        // printed PASS. JSON-encoded so leading/trailing whitespace is visible
        // in the report rather than invisibly equal-looking.
        `body=${JSON.stringify(c.body ?? "")}`,
      ].join(SEP),
    )
    .sort();
  return { nodes, edges, chunks, docCount: payload.docCount ?? 0 };
}

const show = (row) => row.split(SEP).join(" | ");

function diffSets(label, swiftRows, tsRows, out) {
  const inTs = new Set(tsRows);
  const inSwift = new Set(swiftRows);
  const swiftOnly = swiftRows.filter((x) => !inTs.has(x));
  const tsOnly = tsRows.filter((x) => !inSwift.has(x));
  if (swiftOnly.length === 0 && tsOnly.length === 0) {
    out.push(`  OK   ${label}: ${swiftRows.length} identical`);
    return true;
  }
  out.push(`  FAIL ${label}: ${swiftOnly.length} Swift-only, ${tsOnly.length} TypeScript-only`);
  for (const x of swiftOnly.slice(0, 8)) out.push(`         swift only  ${show(x)}`);
  for (const x of tsOnly.slice(0, 8)) out.push(`         ts only     ${show(x)}`);
  const shown = Math.min(swiftOnly.length, 8) + Math.min(tsOnly.length, 8);
  const hidden = swiftOnly.length + tsOnly.length - shown;
  if (hidden > 0) out.push(`         ... ${hidden} more`);
  return false;
}

const work = mkdtempSync(join(tmpdir(), "gk-conformance-"));
let ok = false;
try {
  const corpusArg = process.argv[2];
  const corpus = corpusArg ? resolve(corpusArg) : join(work, "corpus");
  if (!corpusArg) {
    mkdirSync(corpus, { recursive: true });
    buildCorpus(corpus);
  }

  const swiftOut = join(work, "swift.json");
  const tsOut = join(work, "ts.json");
  console.log(`corpus: ${corpus}\n`);

  // Release build: this runs from `make`, and a debug MemoryGenerator over a
  // large corpus is needlessly slow.
  execFileSync(
    "swift",
    ["run", "-c", "release", "graph-engine-lab", "--emit-memory", corpus, swiftOut],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  execFileSync("node", ["bin/graph-kit.js", "memory", corpus, "--out", tsOut],
               { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });

  const swift = project(JSON.parse(readFileSync(swiftOut, "utf8")));
  const ts = project(JSON.parse(readFileSync(tsOut, "utf8")));

  const report = [];
  // An empty corpus makes every comparison below trivially true. Without this
  // the documented "point it at your own corpus" usage proves nothing on a
  // mistyped or empty path, and exits 0 while doing so.
  ok = true;
  if (swift.docCount === 0 && ts.docCount === 0) {
    report.push("  FAIL corpus: no documents found — the comparison would be vacuous");
    ok = false;
  }
  ok = diffSets("nodes", swift.nodes, ts.nodes, report) && ok;
  ok = diffSets("edges", swift.edges, ts.edges, report) && ok;
  ok = diffSets("chunks", swift.chunks, ts.chunks, report) && ok;
  if (swift.docCount === ts.docCount) {
    report.push(`  OK   docCount: ${swift.docCount} identical`);
  } else {
    report.push(`  FAIL docCount: swift=${swift.docCount} ts=${ts.docCount}`);
    ok = false;
  }

  console.log(report.join("\n"));
  console.log("\n" + "=".repeat(72));
  if (ok) {
    console.log("PASS - Swift and TypeScript doc tracks agree\n");
  } else {
    // Copy the artifacts somewhere durable before the temp dir is removed, so
    // a failure can actually be inspected.
    const keep = mkdtempSync(join(tmpdir(), "gk-conformance-failed-"));
    writeFileSync(join(keep, "swift.json"), readFileSync(swiftOut));
    writeFileSync(join(keep, "ts.json"), readFileSync(tsOut));
    console.log("FAIL - implementations diverge\n");
    console.log(`  artifacts: ${keep}\n`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
