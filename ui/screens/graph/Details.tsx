// Node details: everything the model knows about one node, as text. Labels and metadata come from an
// untrusted file, so they are only ever rendered as React text children.
import type { Adjacency } from "./filters.ts";
import type { GraphModel, LayoutResult } from "./model.ts";
import { communityColor } from "./colors.ts";
import { CONFIDENCE_NAMES, edgeWeight } from "./weights.ts";

export const MAX_NEIGHBOURS = 50;

export interface DetailsProps {
  model: GraphModel;
  layout: LayoutResult;
  adj: Adjacency;
  node: number;
  onSelect: (node: number) => void;
  /** Present only when the node has a project-relative path and the shell can open it. */
  onOpenFile: ((path: string) => void) | null;
  onClose: () => void;
}

export function NodeDetails({ model, layout, adj, node, onSelect, onOpenFile, onClose }: DetailsProps) {
  const path = model.paths[node];
  const meta = model.meta[node];
  const items: { other: number; dir: "out" | "in"; kind: string; conf: number; w: number }[] = [];
  for (let k = adj.start[node]; k < adj.start[node + 1]; k++) {
    const e = adj.edge[k];
    const kind = model.edgeKinds[model.edgeKind[e]];
    items.push({ other: adj.nbr[k], dir: model.from[e] === node ? "out" : "in", kind, conf: model.conf[e], w: edgeWeight(kind, model.conf[e]) });
  }
  items.sort((a, b) => b.w - a.w || a.other - b.other);
  return (
    <aside className="gr-details" aria-label={`Details for ${model.titles[node]}`}>
      <div className="gr-details-head">
        <h3 className="gr-details-title">{model.titles[node]}</h3>
        <button type="button" className="gr-btn" onClick={onClose} aria-label="Close details">Close</button>
      </div>
      <dl className="gr-dl">
        <dt>Kind</dt><dd>{model.nodeKinds[model.kindOf[node]]}</dd>
        <dt>Community</dt><dd><span className="gr-dot" style={{ background: communityColor(layout.community[node]) }} aria-hidden="true" /> {layout.community[node] + 1}</dd>
        <dt>Connections</dt><dd>{layout.degree[node]} ({layout.inDegree[node]} in)</dd>
        <dt>Id</dt><dd className="gr-mono">{model.ids[node]}</dd>
        {path !== null && (<><dt>File</dt><dd className="gr-mono">{path}</dd></>)}
        {meta && Object.keys(meta).map((k) => (<div className="gr-dl-pair" key={k}><dt>{k}</dt><dd>{meta[k]}</dd></div>))}
      </dl>
      {path !== null && onOpenFile && (
        <button type="button" className="gr-btn gr-btn-primary" onClick={() => onOpenFile(path)}>Open in Explorer</button>
      )}
      <h4 className="gr-subhead">Neighbours ({items.length.toLocaleString("en-US")})</h4>
      <ul className="gr-nbrs">
        {items.slice(0, MAX_NEIGHBOURS).map((it, k) => (
          <li key={k}>
            <button type="button" className="gr-link" onClick={() => onSelect(it.other)}>{model.titles[it.other]}</button>
            <span className="gr-muted"> {it.dir === "out" ? "to" : "from"} · {it.kind} · {CONFIDENCE_NAMES[it.conf]?.toLowerCase()} · weight {it.w.toFixed(2)}</span>
          </li>
        ))}
      </ul>
      {items.length > MAX_NEIGHBOURS && <p className="gr-muted">Showing the {MAX_NEIGHBOURS} strongest of {items.length.toLocaleString("en-US")}.</p>}
    </aside>
  );
}
