import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

/** Mirrors ResizableDivider.clamp: non-finite input snaps to min; inverted bounds keep min. */
export function clampWidth(proposed: number, min: number, max: number): number {
  if (!Number.isFinite(proposed)) return min;
  return Math.min(Math.max(proposed, min), Math.max(min, max));
}

/** Width after a drag of `dx` pixels from `startWidth`; a right-hand panel (`invert`) widens when dragged left. */
export function dragWidth(startWidth: number, dx: number, min: number, max: number, invert = false): number {
  return clampWidth(startWidth + (invert ? -dx : dx), min, max);
}

/** Width after a key press, or null when the key is not a resize key. Arrow keys follow the pointer direction. */
export function keyWidth(key: string, width: number, min: number, max: number, step: number, invert = false): number | null {
  const next =
    key === "ArrowLeft" ? width + (invert ? step : -step)
    : key === "ArrowRight" ? width + (invert ? -step : step)
    : key === "Home" ? min
    : key === "End" ? max
    : null;
  return next === null ? null : clampWidth(next, min, max);
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
  /** The panel is on the divider's right (a right-hand dock): dragging left widens it. */
  invert?: boolean;
}

/**
 * Vertical divider with an 8px drag handle (Mac ResizableDivider). The drag is
 * measured from the width at pointer-down, so deltas never accumulate.
 * The parent should lay out the column beside this divider; `width` is the
 * width of the column that precedes it.
 */
export function ResizableDivider({ width, onWidthChange, min = 160, max = 520, label = "Resize panel", keyboardStep = 16, invert = false }: Props) {
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
    onWidthChange(dragWidth(s.width, e.clientX - s.x, min, max, invert));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = keyWidth(e.key, width, min, max, keyboardStep, invert);
    if (next === null) return;
    e.preventDefault();
    onWidthChange(next);
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
