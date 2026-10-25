// Used from T4+ (not rendered by the T3b shell yet).
import type { ReactNode } from "react";

interface Props {
  icon?: ReactNode;
  label: string;
  trailing?: ReactNode;
  active?: boolean;
  compact?: boolean;
  onClick?: () => void;
}

/** Capsule label / toggle (Mac Chip). Rendered as a button when clickable. */
export function Chip({ icon, label, trailing, active = false, compact = false, onClick }: Props) {
  const content = (
    <>
      {icon}
      {label && <span className="ui-chip-label">{label}</span>}
      {trailing && <span className="ui-chip-trailing">{trailing}</span>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className="ui-chip"
        data-active={active}
        data-compact={compact}
        aria-pressed={active}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <span className="ui-chip" data-active={active} data-compact={compact} aria-label={label}>
      {content}
    </span>
  );
}
