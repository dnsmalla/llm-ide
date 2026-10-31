// Small shared pieces: the modal, badges, the scan-finding list. Every string reaching these components
// was cleaned in the decoders; they still render only as React text (no HTML, no links, no images).
import { useEffect, useRef, type ReactNode } from "react";
import type { Finding } from "./decoders.ts";

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "warn" | "ok" | "accent"; title?: string }): ReactNode {
  return (
    <span className="ext-badge" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** A modal dialog: labelled, Escape closes, Tab stays inside, focus returns to the opener. */
export function Modal({ titleId, title, onClose, footer, children, wide = false }: { titleId: string; title: string; onClose: () => void; footer: ReactNode; children: ReactNode; wide?: boolean }): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    const first = el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    return () => opener?.focus?.();
  }, []);
  return (
    <div className="ext-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="ext-modal"
        data-wide={wide}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key !== "Tab" || !box.current) return;
          const nodes = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
          if (nodes.length === 0) return;
          const firstN = nodes[0]!;
          const lastN = nodes[nodes.length - 1]!;
          if (e.shiftKey && document.activeElement === firstN) {
            e.preventDefault();
            lastN.focus();
          } else if (!e.shiftKey && document.activeElement === lastN) {
            e.preventDefault();
            firstN.focus();
          }
        }}
      >
        <h2 id={titleId} className="ext-modal-title">
          {title}
        </h2>
        <div className="ext-modal-body">{children}</div>
        <div className="ext-modal-foot">{footer}</div>
      </div>
    </div>
  );
}

/** Scan findings as warnings, never as a verdict. Shows at most `max`; the rest is counted. */
export function FindingList({ findings, total, max = 50 }: { findings: readonly Finding[]; total?: number; max?: number }): ReactNode {
  const shown = findings.slice(0, max);
  const all = Math.max(total ?? findings.length, findings.length);
  return (
    <div className="ext-findings">
      <ul className="ext-findings-list" aria-label="Scan warnings">
        {shown.map((f, i) => (
          <li key={i} className="ext-finding">
            <span className="ext-finding-rule">{f.rule}</span> <span className="ext-finding-where">{f.file}{f.line ? `:${f.line}` : ""}</span>
            <div>{f.detail}</div>
            {f.excerpt && <code className="ext-excerpt">{f.excerpt}</code>}
          </li>
        ))}
      </ul>
      {all > shown.length && <p className="lib-muted">{all - shown.length} more warnings are not listed.</p>}
      <p className="lib-muted">The scan is a heuristic. It never blocks anything and it is not a safety verdict.</p>
    </div>
  );
}
