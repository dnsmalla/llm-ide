// Small presentational pieces shared by the sections. Text goes in as React children
// (escaped); nothing here renders raw HTML or builds a URL from content.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SecretField } from "./secret-field.ts";
import { windowRange } from "./virtual.ts";

export function Button({ children, onClick, disabled, tone, label }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: "primary" | "danger"; label?: string }) {
  return (
    <button type="button" className="st-btn" data-tone={tone} disabled={disabled} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="st-field">
      <span className="st-label">{label}</span>
      {children}
      {hint ? <span className="st-hint">{hint}</span> : null}
    </label>
  );
}

export function Switch({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <div className="st-field">
      <label className="st-row">
        <input type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint ? <p className="st-hint">{hint}</p> : null}
    </div>
  );
}

export function ErrorText({ text }: { text: string | null }) {
  return text ? <StatusBanner severity="error" message={text} /> : null;
}

/** Write-only secret input: uncontrolled, type=password, never filled from a stored value.
 *  `resetKey` changes after a submit so the browser input is emptied too. */
export function SecretInput({ label, field, resetKey, hint, placeholder }: { label: string; field: SecretField; resetKey: number; hint?: string; placeholder?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input
        key={resetKey}
        className="st-input"
        type="password"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={placeholder}
        onInput={(e) => field.set(e.currentTarget.value)}
      />
    </Field>
  );
}

/** A destructive confirmation: names what changes and enables the action only when `word` is typed. */
export function TypedConfirm({ title, body, word, actionLabel, onConfirm, onCancel, busy }: {
  title: string; body: ReactNode; word: string; actionLabel: string; onConfirm: () => void; onCancel: () => void; busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const ok = typed.trim() === word && word.length > 0;
  return (
    <div className="st-dialog" role="alertdialog" aria-modal="false" aria-label={title}>
      <strong>{title}</strong>
      <div>{body}</div>
      <Field label={`Type ${word} to confirm`}>
        <input className="st-input" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
      </Field>
      <div className="st-row">
        <Button tone="danger" disabled={!ok || busy} onClick={onConfirm}>{actionLabel}</Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

/** Windowed list: renders only the rows in view (plus overscan), for thousands of items. */
export function VirtualList<T>({ items, rowHeight, height = 360, label, keyOf, render }: {
  items: readonly T[]; rowHeight: number; height?: number; label: string; keyOf: (t: T) => string; render: (t: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(height);
  useEffect(() => {
    if (ref.current) setViewport(ref.current.clientHeight || height);
  }, [height]);
  const w = windowRange({ total: items.length, rowHeight, scrollTop, viewportHeight: viewport });
  return (
    <div ref={ref} className="st-list" role="list" aria-label={label} aria-rowcount={items.length} style={{ height: Math.min(height, Math.max(rowHeight, items.length * rowHeight)) }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: w.padTop }} aria-hidden="true" />
      {items.slice(w.start, w.end).map((t, i) => (
        <div key={keyOf(t)} className="st-item" role="listitem" aria-posinset={w.start + i + 1} aria-setsize={items.length} style={{ height: rowHeight }}>
          {render(t)}
        </div>
      ))}
      <div style={{ height: w.padBottom }} aria-hidden="true" />
    </div>
  );
}

/** Shown where a host command has not landed yet. */
export function NeedsHost({ what }: { what: string }) {
  return <p className="st-hint">{what} needs the desktop host, which is not connected in this build yet.</p>;
}
