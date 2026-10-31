// A small accessible modal: role dialog / alertdialog, labelled, Escape closes, Tab stays inside, focus
// moves in and is restored on close. Rendered inline (position: fixed) so server rendering works.
import { useEffect, useRef, type ReactNode } from "react";

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** `alertdialog` for destructive confirmations. */
  role?: "dialog" | "alertdialog";
  /** Disable Escape and the backdrop while something is running. */
  busy?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, role = "dialog", busy = false }: DialogProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const id = `lib-dlg-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape" && !busy) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="lib-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={ref} className="lib-modal" role={role} aria-modal="true" aria-labelledby={id} onKeyDown={onKey}>
        <h2 id={id} className="lib-modal-title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
