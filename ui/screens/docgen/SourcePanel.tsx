// Source selection: Library notes, project files, pasted text, and the list of what is selected. Selection holds
// descriptors only; nothing is read until Generate. Every long list is windowed.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { FsApi } from "../explorer/fs";
import { describeFailure, isCancel } from "./errors.ts";
import { estimateFit, formatBytes, MAX_SELECTED_SOURCES } from "./model.ts";
import { filterNotes, loadNotes, type NotesIndexState } from "./notes-source.ts";
import { looksTextual, MAX_SOURCE_FILE_BYTES, walkFolder, type WalkProgress } from "./project-files.ts";
import { estimateChars, fileItem, isImageFile, noteItem, sendOrder, type SourceItem, type SourceSelection } from "./sources.ts";
import { FolderListing } from "./folder-listing.ts";
import type { NotesHost } from "../library/host.ts";
import { VirtualList } from "./VirtualList";
import { shrinkDataUrl } from "./thumbnail.ts";

export interface SourceEnv {
  notes: Pick<NotesHost, "rootGet" | "list"> | null;
  fs: Pick<FsApi, "list"> | null;
  /** Visual image preview through the host's root-confined image reader. */
  readImage?: (path: string) => Promise<string | null>;
  /** Shows a project-relative path in the OS file manager (the host's reveal_in_os). Absent outside the desktop app. */
  reveal?: (path: string) => void;
}

export interface SourcePanelProps {
  env: SourceEnv;
  selection: SourceSelection;
  note: string | null;
  surface: "doc" | "visual";
  onAdd: (items: readonly SourceItem[]) => void;
  onRemove: (keys: readonly string[]) => void;
  onClear: () => void;
  onPaste: (text: string) => boolean;
  /** Test hook: start on this tab. */
  initialTab?: Tab;
  /** When set, the selected source kind is remembered under this localStorage key. */
  sourceTabKey?: string;
  initialViewport?: number;
  /** Source keys (`file:<rel>` / `note:<rel>`) that could not be read as text in the last run: their rows get a warning. Keys, not names, so two sources with one name are told apart. */
  unreadable?: readonly string[];
}

type Tab = "notes" | "files" | "paste";

/** The Mac's Doc Gen sources are the code, LLM-doc and data Library categories (Visual: data and code only). The
 * Files tab therefore roots at those folders and cannot climb above them, instead of browsing the whole project. */
const SOURCE_ROOTS: Record<"doc" | "visual", readonly { path: string; label: string }[]> = {
  doc: [
    { path: "code", label: "Code" },
    { path: "llm-doc", label: "LLM Doc" },
    { path: "data", label: "Data" },
  ],
  visual: [
    { path: "data", label: "Data" },
    { path: "code", label: "Code" },
  ],
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?|svg)$/i;
const MAX_THUMB_BYTES = 5_000_000;

/** Images in one folder for the Visual strip, including the current one so the strip never reflows while flipping. */
export function siblingImages(rows: readonly DirEntryRow[], max = 12, currentPath?: string): DirEntryRow[] {
  const all = rows
    .filter((r) => r.kind === "file" && isImageFile(r.name) && r.size > 0 && r.size <= MAX_THUMB_BYTES)
    .sort((a, b) => a.name.localeCompare(b.name));
  const cap = Math.max(0, max);
  if (cap === 0) return [];
  if (all.length <= cap) return all;
  const at = currentPath ? all.findIndex((r) => r.path === currentPath) : -1;
  // Keep the shown image in the strip even when it sorts past the cap: replace the last slot instead of dropping it.
  return at >= cap ? [...all.slice(0, cap - 1), all[at]!] : all.slice(0, cap);
}

export function SourcePanel(p: SourcePanelProps): ReactNode {
  const [tab, setTabState] = useState<Tab>(() => {
    if (p.sourceTabKey) { try { const v = localStorage.getItem(p.sourceTabKey); if (v === "files" || v === "notes" || v === "paste") return v; } catch { /* session */ } }
    return p.initialTab ?? "files";
  });
  const setTab = (next: Tab) => { setTabState(next); if (p.sourceTabKey) { try { localStorage.setItem(p.sourceTabKey, next); } catch { /* session */ } } };
  const tabs: { id: Tab; label: string }[] = [
    { id: "files", label: "Project files" },
    { id: "notes", label: "Library notes" },
    { id: "paste", label: "Pasted text" },
  ];
  return (
    <section className="dg-sources" aria-label="Sources">
      <div className="dg-tabs" role="tablist" aria-label="Where sources come from">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`dg-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`dg-pane-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className="dg-tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`dg-pane-${tab}`} aria-labelledby={`dg-tab-${tab}`} className="dg-pane">
        {tab === "files" && <FilesTab {...p} />}
        {tab === "notes" && <NotesTab {...p} />}
        {tab === "paste" && <PasteTab onPaste={p.onPaste} />}
      </div>
      {p.note && (
        <div className="dg-note" role="status">
          {p.note}
        </div>
      )}
      <Selected selection={p.selection} surface={p.surface} onRemove={p.onRemove} onClear={p.onClear} initialViewport={p.initialViewport} />
    </section>
  );
}

// ---- project files ----------------------------------------------------------------------------

interface DirEntryRow {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
}

function FilesTab({ env, selection, onAdd, onRemove, surface, initialViewport, unreadable }: SourcePanelProps): ReactNode {
  const roots = SOURCE_ROOTS[surface];
  const [dir, setDir] = useState(roots[0]!.path);
  const [rows, setRows] = useState<DirEntryRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [walk, setWalk] = useState<WalkProgress | null>(null);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [thumbsReady, setThumbsReady] = useState(false);
  const thumbCache = useRef<Map<string, string>>(new Map());
  const previewSeq = useRef(0);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const viewRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const wasOpen = useRef(false);
  const [walkNote, setWalkNote] = useState<string | null>(null);
  const walkCtl = useRef<AbortController | null>(null);
  // Pages of the folder on screen; a folder change aborts the pages of the previous one (see FolderListing).
  const listing = useRef(new FolderListing());
  const fs = env.fs;

  const load = useCallback(
    (path: string, offset: number, signal: AbortSignal) => {
      if (!fs) return;
      setLoading(true);
      setErr(null);
      fs.list(path, { offset, limit: 500, show_hidden: false, gitignore: true, hide_ignored: true }).then(
        (r) => {
          if (signal.aborted) return;
          const add: DirEntryRow[] = [];
          for (const e of r.entries) {
            if (e.symlink || e.ignored || e.hidden) continue;
            if (e.kind === "dir" || e.kind === "file") add.push({ name: e.name, path: e.path, kind: e.kind, size: e.size });
          }
          setRows((old) => (offset === 0 ? add : [...old, ...add]));
          setNext(r.next_offset);
          setLoading(false);
        },
        (e: unknown) => {
          if (signal.aborted) return;
          setLoading(false);
          setErr(describeFailure(e).message);
        },
      );
    },
    [fs],
  );
  useEffect(() => {
    const signal = listing.current.switchTo();
    setRows([]);
    setNext(null);
    load(dir, 0, signal);
  }, [dir, load]);
  useEffect(() => () => { walkCtl.current?.abort(); listing.current.dispose(); }, []);

  if (!fs) return <p className="dg-muted">Project files need the desktop app.</p>;

  const addFolder = () => {
    walkCtl.current?.abort();
    const ctl = new AbortController();
    walkCtl.current = ctl;
    setWalk({ dirs: 0, files: 0 });
    setWalkNote(null);
    walkFolder(fs, dir, ctl.signal, (pr) => !ctl.signal.aborted && setWalk(pr)).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setWalk(null);
        onAdd(r.items);
        const bits = [`Added ${r.items.length.toLocaleString("en")} files`];
        if (r.capped) bits.push("stopped at the folder limit; add subfolders separately");
        if (r.skippedBinary) bits.push(`${r.skippedBinary} binary skipped`);
        if (r.skippedLarge) bits.push(`${r.skippedLarge} over ${formatBytes(MAX_SOURCE_FILE_BYTES)} skipped`);
        setWalkNote(`${bits.join("; ")}.`);
      },
      (e: unknown) => {
        if (ctl.signal.aborted || isCancel(e)) return;
        setWalk(null);
        setErr(describeFailure(e).message);
      },
    );
  };

  const siblings = useMemo(() => (preview ? siblingImages(rows, 12, preview.path) : []), [preview, rows]);
  useEffect(() => {
    setThumbs({});
    if (!preview) thumbCache.current.clear();
  }, [preview?.path]);
  useEffect(() => {
    if (!preview || !env.readImage) return undefined;
    let live = true;
    setThumbsReady(false);
    void (async () => {
      try {
      for (const r of siblings) {
        if (!live) return;
        if (r.path === preview.path) continue;
        const cached = thumbCache.current.get(r.path);
        if (cached) { setThumbs((old) => (old[r.path] === cached ? old : { ...old, [r.path]: cached })); continue; }
        try {
          const full = await env.readImage!(r.path);
          if (!live) return;
          if (!full) continue;
          const thumb = await shrinkDataUrl(full);
          if (!live) return;
          thumbCache.current.set(r.path, thumb);
          setThumbs((old) => ({ ...old, [r.path]: thumb }));
        } catch { /* a sibling that cannot be read is simply omitted */ }
      }
      } finally { if (live) setThumbsReady(true); }
    })();
    return () => { live = false; };
  }, [preview?.path, siblings, env.readImage]);
  useEffect(() => {
    if (preview && !wasOpen.current) stripRef.current?.querySelector<HTMLButtonElement>("[data-current]")?.focus();
    wasOpen.current = preview !== null;
  }, [preview?.path]);

  const openPreview = async (path: string) => {
    if (!env.readImage || path === preview?.path) return;
    const seq = ++previewSeq.current;
    try {
      const url = await env.readImage(path);
      if (seq === previewSeq.current && url) setPreview({ path, url });
    } catch { /* the row's View action stays available for a retry */ }
  };
  const closePreview = (restoreFocus = false) => {
    const path = preview?.path;
    previewSeq.current += 1;
    setPreview(null);
    if (restoreFocus && path) requestAnimationFrame(() => viewRefs.current.get(path)?.focus());
  };

  useEffect(() => { closePreview(false); }, [dir]);
  const root = roots.find((r) => dir === r.path || dir.startsWith(`${r.path}/`)) ?? roots[0]!;
  const rel = dir === root.path ? "" : dir.slice(root.path.length + 1);
  const crumbs = rel === "" ? root.label : `${root.label} / ${rel}`;
  return (
    <div className="dg-files">
      <div className="dg-roots" role="tablist" aria-label="Source categories">
        {roots.map((r) => (
          <button key={r.path} type="button" role="tab" aria-selected={root.path === r.path} className="dg-tab" onClick={() => setDir(r.path)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="dg-bar">
        <button type="button" className="dg-btn" disabled={dir === root.path} onClick={() => setDir(rel.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : root.path)}>
          Up
        </button>
        <span className="dg-crumbs" title={crumbs}>
          {crumbs}
        </span>
        <button type="button" className="dg-btn" disabled={walk !== null} onClick={addFolder} title="Adds the text files in this folder and its subfolders (hidden and git-ignored files are skipped; up to 2,000 files)">
          Add this folder
        </button>
      </div>
      {walk && (
        <p className="dg-muted" role="status" aria-live="polite">
          Scanning… {walk.files.toLocaleString("en")} files in {walk.dirs.toLocaleString("en")} folders{" "}
          <button type="button" className="dg-link" onClick={() => {
              walkCtl.current?.abort();
              setWalk(null);
            }}>
            Cancel
          </button>
        </p>
      )}
      {walkNote && !walk && <p className="dg-muted">{walkNote}</p>}
      {err && (
        <StatusBanner severity="error" message={<>{err}</>} />
      )}
      {preview ? (
        <div className="dg-image-preview" role="dialog" aria-label={`Image preview ${preview.path}`} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); closePreview(true); } }}>
          <div className="dg-image-canvas" role="img" aria-label={preview.path} style={{ backgroundImage: `url(${preview.url})` }} />
          <div className="dg-bar"><span className="dg-muted">{preview.path}</span><span className="dg-spacer" />{env.reveal && <button type="button" className="dg-btn" onClick={() => env.reveal!(preview.path)}>Reveal</button>}<button type="button" className="dg-btn" onClick={() => closePreview(true)}>Close</button></div>
          {env.readImage && siblings.length > 1 && (
            <div ref={stripRef} className="dg-thumbs" role="group" aria-label={`Images in ${crumbs}`} aria-busy={!thumbsReady}>
              {siblings.map((r) => {
                const here = r.path === preview.path;
                const url = here ? preview.url : thumbs[r.path];
                return (
                  <button key={r.path} type="button" className="dg-thumb" data-current={here || undefined} aria-current={here ? "true" : undefined} tabIndex={here ? -1 : 0} title={r.name} aria-label={here ? `${r.name} (shown)` : `Preview ${r.name}`} onClick={() => void openPreview(r.path)}>
                    {url ? <span className="dg-thumb-img" style={{ backgroundImage: `url(${url})` }} /> : <span className="dg-thumb-wait" aria-hidden="true" />}
                    <span className="dg-thumb-name">{r.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      <VirtualList
        items={rows}
        rowHeight={30}
        height={220}
        label={`Files in ${crumbs}`}
        initialViewport={initialViewport}
        keyOf={(r) => r.path}
        render={(r) => {
          if (r.kind === "dir") {
            return (
              <button type="button" className="dg-rowbtn" onClick={() => setDir(r.path)} aria-label={`Open folder ${r.name}`}>
                <span aria-hidden="true">▸</span> {r.name}
              </button>
            );
          }
          const image = IMAGE_EXT.test(r.name);
          // Same size limit as the preview strip (siblingImages): a larger image has no preview to open.
          const previewable = isImageFile(r.name) && r.size <= MAX_THUMB_BYTES;
          // Images can be previewed but not sent: the core reads every source as text (see readOne in sources.ts).
          const reason = image
            ? "image (not sent to the model)"
            : !looksTextual(r.name) ? "binary" : r.size > MAX_SOURCE_FILE_BYTES ? "too large" : null;
          const key = `file:${r.path}`;
          const checked = selection.has(key);
          return (
            <label className="dg-check">
              <input type="checkbox" checked={checked} disabled={reason !== null} onChange={() => (checked ? onRemove([key]) : onAdd([fileItem(r.path, r.size)]))} />
              <span className="dg-name">{r.name}</span>
              <UnreadMark sourceKey={key} unreadable={unreadable} />
              <span className="dg-muted">{reason ?? formatBytes(r.size)}</span>
              {previewable && env.readImage ? (
                <button type="button" className="dg-link" ref={(el) => { if (el) viewRefs.current.set(r.path, el); else viewRefs.current.delete(r.path); }} onClick={(e) => { e.preventDefault(); void openPreview(r.path); }}>View</button>
              ) : null}
            </label>
          );
        }}
      />
      {next !== null && (
        <button type="button" className="dg-btn" disabled={loading} onClick={() => load(dir, next, listing.current.signal)}>
          Load more
        </button>
      )}
      {loading && (
        <p className="dg-muted" role="status">
          Loading…
        </p>
      )}
      {!loading && rows.length === 0 && !err && <p className="dg-muted">This folder is empty.</p>}
    </div>
  );
}

/** Warning on a source row the last run could not read. Matched by the source's unique key, so two sources with one name are told apart. */
export function UnreadMark({ sourceKey, unreadable }: { sourceKey: string; unreadable: readonly string[] | undefined }): ReactNode {
  if (!unreadable || !unreadable.includes(sourceKey)) return null;
  return <span className="dg-warn" role="img" aria-label="Could not read this file" title="Could not read this file">!</span>;
}

// ---- library notes ----------------------------------------------------------------------------

function NotesTab({ env, selection, onAdd, onRemove, initialViewport, unreadable }: SourcePanelProps): ReactNode {
  const [idx, setIdx] = useState<NotesIndexState>({ phase: "idle", records: [], capped: false, errorCode: null });
  const [q, setQ] = useState("");
  const host = env.notes;
  useEffect(() => {
    if (!host) return;
    const ctl = new AbortController();
    setIdx((s) => ({ ...s, phase: "loading" }));
    loadNotes(host, ctl.signal).then(
      (r) => !ctl.signal.aborted && setIdx(r),
      (e: unknown) => !ctl.signal.aborted && !isCancel(e) && setIdx({ phase: "error", records: [], capped: false, errorCode: "io" }),
    );
    return () => ctl.abort();
  }, [host]);
  const shown = useMemo(() => filterNotes(idx.records, q), [idx.records, q]);
  if (!host) return <p className="dg-muted">Library notes need the desktop app.</p>;
  if (idx.phase === "loading" || idx.phase === "idle") {
    return (
      <p className="dg-muted" role="status" aria-live="polite">
        Listing notes…
      </p>
    );
  }
  if (idx.phase === "none") return <p className="dg-muted">No notes folder is chosen yet. Choose one in Library.</p>;
  if (idx.phase === "error") return <StatusBanner severity="error" message={<>The notes folder could not be listed.</>} />;
  const addAll = () => onAdd(shown.slice(0, MAX_SELECTED_SOURCES).map((r) => noteItem(r.rel, r.size, r.title)));
  return (
    <div className="dg-notes">
      <div className="dg-bar">
        <label className="dg-field">
          <span className="dg-sr">Filter notes</span>
          <input type="search" value={q} placeholder="Filter notes by title or path" onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="dg-btn" disabled={shown.length === 0} onClick={addAll}>
          Add {shown.length > 200 ? "first " + Math.min(shown.length, MAX_SELECTED_SOURCES).toLocaleString("en") : `all ${shown.length}`}
        </button>
      </div>
      <p className="dg-muted" role="status">
        {shown.length.toLocaleString("en")} of {idx.records.length.toLocaleString("en")} notes{idx.capped ? " (the list is capped; narrow it with the filter)" : ""}
      </p>
      <VirtualList
        items={shown}
        rowHeight={32}
        height={220}
        label="Library notes"
        initialViewport={initialViewport}
        keyOf={(r) => r.rel}
        render={(r) => {
          const checked = selection.has(`note:${r.rel}`);
          return (
            <label className="dg-check">
              <input type="checkbox" checked={checked} onChange={() => (checked ? onRemove([`note:${r.rel}`]) : onAdd([noteItem(r.rel, r.size, r.title)]))} />
              <span className="dg-name">{r.title}</span>
              <UnreadMark sourceKey={`note:${r.rel}`} unreadable={unreadable} />
              <span className="dg-muted">{formatBytes(r.size)}</span>
            </label>
          );
        }}
      />
    </div>
  );
}

// ---- pasted text ------------------------------------------------------------------------------

function PasteTab({ onPaste }: { onPaste: (text: string) => boolean }): ReactNode {
  const [text, setText] = useState("");
  return (
    <form
      className="dg-paste"
      onSubmit={(e) => {
        e.preventDefault();
        if (onPaste(text)) setText("");
      }}
    >
      <label className="dg-field">
        <span>Paste text to use as a source</span>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </label>
      <button type="submit" className="dg-btn" disabled={text.trim() === ""}>
        Add as source
      </button>
    </form>
  );
}

// ---- what is selected -------------------------------------------------------------------------

function Selected({ selection, surface, onRemove, onClear, initialViewport }: Pick<SourcePanelProps, "selection" | "surface" | "onRemove" | "onClear" | "initialViewport">): ReactNode {
  const items = useMemo(() => sendOrder(selection.items()), [selection]);
  const totals = selection.totals();
  const fit = useMemo(() => estimateFit(items.map((i) => ({ name: i.name, chars: i.kind === "paste" ? i.bytes : estimateChars(i.bytes) }))), [items]);
  if (items.length === 0) {
    return (
      <p className="dg-muted" id="dg-selected-empty">
        {surface === "visual" ? "No sources selected. Add text files or notes to describe or diagram." : "No sources selected. Add files, notes or pasted text."}
      </p>
    );
  }
  return (
    <div className="dg-selected">
      <div className="dg-bar">
        <strong>
          {totals.count.toLocaleString("en")} selected, {formatBytes(totals.bytes)}
        </strong>
        <button type="button" className="dg-btn" onClick={onClear}>
          Clear
        </button>
      </div>
      <p className="dg-muted" role="status" data-testid="fit">
        {fitSentence(fit)}
      </p>
      <VirtualList
        items={items}
        rowHeight={28}
        height={140}
        label="Selected sources"
        initialViewport={initialViewport}
        keyOf={(i) => i.key}
        render={(i) => (
          <span className="dg-check">
            <span className="dg-name" title={i.rel || i.name}>
              {i.name}
            </span>
            <span className="dg-muted">{i.kind === "paste" ? "pasted" : i.kind === "note" ? "note" : "file"}</span>
            <button type="button" className="dg-link" aria-label={`Remove ${i.name}`} onClick={() => onRemove([i.key])}>
              Remove
            </button>
          </span>
        )}
      />
    </div>
  );
}

export function fitSentence(f: ReturnType<typeof estimateFit>): string {
  const parts = [`about ${f.tokens.toLocaleString("en")} input tokens`];
  if (f.shortened > 0) parts.push(`${f.shortened.toLocaleString("en")} will be shortened to fit`);
  if (f.omitted > 0) parts.push(`${f.omitted.toLocaleString("en")} will be left out`);
  return `The model will read ${parts.join("; ")}.`;
}
