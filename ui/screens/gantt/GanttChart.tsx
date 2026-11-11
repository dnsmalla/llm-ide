// The Gantt chart body: the issue labels, the day header, the bars and the dependency arrows. Only the rows in view
// (plus a buffer, and the focused row) are mounted, so the node count follows the viewport, not the project size. The
// day grid is one CSS background layer for the whole body (not a cell per row per day), and each row is memoised so a
// scroll or a focus change re-renders only the rows that enter or leave the window.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  barDates,
  barGeometry,
  dragShift,
  dependencyLines,
  GANTT_ROW_ACTIONS,
  fillRange,
  isWeekend,
  issueLabel,
  issueTitleBody,
  visibleRowWindow,
  type DependencyLine,
  type GanttRow,
  type TimelineRange,
} from "./gantt-model.ts";
import { AssigneeAvatars } from "../issues/AssigneeAvatars.tsx";

/** Mirror gantt.css: the month band (20px) + day header (32px) above the rows, and each row's height. */
export const HEAD_H = 52;
export const ROW_H = 44;
const DAY_MS = 86_400_000;
/** The viewport height assumed before the scroller is measured (server render and the first paint). */
const DEFAULT_VIEWPORT_H = 600;
/** The labels column's width as the Mac draws it; the no-bars note sits just past the label text. */
const LABEL_WIDTH = 240;
/** Room past the last label for the timeline's horizontal scrollbar (classic scrollbars are 15-17px). */
const SCROLLBAR_ROOM = 24;

export type RowTarget = keyof typeof GANTT_ROW_ACTIONS;
export type GanttZoom = "day" | "week" | "month";

export interface GanttChartProps {
  rows: readonly GanttRow[];
  /** The label head's count: rows shown of rows loaded. */
  shown: number;
  total: number;
  /** Shows the "No scheduled issues" note over the chart. */
  noBars: boolean;
  range: TimelineRange;
  dayWidth: number;
  zoom: GanttZoom;
  today: number;
  selectedId: string | undefined;
  onActivate: (row: GanttRow, target: RowTarget) => void;
  /** Drag/keyboard shift of a bar's inclusive dates, in whole days. Absent: bars are not draggable. */
  onShift?: (row: GanttRow, days: number) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Test seam: the viewport height used before the scroller is measured. */
  assumedViewportHeight?: number;
}

/** Weekend columns and column rules as one repeating background, so the grid costs no nodes. */
export function dayGridBackground(start: number, dayWidth: number): string {
  const period = 7 * dayWidth;
  const weekend: string[] = [];
  let cursor = 0;
  for (let k = 0; k < 7; k++) {
    if (!isWeekend(start + k)) continue;
    if (k * dayWidth > cursor) weekend.push(`transparent ${cursor}px ${k * dayWidth}px`);
    weekend.push(`var(--tok-color-surface2) ${k * dayWidth}px ${(k + 1) * dayWidth}px`);
    cursor = (k + 1) * dayWidth;
  }
  if (cursor < period) weekend.push(`transparent ${cursor}px ${period}px`);
  const rule = `transparent 0px ${dayWidth - 1}px, var(--tok-color-border) ${dayWidth - 1}px ${dayWidth}px`;
  return `repeating-linear-gradient(to right, ${rule}), repeating-linear-gradient(to right, ${weekend.join(", ")})`;
}

function monthSpans(range: TimelineRange, dayWidth: number): { label: string; width: number }[] {
  const out: { label: string; width: number }[] = [];
  const fmt = new Intl.DateTimeFormat("en", { month: "short", year: "numeric" });
  for (let i = 0; i < range.days; i++) {
    const label = fmt.format(new Date((range.start + i) * DAY_MS));
    const last = out[out.length - 1];
    if (last?.label === label) last.width += dayWidth; else out.push({ label, width: dayWidth });
  }
  return out;
}

interface RowProps {
  row: GanttRow;
  index: number;
  selected: boolean;
  onActivate: (row: GanttRow, target: RowTarget) => void;
  onFocusRow: (index: number) => void;
  onShift?: (row: GanttRow, days: number) => void;
}

const GanttLabel = memo(function GanttLabel({ row, index, count, selected, onActivate, onFocusRow }: RowProps & { count: number }) {
  // A list item carrying its place in the whole list, so a screen reader hears "12 of 2,000" though ~30 are mounted.
  return (
    <div role="listitem" aria-posinset={index + 1} aria-setsize={count} className="gnt-rowitem" style={{ top: index * ROW_H }}>
    <button
      type="button"
      className="gnt-rowlabel"
      data-on={selected || undefined}
      onFocus={() => onFocusRow(index)}
      onClick={() => onActivate(row, "label")}
      title={`${row.issue.title}\nOpen details`}
    >
      <span className="gnt-status" data-state={row.issue.state === "closed" ? "closed" : "open"} aria-hidden="true">{row.issue.state === "closed" ? "✓" : "○"}</span>
      <span className="gnt-rowtext"><span className="gnt-num">{row.issue.number !== null ? `#${row.issue.number}` : ""}</span> {issueTitleBody(row.issue)}<span className="gnt-rowdates">{barDates(row)}</span></span>{row.issue.assignees.length ? <AssigneeAvatars names={row.issue.assignees} size={14} max={2} label={false} /> : null}
    </button>
    </div>
  );
});

interface TrackProps extends RowProps {
  range: TimelineRange;
  dayWidth: number;
  today: number;
}

const GanttTrack = memo(function GanttTrack({ row, index, selected, range, dayWidth, today, onActivate, onFocusRow, onShift }: TrackProps) {
  const g = barGeometry(row, range, dayWidth);
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  if (!g) return <div className="gnt-track" data-on={selected || undefined} style={{ top: HEAD_H + index * ROW_H }} />;
  const canShift = !!onShift && row.start !== null && row.end !== null;
  const finish = (clientX: number) => {
    const d = drag.current;
    drag.current = null;
    setDx(0);
    if (!d || !canShift) return;
    const shot = dragShift(d.x, clientX, dayWidth);
    if (shot.moved) suppressClick.current = true;
    if (shot.moved && shot.days !== 0) onShift?.(row, shot.days);
  };
  return (
    <div className="gnt-track" data-on={selected || undefined} style={{ top: HEAD_H + index * ROW_H }}>
      {g ? (
        <button
          type="button"
          className="gnt-bar"
          style={{ left: g.left, width: g.width, transform: dx ? `translateX(${dx}px)` : undefined }}
          data-selected={selected || undefined}
          data-state={row.issue.state}
          data-overdue={row.issue.state !== "closed" && row.end !== null && row.end < today || undefined}
          data-dragging={dx !== 0 || undefined}
          title={`${row.issue.title}\n${barDates(row)}\n${canShift ? "Drag to move; Alt+Left/Right for one day" : "Edit schedule"}`}
          onFocus={() => onFocusRow(index)}
          onPointerDown={(e) => {
            if (!canShift || e.button !== 0 || drag.current !== null) return;
            drag.current = { x: e.clientX, moved: false };
            suppressClick.current = false;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (e.buttons === 0) { drag.current = null; setDx(0); return; }
            const shift = dragShift(d.x, e.clientX, dayWidth);
            if (shift.moved) d.moved = true;
            setDx(d.moved ? shift.days * dayWidth : 0);
          }}
          onPointerUp={(e) => finish(e.clientX)}
          onPointerCancel={() => { drag.current = null; setDx(0); }}
          onLostPointerCapture={() => { drag.current = null; setDx(0); }}
          onKeyDown={(e) => {
            if (!canShift || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
            e.preventDefault();
            onShift?.(row, e.key === "ArrowRight" ? 1 : -1);
          }}
          onClick={() => {
            if (suppressClick.current) { suppressClick.current = false; return; }
            onActivate(row, "bar");
          }}
        >
          {row.dependsOn.length ? <span className="gnt-dep" title={`Depends on #${row.dependsOn.join(", #")}`}>⤷</span> : null}
          {issueLabel(row.issue)}
        </button>
      ) : null}
    </div>
  );
});

export const GanttChart = memo(function GanttChart(p: GanttChartProps) {
  const { rows, dayWidth, today, scrollRef, onActivate, onShift } = p;
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const labelsRef = useRef<HTMLDivElement>(null);
  // The focused row is pinned into the window: a Tab from it always lands on a mounted row.
  const pinRef = useRef<number | null>(null);
  const viewportFallback = p.assumedViewportHeight ?? DEFAULT_VIEWPORT_H;
  const count = rows.length;
  const windowFor = useCallback(() => {
    const el = scrollRef.current;
    return visibleRowWindow({
      scrollTop: el?.scrollTop ?? 0,
      viewportHeight: el?.clientHeight || viewportFallback,
      headHeight: HEAD_H,
      rowHeight: ROW_H,
      count,
      pinned: pinRef.current,
    });
  }, [scrollRef, viewportFallback, count]);
  // First paint uses the fallback viewport; the mount effect re-derives the window from the measured scroller.
  const [first, setFirst] = useState(() => visibleRowWindow({ scrollTop: 0, viewportHeight: viewportFallback, headHeight: HEAD_H, rowHeight: ROW_H, count }).first);
  const [last, setLast] = useState(() => visibleRowWindow({ scrollTop: 0, viewportHeight: viewportFallback, headHeight: HEAD_H, rowHeight: ROW_H, count }).last);
  const [extra, setExtra] = useState<number | null>(null);

  // Re-derive the window and keep the labels column scrolled level with the timeline (the labels are their own
  // overflow:hidden viewport, so they follow by scrollTop rather than by a scroll of their own).
  const sync = useCallback(() => {
    const w = windowFor();
    setFirst(w.first);
    setLast(w.last);
    setExtra(w.extra);
    const el = scrollRef.current;
    const labels = labelsRef.current;
    if (el && labels && labels.scrollTop !== el.scrollTop) labels.scrollTop = el.scrollTop;
  }, [windowFor, scrollRef]);

  useEffect(() => { sync(); }, [sync, rows]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => { sync(); setVp((v) => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { w: el.clientWidth, h: el.clientHeight })); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, sync]);

  const onFocusRow = useCallback((index: number) => {
    pinRef.current = index;
    const el = scrollRef.current;
    if (el) {
      // Bring a row focused from the labels column into the timeline's view (the sticky head covers the top HEAD_H).
      const top = HEAD_H + index * ROW_H;
      if (top < el.scrollTop + HEAD_H) el.scrollTop = top - HEAD_H;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    }
    sync();
  }, [scrollRef, sync]);

  const range = useMemo(() => fillRange(p.range, vp.w, dayWidth), [p.range, vp.w, dayWidth]);
  const timelineWidth = range.days * dayWidth;
  const bodyHeight = Math.max(rows.length * ROW_H, vp.h - HEAD_H);
  const todayLeft = (today - range.start) * dayWidth;
  const depLines = useMemo(() => dependencyLines(rows, range, dayWidth, (i) => HEAD_H + i * ROW_H + ROW_H / 2), [rows, range, dayWidth]);
  // Only the arrows that cross the window: both ends above or below it, with a segment through it, are skipped.
  const top = HEAD_H + first * ROW_H;
  const bottom = HEAD_H + (last + 1) * ROW_H;
  const visibleLines = useMemo(() => depLines.filter((l: DependencyLine) => Math.max(l.y1, l.y2) >= top && Math.min(l.y1, l.y2) <= bottom), [depLines, top, bottom]);
  // The window's rows plus the focused row when it is outside it, in list order (so Tab order follows the list).
  const visibleIdx = useMemo(() => {
    const idx: number[] = [];
    for (let i = first; i <= last && i < count; i++) idx.push(i);
    if (extra !== null && extra < count) idx.splice(extra < first ? 0 : idx.length, 0, extra);
    return idx;
  }, [first, last, extra, count]);
  const grid = useMemo(() => dayGridBackground(range.start, dayWidth), [range.start, dayWidth]);
  const months = useMemo(() => monthSpans(range, dayWidth), [range, dayWidth]);

  return (
    <div className="gnt-chart" style={{ ["--gnt-label" as string]: `${LABEL_WIDTH}px` }}>
      {p.noBars ? <div className="gnt-no-bars" style={{ left: LABEL_WIDTH }}><strong>No scheduled issues</strong><span>Open an issue and choose Edit schedule to place it on the timeline.</span></div> : null}
      <div className="gnt-labels">
        <div className="gnt-labels-head"><span>ISSUES</span><span className="gnt-count">{p.shown} / {p.total}</span></div>
        <div className="gnt-month-pad" aria-hidden="true" />
        {/* overflow:hidden, so a wheel here would scroll nothing: hand it to the timeline, which the labels follow. */}
        <div className="gnt-labels-rows" ref={labelsRef} onWheel={(e) => { const el = scrollRef.current; if (el) el.scrollTop += e.deltaY; }}>
          {/* SCROLLBAR_ROOM: the timeline's horizontal scrollbar adds to its scroll range; without the room the labels stop short at the bottom. */}
          <div className="gnt-labels-spacer" role="list" aria-label="Issues" style={{ height: rows.length * ROW_H + SCROLLBAR_ROOM }}>
            {visibleIdx.map((i) => (
              <GanttLabel key={rows[i]!.issue.id} row={rows[i]!} index={i} count={count} selected={rows[i]!.issue.id === p.selectedId} onActivate={onActivate} onFocusRow={onFocusRow} />
            ))}
          </div>
        </div>
      </div>
      <div className="gnt-scroll" ref={scrollRef} onScroll={sync}>
        <div className="gnt-timeline" style={{ width: timelineWidth, height: HEAD_H + bodyHeight }}>
          {todayLeft >= 0 && todayLeft <= timelineWidth ? <div className="gnt-today" style={{ left: todayLeft }} aria-hidden="true" /> : null}
          <div className="gnt-gridlayer" style={{ top: HEAD_H, width: timelineWidth, height: bodyHeight, backgroundImage: grid }} aria-hidden="true" />
          {visibleLines.length ? (
            <svg className="gnt-deps" width={timelineWidth} height={HEAD_H + rows.length * ROW_H} aria-hidden="true">
              <defs>
                <marker id="gnt-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
                  <path d="M0 0 L6 3 L0 6 z" />
                </marker>
              </defs>
              {visibleLines.map((l) => {
                const mid = (l.x1 + l.x2) / 2;
                return <path key={`${l.blocker}>${l.dependent}`} d={`M${l.x1} ${l.y1} H${mid} V${l.y2} H${l.x2}`} markerEnd="url(#gnt-arrow)" />;
              })}
            </svg>
          ) : null}
          <div className="gnt-thead">
            <div className="gnt-months" aria-hidden="true">
              {months.map((m) => <span key={m.label} className="gnt-month" style={{ width: m.width }}>{m.label}</span>)}
            </div>
            <div className="gnt-header">
              {Array.from({ length: range.days }, (_, k) => {
                const day = range.start + k;
                const dt = new Date(day * DAY_MS);
                const label = p.zoom === "day" ? String(dt.getUTCDate()) : p.zoom === "week" ? (dt.getUTCDay() === 1 ? String(dt.getUTCDate()) : "") : "";
                return <div key={day} className="gnt-day" data-weekend={isWeekend(day) || undefined} data-today={day === today || undefined} style={{ width: dayWidth }}>{label}</div>;
              })}
            </div>
          </div>
          {visibleIdx.map((i) => (
            <GanttTrack key={rows[i]!.issue.id} row={rows[i]!} index={i} selected={rows[i]!.issue.id === p.selectedId} range={range} dayWidth={dayWidth} today={today} onActivate={onActivate} onFocusRow={onFocusRow} onShift={onShift} />
          ))}
        </div>
      </div>
    </div>
  );
});
