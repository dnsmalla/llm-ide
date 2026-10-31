// A small windowed list: only the rows in view are mounted, so 50,000 rows scroll like 50. Fixed row height,
// listbox semantics with aria-setsize/posinset so assistive tech still hears "3 of 50,000".
import { useCallback, useState, type ReactNode } from "react";
import { windowRange } from "../library/windowing.ts";

export interface VirtualListProps<T> {
  items: readonly T[];
  rowHeight: number;
  label: string;
  height?: number;
  /** Server-render / test viewport; the live component measures itself. */
  initialViewport?: number;
  keyOf: (item: T, index: number) => string;
  render: (item: T, index: number) => ReactNode;
}

export function VirtualList<T>({ items, rowHeight, label, height = 260, initialViewport, keyOf, render }: VirtualListProps<T>): ReactNode {
  const [top, setTop] = useState(0);
  const [vh, setVh] = useState(initialViewport ?? height);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el && el.clientHeight > 0) setVh(el.clientHeight);
  }, []);
  const w = windowRange({ total: items.length, rowHeight, scrollTop: top, viewportHeight: vh, overscan: 6 });
  return (
    <div ref={ref} className="dg-vlist" role="listbox" aria-label={label} aria-multiselectable="true" tabIndex={0} style={{ height }} onScroll={(e) => setTop((e.target as HTMLElement).scrollTop)}>
      <div style={{ height: w.totalHeight, position: "relative" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: w.padTop }}>
          {items.slice(w.start, w.end).map((it, k) => (
            <div key={keyOf(it, w.start + k)} className="dg-vrow" style={{ height: rowHeight }} aria-setsize={items.length} aria-posinset={w.start + k + 1}>
              {render(it, w.start + k)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
