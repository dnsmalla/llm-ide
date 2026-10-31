// Small modal dialogs (name prompt, confirm, unsaved-changes). Plain React, role="dialog", focus moves in,
// Escape cancels, Enter confirms, focus returns to the opener. File names in messages are text, never HTML.
import { useEffect, useRef, useState, type ReactNode } from "react";

interface ShellProps {
  title: string;
  onCancel: () => void;
  children: ReactNode;
  labelId: string;
}

function Modal({ title, onCancel, children, labelId }: ShellProps) {
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => {
    const o = opener.current;
    return () => {
      if (o instanceof HTMLElement) o.focus();
    };
  }, []);
  return (
    <div
      className="ex-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="ex-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={labelId} className="ex-modal-title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export interface PromptProps {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** Returns an error message to keep the dialog open, or null to accept. */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({ title, label, initial = "", confirmLabel, validate, onSubmit, onCancel }: PromptProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // Select the stem so typing replaces the name but keeps the extension.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const submit = () => {
    const msg = validate?.(value) ?? null;
    if (msg) setError(msg);
    else onSubmit(value);
  };
  return (
    <Modal title={title} onCancel={onCancel} labelId="ex-prompt-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="ex-field">
          <span className="ex-field-label">{label}</span>
          <input
            ref={input}
            className="ex-input"
            value={value}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "ex-prompt-error" : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error && (
          <p id="ex-prompt-error" role="alert" className="ex-field-error">
            {error}
          </p>
        )}
        <div className="ex-modal-actions">
          <button type="button" className="ex-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ex-btn ex-btn-primary">
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface ConfirmProps {
  title: string;
  message: ReactNode;
  /** Names listed under the message (capped). */
  items?: readonly string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const LIST_CAP = 6;

export function ConfirmDialog({ title, message, items, confirmLabel, danger, onConfirm, onCancel }: ConfirmProps) {
  const ok = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // Destructive confirmations focus Cancel, so a stray Enter does not delete.
  useEffect(() => (danger ? cancel : ok).current?.focus(), [danger]);
  return (
    <Modal title={title} onCancel={onCancel} labelId="ex-confirm-title">
      <p className="ex-modal-text">{message}</p>
      {items && items.length > 0 && (
        <ul className="ex-modal-list">
          {items.slice(0, LIST_CAP).map((n) => (
            <li key={n}>{n}</li>
          ))}
          {items.length > LIST_CAP && <li className="ex-muted">and {items.length - LIST_CAP} more</li>}
        </ul>
      )}
      <div className="ex-modal-actions">
        <button ref={cancel} type="button" className="ex-btn" onClick={onCancel}>
          Cancel
        </button>
        <button ref={ok} type="button" className={`ex-btn ${danger ? "ex-btn-danger" : "ex-btn-primary"}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export interface UnsavedProps {
  name: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function UnsavedDialog({ name, onSave, onDiscard, onCancel }: UnsavedProps) {
  const save = useRef<HTMLButtonElement>(null);
  useEffect(() => save.current?.focus(), []);
  return (
    <Modal title="Unsaved changes" onCancel={onCancel} labelId="ex-unsaved-title">
      <p className="ex-modal-text">{`Save the changes to "${name}" before closing?`}</p>
      <div className="ex-modal-actions">
        <button type="button" className="ex-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ex-btn ex-btn-danger" onClick={onDiscard}>
          Don't Save
        </button>
        <button ref={save} type="button" className="ex-btn ex-btn-primary" onClick={onSave}>
          Save
        </button>
      </div>
    </Modal>
  );
}
