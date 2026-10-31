import { useEffect, useRef, useState, type FormEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { CoreError, isAbortError, type CoreClient } from "./core";
import type { StatusView } from "./status-view";

/** Full-area panel while the core is down. Never blank: always says what is happening. */
export function CoreDownPanel({ view, onRetry }: { view: StatusView; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const live = view.level === "error" ? "assertive" : "polite";
  return (
    <div className="sh-panel" role={view.level === "error" ? "alert" : "status"} aria-live={live} data-level={view.level}>
      {view.level === "busy" && <span className="sh-spinner" aria-hidden="true" />}
      <h2 className="sh-panel-title">{view.label}</h2>
      {view.detail && <p className="sh-panel-text">{view.detail}</p>}
      {view.fatal ? (
        <p className="sh-panel-text">
          The core crashed repeatedly and will not be restarted. Quit and reopen LLM-IDE. The reason is in <code>core.log</code> in the app data folder.
        </p>
      ) : (
        <p className="sh-panel-text sh-muted">Your windows and drafts are kept. This screen updates by itself.</p>
      )}
      {view.claudeNotice && <StatusBanner severity="warning" message={view.claudeNotice} />}
      <button
        type="button"
        className="sh-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onRetry();
          setTimeout(() => setBusy(false), 600);
        }}
      >
        Check again
      </button>
    </div>
  );
}

/** Sign-in / create-account panel. Credentials go to the core only; nothing is stored here. */
export function LoginPanel({ client }: { client: CoreClient }) {
  const [mode, setMode] = useState<"signin" | "create">("signin");
  const [canRegister, setCanRegister] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    void client.registrationOpen(ctl.signal).then((open) => {
      if (!ctl.signal.aborted) setCanRegister(open);
    });
    return () => {
      ctl.abort();
      abort.current?.abort();
    };
  }, [client]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const displayName = String(data.get("displayName") ?? "").trim();
    if (!email || !password) {
      setError("Enter an email and a password.");
      return;
    }
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "create") {
        await client.register(email, password, displayName || undefined, ctl.signal);
        setNotice("Account created. Signing in…");
      }
      await client.login(email, password, ctl.signal);
      form.reset();
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof CoreError ? err.message : "Sign-in failed.");
      const pw = form.elements.namedItem("password");
      if (pw instanceof HTMLInputElement) pw.value = "";
    } finally {
      if (!ctl.signal.aborted) setPending(false);
    }
  };

  const create = mode === "create";
  return (
    <div className="sh-panel">
      <h2 className="sh-panel-title">{create ? "Create your account" : "Sign in to LLM-IDE"}</h2>
      <p className="sh-panel-text sh-muted">The account lives only on this computer. You sign in again each time the app starts.</p>
      <form className="sh-form" onSubmit={submit} aria-busy={pending}>
        <label className="sh-field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="username" required autoFocus disabled={pending} />
        </label>
        {create && (
          <label className="sh-field">
            <span>Display name (optional)</span>
            <input name="displayName" type="text" autoComplete="name" disabled={pending} maxLength={80} />
          </label>
        )}
        <label className="sh-field">
          <span>Password</span>
          <input name="password" type="password" autoComplete={create ? "new-password" : "current-password"} required disabled={pending} />
        </label>
        {error && (
          <div role="alert" className="sh-form-error">
            {error}
          </div>
        )}
        {notice && <div role="status">{notice}</div>}
        <div className="sh-form-actions">
          <button type="submit" className="sh-button sh-button-primary" disabled={pending}>
            {pending ? "Please wait…" : create ? "Create account" : "Sign in"}
          </button>
          {(canRegister || create) && (
            <button
              type="button"
              className="sh-button"
              disabled={pending}
              onClick={() => {
                setMode(create ? "signin" : "create");
                setError(null);
              }}
            >
              {create ? "I have an account" : "Create account"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
