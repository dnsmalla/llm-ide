// The full-page graph: the canvas alone over the window, with a close button (the Mac's expanded overlay,
// UAGraphView.swift:1315-1350). Esc closes it. The listener runs in the capture phase so the canvas's own Escape
// (clear the selection) does not also fire when the user only meant to leave full page. It is only registered
// while the section is shown, and it only takes an Escape aimed at the overlay (or at nothing: the body), so an
// Escape meant for another section or for a shell dialog (command palette) is never swallowed.
import { useEffect, useRef, type ReactNode } from "react";

/** True when an Escape with this target belongs to the full-page overlay. */
export function escapeIsOurs(target: EventTarget | null, overlay: { contains(n: unknown): boolean } | null, doc: { body: unknown; documentElement: unknown } | null): boolean {
  if (!overlay) return false;
  if (target === null || (doc && (target === doc.body || target === doc.documentElement))) return true;
  return overlay.contains(target);
}

export function FullPageGraph({ onClose, active = true, children }: { onClose: () => void; active?: boolean; children: ReactNode }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    // Move focus into the overlay so keyboard users land on the canvas (the expand button just unmounted).
    const el = root.current;
    const canvas = el?.querySelector<HTMLElement>(".gr-canvas-wrap");
    if (el && !el.contains(document.activeElement)) (canvas ?? el.querySelector<HTMLElement>("button"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!escapeIsOurs(e.target, root.current, document)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, active]);
  return (
    <div ref={root} className="gr-full" role="dialog" aria-modal="true" aria-label="Code graph, full page">
      {children}
      <button type="button" className="gr-btn gr-full-close" aria-label="Close full-page graph" title="Close full-page graph (Esc)" onClick={onClose}>✕</button>
    </div>
  );
}
