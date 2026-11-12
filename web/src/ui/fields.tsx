import { useEffect, useId, useLayoutEffect, useRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

interface FieldBase { label: string; hint?: ReactNode; error?: string | null; hideLabel?: boolean }
function describe(id: string, hint: unknown, error: unknown) { return [hint ? `${id}-h` : "", error ? `${id}-e` : ""].filter(Boolean).join(" ") || undefined; }

export function TextField({ label, hint, error, hideLabel, id: given, className, ...rest }: FieldBase & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <div className="ui-field">
      <label className={hideLabel ? "ui-sr-only" : "ui-label"} htmlFor={id}>{label}</label>
      <input {...rest} id={id} className={`ui-input${className ? ` ${className}` : ""}`} aria-invalid={error ? true : undefined} aria-describedby={describe(id, hint, error)} />
      {hint ? <p className="ui-hint" id={`${id}-h`}>{hint}</p> : null}
      {error ? <p className="ui-error" id={`${id}-e`} role="alert">{error}</p> : null}
    </div>
  );
}

export function TextArea({ label, hint, error, hideLabel, autoGrow = false, maxRows = 8, id: given, className, value, ...rest }: FieldBase & TextareaHTMLAttributes<HTMLTextAreaElement> & { autoGrow?: boolean; maxRows?: number }) {
  const auto = useId();
  const id = given ?? auto;
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, autoGrow ? String(value ?? "") : null, maxRows);
  return (
    <div className="ui-field">
      <label className={hideLabel ? "ui-sr-only" : "ui-label"} htmlFor={id}>{label}</label>
      <textarea {...rest} ref={ref} id={id} value={value} className={`ui-input${className ? ` ${className}` : ""}`} aria-invalid={error ? true : undefined} aria-describedby={describe(id, hint, error)} />
      {hint ? <p className="ui-hint" id={`${id}-h`}>{hint}</p> : null}
      {error ? <p className="ui-error" id={`${id}-e`} role="alert">{error}</p> : null}
    </div>
  );
}

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;
/** Size a textarea to its content, at most `maxRows` lines (then it scrolls). */
export function growTextarea(el: HTMLTextAreaElement, maxRows: number) {
  el.rows = 1;
  el.style.height = "auto";
  const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
  const max = line * maxRows + 22;
  const want = el.scrollHeight + 2;
  el.style.height = `${Math.min(want, max)}px`;
  el.style.overflowY = want > max ? "auto" : "hidden";
}
/** Grow a textarea to its content up to `maxRows` lines; `null` text turns it off. */
export function useAutoGrow(ref: { current: HTMLTextAreaElement | null }, text: string | null, maxRows: number) {
  useIsoLayout(() => { if (ref.current && text !== null) growTextarea(ref.current, maxRows); }, [ref, text, maxRows]);
}
