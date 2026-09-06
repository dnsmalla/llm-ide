#!/usr/bin/env node
// Cross-implementation conformance gate: the doc track (InfiniteBrain) and
// the merge that joins it to the code track.
//
// Runs BOTH memory generators over one corpus and diffs what they produced:
//
//   doc    Swift  graph-engine-lab --emit-memory <corpus> <out>
//          TS     node bin/graph-kit.js memory <corpus> --out <out>
//   merge  Swift  graph-engine-lab --emit-merge <code> <doc> <chunks> <out>
//          TS     node bin/graph-kit.js merge <code> <doc> <chunks> --out <out>
//
// The merge comparison feeds BOTH sides the same code graph, doc graph and
// chunks, isolating merge logic from code scanning — which is TypeScript/
// JavaScript-only on the plugin side and would otherwise dominate the diff.
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
  // Merge inputs. These exercise the three doc→code cross-link mechanisms
  // against schema/fixtures/merge-code.json: a wikilink to a code symbol
  // (references/EXTRACTED), declared module affinity in several authoring forms
  // (documents/EXTRACTED, including the fan-out cap — `kb` covers 10 files but
  // only 8 may link), and inline backtick mentions (references/INFERRED).
  "merge-wikilink.md":
    "# Merge Wikilink\n\nSee [[backupTo]] and [[Widget]].\n",
  "merge-modules.md":
    "---\nrelated-modules: [kb, ./src, missing/**, .., .]\n---\n" +
    "# Merge Modules\n\nDeclared affinity in several authoring forms.\n",
  // Reaches `backupTo` by wikilink AND by backtick mention. Without this the
  // corpus produced no duplicate cross-link pair at all, so deleting the
  // `crossSeen` de-duplication was a literal no-op on the gate — the precedence
  // rule it enforces went untested.
  "merge-dedup.md":
    "# Merge Dedup\n\nSee [[backupTo]], and also `backupTo` written as a mention.\n",
  "merge-mentions.md":
    "# Merge Mentions\n\nThe `kb/db.mjs` file defines `backupTo`, and `app.ts` uses it.\n\n" +
    "```\n`kb/auth.mjs` must not link from inside a fence\n```\n",
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

/**
 * Multiset difference, not set difference.
 *
 * Comparing as sets made a duplicate invisible: an implementation emitting the
 * same edge twice where the other emits it once produced zero rows of
 * difference. The entire cross-link precedence design rests on de-duplication
 * (`crossSeen`), so counting is the comparison this gate needs.
 */
function diffSets(label, swiftRows, tsRows, out) {
  const count = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r, (m.get(r) ?? 0) + 1);
    return m;
  };
  const swiftCounts = count(swiftRows);
  const tsCounts = count(tsRows);
  const expand = (a, b) => {
    const extra = [];
    for (const [row, n] of a) {
      const surplus = n - (b.get(row) ?? 0);
      for (let i = 0; i < surplus; i++) extra.push(row);
    }
    return extra;
  };
  const swiftOnly = expand(swiftCounts, tsCounts);
  const tsOnly = expand(tsCounts, swiftCounts);
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

  // ---- Merge track -------------------------------------------------------
  //
  // Both implementations are handed the SAME code graph, doc graph and chunks,
  // so this isolates merge logic from code scanning (which is TypeScript/
  // JavaScript-only on the plugin side and would otherwise dominate the diff).
  // The doc side comes from Swift's emission so the inputs are byte-identical.
  const codeFixture = join(ROOT, "schema/fixtures/merge-code.json");
  const swiftPayload = JSON.parse(readFileSync(swiftOut, "utf8"));
  const docOnly = join(work, "doc.json");
  const chunksOnly = join(work, "chunks.json");
  writeFileSync(docOnly, JSON.stringify({
    schemaVersion: swiftPayload.schemaVersion,
    nodes: swiftPayload.nodes, edges: swiftPayload.edges,
    layers: swiftPayload.layers ?? [], tour: swiftPayload.tour ?? [],
  }));
  writeFileSync(chunksOnly, JSON.stringify(swiftPayload.chunks ?? []));

  const swiftMergeOut = join(work, "swift-merge.json");
  const tsMergeOut = join(work, "ts-merge.json");
  execFileSync(
    "swift",
    ["run", "-c", "release", "graph-engine-lab", "--emit-merge",
     codeFixture, docOnly, chunksOnly, swiftMergeOut],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  execFileSync(
    "node",
    ["bin/graph-kit.js", "merge", codeFixture, docOnly, chunksOnly, "--out", tsMergeOut],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
  );

  const swiftMerge = project(JSON.parse(readFileSync(swiftMergeOut, "utf8")));
  const tsMerge = project(JSON.parse(readFileSync(tsMergeOut, "utf8")));
  ok = diffSets("merge nodes", swiftMerge.nodes, tsMerge.nodes, report) && ok;
  ok = diffSets("merge edges", swiftMerge.edges, tsMerge.edges, report) && ok;
  // A merge that produced no cross-links would trivially agree. Assert the
  // corpus actually generated some, so this comparison cannot go vacuous the
  // way the doc track's empty-corpus case could.
  const crossKinds = new Set(["documents"]);
  const crossCount = JSON.parse(readFileSync(swiftMergeOut, "utf8")).edges
    .filter((e) => crossKinds.has(e.kind) || (e.kind === "references" && e.fromId.startsWith("doc:")))
    .length;
  if (crossCount > 0) {
    report.push(`  OK   merge cross-links: ${crossCount} produced`);
  } else {
    report.push("  FAIL merge cross-links: none produced — the comparison is vacuous");
    ok = false;
  }

  console.log(report.join("\n"));
  console.log("\n" + "=".repeat(72));
  if (ok) {
    console.log("PASS - Swift and TypeScript agree on the doc track and the merge\n");
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
