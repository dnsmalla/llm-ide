// Scan SKILL.md skills and agent definitions into capability nodes, and link them
// into a memory graph. This is how "skill and agent" become part of the memory
// index: an agent can consult the graph to see which docs/code a skill relates to
// (correct, low-token updates) instead of re-reading everything.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CGData, CGEdge, CGNode } from "../models.js";
import { containsWholeWord } from "../text/memoryGenerator.js";

/** Pull `name` + `description` from a leading `---` frontmatter block (best-effort). */
function frontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const m = /^(name|description)\s*:\s*(.+?)\s*$/.exec(line.trim());
    if (m) {
      const key = m[1] as "name" | "description";
      if (out[key] === undefined) out[key] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function listFiles(root: string, match: (name: string, full: string) => boolean, max = 1000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= max) return;
      if (name.startsWith(".") && name !== ".claude" && name !== ".agents") continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && match(name, full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function capabilityNode(file: string, kind: "skill" | "agent"): CGNode {
  const abs = resolve(file);
  const text = (() => {
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return "";
    }
  })();
  const fm = frontmatter(text);
  // Skill name defaults to its directory (SKILL.md lives in <name>/SKILL.md);
  // agent name defaults to the filename.
  const fallback = kind === "skill" ? basename(dirname(abs)) : basename(abs).replace(/\.[^.]+$/, "");
  const name = (fm.name ?? fallback).trim();
  return {
    id: `${kind}:${name}`,
    title: name,
    kind,
    metadata: {
      fileURL: pathToFileURL(abs).href,
      ...(fm.description ? { description: fm.description } : {}),
    },
  };
}

/** Scan a directory tree for `SKILL.md` files → `skill` nodes. */
export function scanSkills(skillsRoot: string): CGNode[] {
  return listFiles(skillsRoot, (name) => name === "SKILL.md").map((f) => capabilityNode(f, "skill"));
}

/** Scan a directory for agent definition `*.md` files that carry a `name:` → `agent` nodes. */
export function scanAgents(agentsRoot: string): CGNode[] {
  return listFiles(agentsRoot, (name) => name.endsWith(".md") && name !== "README.md")
    .map((f) => capabilityNode(f, "agent"))
    .filter((n) => n.title.length > 0);
}

/**
 * Merge capability nodes into a graph and link each to the memory/code nodes that
 * whole-word-mention its name. Edge: capability -relatedTo-> node. Pure.
 */
export function mergeCapabilities(graph: CGData, capabilities: CGNode[]): CGData {
  if (capabilities.length === 0) return graph;
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const emitted = new Set(edges.map((e) => `${e.fromId}→${e.toId}:${e.kind}`));

  for (const cap of capabilities) {
    if (!existingIds.has(cap.id)) {
      nodes.push(cap);
      existingIds.add(cap.id);
    }
    const needle = cap.title.toLowerCase();
    if (needle.length < 3) continue;
    for (const node of graph.nodes) {
      if (node.id === cap.id) continue;
      const hay = `${node.title} ${node.metadata["heading"] ?? ""} ${node.metadata["doc"] ?? ""}`.toLowerCase();
      if (!containsWholeWord(hay, needle)) continue;
      const key = `${cap.id}→${node.id}:relatedTo`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      edges.push({ fromId: cap.id, toId: node.id, kind: "relatedTo", confidence: "INFERRED" });
    }
  }
  return { nodes, edges, layers: graph.layers, tour: graph.tour };
}
