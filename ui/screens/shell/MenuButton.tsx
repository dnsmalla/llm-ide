import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  id: string;
  label: string;
  /** Radio-style checked state (`menuitemradio`); omit for a plain `menuitem`. */
  checked?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

interface Props {
  /** Visible button content. */
  children: ReactNode;
  ariaLabel: string;
  items: readonly MenuItem[];
  /** Open upwards (status bar). */
  up?: boolean;
  className?: string;
  /** Runs when the menu opens (e.g. refresh the recent list). */
  onOpen?: () => void;
  emptyText?: string;
}

/** Accessible menu button: Enter/Space/Arrow opens, arrows move, Escape closes and returns focus. */
export function MenuButton({ children, ariaLabel, items, up, className, onOpen, emptyText }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (els.length) els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      els[e.key === "Home" ? 0 : els.length - 1]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="sh-menu-root" ref={root}>
      <button
        ref={button}
        type="button"
        className={className ?? "sh-statusbar-item"}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) onOpen?.();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={ariaLabel} className={`sh-menu${up ? " sh-menu-up" : ""}`} onKeyDown={onMenuKey}>
          {items.length === 0 && emptyText && <div className="sh-menu-empty">{emptyText}</div>}
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role={it.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={it.checked}
              disabled={it.disabled}
              title={it.title}
              className="sh-menu-item"
              tabIndex={-1}
              onClick={() => {
                close(true);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
