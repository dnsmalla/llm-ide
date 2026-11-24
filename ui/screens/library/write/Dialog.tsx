// A small accessible modal: role dialog / alertdialog, labelled, Escape closes, Tab stays inside, focus
// moves in and is restored on close. Rendered inline (position: fixed) so server rendering works.
import { useRef, type ReactNode } from "react";
import { useDialogFocus } from "@llmide/ui-kit";

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** `alertdialog` for destructive confirmations. */
  role?: "dialog" | "alertdialog";
  /** Disable Escape and the backdrop while something is running. */
  busy?: boolean;
}

export function Dialog({ title, onClose, children, role = "dialog", busy = false }: DialogProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const id = `lib-dlg-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  useDialogFocus(ref);
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape" && !busy) {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="lib-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={ref} className="lib-modal" role={role} aria-modal="true" aria-labelledby={id} onKeyDown={onKey}>
        <div className="lib-modal-head">
          <h2 id={id} className="lib-modal-title">{title}</h2>
          <button type="button" className="lib-modal-close" aria-label="Close dialog" title="Close" disabled={busy} onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
