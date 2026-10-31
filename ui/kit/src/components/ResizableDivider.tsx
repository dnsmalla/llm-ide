import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

/** Mirrors ResizableDivider.clamp: non-finite input snaps to min; inverted bounds keep min. */
export function clampWidth(proposed: number, min: number, max: number): number {
  if (!Number.isFinite(proposed)) return min;
  return Math.min(Math.max(proposed, min), Math.max(min, max));
}

interface Props {
  width: number;
  onWidthChange: (width: number) => void;
  /** Mac defaults. */
  min?: number;
  max?: number;
  /** Accessible name of the separator. */
  label?: string;
  /** Pixels moved per arrow-key press. */
  keyboardStep?: number;
}

/**
 * Vertical divider with an 8px drag handle (Mac ResizableDivider). The drag is
 * measured from the width at pointer-down, so deltas never accumulate.
 * The parent should lay out the column beside this divider; `width` is the
 * width of the column that precedes it.
 */
export function ResizableDivider({ width, onWidthChange, min = 160, max = 520, label = "Resize panel", keyboardStep = 16 }: Props) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    onWidthChange(clampWidth(s.width + (e.clientX - s.x), min, max));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowLeft" ? width - keyboardStep
      : e.key === "ArrowRight" ? width + keyboardStep
      : e.key === "Home" ? min
      : e.key === "End" ? max
      : null;
    if (next === null) return;
    e.preventDefault();
    onWidthChange(clampWidth(next, min, max));
  };
  const end = () => {
    start.current = null;
    setDragging(false);
  };

  return (
    <div className="ui-divider">
      <div
        className="ui-divider-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        tabIndex={0}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        data-dragging={dragging}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  );
}
