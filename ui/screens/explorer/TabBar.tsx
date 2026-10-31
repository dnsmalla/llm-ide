// Editor tab strip with preview (italic), pinned, dirty marker, drag-to-reorder and a context menu.
// Built from the kit's tab styles (`ui-tab*`); the kit's EditorTabBar has no preview / pin / reorder yet.
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { XIcon } from "@llmide/ui-kit";
import { tabLabels } from "./labels";
import type { TabsState } from "./tabs-model";

export interface TabBarProps {
  tabs: TabsState;
  onSelect(id: string): void;
  onClose(id: string): void;
  onPromote(id: string): void;
  onMove(id: string, to: number): void;
  onContextMenu(id: string, x: number, y: number): void;
}

const DND = "application/x-llmide-tab";

export function ExplorerTabBar({ tabs, onSelect, onClose, onPromote, onMove, onContextMenu }: TabBarProps) {
  const labels = useMemo(() => tabLabels(tabs.tabs.map((t) => t.id)), [tabs.tabs]);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const onKey = (e: KeyboardEvent<HTMLDivElement>, id: string, i: number) => {
    const go = (k: number) => {
      const t = tabs.tabs[(k + tabs.tabs.length) % tabs.tabs.length];
      if (t) {
        onSelect(t.id);
        refs.current.get(t.id)?.focus();
      }
    };
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(tabs.tabs.length - 1);
    else if (e.key === "Delete" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w")) onClose(id);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = e.currentTarget.getBoundingClientRect();
      onContextMenu(id, r.left, r.bottom);
    } else return;
    e.preventDefault();
  };

  const dragOver = (e: DragEvent, i: number) => {
    if (!e.dataTransfer.types.includes(DND)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
  };

  return (
    <div className="ui-tabbar ex-tabbar" role="tablist" aria-label="Open files" onDragLeave={() => setDropAt(null)}>
      {tabs.tabs.map((t, i) => {
        const active = t.id === tabs.activeId;
        const l = labels.get(t.id);
        const name = l?.label ?? t.id;
        return (
          <div
            key={t.id}
            className="ui-tab ex-tab"
            role="tab"
            aria-selected={active}
            data-preview={t.preview || undefined}
            data-pinned={t.pinned || undefined}
            data-drop={dropAt === i ? "before" : dropAt === i + 1 && i === tabs.tabs.length - 1 ? "after" : undefined}
            draggable
            title={t.id}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND, t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => dragOver(e, i)}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DND);
              setDropAt(null);
              if (!id) return;
              e.preventDefault();
              const from = tabs.tabs.findIndex((x) => x.id === id);
              const to = dropAt ?? i;
              onMove(id, from >= 0 && from < to ? to - 1 : to);
            }}
            onDragEnd={() => setDropAt(null)}
            onDoubleClick={() => onPromote(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(t.id, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => onKey(e, t.id, i)}
          >
            <button
              ref={(el) => {
                if (el) refs.current.set(t.id, el);
                else refs.current.delete(t.id);
              }}
              type="button"
              className="ui-tab-select"
              tabIndex={active || (tabs.activeId === null && i === 0) ? 0 : -1}
              onClick={() => onSelect(t.id)}
            >
              {t.pinned && <span className="ex-pin" aria-label="Pinned" title="Pinned">●</span>}
              <span className="ui-tab-label ex-tab-label">{name}</span>
              {l?.hint && <span className="ex-tab-hint">{l.hint}</span>}
              {t.dirty && <span className="ui-tab-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
            </button>
            <button type="button" className="ui-tab-close" tabIndex={-1} aria-label={`Close ${name}`} onClick={() => onClose(t.id)}>
              <XIcon />
            </button>
            <span className="ui-tab-divider" />
          </div>
        );
      })}
    </div>
  );
}
