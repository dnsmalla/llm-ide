// Presentational building blocks. Every colour is a --tok-* token (via ui.css); every control meets a 44px touch target.
import { useId, useRef, type ButtonHTMLAttributes, type ElementType, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { UiIcon, type UiIconName } from "./icons.tsx";

// ---- Spinner / Skeleton ----
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <span className="ui-spinner" style={{ ["--ui-spinner-size" as string]: `${size}px` }} {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })} />;
}
export function Skeleton({ width = "100%", height = 14, shape = "rect" }: { width?: number | string; height?: number | string; shape?: "rect" | "circle" }) {
  return <span className="ui-skeleton" data-shape={shape} style={{ width, height }} aria-hidden="true" />;
}

// ---- Button / IconButton ----
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: UiIconName; block?: boolean;
}
/** The label is the first child when there is no icon or spinner, so `<button ...>Label` stays greppable. */
export function Button({ variant = "secondary", size = "md", loading = false, icon, block = false, disabled, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={`ui-btn${rest.className ? ` ${rest.className}` : ""}`} data-variant={variant} data-size={size} data-block={block} data-loading={loading}
      disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <Spinner /> : icon ? <UiIcon name={icon} size={size === "sm" ? 16 : 18} /> : null}{children}
    </button>
  );
}
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> { icon: UiIconName; label: string; variant?: "plain" | "filled" | "primary"; size?: "sm" | "md" }
export function IconButton({ icon, label, variant = "plain", size = "md", type = "button", ...rest }: IconButtonProps) {
  return <button {...rest} type={type} className="ui-iconbtn" data-variant={variant} data-size={size} aria-label={label} title={label}><UiIcon name={icon} size={size === "sm" ? 16 : 20} /></button>;
}

// ---- Card / SectionHeader / ListRow ----
export function SectionHeader({ title, description, action, as: Tag = "h2", eyebrow = false }: { title: ReactNode; description?: ReactNode; action?: ReactNode; as?: "h1" | "h2" | "h3"; eyebrow?: boolean }) {
  return (
    <div className="ui-sectionhead" data-eyebrow={eyebrow}>
      <div><Tag>{title}</Tag>{description ? <p>{description}</p> : null}</div>
      {action}
    </div>
  );
}
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> { title?: ReactNode; description?: ReactNode; action?: ReactNode; flush?: boolean; as?: ElementType; headingLevel?: "h2" | "h3" }
export function Card({ title, description, action, flush = false, as: Tag = "section", headingLevel = "h2", children, className, ...rest }: CardProps) {
  return (
    <Tag {...rest} className={`ui-card${className ? ` ${className}` : ""}`} data-flush={flush}>
      {title ? <div className="ui-card-head"><SectionHeader title={title} description={description} action={action} as={headingLevel} /></div> : null}
      <div className="ui-card-body">{children}</div>
    </Tag>
  );
}
export interface ListRowProps {
  icon?: UiIconName; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; chevron?: boolean; selected?: boolean; disabled?: boolean;
  onClick?: () => void; href?: string; external?: boolean; current?: boolean;
}
export function ListRow({ icon, title, subtitle, trailing, chevron, selected, disabled, onClick, href, external, current }: ListRowProps) {
  const inner = (
    <>
      {icon ? <span className="ui-row-icon"><UiIcon name={icon} size={18} /></span> : null}
      <span className="ui-row-body">
        <span className="ui-row-main"><span className="ui-row-title">{title}</span>{subtitle ? <span className="ui-row-sub">{subtitle}</span> : null}</span>
        {trailing || chevron || external ? <span className="ui-row-trailing">{trailing}{external ? <UiIcon name="external-link" size={16} /> : chevron ? <UiIcon name="chevron-right" size={16} /> : null}</span> : null}
      </span>
    </>
  );
  const common = { className: "ui-row", "data-selected": selected || undefined, "aria-current": current ? ("true" as const) : undefined };
  if (href) return <a {...common} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{inner}</a>;
  if (onClick) return <button type="button" {...common} onClick={onClick} disabled={disabled}>{inner}</button>;
  return <div {...common}>{inner}</div>;
}
/** A list of rows: pass <li><ListRow/></li> children, or use `rows`. */
export function RowList({ children, label }: { children: ReactNode; label?: string }) { return <ul className="ui-list" aria-label={label}>{children}</ul>; }

// ---- Badge / StatusPill ----
export type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";
export function Badge({ tone = "neutral", dot = false, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className="ui-badge" data-tone={tone}>{dot ? <i className="ui-badge-dot" aria-hidden="true" /> : null}{children}</span>;
}
export type ConnStatus = "live" | "reconnecting" | "waiting" | "offline" | "idle";
const PILL: Record<ConnStatus, { tone: Tone; label: string }> = {
  live: { tone: "success", label: "Live" }, reconnecting: { tone: "warning", label: "Reconnecting…" }, waiting: { tone: "warning", label: "Waiting for the desktop" },
  offline: { tone: "info", label: "Offline copy" }, idle: { tone: "neutral", label: "Not connected" },
};
export function StatusPill({ status, label }: { status: ConnStatus; label?: string }) {
  const p = PILL[status];
  return <span className="ui-badge ui-pill" data-tone={p.tone} data-status={status}><i className="ui-badge-dot" aria-hidden="true" />{label ?? p.label}</span>;
}

// ---- Banner ----
export type BannerTone = "info" | "warn" | "error" | "success";
export function Banner({ tone = "info", title, children, action, onDismiss }: { tone?: BannerTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; onDismiss?: () => void }) {
  const icon: UiIconName = tone === "info" ? "info" : tone === "success" ? "circle-check" : "triangle-alert";
  return (
    <div className="ui-banner2" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <span className="ui-banner2-icon"><UiIcon name={icon} size={18} /></span>
      <div className="ui-banner2-body">{title ? <span className="ui-banner2-title">{title}</span> : null}{children ? <span>{children}</span> : null}</div>
      {action ? <div className="ui-banner2-action">{action}</div> : null}
      {onDismiss ? <IconButton icon="x" label="Dismiss message" size="sm" onClick={onDismiss} /> : null}
    </div>
  );
}

// ---- SegmentedControl (a radiogroup: arrows move and select, Tab leaves) ----
export interface SegOption<T extends string> { value: T; label: string; icon?: UiIconName }
export function SegmentedControl<T extends string>({ value, onChange, options, label, size = "md", block = false }: { value: T; onChange: (v: T) => void; options: readonly SegOption<T>[]; label: string; size?: "sm" | "md"; block?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n]!.value);
    refs.current[n]?.focus();
  };
  return (
    <div className="ui-seg" role="radiogroup" aria-label={label} data-size={size} data-block={block}>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={value === o.value} tabIndex={value === o.value ? 0 : -1}
          className="ui-seg-opt" onClick={() => onChange(o.value)} onKeyDown={(e) => move(e, i)}>
          {o.icon ? <UiIcon name={o.icon} size={16} /> : null}{o.label}
        </button>
      ))}
    </div>
  );
}

// ---- EmptyState ----
export function EmptyState({ icon, title, children, action, headingLevel = "h2" }: { icon: UiIconName; title: ReactNode; children?: ReactNode; action?: ReactNode; headingLevel?: "h2" | "h3" }) {
  const Tag = headingLevel;
  const id = useId();
  return (
    <div className="ui-empty" role="group" aria-labelledby={id}>
      <span className="ui-empty-icon"><UiIcon name={icon} size={30} /></span>
      <Tag id={id}>{title}</Tag>
      {children ? <p>{children}</p> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}
