// Project search panel: debounced query, option toggles, include/exclude filters, streamed results grouped by
// file in a virtualised listbox (only the visible window is rendered), keyboard navigation.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SearchController } from "./controller";
import { skippedNotice, summaryText, scrollToReveal, truncationNotice, windowRows, type Hit, type Row, type SearchOptions } from "./model";

export const ROW_HEIGHT = 22;
const DEFAULT_VIEWPORT = 400;

export interface SearchPanelProps {
  controller: SearchController;
  /** Incremented to request focus on the query box (Mod+Shift+F). */
  focusSignal?: number;
  /** Initial viewport height before the first measurement (tests, first paint). */
  initialViewport?: number;
  /** Replace all matches in the listed files (preserveCase matches each match's case); absent = read-only search. */
  onReplaceAll?: (query: string, opts: SearchOptions, paths: string[], replacement: string, preserveCase: boolean) => Promise<{ files: number; replacements: number; failed: string[] }>;
}

function HitText({ hit }: { hit: Hit }) {
  const { preview, ms, me } = hit;
  const lead = preview.slice(0, ms).replace(/^\s+/, "");
  return (
    <>
      <span>{lead}</span>
      <mark className="sx-mark">{preview.slice(ms, me)}</mark>
      <span>{preview.slice(me)}</span>
    </>
  );
}

/**
 * Whether "Replace all" may run on this snapshot, as on the Mac (`replaceAllDisabled`): only on a finished, complete
 * search. A search still running or truncated in any way ("matches", "files", "time") lists only part of the matches,
 * so "all" would silently skip the rest.
 */
export function canReplaceAll(snap: { phase: string; query: string; files: { hits: unknown[] }[]; done: { truncated: string | null } | null }): boolean {
  return snap.phase === "done" && snap.query !== "" && snap.done !== null && snap.done.truncated === null && snap.files.some((f) => f.hits.length > 0);
}

/** The files a Replace All rewrites: exactly the listed files with at least one hit. */
export function replaceTargets(snap: { files: { path: string; hits: unknown[] }[] }): string[] {
  return snap.files.filter((f) => f.hits.length > 0).map((f) => f.path);
}

function baseOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function SearchPanel({ controller, focusSignal = 0, initialViewport = DEFAULT_VIEWPORT, onReplaceAll }: SearchPanelProps) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const rows = controller.rows();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(initialViewport);
  const [filters, setFilters] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [replacement, setReplacement] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null);
  const [preserveCase, setPreserveCase] = useState(false);
  /** Replace All asks first, as on the Mac: it rewrites every listed file. */
  const [confirmAll, setConfirmAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();

  useEffect(() => {
    if (focusSignal > 0) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusSignal]);

  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight || DEFAULT_VIEWPORT));
    ro.observe(el);
    setViewport(el.clientHeight || DEFAULT_VIEWPORT);
    return () => ro.disconnect();
  }, []);

  // Keep the keyboard selection visible.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const to = scrollToReveal(snap.selected, el.scrollTop, el.clientHeight || viewport, ROW_HEIGHT);
    if (to !== null) el.scrollTop = to;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.selected]);

  const win = windowRows(rows.length, scrollTop, viewport, ROW_HEIGHT);
  const rowId = (i: number) => `${uid}-r${i}`;
  const o = snap.opts;

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      controller.moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      controller.moveSelection(-1);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      controller.moveSelection((e.key === "PageDown" ? 1 : -1) * Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      controller.select(e.key === "Home" ? 0 : rows.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (snap.selected >= 0) controller.activate(snap.selected);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const r = rows[snap.selected];
      if (r?.kind === "file" && r.collapsed === (e.key === "ArrowRight")) {
        e.preventDefault();
        controller.toggleCollapsed(r.path);
      }
    } else if (e.key === "Escape") {
      input.current?.focus();
    }
  };

  const onQueryKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      controller.runNow();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (snap.phase === "searching") controller.cancel();
      else controller.clear();
    } else if (e.key === "ArrowDown" && rows.length > 0) {
      e.preventDefault();
      controller.moveSelection(1);
      list.current?.focus();
    }
  };

  const toggle = (label: string, title: string, pressed: boolean, on: () => void) => (
    <button type="button" className="sx-toggle" aria-pressed={pressed} aria-label={title} title={title} onClick={on}>
      {label}
    </button>
  );

  /** Replaces in `paths` and reports the outcome in the replace note. */
  const runReplace = (paths: string[]) => {
    if (!onReplaceAll) return;
    setReplacing(true);
    setConfirmAll(false);
    setReplaceNotice(null);
    void onReplaceAll(snap.query, snap.opts, paths, replacement, preserveCase).then(
      (r) => setReplaceNotice(`Replaced ${r.replacements.toLocaleString()} match${r.replacements === 1 ? "" : "es"} in ${r.files.toLocaleString()} file${r.files === 1 ? "" : "s"}${r.failed.length ? `; ${r.failed.length} could not be written` : ""}.`),
      () => setReplaceNotice("Replace all failed."),
    ).finally(() => setReplacing(false));
  };
  const canReplace = !!onReplaceAll && !replacing && canReplaceAll(snap);
  // Per-file replace rewrites one listed file the user picked; the Mac allows it on a truncated search too.
  const canReplaceFile = !!onReplaceAll && !replacing && snap.phase === "done" && snap.query !== "";
  // The confirm names a file count: a new search (or new results) invalidates it, so it closes.
  useEffect(() => setConfirmAll(false), [snap.query, snap.opts, snap.files, snap.phase]);

  const trunc = truncationNotice(snap.done);
  const skipped = snap.phase === "done" ? skippedNotice(snap.done) : null;

  const renderRow = (r: Row, i: number) => {
    const common = { id: rowId(i), role: "option" as const, "aria-selected": snap.selected === i, "aria-posinset": i + 1, "aria-setsize": rows.length, style: { height: ROW_HEIGHT } };
    if (r.kind === "file") {
      return (
        <div key={`f:${r.path}`} {...common} aria-expanded={!r.collapsed} aria-label={`${r.path}, ${r.count} result${r.count === 1 ? "" : "s"}${r.more ? " or more" : ""}`} className="sx-row sx-file" data-selected={snap.selected === i} title={r.path} onClick={() => controller.activate(i)}>
          <span className="sx-chevron" aria-hidden="true">{r.collapsed ? "▸" : "▾"}</span>
          <span className="sx-fname">{baseOf(r.path)}</span>
          <span className="sx-fdir">{dirOf(r.path)}</span>
          <span className="sx-count">{r.count}{r.more ? "+" : ""}</span>
          {canReplaceFile ? (
            <button type="button" className="sx-toggle" aria-label={`Replace all in ${baseOf(r.path)}`} title="Replace all matches in this file" onClick={(e) => { e.stopPropagation(); runReplace([r.path]); }}>⇄</button>
          ) : null}
        </div>
      );
    }
    return (
      <div key={r.key} {...common} aria-label={`Line ${r.hit.line} in ${baseOf(r.path)}: ${r.hit.preview.slice(0, 120)}`} className="sx-row sx-hit" data-selected={snap.selected === i} title={`${r.path}:${r.hit.line}`} onClick={() => controller.activate(i)}>
        <span className="sx-line">{r.hit.line}</span>
        <span className="sx-preview"><HitText hit={r.hit} /></span>
      </div>
    );
  };

  return (
    <section className="sx-root" aria-label="Search">
      <div className="sx-form">
        <div className="sx-inputrow">
          <input
            ref={input}
            type="text"
            className="sx-input"
            role="searchbox"
            aria-label="Search query"
            placeholder="Search"
            spellCheck={false}
            autoComplete="off"
            maxLength={1000}
            value={snap.query}
            onChange={(e) => controller.setQuery(e.target.value)}
            onKeyDown={onQueryKey}
          />
          {toggle("Aa", "Match case", o.caseSensitive, () => controller.setOptions({ caseSensitive: !o.caseSensitive }))}
          {toggle("W", "Match whole word", o.wholeWord, () => controller.setOptions({ wholeWord: !o.wholeWord }))}
          {toggle(".*", "Use regular expression", o.regex, () => controller.setOptions({ regex: !o.regex }))}
        </div>
        {onReplaceAll ? (
          <div className="sx-inputrow">
            <input
              type="text"
              className="sx-input"
              aria-label="Replace with"
              placeholder="Replace with"
              spellCheck={false}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
            {toggle("AB", "Preserve case", preserveCase, () => setPreserveCase(!preserveCase))}
            <button
              type="button"
              className="sx-toggle"
              disabled={!canReplace}
              title={snap.done?.truncated ? "Replace all is disabled when the search was truncated; narrow the search first." : "Replace all matches in the listed text files"}
              onClick={() => setConfirmAll(true)}
            >
              {replacing ? "Replacing…" : "Replace all"}
            </button>
          </div>
        ) : null}
        {confirmAll && canReplace ? (
          <div className="sx-note" role="alertdialog" aria-label="Confirm replace all" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setConfirmAll(false); } }}>
            <span>{`Replace all matches in ${replaceTargets(snap).length.toLocaleString()} file${replaceTargets(snap).length === 1 ? "" : "s"}?`}</span>{" "}
            <button type="button" className="ex-link" onClick={() => { if (canReplace) runReplace(replaceTargets(snap)); }}>Replace all</button>{" "}
            {/* Focus lands on Cancel (the safe default), so Escape reaches the handler above and Enter does not replace. */}
            <button type="button" className="ex-link" autoFocus onClick={() => setConfirmAll(false)}>Cancel</button>
          </div>
        ) : null}
        {replaceNotice ? <p className="sx-note" role="status">{replaceNotice}</p> : null}
        <div className="sx-filterhead">
          <button type="button" className="ex-link" aria-expanded={filters} aria-controls={`${uid}-filters`} onClick={() => setFilters(!filters)}>
            {filters ? "Hide filters" : "Filters…"}
          </button>
          {snap.files.length > 1 && (
            <>
              <button type="button" className="ex-link" onClick={() => controller.collapseAll(true)}>Collapse all</button>
              <button type="button" className="ex-link" onClick={() => controller.collapseAll(false)}>Expand all</button>
            </>
          )}
        </div>
        {filters && (
          <div id={`${uid}-filters`} className="sx-filters">
            <label className="sx-flabel">
              Files to include
              <input type="text" className="sx-input" aria-label="Files to include" placeholder="e.g. src/**, *.ts" spellCheck={false} value={o.include} onChange={(e) => controller.setOptions({ include: e.target.value })} />
            </label>
            <label className="sx-flabel">
              Files to exclude
              <input type="text" className="sx-input" aria-label="Files to exclude" placeholder="e.g. dist/, *.min.js" spellCheck={false} value={o.exclude} onChange={(e) => controller.setOptions({ exclude: e.target.value })} />
            </label>
            <label className="sx-check">
              <input type="checkbox" checked={o.openFilesOnly} onChange={(e) => controller.setOptions({ openFilesOnly: e.target.checked })} />
              Open files only (saved content)
            </label>
            <label className="sx-check">
              <input type="checkbox" checked={o.useIgnore} onChange={(e) => controller.setOptions({ useIgnore: e.target.checked })} />
              Use .gitignore
            </label>
          </div>
        )}
      </div>
      <div className="sx-summary" role="status" aria-live="polite" data-phase={snap.phase}>
        {snap.phase === "error" ? <StatusBanner severity="error" message={summaryText(snap)} /> : summaryText(snap)}
        {snap.phase === "searching" && (
          <button type="button" className="ex-link" onClick={() => controller.cancel()}>Stop</button>
        )}
      </div>
      {trunc && <StatusBanner severity="warning" message={trunc} />}
      {skipped && <p className="sx-skipped">{skipped}</p>}
      <div
        ref={list}
        className="sx-results"
        role="listbox"
        aria-label="Search results"
        aria-activedescendant={snap.selected >= 0 && snap.selected < rows.length ? rowId(snap.selected) : undefined}
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onListKey}
      >
        <div data-pad="top" style={{ height: win.padTop }} aria-hidden="true" />
        {rows.slice(win.start, win.end).map((r, k) => renderRow(r, win.start + k))}
        <div data-pad="bottom" style={{ height: win.padBottom }} aria-hidden="true" />
      </div>
    </section>
  );
}
