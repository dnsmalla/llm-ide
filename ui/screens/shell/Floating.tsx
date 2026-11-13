// Popups (menus, popovers, pickers) render here: in a layer attached to the page body, fixed next to their button.
// A popup inside a pane is otherwise cut off by the pane's scrolling edge or covered by the next pane (the Code
// Assistant's Route history under the Explorer, a status-bar menu under the editor). It opens below or above, on
// the side with more room, slides to stay inside the window, and closes on Esc or a click outside. Without a
// document (server rendering, tests) it renders in place.
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { placeFloating, type Placed, type Placement } from "./floating-place";
export { placeFloating, type Placement } from "./floating-place";

export function Floating({ anchor, onDismiss, placement = "below-start", children, style, floatingRef, ...rest }: {
  /** The popup element itself (Floating IS the popup: pass its className, role, id and handlers here). */
  floatingRef?: (el: HTMLDivElement | null) => void;
  /** The element the popup belongs to (its button; a click on it is not an outside click), or a point (a right-click). */
  anchor: HTMLElement | { x: number; y: number } | null;
  /** Esc or a click outside the popup and its anchor. */
  onDismiss?: () => void;
  placement?: Placement;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>): ReactNode {
  const self = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Placed | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const inDom = typeof document !== "undefined";
  // A point anchor is a fresh object each render: key it by value so the popup is not re-measured every render.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const anchorKey: HTMLElement | string | null = anchor && "getBoundingClientRect" in anchor ? anchor : anchor ? `${anchor.x},${anchor.y}` : null;

  useLayoutEffect(() => {
    if (!inDom) return undefined;
    const measure = () => {
      const el = self.current;
      const anchor = anchorRef.current;
      if (!el || !anchor) return;
      const a = "getBoundingClientRect" in anchor ? anchor.getBoundingClientRect() : { top: anchor.y, left: anchor.x, right: anchor.x, bottom: anchor.y };
      const natural = { width: el.offsetWidth, height: el.scrollHeight };
      setPos(placeFloating(a, natural, window.innerWidth, window.innerHeight, placement));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (self.current) ro?.observe(self.current);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); ro?.disconnect(); };
  }, [anchorKey, placement, inDom]);

  useEffect(() => {
    if (!inDom) return undefined;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || self.current?.contains(t) || (anchor && "contains" in anchor && anchor.contains(t))) return;
      dismiss.current?.();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && dismiss.current) { e.stopPropagation(); dismiss.current(); } };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [anchor, inDom]);

  if (!inDom) return <div {...rest} style={style}>{children}</div>;
  return createPortal(
    <div {...rest} ref={(el) => { self.current = el; floatingRef?.(el); }} data-floating={pos?.side ?? "measuring"}
      style={{ ...style, position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, right: "auto", bottom: "auto", margin: 0, transform: "none", maxHeight: pos?.maxHeight, overflowY: "auto", zIndex: 1000, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}

/** Renders its children in the page body, above every pane (for a popup that positions itself). */
export function Portal({ children }: { children: ReactNode }): ReactNode {
  return typeof document === "undefined" ? children : createPortal(children, document.body);
}
