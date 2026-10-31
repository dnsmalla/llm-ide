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
import { NoteList } from "./NoteList";
import { NoteViewer } from "./NoteViewer";
import { NoFolder, LoadError } from "./States";
import { useLibraryState } from "./use-library.ts";

export interface LibraryScreenProps {
  store: LibraryStore;
  host: NotesHost;
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

export function LibraryScreen({ store, host, runRebuild = null, onOpenExternal, extensions = EXTENSION_PLACEHOLDERS, active = true, hostAvailable = true, initialHeight }: LibraryScreenProps): ReactNode {
  const state = useLibraryState(store);
  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [rebuild, setRebuild] = useState<RebuildProgress | null>(null);
  const rebuildAbort = useRef<AbortController | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

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

  const ext = extensionId === null ? undefined : extensions.find((x) => x.id === extensionId);

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
        <NoFolder onChoose={() => void store.chooseRoot()} error={state.error} hostAvailable={hostAvailable} />
      </div>
    );
  }
  if (state.rootStatus === "error" && state.records.length === 0) {
    return (
      <div className="lib-screen lib-screen-single" hidden={!active}>
        <NoFolder onChoose={() => void store.chooseRoot()} error={state.error} hostAvailable={hostAvailable} />
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
        onSection={(id) => {
          setExtensionId(null);
          store.setSection(id);
        }}
        onExtension={(id) => setExtensionId(id)}
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
            <NoteList store={store} state={state} initialHeight={initialHeight} />
          </div>
          <main className="lib-detail" aria-label="Note">
            {selected ? (
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
    </div>
  );
}
