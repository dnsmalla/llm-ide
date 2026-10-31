// Virtualised file tree. Only the rows in the window are rendered (a 100k-entry folder renders ~60 rows);
// the window is computed from the scroll offset, pages are requested for the rows that need them, and focus
// stays on the tree element (aria-activedescendant) so keyboard use survives row recycling.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronIcon, FolderIcon, DocIcon } from "@llmide/ui-kit";
import type { ExplorerController, ExplorerSnapshot } from "./controller";
import {
  ROW_HEIGHT, canDrop, indexOfPath, navigate, rowsInRange, topLevel, typeAhead, windowRange, type NavKey, type Row,
} from "./tree-model";

export interface TreeCallbacks {
  onContextMenu(path: string | null, x: number, y: number): void;
  /** The user dropped these paths on `destDir`; the screen confirms and then moves. */
  onDropMove(paths: string[], destDir: string): void;
  /** F2 (rename) and Delete / Cmd+Backspace (move to trash) on the focused row. */
  onKeyCommand(cmd: "rename" | "delete", path: string): void;
}

interface Props extends TreeCallbacks {
  controller: ExplorerController;
  snap: ExplorerSnapshot;
  active: boolean;
}

const DND_TYPE = "application/x-llmide-paths";
const NAV_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter"]);
const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export function FileTree({ controller, snap, active, onContextMenu, onDropMove, onKeyCommand }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const pendingFocus = useRef<number | null>(null);

  const { layout, tree } = snap;
  const win = useMemo(() => windowRange(layout.count, scrollTop, viewport), [layout.count, scrollTop, viewport]);
  const rows = useMemo(() => rowsInRange(layout, win.start, win.end, tree), [layout, tree, win.start, win.end]);

  // Viewport height.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewport(el.clientHeight || 600);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ask for the pages the window touches (and for expanded folders that have no listing).
  useEffect(() => {
    if (active) controller.requestPages(rows);
  }, [controller, rows, active]);

  const scrollToIndex = useCallback((index: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, []);

  // Focus a row that was a not-yet-loaded gap when the key was pressed.
  useEffect(() => {
    const idx = pendingFocus.current;
    if (idx === null) return;
    const r = rowsInRange(layout, idx, idx + 1, tree)[0];
    if (r?.kind === "entry") {
      pendingFocus.current = null;
      controller.setFocus(r.entry.path);
    }
  }, [layout, tree, controller]);

  const focusIndex = (index: number) => {
    scrollToIndex(index);
    const r = rowsInRange(layout, index, index + 1, tree)[0];
    if (r?.kind === "entry") {
      pendingFocus.current = null;
      controller.setFocus(r.entry.path);
    } else {
      pendingFocus.current = index;
      // Make sure the page is requested even if the window has not re-rendered yet.
      if (r) controller.requestPages([r]);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (NAV_KEYS.has(e.key) && !mod && !e.altKey) {
      const a = navigate(layout, tree, snap.focusPath, e.key as NavKey, Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1));
      e.preventDefault();
      if (!a) return;
      if (a.type === "focus-index") {
        focusIndex(a.index);
        if (e.shiftKey) {
          const r = rowsInRange(layout, a.index, a.index + 1, tree)[0];
          if (r?.kind === "entry") controller.select(r.entry.path, { shift: true, toggle: false });
        }
      } else if (a.type === "expand") void controller.toggleDir(a.path, true);
      else if (a.type === "collapse") void controller.toggleDir(a.path, false);
      else if (a.type === "toggle") void controller.toggleDir(a.path);
      else if (a.type === "focus-path") {
        controller.setFocus(a.path);
        const i = indexOfPath(layout, a.path);
        if (i >= 0) scrollToIndex(i);
      } else if (a.type === "open") void controller.openFile(a.path, false);
      return;
    }
    if (snap.focusPath && (e.key === "F2" || e.key === "Delete" || (e.key === "Backspace" && e.metaKey))) {
      e.preventDefault();
      onKeyCommand(e.key === "F2" ? "rename" : "delete", snap.focusPath);
      return;
    }
    if (e.key === " " && snap.focusPath) {
      e.preventDefault();
      controller.select(snap.focusPath, { shift: false, toggle: true });
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = scroller.current?.getBoundingClientRect();
      onContextMenu(snap.focusPath, (r?.left ?? 0) + 24, (r?.top ?? 0) + 24);
      return;
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at > 700 ? e.key : t.text + e.key;
      t.at = now;
      const from = snap.focusPath ? indexOfPath(layout, snap.focusPath) : -1;
      // A repeated single letter cycles through matches; a longer buffer narrows from the current row.
      const allSame = [...t.text].every((c) => c === t.text[0]);
      const prefix = allSame ? t.text[0]! : t.text;
      const idx = typeAhead(layout, tree, allSame || t.text.length === 1 ? from : from - 1, prefix);
      if (idx >= 0) {
        e.preventDefault();
        focusIndex(idx);
      }
    }
  };

  const onRowClick = (e: MouseEvent, row: Extract<Row, { kind: "entry" }>) => {
    const mods = { shift: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey };
    controller.select(row.entry.path, mods);
    if (mods.shift || mods.toggle) return;
    if (row.entry.kind === "dir") void controller.toggleDir(row.entry.path);
    else if (row.entry.kind === "file") void controller.openFile(row.entry.path, true);
  };

  const dragPaths = (path: string): string[] => (snap.selection.paths.has(path) ? topLevel(snap.selection.paths) : [path]);

  const onDragStart = (e: DragEvent, path: string) => {
    const paths = dragPaths(path);
    e.dataTransfer.setData(DND_TYPE, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  };

  const readDrag = (e: DragEvent): string[] | null => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return null;
    try {
      const raw = e.dataTransfer.getData(DND_TYPE);
      const v: unknown = raw ? JSON.parse(raw) : null;
      return Array.isArray(v) && v.every((p) => typeof p === "string") ? (v as string[]) : null;
    } catch {
      return null;
    }
  };

  const overDir = (e: DragEvent, dir: string) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    // The payload is unreadable during dragover; the drop re-checks every path.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== dir) setDropTarget(dir);
  };

  const dropOn = (e: DragEvent, dir: string) => {
    e.preventDefault();
    setDropTarget(null);
    const paths = readDrag(e)?.filter((p) => canDrop(p, dir));
    if (paths && paths.length > 0) onDropMove(paths, dir);
  };

  const activeIndex = snap.focusPath ? indexOfPath(layout, snap.focusPath) : -1;

  return (
    <div
      ref={scroller}
      className="ex-tree"
      role="tree"
      aria-label="Project files"
      aria-multiselectable="true"
      aria-activedescendant={activeIndex >= 0 ? `ex-row-${activeIndex}` : undefined}
      tabIndex={0}
      data-drop={dropTarget === "" ? "true" : undefined}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (snap.focusPath === null && rows[0]?.kind === "entry") controller.setFocus(rows[0].entry.path);
      }}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.pad) {
          e.preventDefault();
          onContextMenu(null, e.clientX, e.clientY);
        }
      }}
      onDragOver={(e) => overDir(e, "")}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(e) => dropOn(e, "")}
    >
      <div style={{ height: win.padTop }} data-pad="top" aria-hidden="true" />
      {rows.map((row, i) => {
        const index = win.start + i;
        return <TreeRow key={rowKey(row, index)} row={row} index={index} snap={snap} dropTarget={dropTarget} onClick={onRowClick} onDoubleClick={(p) => void controller.openFile(p, false)} onToggle={(p) => void controller.toggleDir(p)} onContextMenu={onContextMenu} onDragStart={onDragStart} overDir={overDir} dropOn={dropOn} controller={controller} />;
      })}
      <div style={{ height: win.padBottom }} data-pad="bottom" aria-hidden="true" />
    </div>
  );
}

function rowKey(row: Row, index: number): string {
  return row.kind === "entry" ? row.entry.path : `${row.kind}-${index}`;
}

interface RowProps {
  row: Row;
  index: number;
  snap: ExplorerSnapshot;
  dropTarget: string | null;
  controller: ExplorerController;
  onClick(e: MouseEvent, row: Extract<Row, { kind: "entry" }>): void;
  onDoubleClick(path: string): void;
  onToggle(path: string): void;
  onContextMenu(path: string | null, x: number, y: number): void;
  onDragStart(e: DragEvent, path: string): void;
  overDir(e: DragEvent, dir: string): void;
  dropOn(e: DragEvent, dir: string): void;
}

const INDENT = 14;
const GIT_LETTER: Record<string, string> = { modified: "M", added: "A", untracked: "U", deleted: "D", conflicted: "!" };

function TreeRow({ row, index, snap, dropTarget, controller, onClick, onDoubleClick, onToggle, onContextMenu, onDragStart, overDir, dropOn }: RowProps) {
  const pad = { paddingLeft: row.depth * INDENT + 6 };
  if (row.kind === "gap") {
    return <div id={`ex-row-${index}`} className="ex-row ex-gap" role="none" style={pad} aria-busy="true"><span className="ex-skeleton" /></div>;
  }
  if (row.kind === "status") {
    const text = row.text === "loading" ? "Loading…" : row.text === "empty" ? "Empty folder" : `Cannot read this folder${row.message ? `: ${row.message}` : ""}`;
    return (
      <div id={`ex-row-${index}`} className="ex-row ex-status" role="none" style={{ paddingLeft: row.depth * INDENT + 22 }} data-kind={row.text}>
        {text}
        {row.text === "error" && (
          <button type="button" className="ex-link" onClick={() => void controller.refreshDir(row.dir)}>
            Retry
          </button>
        )}
      </div>
    );
  }
  const e = row.entry;
  const isDir = e.kind === "dir";
  const deco = snap.git?.deco.get(e.path);
  const dirty = !isDir ? undefined : snap.git?.dirs.has(e.path) ? "modified" : undefined;
  const selected = snap.selection.paths.has(e.path);
  const focused = snap.focusPath === e.path;
  return (
    <div
      id={`ex-row-${index}`}
      className="ex-row"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-label={e.name}
      data-focused={focused || undefined}
      data-ignored={e.ignored || undefined}
      data-hidden={e.hidden || undefined}
      data-git={deco ?? dirty}
      data-drop={isDir && dropTarget === e.path ? "true" : undefined}
      style={pad}
      title={e.path}
      draggable={e.kind !== "other"}
      onClick={(ev) => onClick(ev, row)}
      onDoubleClick={() => !isDir && onDoubleClick(e.path)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onContextMenu(e.path, ev.clientX, ev.clientY);
      }}
      onDragStart={(ev) => onDragStart(ev, e.path)}
      onDragOver={isDir ? (ev) => { ev.stopPropagation(); overDir(ev, e.path); } : undefined}
      onDrop={isDir ? (ev) => { ev.stopPropagation(); dropOn(ev, e.path); } : undefined}
    >
      {isDir ? (
        <button type="button" className="ex-chevron" tabIndex={-1} aria-hidden="true" onClick={(ev) => { ev.stopPropagation(); onToggle(e.path); }}>
          <span style={{ display: "inline-flex", transform: row.expanded ? "rotate(90deg)" : undefined }}><ChevronIcon /></span>
        </button>
      ) : (
        <span className="ex-chevron" aria-hidden="true" />
      )}
      <span className="ex-icon" aria-hidden="true">{isDir ? <FolderIcon /> : <DocIcon />}</span>
      <span className="ex-name">{e.name}</span>
      {e.symlink && <span className="ex-badge" title="Symbolic link">link</span>}
      {deco && <span className="ex-git-letter" aria-label={deco}>{GIT_LETTER[deco]}</span>}
    </div>
  );
}
