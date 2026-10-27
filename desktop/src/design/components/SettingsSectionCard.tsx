// Used from T4+ (not rendered by the T3b shell yet).
import { useState, type ReactNode } from "react";
import { ChevronIcon } from "./icons";

const storageKey = (title: string) => `settings.section.${title}.expanded`;

/** Reads the persisted expanded flag; storage failures fall back to `fallback`. */
function readExpanded(title: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(storageKey(title));
    if (v === "true") return true;
    if (v === "false") return false;
  } catch {
    // storage unavailable: use the default
  }
  return fallback;
}

function writeExpanded(title: string, value: boolean): void {
  try {
    window.localStorage.setItem(storageKey(title), String(value));
  } catch {
    // storage unavailable: the state lasts for this session only
  }
}

interface Props {
  icon: ReactNode;
  title: string;
  /** Sections start collapsed, like the Mac Settings index (default false). */
  defaultExpanded?: boolean;
  children: ReactNode;
}

/** Collapsible settings section with a persisted open state (Mac SettingsSectionCard). */
export function SettingsSectionCard({ icon, title, defaultExpanded = false, children }: Props) {
  const [open, setOpen] = useState(() => readExpanded(title, defaultExpanded));

  const toggle = () => {
    setOpen((prev) => {
      writeExpanded(title, !prev);
      return !prev;
    });
  };

  return (
    <section className="ui-settings-section">
      <button
        type="button"
        className="ui-settings-header"
        aria-expanded={open}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        onClick={toggle}
      >
        <span className="ui-settings-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="ui-settings-title">{title}</span>
        <span className="ui-settings-spacer" />
        <span className="ui-settings-chevron" data-open={open} aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      {open && <div className="ui-card">{children}</div>}
    </section>
  );
}
