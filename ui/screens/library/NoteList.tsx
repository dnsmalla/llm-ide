// The item list: search box, filters, grouping, and the virtualised, keyboard-operable listbox.
// Only the rows in view are mounted, so 50,000+ notes scroll like 50; the visible rows' headers are
// requested first from the background head reader.
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Chip, SearchIcon, StatusBanner, XIcon } from "@llmide/ui-kit";
import type { LibraryState, LibraryStore } from "./library-store.ts";
import { filtersActive, formatDate, formatDuration, sectionLabel, stepNoteRow, type DateRange, type GroupKey, type NoteRecord, type Row, type SortKey } from "./notes-model.ts";
import { useScroller } from "./use-library.ts";

export const ROW_HEIGHT = 52;
const HEADER_HEIGHT = 28;

const RANGES: { id: DateRange; label: string }[] = [
  { id: "all", label: "Any time" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "year", label: "Last year" },
];

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

export interface NoteListProps {
  store: LibraryStore;
  state: LibraryState;
  /** Initial viewport height when not measured (server rendering and tests). */
  initialHeight?: number;
}

export function NoteList({ store, state, initialHeight = 600 }: NoteListProps): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null);
  const { scrollTop, height } = useScroller(scroller, initialHeight);
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

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = (d: 1 | -1): void => {
      const i = stepNoteRow(rows, selectedIdx, d);
      const r = rows[i];
      if (r?.kind === "note") store.select(r.rec.rel);
    };
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
  const title = state.sectionId === null ? "All notes" : sectionLabel(state.sectionId);
  const visible: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const r = rows[i]!;
    const top = offsets[i]!;
    if (r.kind === "header") {
      visible.push(
        <div key={`h:${r.key}`} className="lib-group" role="presentation" style={{ top, height: HEADER_HEIGHT }}>
          {r.label} <span className="lib-count">{r.count}</span>
        </div>,
      );
      continue;
    }
    const rec = r.rec;
    const selected = rec.rel === state.selectedRel;
    visible.push(
      <div
        key={rec.rel}
        id={optionId(rec.rel)}
        role="option"
        aria-selected={selected}
        aria-label={`${rec.title}, ${formatDate(rec.dateMs)}`}
        className="lib-row"
        data-selected={selected}
        data-placeholder={rec.placeholder}
        style={{ top, height: ROW_HEIGHT }}
        onClick={() => store.select(rec.rel)}
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
        <div className="lib-search" role="search">
          <SearchIcon />
          <input
            type="search"
            className="lib-search-input"
            placeholder={store.searchAvailable ? "Filter and search notes" : "Filter notes"}
            aria-label="Filter and search notes"
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
        </div>
        <div className="lib-chips" role="group" aria-label="Filters">
          <Chip label="With summary" compact active={f.hasSummary} onClick={() => store.setFilters({ hasSummary: !f.hasSummary })} />
          <label className="lib-select">
            <span className="lib-sr">Date range</span>
            <select value={f.range} onChange={(e) => store.setFilters({ range: e.target.value as DateRange })}>
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="lib-select">
            <span className="lib-sr">Sort</span>
            <select value={state.sort} onChange={(e) => store.setSort(e.target.value as SortKey)}>
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="title">Title</option>
              <option value="path">Path</option>
            </select>
          </label>
          <label className="lib-select">
            <span className="lib-sr">Group</span>
            <select value={state.group} onChange={(e) => store.setGroup(e.target.value as GroupKey)}>
              <option value="month">By month</option>
              <option value="folder">By folder</option>
              <option value="none">No grouping</option>
            </select>
          </label>
          {filtersActive(f) && (
            <button type="button" className="lib-link-btn" onClick={() => store.setFilters({ query: "", platform: null, hasSummary: false, range: "all" })}>
              Reset
            </button>
          )}
        </div>
        <p className="lib-muted lib-status" role="status" aria-live="polite">
          {noteCount.toLocaleString()} {noteCount === 1 ? "note" : "notes"}
          {state.listing.phase === "listing" && " · listing…"}
          {state.heads.total > state.heads.done && ` · reading details ${state.heads.done.toLocaleString()} of ${state.heads.total.toLocaleString()}`}
        </p>
        <SearchResults store={store} state={state} />
      </div>
      {search.phase === "unavailable" && store.searchAvailable && f.query.trim().length >= 2 && (
        <StatusBanner severity="info" message="Full-text search is not available in this core yet. Filtering titles, paths and summaries only." />
      )}
      {rows.length === 0 ? (
        <Empty state={state} />
      ) : (
        <div
          ref={scroller}
          className="lib-scroll"
          role="listbox"
          tabIndex={0}
          aria-label={`${title}, ${noteCount} notes`}
          aria-activedescendant={state.selectedRel ? optionId(state.selectedRel) : undefined}
          onKeyDown={onKey}
        >
          <div className="lib-canvas" style={{ height: total }}>
            {visible}
          </div>
        </div>
      )}
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
  return (
    <div className="lib-hits" aria-label="Full-text matches" role="region">
      {(s.phase === "searching" || s.phase === "debouncing") && s.hits.length === 0 && (
        <p className="lib-muted" role="status">
          Searching note text…
        </p>
      )}
      {s.phase === "error" && <StatusBanner severity="warning" message={s.error ?? "Search failed."} />}
      {s.phase === "done" && s.hits.length === 0 && <p className="lib-muted">No matches in note text.</p>}
      {s.hits.length > 0 && (
        <>
          <h3 className="lib-hits-title">Matches in note text</h3>
          <ul className="lib-hits-list">
            {s.hits.slice(0, 20).map((h) => (
              <li key={h.rel}>
                <button type="button" className="lib-hit" onClick={() => store.reveal(h.rel)}>
                  <span className="lib-hit-title">{h.title}</span>
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
  if (state.records.length === 0) {
    return (
      <div className="lib-empty" role="status">
        <p className="lib-empty-title">No notes in this folder</p>
        <p className="lib-muted">Notes appear here when meetings are captured or sources are fetched into this folder.</p>
      </div>
    );
  }
  return (
    <div className="lib-empty" role="status">
      <p className="lib-empty-title">{filtersActive(state.filters) ? "No notes match the filters" : "Nothing in this section yet"}</p>
    </div>
  );
}
