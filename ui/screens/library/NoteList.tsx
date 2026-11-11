// The item list: search box, filters, grouping, and the virtualised, keyboard-operable listbox.
// Only the rows in view are mounted, so 50,000+ notes scroll like 50; the visible rows' headers are
// requested first from the background head reader.
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { RefreshIcon, SearchIcon, StatusBanner, XIcon } from "@llmide/ui-kit";
import type { LibraryState, LibraryStore } from "./library-store.ts";
import { isVisible, refusedMessage } from "./hidden-notes.ts";
import { filtersActive, formatDate, formatDuration, sectionLabel, stepNoteRow, type GroupKey, type NoteRecord, type Row, type SortKey } from "./notes-model.ts";
import { useScroller } from "./use-library.ts";

export const ROW_HEIGHT = 78;
const HEADER_HEIGHT = 32;

function rowHeight(r: Row | undefined): number {
  return r?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT;
}

/** Row offsets for mixed header / note heights (prefix sums), so windowing stays exact. */
export function rowOffsets(rows: readonly Row[]): Float64Array {
  const o = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) o[i + 1] = o[i]! + rowHeight(rows[i]);
  return o;
}

/** First row index whose bottom is below `y` (binary search over the prefix sums). */
export function rowAt(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, offsets.length - 2));
}

function Meta({ rec }: { rec: NoteRecord }): ReactNode {
  const bits: string[] = [];
  if (rec.platform) bits.push(rec.platform);
  const dur = formatDuration(rec.durationSec);
  if (dur) bits.push(dur);
  if (rec.participants.length) bits.push(`${rec.participants.length} people`);
  if (rec.placeholder) bits.push("not downloaded");
  if (!rec.headRead && !rec.placeholder) bits.push("…");
  return <>{bits.join(" · ") || rec.rel}</>;
}

/** Multi-select mode (write side): clicks toggle membership instead of opening the note. */
export interface BulkSelect {
  selected: ReadonlySet<string>;
  onToggle: (rel: string, shift: boolean) => void;
  onSelectAll: () => void;
}

export interface NoteListProps {
  store: LibraryStore;
  state: LibraryState;
  bulk?: BulkSelect | null;
  /** Initial viewport height when not measured (server rendering and tests). */
  initialHeight?: number;
  /** The Library section is showing: ⌘F may focus the search box. */
  active?: boolean;
  /** A note row was right-clicked (project-relative path, viewport coordinates). */
  onContext?: (rel: string, x: number, y: number) => void;
  /** Sections rendered after the notes inside the SAME scroll (Mac's one sectioned list). */
  footer?: ReactNode;
  /** Refresh every section, like the Mac search bar's refresh button. */
  onRefresh?: () => void;
  /** A plain notice (for example, the hidden list is full). */
  onNotice?: (message: string) => void;
}

export function NoteList({ store, state, bulk = null, initialHeight = 600, active = true, onContext, footer, onRefresh, onNotice }: NoteListProps): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { scrollTop, height } = useScroller(scroller, initialHeight);
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  const rows = store.rows();
  const offsets = useMemo(() => rowOffsets(rows), [rows]);
  const total = offsets[rows.length] ?? 0;
  const first = rowAt(offsets, scrollTop);
  const last = Math.min(rows.length, rowAt(offsets, scrollTop + height) + 1);
  const OVERSCAN = 8;
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(rows.length, last + OVERSCAN);
  const noteCount = useMemo(() => rows.reduce((n, r) => n + (r.kind === "note" ? 1 : 0), 0), [rows]);
  const selectedIdx = state.selectedRel === null ? -1 : rows.findIndex((r) => r.kind === "note" && r.rec.rel === state.selectedRel);

  // Ask for the visible rows' heads first.
  useEffect(() => {
    const rels: string[] = [];
    for (let i = start; i < end; i++) {
      const r = rows[i];
      if (r?.kind === "note" && !r.rec.headRead && !r.rec.placeholder) rels.push(r.rec.rel);
    }
    if (rels.length) store.prioritize(rels);
  }, [rows, start, end, store]);

  // Keep the selected row in view when it changes through the keyboard.
  const lastSel = useRef<string | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || state.selectedRel === lastSel.current) return;
    lastSel.current = state.selectedRel;
    if (selectedIdx < 0) return;
    const top = offsets[selectedIdx]!;
    const bottom = offsets[selectedIdx + 1]!;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [state.selectedRel, selectedIdx, offsets]);

  /** Mac: "Remove All <group> from List" on a date header. Hides only; the files stay. */
  const removeGroup = (header: number): void => {
    const rels: string[] = [];
    for (let j = header + 1; j < rows.length; j++) {
      const x = rows[j]!;
      if (x.kind === "header") break;
      rels.push(x.rec.rel);
    }
    const msg = refusedMessage(store.hideNotes(rels).refused);
    if (msg && onNotice) onNotice(msg);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = (d: 1 | -1): void => {
      const i = stepNoteRow(rows, selectedIdx, d);
      const r = rows[i];
      if (r?.kind === "note") store.select(r.rec.rel);
    };
    if (bulk && e.key === " " && state.selectedRel) {
      e.preventDefault();
      bulk.onToggle(state.selectedRel, e.shiftKey);
      return;
    }
    if (bulk && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      bulk.onSelectAll();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        break;
      case "Home": {
        e.preventDefault();
        const r = rows.find((x) => x.kind === "note");
        if (r?.kind === "note") store.select(r.rec.rel);
        break;
      }
      case "End": {
        e.preventDefault();
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i]!;
          if (r.kind === "note") {
            store.select(r.rec.rel);
            break;
          }
        }
        break;
      }
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        const jump = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
        let i = selectedIdx;
        for (let k = 0; k < jump; k++) i = stepNoteRow(rows, i, e.key === "PageDown" ? 1 : -1);
        const r = rows[i];
        if (r?.kind === "note") store.select(r.rec.rel);
        break;
      }
    }
  };

  const f = state.filters;
  const search = state.search;
  const platforms = useMemo(() => [...new Set(state.records.flatMap((r) => (r.platform ? [r.platform] : [])))].sort((a, b) => a.localeCompare(b)), [state.records]);
  const title = state.sectionId === null ? "All notes" : sectionLabel(state.sectionId);
  const visible: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const r = rows[i]!;
    const top = offsets[i]!;
    if (r.kind === "header") {
      visible.push(
        <div key={`h:${r.key}`} className="lib-group" role="presentation" style={{ top, height: HEADER_HEIGHT }}>
          {r.label} <span className="lib-count">{r.count}</span>
          {r.count > 0 && !bulk ? (
            <button type="button" className="lib-link-btn lib-group-action" aria-label={`Remove all ${r.label} from List`} title={`Remove all ${r.label} from List (the files stay)`} onClick={() => removeGroup(i)}>
              Remove all
            </button>
          ) : null}
        </div>,
      );
      continue;
    }
    const rec = r.rec;
    const cursor = rec.rel === state.selectedRel;
    const selected = bulk ? bulk.selected.has(rec.rel) : cursor;
    const hiddenRow = state.hidden.has(rec.rel);
    visible.push(
      <div
        key={rec.rel}
        id={optionId(rec.rel)}
        role="option"
        aria-selected={selected}
        aria-label={`${rec.title}, ${formatDate(rec.dateMs)}${hiddenRow ? ", hidden from the list" : ""}`}
        className="lib-row"
        data-selected={selected}
        data-hidden={hiddenRow || undefined}
        data-cursor={bulk ? cursor : undefined}
        data-placeholder={rec.placeholder}
        style={{ top, height: ROW_HEIGHT }}
        onContextMenu={(e) => {
          if (onContext) { e.preventDefault(); onContext(rec.rel, e.clientX, e.clientY); }
        }}
        onClick={(e) => {
          if (bulk) {
            store.select(rec.rel);
            bulk.onToggle(rec.rel, e.shiftKey);
          } else store.select(rec.rel);
        }}
      >
        <span className="lib-row-title">{rec.title}</span>
        <span className="lib-row-date">{formatDate(rec.dateMs)}</span>
        <span className="lib-row-meta">
          <Meta rec={rec} />
        </span>
        {rec.gist && <span className="lib-row-gist">{rec.gist}</span>}
      </div>,
    );
  }

  return (
    <section className="lib-list" aria-label={`${title} list`}>
      <div className="lib-list-head">
        {state.hiddenCount > 0 && (
          <div className="lib-hidden-line" role="status">
            <span>{state.hiddenCount.toLocaleString("en-US")} hidden</span>
            <button type="button" className="lib-link-btn" aria-pressed={state.showHidden} onClick={() => store.setShowHidden(!state.showHidden)}>
              {state.showHidden ? "Hide hidden" : "Show hidden"}
            </button>
            <button type="button" className="lib-link-btn" onClick={() => store.unhideNotes([...state.hidden])}>
              Unhide all
            </button>
          </div>
        )}
        <div className="lib-search" role="search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            className="lib-search-input"
            placeholder="Search Library…"
            aria-label="Search the Library"
            value={f.query}
            onChange={(e) => {
              store.setFilters({ query: e.target.value });
              store.setSearchQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") store.submitSearch();
              if (e.key === "Escape" && f.query !== "") {
                e.preventDefault();
                store.setFilters({ query: "" });
                store.clearSearch();
              }
            }}
          />
          {f.query !== "" && (
            <button type="button" className="ui-icon-button" aria-label="Clear filter" onClick={() => { store.setFilters({ query: "" }); store.clearSearch(); }}>
              <XIcon />
            </button>
          )}
          {onRefresh ? <button type="button" className="ui-icon-button" aria-label="Refresh library" title="Reload files, plugins and connectors" onClick={onRefresh}><RefreshIcon /></button> : null}
        </div>
        <div className="lib-controls" role="group" aria-label="Sort, group and filter notes">
          <label className="lib-select">Sort
            <select aria-label="Sort notes" value={state.sort} onChange={(e) => store.setSort(e.target.value as SortKey)}>
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="title">Title</option>
              <option value="path">Path</option>
            </select>
          </label>
          <label className="lib-select">Group
            <select aria-label="Group notes" value={state.group} onChange={(e) => store.setGroup(e.target.value as GroupKey)}>
              <option value="relative">Date</option>
              <option value="month">Month</option>
              <option value="folder">Folder</option>
              <option value="none">None</option>
            </select>
          </label>
          {platforms.length > 0 && (
            <label className="lib-select">Source
              <select aria-label="Filter notes by source" value={f.platform ?? ""} onChange={(e) => store.setFilters({ platform: e.target.value || null })}>
                <option value="">All sources</option>
                {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
          <label className="lib-select">Date
            <select aria-label="Filter notes by date" value={f.range} onChange={(e) => store.setFilters({ range: e.target.value as typeof f.range })}>
              <option value="all">All time</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="year">Last year</option>
            </select>
          </label>
          <button type="button" className="lib-link-btn" aria-pressed={f.hasSummary} onClick={() => store.setFilters({ hasSummary: !f.hasSummary })}>Summaries only</button>
          {filtersActive(f) ? <button type="button" className="lib-link-btn" onClick={() => store.setFilters({ query: "", platform: null, hasSummary: false, range: "all" })}>Clear filters</button> : null}
        </div>
      </div>
      <SearchResults store={store} state={state} />
      {search.phase === "unavailable" && store.searchAvailable && f.query.trim().length >= 2 && (
        <StatusBanner severity="info" message="This core has no note search yet (it needs a newer core). Filtering titles, paths and summaries only." />
      )}
      <div
        ref={scroller}
        className="lib-scroll"
        role={rows.length === 0 ? undefined : "listbox"}
        aria-multiselectable={bulk ? true : undefined}
        tabIndex={rows.length === 0 ? undefined : 0}
        aria-label={rows.length === 0 ? undefined : `${title}, ${noteCount.toLocaleString("en-US")} notes`}
        aria-activedescendant={state.selectedRel ? optionId(state.selectedRel) : undefined}
        onKeyDown={rows.length === 0 ? undefined : onKey}
      >
        {rows.length === 0 ? (
          <Empty state={state} />
        ) : (
          <div className="lib-canvas" style={{ height: total }}>
            {visible}
          </div>
        )}
        {footer ? <div className="lib-footer-nav">{footer}</div> : null}
      </div>
    </section>
  );
}

const optionId = (rel: string): string => `lib-opt-${hash(rel)}`;
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function SearchResults({ store, state }: { store: LibraryStore; state: LibraryState }): ReactNode {
  const s = state.search;
  if (s.phase === "idle" || s.phase === "unavailable") return null;
  const hits = s.hits.filter((h) => isVisible(h.rel, state.hidden, state.showHidden));
  return (
    <div className="lib-hits" aria-label="Full-text matches" role="region">
      {(s.phase === "searching" || s.phase === "debouncing") && hits.length === 0 && (
        <p className="lib-muted" role="status">
          Searching note text…
        </p>
      )}
      {s.phase === "error" && <StatusBanner severity="warning" message={s.error ?? "Search failed."} />}
      {s.phase === "done" && hits.length === 0 && <p className="lib-muted">No matches in note text.</p>}
      {hits.length > 0 && (
        <>
          <h3 className="lib-hits-title">Matches in note text</h3>
          <ul className="lib-hits-list">
            {hits.slice(0, 20).map((h) => (
              <li key={h.rel}>
                <button type="button" className="lib-hit" onClick={() => store.reveal(h.rel)}>
                  <span className="lib-hit-title">{h.title}</span>
                  {h.kind && h.kind !== "meeting" && <span className="lib-muted lib-hit-kind"> {h.kind}</span>}
                  {h.snippet && <span className="lib-hit-snippet">{h.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Empty({ state }: { state: LibraryState }): ReactNode {
  if (state.listing.phase === "listing") {
    return (
      <p className="lib-empty" role="status">
        Listing notes…
      </p>
    );
  }
  return <p className="lib-empty-hint" role="status">No items in this section.</p>;
}
