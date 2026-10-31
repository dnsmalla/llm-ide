// The list's selection toolbar: shown while selecting notes. Delete and tag run through the chunked,
// cancellable runners of bulk.ts; the list is updated from each chunk's result, never by rescanning.
import { useRef, useState, type ReactNode } from "react";
import type { LibraryStore } from "../library-store.ts";
import { bulkDelete, bulkTag, type BulkProgress } from "./bulk.ts";
import { DeleteDialog, TagDialog } from "./WriteDialogs";
import type { Selection } from "./selection.ts";
import type { WriteHost } from "./write-host.ts";

export interface BulkBarProps {
  store: LibraryStore;
  write: WriteHost;
  selection: Selection;
  /** Notes in the current view (after filters), for "select all". */
  viewCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
  /** Called after notes were removed or changed, so the selection can drop vanished paths. */
  onChanged: () => void;
}

export function BulkBar({ store, write, selection, viewCount, onSelectAll, onClear, onDone, onChanged }: BulkBarProps): ReactNode {
  const [dialog, setDialog] = useState<"delete" | "tag" | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  const rels = [...selection.ids];
  const n = rels.length;

  const close = (): void => {
    if (progress?.phase === "running") return;
    setDialog(null);
    setProgress(null);
    onChanged();
  };
  const titles = new Map(rels.slice(0, 20).map((r) => [r, store.record(r)?.title ?? r]));

  const runDelete = async (): Promise<void> => {
    const ac = new AbortController();
    abort.current = ac;
    const out = await bulkDelete(rels, { host: write, signal: ac.signal, onProgress: setProgress, onDeleted: (r) => store.noteRemoved(r) });
    abort.current = null;
    setProgress(out);
  };
  const runTag = async (tags: string[], mode: "add" | "remove"): Promise<void> => {
    const ac = new AbortController();
    abort.current = ac;
    const out = await bulkTag(rels, tags, mode, { host: write, signal: ac.signal, onProgress: setProgress, onSaved: (saved, text) => store.noteWritten(saved, text) });
    abort.current = null;
    setProgress(out);
  };

  return (
    <div className="lib-bulkbar" role="toolbar" aria-label="Selected notes">
      <span role="status" aria-live="polite">
        {n.toLocaleString()} selected
      </span>
      <button type="button" className="lib-link-btn" onClick={onSelectAll} disabled={viewCount === 0 || n >= viewCount}>
        Select all {viewCount.toLocaleString()}
      </button>
      <button type="button" className="lib-link-btn" onClick={onClear} disabled={n === 0}>
        Clear
      </button>
      <span className="lib-bulk-spacer" />
      <button type="button" className="lib-btn" disabled={n === 0} onClick={() => { setProgress(null); setDialog("tag"); }}>
        Tag…
      </button>
      <button type="button" className="lib-btn lib-btn-danger" disabled={n === 0} onClick={() => { setProgress(null); setDialog("delete"); }}>
        Delete…
      </button>
      <button type="button" className="lib-btn" onClick={onDone}>
        Done
      </button>
      {dialog === "delete" && <DeleteDialog rels={rels} titles={titles} progress={progress} onConfirm={() => void runDelete()} onCancelRun={() => abort.current?.abort()} onClose={close} />}
      {dialog === "tag" && <TagDialog count={n} progress={progress} onApply={(t, m) => void runTag(t, m)} onCancelRun={() => abort.current?.abort()} onClose={close} />}
    </div>
  );
}
