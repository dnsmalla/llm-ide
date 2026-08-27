#!/usr/bin/env node
// graph-kit CLI — language-neutral entry point so non-Swift tools can produce and
// consume the canonical graph via JSON. Commands:
//
//   graph-kit memory <dir> [--out graph.json] [--index index.md]
//       Build a text→memory graph from a folder of markdown/text files.
//   graph-kit index <graph.json> [--out index.md]
//       Render a markdown index from a canonical graph document.
//   graph-kit validate <graph.json>
//       Validate a graph document against the canonical schema (exit 1 on failure).

import { readFileSync, writeFileSync, watch } from "node:fs";
import { generateFromDir } from "./text/memoryGenerator.js";
import { generateIndex } from "./indexGenerator.js";
import { parseDocumentString, serializeDocument, toDocument, toGraph } from "./models.js";
import { updateMemory, type UpdateReport } from "./incremental.js";
import { scanCode } from "./code/tsScanner.js";

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
  const outPath = optValue(args, "--out");
  if (outPath) writeFileSync(outPath, serializeDocument(doc));
  else process.stdout.write(serializeDocument(doc));
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
    case "validate": return cmdValidate(rest);
    default:
      fail(`unknown command '${cmd ?? ""}'. Use: memory | update | watch | code | index | validate`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`graph-kit: ${(err as Error).message}\n`);
  process.exit(1);
});
