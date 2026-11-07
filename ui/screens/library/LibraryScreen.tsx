// The Library screen (read side): sidebar sections, the virtualised item list and the note viewer.
// Everything it needs arrives as props (store, host, optional rebuild runner, link openers), so it
// renders and tests without Tauri; index.tsx wires the real ones.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DocIcon, StatusBanner } from "@llmide/ui-kit";
import type { NotesHost } from "./host.ts";
import type { LibraryStore } from "./library-store.ts";
import { IDLE_REBUILD, type RebuildProgress } from "./index-rebuild.ts";
import type { NoteRecord } from "./notes-model.ts";
import { EXTENSION_PLACEHOLDERS, LibraryNav, type LibraryExtension } from "./LibraryNav";
import { NoteList } from "./NoteList";
import { ProjectFilesNav, ProjectFileView, type ProjectFilesDeps } from "./ProjectFiles.tsx";
import { MEETINGS_REVEAL_PATHS, revealFirst } from "./project-files.ts";
import { refusedMessage } from "./hidden-notes.ts";
import { NoteViewer } from "./NoteViewer";
import { DiscardDialog, NewNoteDialog } from "./write/WriteDialogs";
import { NoteWorkspace } from "./write/NoteWorkspace";
import { initialNoteText, newNoteRel } from "./write/note-ops.ts";
import type { SummarizeCore } from "./write/resummarize.ts";
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
  /** Project folders for the Mac's Code/Data categories; absent when the host cannot list them. */
  files?: ProjectFilesDeps;
  /** Runs an index rebuild over the current records; absent when the core is not reachable from here. */
  runRebuild?: ((records: readonly NoteRecord[], report: (p: RebuildProgress) => void, signal: AbortSignal) => Promise<RebuildProgress>) | null;
  /** Opens an allowlisted URL through the host; reject when it cannot (a notice is shown). */
  onOpenExternal?: (url: string) => void | Promise<void>;
  extensions?: readonly LibraryExtension[];
  /** False while another section is shown (the shell keeps this screen mounted). */
  active?: boolean;
  /** True inside the desktop app: the folder dialog exists. */
  hostAvailable?: boolean;
  /** A project is open: its Paths layout owns the Library folders, so there is no separate notes-folder chooser. */
  projectOpen?: boolean;
  onCopyPath?: (text: string) => Promise<void> | void;
  onRevealPath?: (projectRelative: string) => Promise<void> | void;
  /** Host save panel for Export; absent writes a copy into the notes folder. */
  onExportFile?: (name: string, text: string) => Promise<string | null>;
  initialHeight?: number;
}

export function LibraryScreen({ store, host, write = null, connections, files, runRebuild = null, onOpenExternal, extensions = EXTENSION_PLACEHOLDERS, active = true, hostAvailable = true, projectOpen = false, onCopyPath, onRevealPath, onExportFile, initialHeight }: LibraryScreenProps): ReactNode {
  const state = useLibraryState(store);
  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [rebuild, setRebuild] = useState<RebuildProgress | null>(null);
  const rebuildAbort = useRef<AbortController | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [projectFile, setProjectFile] = useState<string | null>(null);
  const [projectFileDirty, setProjectFileDirty] = useState(false);
  const selectProjectFile = (path: string | null) => { if (projectFileDirty && !window.confirm("Discard unsaved changes?")) return; setProjectFileDirty(false); setProjectFile(path); };
  const [noteMenu, setNoteMenu] = useState<{ rel: string; x: number; y: number } | null>(null);
  // ---- write side
  const queue = useMemo(() => new WriteQueue(), []);
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
    setProjectFile(null);
  }, [state.selectedRel]);

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

  // Mac Meetings "+" menu, Reveal Folder in Finder: the meetings folder, else its parent (see revealFirst).
  const revealMeetings = useCallback(async () => {
    if (!onRevealPath) return;
    if (!(await revealFirst(MEETINGS_REVEAL_PATHS, onRevealPath))) {
      setLinkNotice("The meetings folder could not be revealed. It may not exist yet.");
    }
  }, [onRevealPath]);

  const ext = extensionId === null ? undefined : [...extensions, ...(connections ?? [])].find((x) => x.id === extensionId);

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
      <div className="lib-list-pane">
        <div className="lib-list-col">
          {linkNotice && <StatusBanner severity="info" message={linkNotice} onDismiss={() => setLinkNotice(null)} />}
          {state.error && state.records.length > 0 && <StatusBanner severity="warning" message="Some notes could not be listed. The list may be incomplete." />}
          <NoteList
            store={store}
            state={state}
            initialHeight={initialHeight}
            active={active}
            onRefresh={refresh}
            onContext={(rel, x, y) => setNoteMenu({ rel, x, y })}
            onNotice={setLinkNotice}
            footer={
              <LibraryNav
                state={state}
                extensionId={extensionId}
                extensions={extensions}
                connections={connections}
                projectNav={files ? <ProjectFilesNav deps={files} selected={projectFile} onSelect={(path) => selectProjectFile(path)} active={active} /> : undefined}
                onSection={(id) => {
                  setProjectFile(null);
                  setExtensionId(null);
                  store.setSection(state.sectionId === id ? null : id);
                }}
                onExtension={(id) => {
                  if (dirtyRef.current) setPendingNav({ proceed: () => setExtensionId(id) });
                  else setExtensionId(id);
                }}
                onRefresh={refresh}
                onChangeFolder={projectOpen ? null : () => void store.chooseRoot()}
                onRevealMeetings={onRevealPath ? () => void revealMeetings() : undefined}
                rebuild={rebuild}
                onRebuild={runRebuild ? startRebuild : null}
                onCancelRebuild={cancelRebuild}
              />
            }
          />
        </div>
      </div>
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
        <main className="lib-detail" aria-label={projectFile ? "Project file" : "Note"}>
          {projectFile ? (
            <ProjectFileView path={projectFile} deps={files!} onDirtyChange={setProjectFileDirty} onClose={() => selectProjectFile(null)} />
          ) : selected && write ? (
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
              onCopyPath={onCopyPath}
              onRevealPath={onRevealPath}
              onExportFile={onExportFile}
              active={active}
            />
          ) : selected ? (
            <NoteViewer key={selected} host={host} rel={selected} record={store.record(selected)} reloadKey={reloadKey} onOpenExternal={openExternal} onOpenNote={openNote} />
          ) : (
            <div className="lib-empty" role="status">
              <div className="lib-empty-icon" aria-hidden="true"><DocIcon /></div>
              <p className="lib-empty-title">Select an Item</p>
              <p className="lib-muted">Choose an item from the sidebar.</p>
            </div>
          )}
        </main>
      )}
      {noteMenu ? (
        <div className="lib-context" role="menu" style={{ left: noteMenu.x, top: noteMenu.y }} onMouseLeave={() => setNoteMenu(null)}>
          <button type="button" role="menuitem" onClick={() => { store.select(noteMenu.rel); setNoteMenu(null); }}>Open</button>
          <button type="button" role="menuitem" onClick={() => { void onCopyPath?.(`llm-doc/${noteMenu.rel}`); setNoteMenu(null); }}>Copy relative path</button>
          <button type="button" role="menuitem" onClick={() => { void onRevealPath?.(`llm-doc/${noteMenu.rel}`); setNoteMenu(null); }}>Reveal in Finder</button>
          {/* Hides from this list only: the note file stays where it is. */}
          {state.hidden.has(noteMenu.rel) ? (
            <button type="button" role="menuitem" onClick={() => { store.unhideNotes([noteMenu.rel]); setNoteMenu(null); }}>Unhide</button>
          ) : (
            <button type="button" role="menuitem" onClick={() => { const msg = refusedMessage(store.hideNotes([noteMenu.rel]).refused); if (msg) setLinkNotice(msg); setNoteMenu(null); }}>Remove from List</button>
          )}
        </div>
      ) : null}
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
