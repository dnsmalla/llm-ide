import type { ReactNode } from "react";

/** Plain button (class `st-btn`; its styles ship with the settings stylesheet). Text goes in as children. */
export function Button({ children, onClick, disabled, tone, label }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: "primary" | "danger"; label?: string }) {
  return (
    <button type="button" className="st-btn" data-tone={tone} disabled={disabled} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}
