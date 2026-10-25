// Used from T4+ (not rendered by the T3b shell yet).
import type { ReactNode } from "react";
import { XIcon } from "./icons";

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

/** Horizontal editor tab strip (Mac EditorTabBar, 35pt high, 2pt accent under the active tab). */
export function EditorTabBar({ tabs, activeId, onSelect, onClose }: Props) {
  return (
    <div className="ui-tabbar" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div key={tab.id} className="ui-tab" role="tab" aria-selected={active}>
            <button type="button" className="ui-tab-select" onClick={() => onSelect(tab.id)}>
              {tab.icon}
              <span className="ui-tab-label">{tab.label}</span>
              {tab.dirty && <span className="ui-tab-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
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
