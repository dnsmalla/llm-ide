// Virtualised node list: the keyboard and screen-reader alternative to the canvas (the "Nodes" tab), and
// the search result list. Only the rows in view exist in the DOM; a listbox with aria-activedescendant so
// focus stays on one element while arrow keys move through up to 100k rows.
import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphModel, LayoutResult } from "./model.ts";
import { fixedWindow } from "./search.ts";
import { communityColor } from "./colors.ts";

export const ROW_HEIGHT = 30;

export interface NodeListProps {
  id: string;
  label: string;
  model: GraphModel;
  layout: LayoutResult;
  /** Number of rows and the node index at row k. */
  count: number;
  nodeAt: (row: number) => number;
  selected: number;
  onSelect: (node: number) => void;
  /** Viewport height used before the element is measured (server render, first paint). */
  initialViewport?: number;
  emptyText?: string;
}

export function NodeList(p: NodeListProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(p.initialViewport ?? 420);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || p.initialViewport || 420);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.initialViewport]);

  useEffect(() => {
    setActive(0);
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [p.count]);

  const reveal = useCallback((row: number) => {
    const el = ref.current;
    if (!el) return;
    const top = row * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (p.count === 0) return;
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
    let next = active;
    if (e.key === "ArrowDown") next = Math.min(p.count - 1, active + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, active - 1);
    else if (e.key === "PageDown") next = Math.min(p.count - 1, active + page);
    else if (e.key === "PageUp") next = Math.max(0, active - page);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = p.count - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      p.onSelect(p.nodeAt(active));
      return;
    } else return;
    e.preventDefault();
    setActive(next);
    reveal(next);
  };

  const w = fixedWindow(p.count, ROW_HEIGHT, scrollTop, viewport);
  const rows = [];
  for (let k = w.start; k < w.end; k++) {
    const i = p.nodeAt(k);
    rows.push(
      <div
        key={k}
        id={`${p.id}-r${k}`}
        role="option"
        aria-selected={i === p.selected}
        aria-posinset={k + 1}
        aria-setsize={p.count}
        className="gr-row"
        data-active={k === active}
        style={{ height: ROW_HEIGHT }}
        onClick={() => { setActive(k); p.onSelect(i); }}
      >
        <span className="gr-dot" style={{ background: communityColor(p.layout.community[i]) }} aria-hidden="true" />
        <span className="gr-row-title">{p.model.titles[i]}</span>
        <span className="gr-row-kind">{p.model.nodeKinds[p.model.kindOf[i]]}</span>
        {p.model.paths[i] !== null && <span className="gr-row-path">{p.model.paths[i]}</span>}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      role="listbox"
      id={p.id}
      aria-label={p.label}
      aria-activedescendant={p.count > 0 ? `${p.id}-r${active}` : undefined}
      tabIndex={0}
      className="gr-list"
      onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
      onKeyDown={onKey}
    >
      {p.count === 0 ? <div className="gr-empty-row" role="status">{p.emptyText ?? "Nothing to show."}</div> : (
        <div style={{ paddingTop: w.padTop, paddingBottom: w.padBottom }}>{rows}</div>
      )}
    </div>
  );
}
