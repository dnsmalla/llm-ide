// The left panel's file tree, Mac-style: folders expand, a file row focuses the nodes that mention it. It is built
// from the graph's own paths (not the whole project), so every row has graph content behind it.
import { useMemo, type ReactNode } from "react";
import { FolderIcon, Icon } from "@llmide/ui-kit";
import { fileKind, fileKindIcon } from "../explorer/file-kind.ts";
import { buildPathTree, fileCount, totalGraphFiles, type FileNode } from "./path-tree";

export interface GraphFileTreeProps {
  paths: readonly (string | null)[];
  /** The focused file (the store's query when it names one). */
  selected: string;
  onSelect: (path: string) => void;
  onClear: () => void;
}

export function GraphFileTree({ paths, selected, onSelect, onClear }: GraphFileTreeProps): ReactNode {
  const root = useMemo(() => buildPathTree(paths), [paths]);
  const shown = useMemo(() => fileCount(root), [root]);
  const total = useMemo(() => totalGraphFiles(paths), [paths]);
  return (
    <section className="gr-tree" aria-label="Files in this graph">
      <div className="gr-tree-head">
        <span className="gr-tree-title">Files in this graph</span>
        <span className="gr-muted">{total.toLocaleString("en-US")}</span>
        {selected ? (
          <button type="button" className="gr-link" onClick={onClear}>Clear</button>
        ) : null}
      </div>
      {shown === 0 ? (
        <p className="gr-muted">No file paths in this graph.</p>
      ) : (
        <>
          {total > shown ? <p className="gr-muted" role="status">Showing the first {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")} files, in alphabetical order.</p> : null}
          <div className="gr-tree-body" role="tree" aria-label="Graph files">
            {root.children.map((c) => <Node key={c.path} node={c} depth={0} selected={selected} onSelect={onSelect} />)}
          </div>
        </>
      )}
    </section>
  );
}

function Node({ node, depth, selected, onSelect }: { node: FileNode; depth: number; selected: string; onSelect: (p: string) => void }): ReactNode {
  if (node.kind === "file") {
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={selected === node.path}
        aria-level={depth + 1}
        className="gr-file"
        data-on={selected === node.path || undefined}
        title={node.path}
        onClick={() => onSelect(node.path)}
      >
        <span className="gr-file-icon" data-kind={fileKind(node.name)} aria-hidden="true"><Icon name={fileKindIcon(fileKind(node.name))} size={11} /></span>
        {node.name}
      </button>
    );
  }
  return (
    <details className="gr-dir" open={depth < 1}>
      <summary className="gr-dir-summary" title={node.path} style={{ paddingLeft: `${depth * 12}px` }}><span className="gr-file-icon" data-kind="folder" aria-hidden="true"><FolderIcon /></span>{node.name}/</summary>
      {node.children.map((c) => <Node key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
    </details>
  );
}
