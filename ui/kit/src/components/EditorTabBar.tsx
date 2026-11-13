import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { XIcon } from "../icons";

export interface EditorTab {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Unsaved edits: shows the accent dot (Mac EditorDraftStore). */
  dirty?: boolean;
}

interface Props {
  tabs: EditorTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/** Arrow/Home/End target in a horizontal tab list (wraps); null for any other key. Pure. */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight": return (index + 1) % count;
    case "ArrowLeft": return (index - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/** The tab's accessible name: the unsaved state is part of it, not a separate unnamed dot. */
export const tabAccessibleName = (tab: EditorTab): string => (tab.dirty ? `${tab.label}, unsaved changes` : tab.label);

/** Horizontal editor tab strip (Mac EditorTabBar, 35pt high, 2pt accent under the active tab). */
export function EditorTabBar({ tabs, activeId, onSelect, onClose }: Props) {
  const selects = useRef(new Map<string, HTMLButtonElement>());
  // Roving tabindex: one tab stop, the active tab (the first when none is active).
  const stopId = tabs.some((t) => t.id === activeId) ? activeId : tabs[0]?.id;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = tabs.findIndex((t) => selects.current.get(t.id) === document.activeElement);
    if (from < 0) return;
    const to = tabKeyTarget(e.key, from, tabs.length);
    if (to === null) return;
    e.preventDefault();
    const next = tabs[to]!;
    selects.current.get(next.id)?.focus();
    onSelect(next.id);
  };
  return (
    <div className="ui-tabbar" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          // The wrapper only groups the two buttons; the tab role sits on the focusable select button. data-active is
          // the styling hook that used to be aria-selected on this element.
          <div key={tab.id} className="ui-tab" role="presentation" data-active={active}>
            <button
              type="button"
              role="tab"
              ref={(el) => { if (el) selects.current.set(tab.id, el); else selects.current.delete(tab.id); }}
              aria-selected={active}
              aria-label={tabAccessibleName(tab)}
              tabIndex={tab.id === stopId ? 0 : -1}
              className="ui-tab-select"
              onClick={() => onSelect(tab.id)}
            >
              {tab.icon}
              <span className="ui-tab-label">{tab.label}</span>
              {tab.dirty && <span className="ui-tab-dirty" aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="ui-tab-close"
              aria-label={`Close ${tab.label}`}
              onClick={() => onClose(tab.id)}
            >
              <XIcon />
            </button>
            <span className="ui-tab-divider" />
          </div>
        );
      })}
    </div>
  );
}
