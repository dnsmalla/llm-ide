// Explorer / Search / Source Control switcher at the top of the left panel (Mac `PanelSectionTabs`).
import { useRef, type KeyboardEvent } from "react";
import { PANELS, stepPanel, type PanelId } from "./panels";

export function PanelTabs({ active, onChange }: { active: PanelId; onChange: (id: PanelId) => void }) {
  const refs = useRef(new Map<PanelId, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d === 0) return;
    e.preventDefault();
    const next = stepPanel(active, d);
    onChange(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div className="ex-ptabs" role="tablist" aria-label="Side panel" onKeyDown={onKey}>
      {PANELS.map((p) => (
        <button
          key={p.id}
          ref={(el) => {
            if (el) refs.current.set(p.id, el);
          }}
          type="button"
          role="tab"
          id={`ex-ptab-${p.id}`}
          aria-selected={active === p.id}
          aria-controls={`ex-panel-${p.id}`}
          tabIndex={active === p.id ? 0 : -1}
          className="ex-ptab"
          data-active={active === p.id}
          title={`${p.label} (${p.shortcut})`}
          onClick={() => onChange(p.id)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
