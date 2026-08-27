// Render a CGData graph to a human + agent readable markdown index. Mirrors the
// spirit of the Swift MemoryNotesWriter: a compact "what's in here" cheatsheet —
// stats, container→children groupings, and cross-references — that an agent can
// read instead of traversing the raw graph.

import type { CGData, CGNode, CGNodeKind } from "./models.js";
import { displayName } from "./text/memoryGenerator.js";

export interface IndexOptions {
  title?: string;
  maxItemsPerGroup?: number;
}

const CONTAINER_KINDS: ReadonlySet<CGNodeKind> = new Set<CGNodeKind>([
  "memoryDoc", "file", "module",
]);
// Edges that express "X owns/leads to child Y" for grouping.
const CHILD_EDGE_KINDS = new Set(["contains", "defines", "relatedTo"]);

export function generateIndex(graph: CGData, opts: IndexOptions = {}): string {
  const title = opts.title ?? "Graph Index";
  const maxItems = opts.maxItemsPerGroup ?? 25;

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const out: string[] = [];

  out.push(`# ${title}`, "");
  out.push(...statsSection(graph));

  // Container groupings: each doc/file/module → its children.
  const containers = graph.nodes
    .filter((n) => CONTAINER_KINDS.has(n.kind))
    .sort((a, b) => a.title.localeCompare(b.title));

  if (containers.length > 0) {
    out.push("", "## Containers", "");
    for (const c of containers) {
      const children = childrenOf(c, graph, nodesById);
      out.push(`### ${c.title} _(${displayName(c.kind)})_`);
      if (children.length === 0) {
        out.push("- _(no linked children)_");
      } else {
        for (const child of children.slice(0, maxItems)) {
          out.push(`- ${child.title} _(${displayName(child.kind)})_`);
        }
        if (children.length > maxItems) {
          out.push(`- _… and ${children.length - maxItems} more_`);
        }
      }
      out.push("");
    }
  }

  // Cross-references (non-ownership edges between named nodes).
  const xrefs = graph.edges
    .filter((e) => !CHILD_EDGE_KINDS.has(e.kind) || e.kind === "relatedTo")
    .filter((e) => e.kind !== "contains" && e.kind !== "defines");
  if (xrefs.length > 0) {
    out.push("## Cross-references", "");
    const seen = new Set<string>();
    for (const e of xrefs) {
      const from = nodesById.get(e.fromId);
      const to = nodesById.get(e.toId);
      if (!from || !to) continue;
      const key = `${e.fromId}:${e.kind}:${e.toId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`- ${from.title} → ${e.kind} → ${to.title}`);
    }
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function statsSection(graph: CGData): string[] {
  const byKind = new Map<CGNodeKind, number>();
  for (const n of graph.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  const lines = [`- **Nodes:** ${graph.nodes.length}`, `- **Edges:** ${graph.edges.length}`];
  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
  if (kinds.length > 0) {
    lines.push(
      "- **By kind:** " + kinds.map(([k, n]) => `${displayName(k)}×${n}`).join(", "),
    );
  }
  return lines;
}

function childrenOf(
  parent: CGNode,
  graph: CGData,
  nodesById: Map<string, CGNode>,
): CGNode[] {
  const out: CGNode[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (id === parent.id || seen.has(id)) return;
    const child = nodesById.get(id);
    if (!child) return;
    seen.add(id);
    out.push(child);
  };
  for (const e of graph.edges) {
    // Outgoing ownership: code graphs emit file/module -contains/defines-> symbol.
    if (e.fromId === parent.id && CHILD_EDGE_KINDS.has(e.kind)) add(e.toId);
    // Inversion for memory graphs: chunks emit chunk -relatedTo-> memoryDoc.
    else if (parent.kind === "memoryDoc" && e.toId === parent.id && e.kind === "relatedTo") {
      add(e.fromId);
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
