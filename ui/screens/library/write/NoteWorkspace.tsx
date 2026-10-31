// The detail pane when writing is available: a toolbar (Edit, Rename, Re-summarise, Delete) over the
// viewer, or the editor while editing. Dialogs and long-running actions live here; all state changes of
// the list go through the store's incremental methods.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { NotesHost } from "../host.ts";
import type { LibraryStore } from "../library-store.ts";
import type { NoteRecord } from "../notes-model.ts";
import { NoteViewer } from "../NoteViewer";
import type { LinkHandlers } from "../MarkdownView";
import { bulkDelete, type BulkProgress } from "./bulk.ts";
import type { EditorDeps } from "./editor-session.ts";
import { NoteEditor } from "./NoteEditor";
import { renamedRel } from "./note-ops.ts";
import { DeleteDialog, RenameDialog } from "./WriteDialogs";
import { resummarize, SummarizeError, summarizeErrorText, type SummarizeCore, type SummarizePhase } from "./resummarize.ts";
import { toWriteError, writeErrorText, type WriteHost } from "./write-host.ts";
import type { WriteQueue } from "./write-queue.ts";

export interface NoteWorkspaceProps extends LinkHandlers {
  host: NotesHost;
  write: WriteHost;
  queue: WriteQueue;
  summarize: SummarizeCore | null;
  store: LibraryStore;
  rel: string;
  record: NoteRecord | undefined;
  reloadKey: number;
  /** Start in the editor (a note just created). */
  startEditing?: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** The viewer must reload this note (it was saved, summarised or replaced). */
  onChanged: () => void;
}

export function NoteWorkspace(p: NoteWorkspaceProps): ReactNode {
  const { store, write, queue, rel } = p;
  const [editing, setEditing] = useState(p.startEditing === true);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<BulkProgress | null>(null);
  const delAbort = useRef<AbortController | null>(null);
  const [sum, setSum] = useState<{ phase: SummarizePhase | null; message: string | null; ok: boolean }>({ phase: null, message: null, ok: false });
  const sumAbort = useRef<AbortController | null>(null);

  const deps = useMemo<EditorDeps>(
    () => ({
      host: write,
      queue,
      onWritten: (saved, text) => {
        store.noteWritten(saved, text);
        p.onChanged();
      },
      taken: (r) => store.record(r) !== undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [write, queue, store],
  );

  const doRename = useCallback(
    async (newName: string) => {
      setBusy(true);
      setDialogError(null);
      try {
        const to = renamedRel(rel, newName);
        await queue.run(rel, () => write.rename(rel, to));
        const old = store.record(rel);
        store.noteRenamed(rel, { rel: to, size: old?.size ?? 0, mtimeMs: old?.mtimeMs ?? Date.now() });
        setDialog(null);
      } catch (e) {
        setDialogError(writeErrorText(toWriteError(e).code));
      } finally {
        setBusy(false);
      }
    },
    [rel, queue, write, store],
  );

  const doDelete = useCallback(async () => {
    const ac = new AbortController();
    delAbort.current = ac;
    const out = await bulkDelete([rel], { host: write, signal: ac.signal, onProgress: setDel, onDeleted: (r) => store.noteRemoved(r) });
    delAbort.current = null;
    setDel(out);
  }, [rel, write, store]);

  const doSummarize = useCallback(async () => {
    if (!p.summarize || sumAbort.current) return;
    const ac = new AbortController();
    sumAbort.current = ac;
    setSum({ phase: "reading", message: null, ok: false });
    try {
      const r = await resummarize(rel, { host: write, core: p.summarize, signal: ac.signal, onPhase: (phase) => setSum({ phase, message: null, ok: false }) });
      store.noteWritten(r.saved, r.text);
      p.onChanged();
      setSum({ phase: null, ok: true, message: r.truncated ? "Summary updated from the first part of a very long transcript." : "Summary updated." });
    } catch (e) {
      setSum({ phase: null, ok: false, message: summarizeErrorText(e instanceof SummarizeError ? e.code : "failed") });
    } finally {
      sumAbort.current = null;
    }
  }, [p, rel, write, store]);

  const titles = useMemo(() => new Map([[rel, p.record?.title ?? rel]]), [rel, p.record?.title]);
  const isMeeting = p.record?.sourceId === "meeting" && p.summarize !== null;
  const summarising = sum.phase !== null;

  if (editing) {
    return (
      <NoteEditor
        rel={rel}
        deps={deps}
        onDirtyChange={p.onDirtyChange}
        onCopySaved={(r) => store.reveal(r)}
        onClose={() => {
          setEditing(false);
          p.onChanged();
        }}
        onOpenExternal={p.onOpenExternal}
        onOpenNote={p.onOpenNote}
      />
    );
  }
  return (
    <>
      <div className="lib-editor-bar lib-note-actions" role="toolbar" aria-label="Note actions">
        <button type="button" className="lib-btn" onClick={() => setEditing(true)} disabled={p.record?.placeholder === true}>
          Edit
        </button>
        <button type="button" className="lib-btn" onClick={() => { setDialogError(null); setDialog("rename"); }}>
          Rename…
        </button>
        {isMeeting && (
          <button type="button" className="lib-btn" onClick={() => void doSummarize()} disabled={summarising}>
            Re-summarise
          </button>
        )}
        {summarising && (
          <>
            <span className="lib-muted" role="status" aria-live="polite">
              {sum.phase === "reading" ? "Reading the note…" : sum.phase === "summarising" ? "Summarising (this can take a minute)…" : "Saving the summary…"}
            </span>
            <button type="button" className="lib-link-btn" onClick={() => sumAbort.current?.abort()}>
              Cancel
            </button>
          </>
        )}
        <button type="button" className="lib-btn lib-btn-danger" onClick={() => { setDel(null); setDialog("delete"); }}>
          Delete…
        </button>
      </div>
      {sum.message && <StatusBanner severity={sum.ok ? "info" : "warning"} message={sum.message} onDismiss={() => setSum({ phase: null, message: null, ok: false })} />}
      <NoteViewer host={p.host} rel={rel} record={p.record} reloadKey={p.reloadKey} onOpenExternal={p.onOpenExternal} onOpenNote={p.onOpenNote} />
      {dialog === "rename" && <RenameDialog rel={rel} onRename={(n) => void doRename(n)} onClose={() => setDialog(null)} error={dialogError} busy={busy} />}
      {dialog === "delete" && (
        <DeleteDialog
          rels={[rel]}
          titles={titles}
          progress={del}
          onConfirm={() => void doDelete()}
          onCancelRun={() => delAbort.current?.abort()}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
