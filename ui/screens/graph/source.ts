// Where the graph comes from: `graph.json` inside the open project, read ONLY through the host command
// `read_graph_file` (root-confined, no symlink following, 32 MB cap; all enforced in Rust). The webview
// builds absolute candidate paths from the project root the shell gave it; the host re-checks every one
// and refuses anything outside the root or not named graph.json.
import { relativePath } from "./decode.ts";

/** Where graph-kit writes it (ProjectLayout.graphDir = system/graph), then the flat legacy spot. */
export const GRAPH_CANDIDATES: readonly string[] = ["system/graph/graph.json", "system/graph.json"];

export type ReadFailure = "not-found" | "too-large" | "no-project" | "error";
export type ReadResult = { ok: true; text: string; path: string } | { ok: false; kind: ReadFailure; message: string; tried: string[] };

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function classifyReadError(message: string): ReadFailure {
  if (/no project root/i.test(message)) return "no-project";
  if (/size limit/i.test(message)) return "too-large";
  if (/no such file|cannot resolve|not found|does not exist/i.test(message)) return "not-found";
  return "error";
}

export function joinRoot(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

/** A user-typed project-relative path to a graph.json, or null when it is not one. */
export function customGraphPath(input: string): string | null {
  const p = relativePath(input.trim(), 512);
  return p !== null && /(^|\/)graph\.json$/.test(p) ? p : null;
}

export async function readProjectGraph(invoke: Invoke, root: string | null, rels: readonly string[] = GRAPH_CANDIDATES): Promise<ReadResult> {
  if (!root) return { ok: false, kind: "no-project", message: "No project is open.", tried: [] };
  const tried: string[] = [];
  let last: ReadResult | null = null;
  for (const rel of rels) {
    tried.push(rel);
    try {
      const text = await invoke("read_graph_file", { path: joinRoot(root, rel) });
      if (typeof text !== "string") return { ok: false, kind: "error", message: "The host returned something that is not text.", tried };
      return { ok: true, text, path: rel };
    } catch (e) {
      const message = e instanceof Error ? e.message : typeof e === "string" ? e : "read failed";
      const kind = classifyReadError(message);
      last = { ok: false, kind, message, tried };
      if (kind !== "not-found") return last; // a real failure (too large, host refusal) must not be masked by the next candidate
    }
  }
  return last ?? { ok: false, kind: "not-found", message: "No graph.json found.", tried };
}
