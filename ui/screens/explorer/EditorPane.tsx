// Editor column: banners, toolbar and the Monaco host. Monaco is loaded lazily (first open file) through
// `loadEditor`, so it stays out of the entry chunk; the controller owns documents, this owns the surface.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ExplorerController, ExplorerSnapshot } from "./controller";
import type { EditorHost } from "./editor-types";
import { canSave } from "./conflict";
import { formatSize } from "./labels";
import { invokeHost } from "../shell/host";
import { MarkdownView } from "../library/MarkdownView";

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
  const markdown = !!activeId && /\.(md|markdown)$/i.test(activeId);
  const image = !!activeId && /\.(png|jpe?g|gif|webp)$/i.test(activeId);
  const [preview, setPreview] = useState<"render" | "raw" | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const showEditor = !!doc && (doc.status === "ready" || doc.status === "range") && (!markdown || preview === "raw");
  useEffect(() => {
    setPreview(markdown ? "render" : null);
    setPreviewText("");
    setPreviewError(null);
  }, [activeId, markdown]);
  useEffect(() => {
    if (preview !== "render" || !activeId) return;
    let live = true;
    void invokeHost<unknown>("fs_read_file", { req: { path: activeId, max_bytes: 1_500_000 } }).then(
      (body) => {
        if (!live) return;
        const o = body && typeof body === "object" ? body as Record<string, unknown> : {};
        if (o.status === "ok" && typeof o.text === "string") setPreviewText(o.text);
        else setPreviewError("This Markdown file could not be read for preview.");
      },
      () => live && setPreviewError("This Markdown file could not be read for preview."),
    );
    return () => { live = false; };
  }, [preview, activeId]);

  // Load and mount Monaco the first time a tab exists. No per-run cancel flag: the effect re-runs when the tab
  // count changes, and a run-scoped flag would dispose the load that the first run already started. Unmount is
  // detected through mountEl (React nulls the ref), which is the only case where the editor must be thrown away.
  const hasTabs = snap.tabs.tabs.length > 0;
  useEffect(() => {
    if (started.current || !hasTabs) return;
    started.current = true;
    loadEditor().then(
      (ed) => {
        if (!mountEl.current) {
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
  }, [hasTabs, loadEditor, controller, editorRef]);

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
            {markdown && (d.status === "ready" || d.status === "range") ? (
              <button type="button" className="ex-tool" aria-pressed={preview === "raw"} onClick={() => setPreview(preview === "render" ? "raw" : "render")} title={preview === "render" ? "Edit the Markdown source" : "Preview Markdown"}>
                {preview === "render" ? "Edit" : "Preview"}
              </button>
            ) : null}
            {showEditor && (
              <>
                {showEditor ? <button type="button" className="ex-tool" onClick={() => editorRef.current?.find()} title="Find in file (Cmd/Ctrl+F)" aria-label="Find in file">Find</button> : null}
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
        {markdown && preview === "render" ? (
          <div className="ex-markdown" aria-label="Markdown preview">
            {previewError ? <StatusBanner severity="warning" message={previewError} /> : <MarkdownView text={previewText} baseRel={activeId} initialSections={4} />}
          </div>
        ) : image && activeId && (!d || d.status === "binary") ? (
          <ImagePreview path={activeId} size={d?.size ?? 0} />
        ) : !showEditor ? <Placeholder doc={d} controller={controller} activeId={activeId} hasTabs={snap.tabs.tabs.length > 0} /> : null}
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
  if (activeId && /\.pdf$/i.test(activeId)) {
    return (
      <div className="ex-empty" role="status">
        <p className="ex-empty-title">PDF</p>
        <p className="ex-empty-hint">PDFs are not embedded in the desktop webview. Open this one in Preview.</p>
        <button type="button" className="ex-tool" onClick={() => void invokeHost("fs_open_pdf", { path: activeId }).catch(() => undefined)}>Open in Preview</button>
      </div>
    );
  }
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


/** A host-read image preview (PNG/JPEG/GIF/WebP), bounded by the host and rendered from a data URL. */
function ImagePreview({ path, size }: { path: string; size: number }): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setError(null);
    void invokeHost<unknown>("fs_read_image", { path }).then(
      (body) => {
        if (!live) return;
        const o = body && typeof body === "object" ? body as Record<string, unknown> : {};
        if (typeof o.dataUrl === "string") setUrl(o.dataUrl);
        else setError("The image could not be read.");
      },
      (e) => live && setError(typeof e === "string" ? e : "The image could not be read."),
    );
    return () => { live = false; };
  }, [path]);
  return (
    <div className="ex-image" aria-label="Image preview">
      {error ? <StatusBanner severity="warning" message={error} /> : url ? <div className="ex-image-canvas" role="img" aria-label={path} style={{ backgroundImage: `url(${url})` }} /> : <p className="ex-empty-title" role="status">Loading image…</p>}
      <p className="ex-muted">{path} · {formatSize(size)}</p>
    </div>
  );
}
