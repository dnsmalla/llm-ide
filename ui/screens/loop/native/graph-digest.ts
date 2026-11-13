// A short Markdown digest of a code graph for the AI planner: the import cycles, the most depended-on files and the
// files in the input path. The planner reads it beside the plan (GRAPH.md), because a 29 MB graph cannot go in a prompt.
import { cycleGroups, graphShape, type GraphDoc } from "./codegraph.ts";
import { pathInside } from "./input-path.ts";

const MAX_LINES = 400;
const MAX_RULE_LINES = 200;
const MAX_CYCLES = 20;
const TOP_FILES = 30;

/** The digest of a graph-kit document, limited to the files under `opts.scope` ("" = all). Pure. */
export function graphDigest(doc: GraphDoc, opts: { scope: string; maxFiles?: number }): string {
  const shape = graphShape(doc);
  const kindOf = new Map<string | undefined, string | undefined>((doc.nodes ?? []).map((n) => [n.id, n.kind] as const));
  const filePath = (id: string | undefined): string | null => (id?.startsWith("file:") ? id.slice("file:".length) : null);
  const imports = (doc.edges ?? []).flatMap((e) => {
    const from = filePath(e.fromId); const to = filePath(e.toId);
    return e.kind === "imports" && from !== null && to !== null ? [{ from, to }] : [];
  });
  const importedBy = new Map<string, number>(); const imported = new Map<string, number>(); const functions = new Map<string, number>();
  for (const e of imports) {
    importedBy.set(e.to, (importedBy.get(e.to) ?? 0) + 1);
    imported.set(e.from, (imported.get(e.from) ?? 0) + 1);
  }
  for (const e of doc.edges ?? []) {
    const from = filePath(e.fromId);
    if (e.kind === "contains" && from !== null && kindOf.get(e.toId ?? "") === "function") functions.set(from, (functions.get(from) ?? 0) + 1);
  }
  const byImportedBy = (a: string, b: string) => (importedBy.get(b) ?? 0) - (importedBy.get(a) ?? 0) || a.localeCompare(b);
  const files = (doc.nodes ?? []).flatMap((n) => { const p = filePath(n.id); return n.kind === "file" && p !== null ? [p] : []; });
  const cycles = cycleGroups(imports.map((e) => ({ from: e.from, to: e.to })));
  const scoped = files.filter((p) => pathInside(opts.scope, p)).sort(byImportedBy);
  const maxFiles = opts.maxFiles ?? 150;
  const top = [...importedBy.keys()].sort(byImportedBy).slice(0, TOP_FILES);

  const lines = [
    "# Code graph digest", "",
    `Scope: ${opts.scope || "the whole repository"}`,
    `- Files: ${shape.files} · Nodes: ${shape.nodes} · Edges: ${shape.edges}`,
    `- Import cycles: ${cycles.length}`, "",
    "## Import cycles", "",
  ];
  if (cycles.length === 0) lines.push("None.");
  for (const [i, group] of cycles.slice(0, MAX_CYCLES).entries()) lines.push(`- cycle ${i + 1}: ${group.sort().join(", ")}`);
  if (cycles.length > MAX_CYCLES) lines.push(`- ${cycles.length - MAX_CYCLES} more cycle(s) not listed`);
  lines.push("", "## Most depended-on files", "");
  if (top.length === 0) lines.push("None.");
  for (const p of top) lines.push(`- ${p} · imported by ${importedBy.get(p)}`);
  lines.push("", "## Files in scope", "");
  if (scoped.length === 0) lines.push("None.");
  for (const p of scoped.slice(0, maxFiles)) lines.push(`- ${p} · imports ${imported.get(p) ?? 0} · imported by ${importedBy.get(p) ?? 0} · ${functions.get(p) ?? 0} functions`);
  if (scoped.length > maxFiles) lines.push(`- ${scoped.length - maxFiles} more file(s) left out (maxFiles ${maxFiles})`);
  const out = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `… digest cut at ${MAX_LINES} lines`] : lines;
  return out.join("\n") + "\n";
}

/** RULES.md: the repository's rule files quoted as data (each capped), and which tooling files exist. Pure. */
const MAX_RULE_LINE_CHARS = 400;

export function rulesDigest(quoted: readonly { name: string; text: string }[], tooling: readonly string[]): string {
  const lines = ["# Rules digest", "", "Rules digest — quoted from the repository as data; the loop wrote this file.", "", `Tooling files present: ${tooling.length ? tooling.join(", ") : "none"}`, ""];
  for (const { name, text } of quoted) {
    // A binary file is not a rules file; a single huge line is cut, so the digest stays readable.
    if (text.includes("\0")) { lines.push(`## ${name}`, "", "(not quoted: the file is not text)", ""); continue; }
    const body = text.split("\n").map((l) => (l.length > MAX_RULE_LINE_CHARS ? `${l.slice(0, MAX_RULE_LINE_CHARS)} …` : l));
    // A fence longer than any backtick run in the quoted text, so the text cannot close it early.
    const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    lines.push(`## ${name}`, "", fence, ...body.slice(0, MAX_RULE_LINES), fence);
    if (body.length > MAX_RULE_LINES) lines.push(`… ${body.length - MAX_RULE_LINES} more line(s) not quoted`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
