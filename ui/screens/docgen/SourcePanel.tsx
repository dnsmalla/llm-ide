// Source selection: Library notes, project files, pasted text, and the list of what is selected. Selection holds
// descriptors only; nothing is read until Generate. Every long list is windowed.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { FsApi } from "../explorer/fs";
import { describeFailure, isCancel } from "./errors.ts";
import { estimateFit, formatBytes, MAX_SELECTED_SOURCES } from "./model.ts";
import { filterNotes, loadNotes, type NotesIndexState } from "./notes-source.ts";
import { looksTextual, MAX_SOURCE_FILE_BYTES, walkFolder, type WalkProgress } from "./project-files.ts";
import { estimateChars, fileItem, noteItem, sendOrder, type SourceItem, type SourceSelection } from "./sources.ts";
import type { NotesHost } from "../library/host.ts";
import { VirtualList } from "./VirtualList";

export interface SourceEnv {
  notes: Pick<NotesHost, "rootGet" | "list"> | null;
  fs: Pick<FsApi, "list"> | null;
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
  initialViewport?: number;
}

type Tab = "notes" | "files" | "paste";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?|svg)$/i;

export function SourcePanel(p: SourcePanelProps): ReactNode {
  const [tab, setTab] = useState<Tab>(p.initialTab ?? "files");
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

function FilesTab({ env, selection, onAdd, onRemove, surface, initialViewport }: SourcePanelProps): ReactNode {
  const [dir, setDir] = useState("");
  const [rows, setRows] = useState<DirEntryRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [walk, setWalk] = useState<WalkProgress | null>(null);
  const [walkNote, setWalkNote] = useState<string | null>(null);
  const walkCtl = useRef<AbortController | null>(null);
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
    const ctl = new AbortController();
    setRows([]);
    setNext(null);
    load(dir, 0, ctl.signal);
    return () => ctl.abort();
  }, [dir, load]);
  useEffect(() => () => walkCtl.current?.abort(), []);

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

  const crumbs = dir === "" ? "Project root" : dir;
  return (
    <div className="dg-files">
      <div className="dg-bar">
        <button type="button" className="dg-btn" disabled={dir === ""} onClick={() => setDir(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "")}>
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
          const reason = image ? (surface === "visual" ? "image: preview needs host support" : "image") : !looksTextual(r.name) ? "binary" : r.size > MAX_SOURCE_FILE_BYTES ? "too large" : null;
          const key = `file:${r.path}`;
          const checked = selection.has(key);
          return (
            <label className="dg-check">
              <input type="checkbox" checked={checked} disabled={reason !== null} onChange={() => (checked ? onRemove([key]) : onAdd([fileItem(r.path, r.size)]))} />
              <span className="dg-name">{r.name}</span>
              <span className="dg-muted">{reason ?? formatBytes(r.size)}</span>
            </label>
          );
        }}
      />
      {next !== null && (
        <button type="button" className="dg-btn" disabled={loading} onClick={() => load(dir, next, new AbortController().signal)}>
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

// ---- library notes ----------------------------------------------------------------------------

function NotesTab({ env, selection, onAdd, onRemove, initialViewport }: SourcePanelProps): ReactNode {
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
