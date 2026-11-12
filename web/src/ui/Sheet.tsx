// A modal sheet (bottom sheet on a phone, centred dialog from 600px): focus moves in and is trapped, Esc and a backdrop
// press close it, focus returns to what opened it, and the page behind does not scroll.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./primitives.tsx";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Sheet({ open, onClose, title, children, footer, dismissible = true }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; dismissible?: boolean }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = box.current?.querySelector<HTMLElement>("input,textarea,select") ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const els = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (els.length === 0) { e.preventDefault(); box.current.focus(); return; }
      const a = els[0]!, z = els[els.length - 1]!;
      if (e.shiftKey && (document.activeElement === a || document.activeElement === box.current)) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.body.style.overflow = prevOverflow; before?.focus?.(); };
  }, [open, dismissible]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="ui-backdrop" onMouseDown={(e) => { if (dismissible && e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="ui-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="ui-sheet-grab" aria-hidden="true" />
        <div className="ui-sheet-head"><h2 id={titleId}>{title}</h2>{dismissible && <IconButton icon="x" label="Close" onClick={onClose} />}</div>
        <div className="ui-sheet-body">{children}</div>
        {footer ? <div className="ui-sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
