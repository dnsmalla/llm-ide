#!/usr/bin/env node
// graph-kit CLI — language-neutral entry point so non-Swift tools can produce and
// consume the canonical graph via JSON. Commands:
//
//   graph-kit memory <dir> [--out graph.json] [--index index.md]
//       Build a text→memory graph from a folder of markdown/text files.
//   graph-kit index <graph.json> [--out index.md]
//       Render a markdown index from a canonical graph document.
//   graph-kit merge <code.json> <doc.json> <chunks.json> [--out graph.json]
//       Join a code graph and a doc graph, adding doc→code cross-links. This is
//       the `merge` command a host's plugin manifest declares; without it a host
//       can only union the two tracks, losing every cross-link.
//   graph-kit validate <graph.json>
//       Validate a graph document against the canonical schema (exit 1 on failure).

import { readFileSync, writeFileSync, watch } from "node:fs";
import { generateFromDir } from "./text/memoryGenerator.js";
import { generateIndex } from "./indexGenerator.js";
import { parseDocumentString, serializeDocument, toDocument, toGraph } from "./models.js";
import { updateMemory, type UpdateReport } from "./incremental.js";
import { scanCode } from "./code/tsScanner.js";
import { mergeCodeAndDoc, type MergeChunk } from "./build/graphMerger.js";

function fail(msg: string): never {
  process.stderr.write(`graph-kit: ${msg}\n`);
  process.exit(1);
}

function optValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function cmdMemory(args: string[]): void {
  const dir = args[0];
  if (!dir || dir.startsWith("--")) fail("usage: graph-kit memory <dir> [--out f] [--index f]");
  const result = generateFromDir(dir);
  const doc = toDocument(result.graph);
  // Emit the chunks and the doc count alongside the canonical document.
  //
  // They were computed and then dropped, so a consumer got the graph but no
  // chunk bodies — and doc→code cross-linking needs the chunks (it resolves
  // inline code mentions inside chunk bodies), as does any UI that shows a
  // section's text. The extra keys are additive: a reader that only knows the
  // canonical graph schema ignores them.
  const payload = { ...doc, chunks: result.chunks, docCount: result.docCount };
  const json = JSON.stringify(payload, null, 2) + "\n";
  const outPath = optValue(args, "--out");
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json);
  const indexPath = optValue(args, "--index");
  if (indexPath) writeFileSync(indexPath, generateIndex(result.graph, { title: "Memory Index" }));
  process.stderr.write(
    `graph-kit: ${result.docCount} doc(s) → ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges\n`,
  );
}

function cmdIndex(args: string[]): void {
  const file = args[0];
  if (!file || file.startsWith("--")) fail("usage: graph-kit index <graph.json> [--out f]");
  const doc = parseDocumentString(readFileSync(file, "utf8"));
  const md = generateIndex(toGraph(doc), { title: "Graph Index" });
  const outPath = optValue(args, "--out");
  if (outPath) writeFileSync(outPath, md);
  else process.stdout.write(md);
}

function reportLine(r: UpdateReport): string {
  return `graph-kit: +${r.added.length} ~${r.updated.length} =${r.unchanged.length} -${r.removed.length} → ${r.nodes} nodes, ${r.edges} edges (${r.outDir})`;
}

function updateOpts(args: string[]): {
  outDir?: string;
  skillsDir?: string;
  agentsDir?: string;
  codeDir?: string;
  scipIndex?: string;
} {
  const o: { outDir?: string; skillsDir?: string; agentsDir?: string; codeDir?: string; scipIndex?: string } = {};
  const out = optValue(args, "--out");
  const skills = optValue(args, "--skills");
  const agents = optValue(args, "--agents");
  const code = optValue(args, "--code");
  const scip = optValue(args, "--scip");
  if (out) o.outDir = out;
  if (skills) o.skillsDir = skills;
  if (agents) o.agentsDir = agents;
  if (code) o.codeDir = code;
  if (scip) o.scipIndex = scip;
  return o;
}

async function cmdCode(args: string[]): Promise<void> {
  const dir = args[0];
  if (!dir || dir.startsWith("--")) fail("usage: graph-kit code <dir> [--out <graph.json>]");
  const doc = toDocument(await scanCode(dir));
  const out = optValue(args, "--out");
  const json = serializeDocument(doc);
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
  process.stderr.write(`graph-kit: ${doc.nodes.length} nodes, ${doc.edges.length} edges\n`);
}

async function cmdUpdate(args: string[]): Promise<void> {
  const dir = args[0];
  if (!dir || dir.startsWith("--")) {
    fail("usage: graph-kit update <dir> [--out <artifact-dir>] [--skills <dir>] [--agents <dir>]");
  }
  process.stderr.write(reportLine(await updateMemory(dir, updateOpts(args))) + "\n");
}

function cmdWatch(args: string[]): void {
  const dir = args[0];
  if (!dir || dir.startsWith("--")) {
    fail("usage: graph-kit watch <dir> [--out <artifact-dir>] [--skills <dir>] [--agents <dir>]");
  }
  const opts = updateOpts(args);
  const run = () => {
    updateMemory(dir, opts)
      .then((r) => process.stderr.write(reportLine(r) + "\n"))
      .catch((err: unknown) => process.stderr.write(`graph-kit: update failed: ${(err as Error).message}\n`));
  };
  run(); // initial build
  process.stderr.write(`graph-kit: watching ${dir} (Ctrl-C to stop)\n`);
  let timer: NodeJS.Timeout | null = null;
  watch(dir, { recursive: true }, (_event, filename) => {
    if (filename && filename.includes(".graphkit")) return; // ignore our own writes
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 300); // debounce bursts of edits
  });
}

function cmdMerge(args: string[]): void {
  const [codePath, docPath, chunksPath] = args;
  if (!codePath || !docPath || !chunksPath ||
      codePath.startsWith("--") || docPath.startsWith("--") || chunksPath.startsWith("--")) {
    fail("usage: graph-kit merge <code.json> <doc.json> <chunks.json> [--out f]");
  }
  const code = toGraph(parseDocumentString(readFileSync(codePath, "utf8")));
  const doc = toGraph(parseDocumentString(readFileSync(docPath, "utf8")));
  // Chunks are whatever the doc track emitted. Only id/body/wikiLinks/
  // relatedModules are read, so a payload from either implementation works —
  // Swift writes `docURL` where this one writes `docPath`, and neither is used.
  const chunks = JSON.parse(readFileSync(chunksPath, "utf8")) as MergeChunk[];
  if (!Array.isArray(chunks)) fail(`${chunksPath} is not a chunk array`);
  const merged = mergeCodeAndDoc(code, doc, chunks);
  const json = serializeDocument(toDocument(merged));
  const outPath = optValue(args, "--out");
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json);
  process.stderr.write(
    `graph-kit: merged → ${merged.nodes.length} nodes, ${merged.edges.length} edges\n`,
  );
}

function cmdValidate(args: string[]): void {
  const file = args[0];
  if (!file) fail("usage: graph-kit validate <graph.json>");
  try {
    const doc = parseDocumentString(readFileSync(file, "utf8"));
    process.stdout.write(
      `valid: schemaVersion ${doc.schemaVersion}, ${doc.nodes.length} nodes, ${doc.edges.length} edges\n`,
    );
  } catch (err) {
    fail((err as Error).message);
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "memory": return cmdMemory(rest);
    case "update": return cmdUpdate(rest);
    case "watch": return cmdWatch(rest);
    case "code": return cmdCode(rest);
    case "index": return cmdIndex(rest);
    case "merge": return cmdMerge(rest);
    case "validate": return cmdValidate(rest);
    default:
      fail(`unknown command '${cmd ?? ""}'. Use: memory | update | watch | code | merge | index | validate`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`graph-kit: ${(err as Error).message}\n`);
  process.exit(1);
});
