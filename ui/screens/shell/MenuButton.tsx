import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/** A non-interactive row: a heading (the account's name and email) or a divider. Skipped by arrow-key movement. */
export interface MenuDecor {
  id: string;
  kind: "label" | "separator";
  label?: string;
  muted?: boolean;
}

export interface MenuAction {
  id: string;
  label: string;
  /** Radio-style checked state (`menuitemradio`); omit for a plain `menuitem`. */
  checked?: boolean;
  disabled?: boolean;
  title?: string;
  /** Keyboard hint shown at the right (display only; the shell owns the key handling). */
  hint?: string;
  onSelect: () => void;
}

export type MenuItem = MenuAction | MenuDecor;

const isDecor = (it: MenuItem): it is MenuDecor => "kind" in it;

interface Props {
  /** Visible button content. */
  children: ReactNode;
  ariaLabel: string;
  items: readonly MenuItem[];
  /** Open upwards (status bar). */
  up?: boolean;
  /** Align the menu's right edge with the button (toolbar items near the window's right edge). */
  end?: boolean;
  className?: string;
  /** Runs when the menu opens (e.g. refresh the recent list). */
  onOpen?: () => void;
  emptyText?: string;
  /** Lets a host (the toolbar) measure the button and give it a roving tab stop. */
  buttonRef?: (el: HTMLButtonElement | null) => void;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> & { [attr: `data-${string}`]: string | undefined };
}

/** Accessible menu button: Enter/Space/Arrow opens, arrows move, Escape closes and returns focus. */
export function MenuButton({ children, ariaLabel, items, up, end, className, onOpen, emptyText, buttonRef, buttonProps }: Props) {
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
        {...buttonProps}
        ref={(el) => {
          button.current = el;
          buttonRef?.(el);
        }}
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
        <div id={menuId} role="menu" aria-label={ariaLabel} className={`sh-menu${up ? " sh-menu-up" : ""}${end ? " sh-menu-end" : ""}`} onKeyDown={onMenuKey}>
          {items.length === 0 && emptyText && <div className="sh-menu-empty">{emptyText}</div>}
          {items.map((it) => {
            if (isDecor(it)) {
              return it.kind === "separator"
                ? <div key={it.id} role="separator" className="sh-menu-sep" />
                : <div key={it.id} role="presentation" className={it.muted ? "sh-menu-label sh-menu-label-muted" : "sh-menu-label"}>{it.label}</div>;
            }
            return (
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
                <span className="sh-menu-text">{it.label}</span>
                {it.hint && <span className="sh-menu-hint" aria-hidden="true">{it.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
