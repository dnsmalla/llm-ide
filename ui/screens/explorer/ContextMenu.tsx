// Context menu: role="menu", arrow-key navigation, Enter/Space activates, Escape / outside click closes,
// focus returns to the opener. Position is clamped to the viewport.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: readonly MenuItem[];
  label: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, items, label, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const [pos, setPos] = useState({ x, y });
  const [cursor, setCursor] = useState(() => Math.max(0, items.findIndex((i) => !i.disabled)));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);

  useEffect(() => {
    ref.current?.focus();
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const blur = () => onClose();
    document.addEventListener("mousedown", down, true);
    window.addEventListener("blur", blur);
    const o = opener.current;
    return () => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("blur", blur);
      if (o instanceof HTMLElement) o.focus();
    };
  }, [onClose]);

  const move = (delta: 1 | -1) => {
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const i = (cursor + delta * k + n * k) % n;
      if (!items[i]?.disabled) {
        setCursor(i);
        return;
      }
    }
  };

  return (
    <div
      ref={ref}
      className="ex-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      aria-activedescendant={`ex-menu-${items[cursor]?.id ?? ""}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Home") setCursor(Math.max(0, items.findIndex((i) => !i.disabled)));
        else if (e.key === "Escape") onClose();
        else if (e.key === "Enter" || e.key === " ") {
          const it = items[cursor];
          if (it && !it.disabled) onPick(it.id);
        } else if (e.key === "Tab") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <div key={it.id}>
          {it.separator && <div className="ex-menu-sep" role="separator" />}
          <div
            id={`ex-menu-${it.id}`}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            data-active={i === cursor}
            data-danger={it.danger || undefined}
            className="ex-menu-item"
            onMouseEnter={() => !it.disabled && setCursor(i)}
            onClick={() => !it.disabled && onPick(it.id)}
          >
            {it.label}
          </div>
        </div>
      ))}
    </div>
  );
}
