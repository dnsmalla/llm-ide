// Editor column: banners, toolbar and the Monaco host. Monaco is loaded lazily (first open file) through
// `loadEditor`, so it stays out of the entry chunk; the controller owns documents, this owns the surface.
import { useEffect, useRef, useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ExplorerController, ExplorerSnapshot } from "./controller";
import type { EditorHost } from "./editor-types";
import { canSave } from "./conflict";
import { formatSize } from "./labels";

interface Props {
  controller: ExplorerController;
  snap: ExplorerSnapshot;
  loadEditor: () => Promise<EditorHost>;
  /** Mutable slot the screen's controller reads the live editor from. */
  editorRef: { current: EditorHost | null };
  onCloseTab(id: string): void;
}

export function EditorPane({ controller, snap, loadEditor, editorRef, onCloseTab }: Props) {
  const mountEl = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeId = snap.tabs.activeId;
  const doc = activeId ? snap.docs.get(activeId) : undefined;
  const showEditor = !!doc && (doc.status === "ready" || doc.status === "range");

  // Load and mount Monaco the first time a tab exists.
  useEffect(() => {
    if (started.current || snap.tabs.tabs.length === 0) return;
    started.current = true;
    let cancelled = false;
    loadEditor().then(
      (ed) => {
        if (cancelled || !mountEl.current) {
          ed.dispose();
          return;
        }
        ed.mount(mountEl.current, {
          onDirty: (p, d) => controller.onEditorDirty(p, d),
          onSave: (p) => void controller.save(p),
          onEvict: () => undefined,
        });
        editorRef.current = ed;
        controller.attachEditor();
      },
      (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [snap.tabs.tabs.length, loadEditor, controller, editorRef]);

  // Dispose with the screen.
  useEffect(
    () => () => {
      editorRef.current?.dispose();
      editorRef.current = null;
    },
    [editorRef],
  );

  // Re-theme when the app theme changes.
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => editorRef.current?.retheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [editorRef]);

  // Monaco must re-measure after being hidden.
  useEffect(() => {
    if (showEditor) editorRef.current?.layout();
  }, [showEditor, activeId, editorRef]);

  const d = doc;
  const st = d?.state;
  const readOnlyReason = !d
    ? null
    : d.status === "range"
      ? null
      : d.readOnly && d.status === "ready"
        ? d.encoding === "unknown"
          ? "This file is not valid UTF-8, so it is open read-only to avoid corrupting it."
          : "This file is read-only."
        : null;

  return (
    <section className="ex-editor" aria-label="Editor">
      {loadError && <StatusBanner severity="error" message={`The editor could not load: ${loadError}`} />}
      {d && st && activeId && (
        <>
          <div className="ex-toolbar" role="toolbar" aria-label="File actions">
            <span className="ex-crumb" title={activeId}>{activeId}</span>
            <span className="ex-spacer" />
            {showEditor && (
              <span className="ex-meta">
                {d.language}
                {d.status === "ready" ? ` · ${d.encoding === "unknown" ? "unknown encoding" : d.encoding.toUpperCase()}${d.bom ? " BOM" : ""} · ${d.eol === "none" ? "LF" : d.eol.toUpperCase()}` : ""}
                {` · ${formatSize(d.size)}`}
              </span>
            )}
            {showEditor && (
              <>
                <button type="button" className="ex-tool" onClick={() => editorRef.current?.find()} title="Find in file (Cmd/Ctrl+F)" aria-label="Find in file">Find</button>
                {snap.git && d.status === "ready" && (
                  <button type="button" className="ex-tool" aria-pressed={snap.diffPath === activeId} onClick={() => void controller.toggleDiff(activeId)} title="Compare with the last commit">Diff</button>
                )}
                <button type="button" className="ex-tool ex-tool-primary" disabled={!canSave(st, d.readOnly)} onClick={() => void controller.save(activeId)} title="Save (Cmd/Ctrl+S)">
                  {st.saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
          {st.external === "changed" && (
            <div className="ex-banner-row">
              <StatusBanner severity="warning" message="This file changed on disk while you have unsaved edits." />
              <button type="button" className="ex-btn" onClick={() => void controller.reloadFromDisk(activeId)}>Reload from disk</button>
              <button type="button" className="ex-btn" onClick={() => void controller.keepMineOnly(activeId)}>Keep mine</button>
            </div>
          )}
          {st.external === "deleted" && (
            <div className="ex-banner-row">
              <StatusBanner severity="warning" message="This file was deleted on disk." />
              <button type="button" className="ex-btn" onClick={() => void controller.keepMineAndSave(activeId)}>Save to recreate</button>
              <button type="button" className="ex-btn" onClick={() => onCloseTab(activeId)}>Close tab</button>
            </div>
          )}
          {st.saveError && <StatusBanner severity="error" message={`Could not save: ${st.saveError}`} />}
          {readOnlyReason && <StatusBanner severity="info" message={readOnlyReason} />}
          {d.status === "range" && (
            <div className="ex-banner-row">
              <StatusBanner severity="info" message={`Read-only view of a large file (${formatSize(d.size)}). ${d.rangeNext === null ? "End of file." : "More is available."}`} />
              {d.rangeNext !== null && <button type="button" className="ex-btn" onClick={() => void controller.loadMoreRange(activeId)}>Load next 1 MB</button>}
            </div>
          )}
        </>
      )}
      <div className="ex-editor-body">
        <div ref={mountEl} className="ex-monaco" hidden={!showEditor} />
        {!showEditor && <Placeholder doc={d} controller={controller} activeId={activeId} hasTabs={snap.tabs.tabs.length > 0} />}
      </div>
    </section>
  );
}

function Placeholder({ doc, controller, activeId, hasTabs }: { doc: ReturnType<ExplorerSnapshot["docs"]["get"]>; controller: ExplorerController; activeId: string | null; hasTabs: boolean }) {
  if (!activeId || !hasTabs) {
    return (
      <div className="ex-empty" role="status">
        <p className="ex-empty-title">No file open</p>
        <p className="ex-empty-hint">Select a file in the tree to open it. Single click previews, double click keeps the tab.</p>
      </div>
    );
  }
  if (!doc || doc.status === "loading") return <div className="ex-empty" role="status"><p className="ex-empty-title">Opening…</p></div>;
  if (doc.status === "binary") {
    return (
      <div className="ex-empty" role="status">
        <p className="ex-empty-title">Binary file</p>
        <p className="ex-empty-hint">{`${activeId} (${formatSize(doc.size)}) is not shown because it is not text.`}</p>
      </div>
    );
  }
  if (doc.status === "too_large") {
    return (
      <div className="ex-empty" role="status">
        <p className="ex-empty-title">File too large to open</p>
        <p className="ex-empty-hint">{`${activeId} is ${formatSize(doc.size)}. Opening it whole would slow the app down.`}</p>
        <button type="button" className="ex-btn" onClick={() => void controller.openAnyway(activeId)}>Open first 1 MB read-only</button>
      </div>
    );
  }
  return (
    <div className="ex-empty" role="alert">
      <p className="ex-empty-title">Cannot open this file</p>
      <p className="ex-empty-hint">{doc.error ?? "Unknown error."}</p>
    </div>
  );
}
