// Small pieces shared by the Google pane and its easy-setup cards: a cancellable task hook, error line, copy button,
// checkbox and field wrappers. Text only; nothing here renders HTML from a string.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { googleErrorText, mapGoogleThrown, type GoogleError } from "./google-core.ts";

export interface Task {
  busy: boolean;
  error: GoogleError | null;
  run: <R>(fn: (signal: AbortSignal) => Promise<R>) => Promise<R | undefined>;
  stop: () => void;
  clear: () => void;
}

export function useTask(): Task {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GoogleError | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = useCallback(async <R,>(fn: (signal: AbortSignal) => Promise<R>): Promise<R | undefined> => {
    if (abort.current) return undefined;
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setError(null);
    try {
      return await fn(ac.signal);
    } catch (e) {
      const err = mapGoogleThrown(e, ac.signal);
      if (err.code !== "cancelled") setError(err);
      return undefined;
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }, []);
  return useMemo(() => ({ busy, error, run, stop: () => abort.current?.abort(), clear: () => setError(null) }), [busy, error, run]);
}

export function ErrorLine({ task }: { task: Task }): ReactNode {
  if (!task.error) return null;
  return <StatusBanner severity={task.error.code === "cancelled" ? "info" : "error"} message={`${googleErrorText(task.error.code)}${task.error.serverCode ? ` (${task.error.serverCode})` : ""}`} onDismiss={task.clear} />;
}

export function errorMessage(code: Parameters<typeof googleErrorText>[0], serverCode: string | null): string {
  return `${googleErrorText(code)}${serverCode ? ` (${serverCode})` : ""}`;
}

/** A readable local time for an ISO string from the core, or null when it is not a date. */
export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toLocaleString();
}

export function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [note, setNote] = useState<string | null>(null);
  const copy = (): void => {
    try {
      const w = navigator.clipboard?.writeText(text);
      if (!w) throw new Error("no clipboard");
      w.then(() => setNote("Copied"), () => setNote("Copy failed: select the text and copy it yourself"));
    } catch {
      setNote("Copy failed: select the text and copy it yourself");
    }
  };
  return (
    <span>
      <button type="button" className="lib-btn" onClick={copy} aria-label={`Copy ${label}`}>
        Copy
      </button>
      {note && (
        <span className="lib-muted" role="status">
          {" "}
          {note}
        </span>
      )}
    </span>
  );
}

export function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <label className="lib-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {children}
    </label>
  );
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }): ReactNode {
  return (
    <label className="lib-field">
      <span>{label}</span>
      {children}
      {error && (
        <span className="lib-muted" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

