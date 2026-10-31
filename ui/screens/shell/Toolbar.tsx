// The top toolbar (Mac `AppShell.shellToolbar`): Home, the section buttons in the Mac's order with icon and label, a
// More menu when the window is too narrow, and the account menu on the right. On macOS the host window has an
// overlay title bar, so the traffic lights sit on this row (left inset) and the empty parts of the row drag the window.
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "@llmide/ui-kit";
import { MenuButton, type MenuItem } from "./MenuButton";
import { estimateWidth, partitionToolbar, rovingStop, samePartition, toolbarKeyTarget, toolbarSections, type Partition } from "./toolbar-model";
import type { SectionDef, SectionId } from "./sections";

const ICONS: Partial<Record<SectionId, IconName>> = {
  explorer: "folder",
  graph: "network",
  autotasks: "refresh-cw",
  conflicts: "triangle-alert",
  issues: "list-checks",
  gantt: "chart-column",
  loop: "repeat",
  docgen: "wand-sparkles",
  visual: "images",
  library: "library",
  spike: "gauge",
};

const MORE_ID = "__more";
const GAP = 2;

export interface ToolbarProps {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  /** Developer tools on: the Spike item joins the list. */
  devTools: boolean;
}

const ToolButton = memo(function ToolButton({ def, active, stop, onSelect, onFocus, setRef }: { def: SectionDef; active: boolean; stop: boolean; onSelect: (id: SectionId) => void; onFocus: (id: string) => void; setRef: (id: string, el: HTMLElement | null) => void }) {
  const icon = ICONS[def.id];
  return (
    <button
      type="button"
      ref={(el) => setRef(def.id, el)}
      className="sh-tool"
      data-tb-id={def.id}
      data-tb-focus={def.enabled ? "" : undefined}
      aria-current={active ? "page" : undefined}
      aria-disabled={def.enabled ? undefined : true}
      title={def.note ? `${def.label}: ${def.note}` : def.shortcut ? `${def.label} (Ctrl/Cmd+${def.shortcut})` : def.label}
      tabIndex={def.enabled && stop ? 0 : -1}
      onFocus={() => def.enabled && onFocus(def.id)}
      onClick={() => def.enabled && onSelect(def.id)}
    >
      {icon && <Icon name={icon} size={14} />}
      <span className="sh-tool-label">{def.label}</span>
      {!def.enabled && <span className="sh-tool-soon">Soon</span>}
    </button>
  );
});

export const SectionToolbar = memo(function SectionToolbar({ active, onSelect, devTools }: ToolbarProps) {
  const defs = useMemo(() => toolbarSections(devTools), [devTools]);
  const bar = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const widths = useRef(new Map<string, number>());
  const moreWidth = useRef(84);
  const [part, setPart] = useState<Partition>({ visible: defs.map((_, i) => i), overflow: [] });
  const [focusId, setFocusId] = useState<string | null>(null);

  const setRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  }, []);

  // Measure what is rendered, remember widths of what is not, and re-partition on every size change.
  const layout = useCallback(() => {
    const el = bar.current;
    if (!el) return;
    for (const [id, node] of els.current) {
      const w = node.offsetWidth;
      if (id === MORE_ID) {
        if (w > 0) moreWidth.current = w;
      } else if (w > 0) widths.current.set(id, w);
    }
    const ws = defs.map((d) => widths.current.get(d.id) ?? estimateWidth(d.label));
    const next = partitionToolbar(ws, el.clientWidth, moreWidth.current, GAP, defs.findIndex((d) => d.id === active));
    setPart((cur) => (samePartition(cur, next) && cur.visible.length === next.visible.length ? cur : next));
  }, [defs, active]);

  useLayoutEffect(() => {
    layout();
    const el = bar.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => layout());
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);

  const shown = part.visible.map((i) => defs[i]!).filter(Boolean);
  const hidden = part.overflow.map((i) => defs[i]!).filter(Boolean);
  const focusable = [...shown.filter((d) => d.enabled).map((d) => d.id), ...(hidden.length ? [MORE_ID] : [])];
  const stop = rovingStop(focusable, focusId ?? active);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const nodes = [...(bar.current?.querySelectorAll<HTMLElement>("[data-tb-focus]") ?? [])];
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const t = toolbarKeyTarget(e.key, i, nodes.length);
    if (t === null) return;
    e.preventDefault();
    nodes[t]?.focus();
  };

  const moreItems: MenuItem[] = hidden.map((d) => ({
    id: d.id,
    label: d.enabled ? d.label : `${d.label} (Soon)`,
    title: d.note ? `${d.label}: ${d.note}` : d.label,
    disabled: !d.enabled,
    onSelect: () => onSelect(d.id),
  }));

  return (
    <div ref={bar} className="sh-toolbar" role="toolbar" aria-label="Sections" aria-orientation="horizontal" data-tauri-drag-region onKeyDown={onKeyDown}>
      {shown.map((d) => (
        <ToolButton key={d.id} def={d} active={active === d.id} stop={stop === d.id} onSelect={onSelect} onFocus={setFocusId} setRef={setRef} />
      ))}
      {hidden.length > 0 && (
        <MenuButton ariaLabel={`More sections (${hidden.length})`} className="sh-tool sh-tool-more" items={moreItems} end buttonRef={(el) => setRef(MORE_ID, el)} buttonProps={{ "data-tb-focus": "", tabIndex: stop === MORE_ID ? 0 : -1, onFocus: () => setFocusId(MORE_ID) }}>
          <Icon name="ellipsis" size={14} />
          <span className="sh-tool-label">More</span>
        </MenuButton>
      )}
    </div>
  );
});

