// The Library screen (read side): sidebar sections, the virtualised item list and the note viewer.
// Everything it needs arrives as props (store, host, optional rebuild runner, link openers), so it
// renders and tests without Tauri; index.tsx wires the real ones.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { NotesHost } from "./host.ts";
import type { LibraryStore } from "./library-store.ts";
import { IDLE_REBUILD, type RebuildProgress } from "./index-rebuild.ts";
import type { NoteRecord } from "./notes-model.ts";
import { EXTENSION_PLACEHOLDERS, LibraryNav, type LibraryExtension } from "./LibraryNav";
import { NoteList, type BulkSelect } from "./NoteList";
import { NoteViewer } from "./NoteViewer";
import { BulkBar } from "./write/BulkBar";
import { DiscardDialog, NewNoteDialog } from "./write/WriteDialogs";
import { NoteWorkspace } from "./write/NoteWorkspace";
import { initialNoteText, newNoteRel } from "./write/note-ops.ts";
import type { SummarizeCore } from "./write/resummarize.ts";
import { EMPTY_SELECTION, extendRange, prune, selectAll, toggle, type Selection } from "./write/selection.ts";
import { toWriteError, writeErrorText, type WriteHost } from "./write/write-host.ts";
import { WriteQueue } from "./write/write-queue.ts";
import { NoFolder, LoadError } from "./States";
import { useLibraryState } from "./use-library.ts";

/** The write side (S-I). Absent: the Library is read-only, as before. */
export interface LibraryWriteProps {
  host: WriteHost;
  /** Re-summarise needs the core; null hides the action. */
  summarize: SummarizeCore | null;
  now?: () => number;
}

export interface LibraryScreenProps {
  store: LibraryStore;
  host: NotesHost;
  write?: LibraryWriteProps | null;
  /** Source connection panes (Email, Slack, Box, ...), listed under "Connections". */
  connections?: readonly LibraryExtension[];
  /** Runs an index rebuild over the current records; absent when the core is not reachable from here. */
  runRebuild?: ((records: readonly NoteRecord[], report: (p: RebuildProgress) => void, signal: AbortSignal) => Promise<RebuildProgress>) | null;
  /** Opens an allowlisted URL through the host; reject when it cannot (a notice is shown). */
  onOpenExternal?: (url: string) => void | Promise<void>;
  extensions?: readonly LibraryExtension[];
  /** False while another section is shown (the shell keeps this screen mounted). */
  active?: boolean;
  /** True inside the desktop app: the folder dialog exists. */
  hostAvailable?: boolean;
  initialHeight?: number;
}

export function LibraryScreen({ store, host, write = null, connections, runRebuild = null, onOpenExternal, extensions = EXTENSION_PLACEHOLDERS, active = true, hostAvailable = true, initialHeight }: LibraryScreenProps): ReactNode {
  const state = useLibraryState(store);
  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [rebuild, setRebuild] = useState<RebuildProgress | null>(null);
  const rebuildAbort = useRef<AbortController | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  // ---- write side
  const queue = useMemo(() => new WriteQueue(), []);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [dirty, setDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<{ proceed: () => void } | null>(null);
  const [newNote, setNewNote] = useState<{ error: string | null; busy: boolean } | null>(null);
  const [editNew, setEditNew] = useState<string | null>(null);
  const [writeKey, setWriteKey] = useState(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (editNew !== null && state.selectedRel !== editNew) setEditNew(null);
  }, [editNew, state.selectedRel]);

  useEffect(() => {
    // While a note has unsaved changes, selecting another note (or section) asks first.
    store.selectGuard = write
      ? (_next, proceed) => {
          if (!dirtyRef.current) return true;
          setPendingNav({ proceed });
          return false;
        }
      : null;
    store.hasUnsaved = write ? () => dirtyRef.current : null;
    return () => {
      store.selectGuard = null;
      store.hasUnsaved = null;
    };
  }, [store, write]);

  useEffect(() => {
    void store.init();
    return () => {
      rebuildAbort.current?.abort();
    };
  }, [store]);

  const startRebuild = useCallback(() => {
    if (!runRebuild || rebuildAbort.current) return;
    const ac = new AbortController();
    rebuildAbort.current = ac;
    setRebuild({ ...IDLE_REBUILD, phase: "reading" });
    void runRebuild(store.getSnapshot().records, setRebuild, ac.signal).then((final) => {
      setRebuild(final);
      rebuildAbort.current = null;
    });
  }, [runRebuild, store]);

  const cancelRebuild = useCallback(() => rebuildAbort.current?.abort(), []);
  const refresh = useCallback(() => {
    setReloadKey((k) => k + 1);
    void store.scan();
  }, [store]);
  const openNote = useCallback((rel: string) => store.reveal(rel), [store]);
  const openExternal = useMemo(
    () =>
      onOpenExternal
        ? (url: string): void => {
            Promise.resolve()
              .then(() => onOpenExternal(url))
              .catch(() => setLinkNotice("Opening links in the browser is not available yet. The address was not opened."));
          }
        : undefined,
    [onOpenExternal],
  );

  const ext = extensionId === null ? undefined : [...extensions, ...(connections ?? [])].find((x) => x.id === extensionId);

  const bulk = useMemo<BulkSelect | null>(() => {
    if (!write || !selecting) return null;
    const ordered = (): string[] => store.rows().flatMap((r) => (r.kind === "note" ? [r.rec.rel] : []));
    return {
      selected: selection.ids,
      onToggle: (rel, shift) => setSelection((sel) => (shift ? extendRange(sel, ordered(), rel) : toggle(sel, rel))),
      onSelectAll: () => setSelection(selectAll(ordered())),
    };
  }, [write, selecting, selection, store]);

  const createNote = useCallback(
    async (title: string, folder: string) => {
      if (!write) return;
      const now = (write.now ?? Date.now)();
      setNewNote({ error: null, busy: true });
      try {
        const rel = newNoteRel(folder, title, now, (r) => store.record(r) !== undefined);
        const saved = await queue.run(rel, () => write.host.create(rel, initialNoteText(title, now)));
        store.noteWritten(saved, initialNoteText(title, now));
        setNewNote(null);
        setEditNew(rel);
        store.setFilters({ query: "" });
        store.setSection(null);
        store.reveal(rel);
      } catch (e) {
        setNewNote({ error: writeErrorText(toWriteError(e).code), busy: false });
      }
    },
    [write, queue, store],
  );

  const leaveSelection = useCallback(() => {
    setSelecting(false);
    setSelection(EMPTY_SELECTION);
  }, []);

  if (state.rootStatus === "unknown" || state.rootStatus === "loading") {
    return (
      <div className="lib-screen" hidden={!active}>
        <p className="lib-empty" role="status">
          Loading the Library…
        </p>
      </div>
    );
  }
  if (state.rootStatus === "none") {
    return (
      <div className="lib-screen lib-screen-single" hidden={!active}>
        <NoFolder onChoose={() => void store.chooseRoot()} error={state.error} hostAvailable={hostAvailable} canWrite={write !== null} />
      </div>
    );
  }
  if (state.rootStatus === "error" && state.records.length === 0) {
    return (
      <div className="lib-screen lib-screen-single" hidden={!active}>
        <NoFolder onChoose={() => void store.chooseRoot()} error={state.error} hostAvailable={hostAvailable} canWrite={write !== null} />
      </div>
    );
  }
  const selected = state.selectedRel;
  return (
    <div className="lib-screen" hidden={!active}>
      <LibraryNav
        state={state}
        extensionId={extensionId}
        extensions={extensions}
        connections={connections}
        onSection={(id) => {
          setExtensionId(null);
          store.setSection(id);
        }}
        onExtension={(id) => {
          if (dirtyRef.current) setPendingNav({ proceed: () => setExtensionId(id) });
          else setExtensionId(id);
        }}
        onRefresh={refresh}
        onChangeFolder={() => void store.chooseRoot()}
        rebuild={rebuild}
        onRebuild={runRebuild ? startRebuild : null}
        onCancelRebuild={cancelRebuild}
      />
      {ext ? (
        <div className="lib-ext" role="region" aria-label={ext.label}>
          {ext.render ? ext.render() : (
            <>
              <h2>{ext.label}</h2>
              <p className="lib-muted">{ext.note ?? "Coming soon."}</p>
            </>
          )}
        </div>
      ) : state.rootStatus === "error" || (state.listing.phase === "error" && state.records.length === 0) ? (
        <div className="lib-ext">
          <LoadError code={state.error ?? "io"} onRetry={() => void store.scan()} />
        </div>
      ) : (
        <>
          <div className="lib-list-col">
            {linkNotice && <StatusBanner severity="info" message={linkNotice} onDismiss={() => setLinkNotice(null)} />}
            {state.error && state.records.length > 0 && <StatusBanner severity="warning" message="Some notes could not be listed. The list may be incomplete." />}
            {write && (
              <div className="lib-list-actions" role="toolbar" aria-label="Library actions">
                <button type="button" className="lib-btn lib-btn-primary" onClick={() => setNewNote({ error: null, busy: false })}>
                  New note
                </button>
                <button type="button" className="lib-btn" aria-pressed={selecting} onClick={() => (selecting ? leaveSelection() : setSelecting(true))}>
                  {selecting ? "Stop selecting" : "Select notes"}
                </button>
              </div>
            )}
            {write && selecting && (
              <BulkBar
                store={store}
                write={write.host}
                selection={selection}
                viewCount={store.rows().reduce((n, r) => n + (r.kind === "note" ? 1 : 0), 0)}
                onSelectAll={() => bulk?.onSelectAll()}
                onClear={() => setSelection(EMPTY_SELECTION)}
                onDone={leaveSelection}
                onChanged={() => setSelection((sel) => prune(sel, (rel) => store.record(rel) !== undefined))}
              />
            )}
            <NoteList store={store} state={state} bulk={bulk} initialHeight={initialHeight} />
          </div>
          <main className="lib-detail" aria-label="Note">
            {selected && write ? (
              <NoteWorkspace
                key={selected}
                host={host}
                write={write.host}
                queue={queue}
                summarize={write.summarize}
                store={store}
                rel={selected}
                record={store.record(selected)}
                reloadKey={reloadKey + writeKey}
                startEditing={editNew === selected}
                onDirtyChange={setDirty}
                onChanged={() => setWriteKey((k) => k + 1)}
                onOpenExternal={openExternal}
                onOpenNote={openNote}
              />
            ) : selected ? (
              <NoteViewer key={selected} host={host} rel={selected} record={store.record(selected)} reloadKey={reloadKey} onOpenExternal={openExternal} onOpenNote={openNote} />
            ) : (
              <div className="lib-empty" role="status">
                <p className="lib-empty-title">Select a note</p>
                <p className="lib-muted">Use the arrow keys in the list, or click a note.</p>
              </div>
            )}
          </main>
        </>
      )}
      {newNote && (
        <NewNoteDialog
          defaultFolder="notes"
          busy={newNote.busy}
          error={newNote.error}
          onClose={() => setNewNote(null)}
          onCreate={(t, f) => void createNote(t, f)}
        />
      )}
      {pendingNav && (
        <DiscardDialog
          onKeep={() => setPendingNav(null)}
          onDiscard={() => {
            const { proceed } = pendingNav;
            setPendingNav(null);
            dirtyRef.current = false;
            setDirty(false);
            setExtensionId(null);
            proceed();
          }}
        />
      )}
    </div>
  );
}
