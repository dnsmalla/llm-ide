// A compact, local description of the project's graph for the chat context pack. Pure: the caller reads the
// file through the host; this function never throws and never includes file contents.
export function summarizeGraph(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const files = Array.isArray(o.files) ? o.files : [];
  const nodes = Array.isArray(o.nodes) ? o.nodes : [];
  const edges = Array.isArray(o.edges) ? o.edges : Array.isArray(o.calls) ? o.calls : [];
  const count = files.length || nodes.length;
  if (count === 0 && edges.length === 0) return null;
  const top = files
    .slice(0, 8)
    .map((f) => (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string" ? (f as { path: string }).path : ""))
    .filter(Boolean);
  return `Project graph: ${count} files/nodes, ${edges.length} edges.${top.length ? ` Main files: ${top.join(", ")}.` : ""}`;
}
