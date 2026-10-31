// The completion menu (listbox). Windowed: only the rows in view are rendered, so 5,000+ entries cost the same as
// 20. All text is rendered as React text (escaped); sanitising happened when the items were built.
import { useEffect, useMemo, useRef, useState } from "react";
import { buildOffsets, computeWindow } from "../virtual";
import type { MenuView } from "./menu";
import { SECTION_TITLES } from "./items";

export const ITEM_H = 40;
export const HEADER_H = 26;
export const MENU_H = 280;

export interface MenuRow { kind: "header" | "item"; index: number; title?: string }

/** Items with their section headers interleaved (the unit the window math works on). */
export function menuRows(view: MenuView): MenuRow[] {
  const rows: MenuRow[] = [];
  view.items.forEach((_, i) => {
    const h = view.headers.get(i);
    if (h) rows.push({ kind: "header", index: i, title: h });
    rows.push({ kind: "item", index: i });
  });
  return rows;
}

export interface CompletionMenuProps {
  id: string;
  view: MenuView;
  loading: boolean;
  note: string | null;
  label: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

export const optionId = (menuId: string, index: number): string => `${menuId}-opt-${index}`;

export function CompletionMenu(p: CompletionMenuProps) {
  const rows = useMemo(() => menuRows(p.view), [p.view]);
  const offsets = useMemo(() => buildOffsets(rows.map((r) => (r.kind === "header" ? HEADER_H : ITEM_H)), rows.length, ITEM_H), [rows]);
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const win = computeWindow(offsets, scrollTop, MENU_H, 3);

  // Keep the selected row visible when it moves (arrow keys).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const at = rows.findIndex((r) => r.kind === "item" && r.index === p.view.selected);
    if (at < 0) return;
    const top = offsets[at], bottom = offsets[at + 1];
    const headerAbove = rows[at - 1]?.kind === "header" ? HEADER_H : 0;
    if (top - headerAbove < el.scrollTop) el.scrollTop = Math.max(0, top - headerAbove);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [p.view.selected, rows, offsets]);

  const items = p.view.items;
  const total = items.length;
  return (
    <div className="chat-menu" data-testid="completion-menu">
      <div
        ref={ref} id={p.id} role="listbox" aria-label={p.label} className="chat-menu-scroll" style={{ maxHeight: MENU_H }}
        onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
      >
        <div style={{ height: win.padTop }} aria-hidden="true" />
        {rows.slice(win.start, win.end).map((r) => {
          if (r.kind === "header") return <div key={`h${r.index}`} className="chat-menu-header" role="presentation" style={{ height: HEADER_H }}>{r.title}</div>;
          const it = items[r.index];
          const section = SECTION_TITLES[it.kind];
          return (
            <div
              key={it.id} id={optionId(p.id, r.index)} role="option" aria-selected={r.index === p.view.selected}
              aria-posinset={r.index + 1} aria-setsize={total} aria-label={`${it.label}${section ? `, ${section}` : ""}${it.detail ? `, ${it.detail}` : ""}`}
              className="chat-menu-item" data-selected={r.index === p.view.selected} style={{ height: ITEM_H }}
              onMouseDown={(e) => { e.preventDefault(); p.onPick(r.index); }} onMouseMove={() => p.onHover(r.index)}
            >
              <span className="chat-menu-label">{it.label}</span>
              <span className="chat-menu-detail">{it.detail}</span>
            </div>
          );
        })}
        <div style={{ height: win.padBottom }} aria-hidden="true" />
      </div>
      {(p.loading || p.note) && <div className="chat-menu-note" role="status">{p.loading && total === 0 ? "Searching…" : p.note}</div>}
    </div>
  );
}
