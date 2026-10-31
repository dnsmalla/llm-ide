import type { ReactNode } from "react";

/** One panel toggle (Mac `SectionToggle`). */
export interface SectionToggle {
  id: string;
  icon: ReactNode;
  isOn: boolean;
  helpOn: string;
  helpOff: string;
  onToggle: () => void;
}

interface Props {
  title?: string;
  toggles?: SectionToggle[];
  /** Left-aligned accessory after the toggles (Mac `leading`). */
  leading?: ReactNode;
  /** Right-aligned controls (Mac `trailing`). */
  trailing?: ReactNode;
}

/** Thin control strip at the top of a section's content (Mac SectionChromeBar, 30pt high). */
export function SectionChromeBar({ title, toggles = [], leading, trailing }: Props) {
  return (
    <div className="ui-chrome-bar" role="toolbar" aria-label={title}>
      {toggles.map((t) => (
        <button
          key={t.id}
          type="button"
          className="ui-icon-button"
          aria-pressed={t.isOn}
          title={t.isOn ? t.helpOn : t.helpOff}
          aria-label={t.isOn ? t.helpOn : t.helpOff}
          onClick={t.onToggle}
        >
          {t.icon}
        </button>
      ))}
      {title && <span className="ui-chrome-title">{title}</span>}
      {leading}
      <span className="ui-chrome-spacer" />
      {trailing}
    </div>
  );
}
