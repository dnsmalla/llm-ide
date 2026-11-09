import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { CoreError, isAbortError, type CoreClient } from "./core";
import { describeCoreErrorFor } from "./core-explain";
import type { CoreStatus } from "./host";
import type { StatusHint, StatusView } from "./status-view";
import type { TrustGate } from "./trust-gate";

/** Names the unverified core and the risk; credentials are held back until the user agrees. */
export function UntrustedCoreNotice({ url, onConfirm }: { url: string | null; onConfirm: () => void }) {
  return (
    <div role="alertdialog" aria-labelledby="sh-untrusted-title" className="sh-form-error" data-testid="untrusted-core">
      <strong id="sh-untrusted-title">Unverified core at {url ?? "an unknown address"}</strong>
      <p>
        LLM-IDE did not start this core. Another program on this computer may be answering on that address, and it would receive your password and
        session tokens. Only continue if you started this core yourself.
      </p>
      <button type="button" className="sh-button" onClick={onConfirm}>
        I started it, trust this core for this session
      </button>
    </div>
  );
}

/** Copies text to the clipboard when the webview allows it; never throws. The app never runs the command. */
function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable: the command is shown on screen anyway */
  }
}

/** One explanation with a copyable command. Text only: there is deliberately no button that runs anything. */
export function HintNote({ hint }: { hint: StatusHint }) {
  return (
    <div className="sh-hint" role="note" data-hint={hint.id} data-level={hint.level}>
      <p className="sh-panel-text">{hint.text}</p>
      {hint.command && (
        <p className="sh-panel-text">
          <code>{hint.command}</code>{" "}
          <button type="button" className="sh-button" aria-label={`Copy command: ${hint.command}`} onClick={() => copyText(hint.command ?? "")}>
            Copy
          </button>
        </p>
      )}
    </div>
  );
}

/** Full-area panel while the core is down. Never blank: always says what is happening. */
export function CoreDownPanel({ view, onRetry, onStart }: { view: StatusView; onRetry: () => void; onStart?: () => void }) {
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
      {view.hints.map((h) => (
        <HintNote key={h.id} hint={h} />
      ))}
      {view.claudeNotice && <StatusBanner severity="warning" message={view.claudeNotice} />}
      <div className="sh-row">
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
        {onStart ? (
          <button
            type="button"
            className="sh-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onStart();
              setTimeout(() => setBusy(false), 800);
            }}
          >
            Start core
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Sign-in / create-account panel. Credentials go to the core only; nothing is stored here. */
export function LoginPanel({ client, gate, getStatus }: { client: CoreClient; gate?: TrustGate; getStatus?: () => CoreStatus | null }) {
  const trust = useSyncExternalStore(
    (l) => (gate ? gate.subscribe(l) : () => undefined),
    () => (gate ? gate.view() : null),
    () => null,
  );
  const blocked = trust !== null && !trust.allowed;
  const [mode, setMode] = useState<"signin" | "create">("signin");
  const [showPassword, setShowPassword] = useState(false);
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
    if (blocked) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const displayName = String(data.get("displayName") ?? "").trim();
    const invite = String(data.get("invite") ?? "").trim();
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
        await client.register(email, password, displayName || undefined, ctl.signal, invite || undefined);
        setNotice("Account created. Signing in…");
      }
      await client.login(email, password, ctl.signal);
      form.reset();
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof CoreError ? describeCoreErrorFor(err, getStatus ? getStatus() : null) : "Sign-in failed.");
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
      <p className="sh-panel-text sh-muted">The account lives on the LLM-IDE core you connect to. You sign in again each time the app starts.</p>
      {getStatus?.()?.url ? <p className="sh-panel-text sh-muted">Server: <code>{getStatus()!.url}</code></p> : null}
      {trust?.needsConfirm && gate && <UntrustedCoreNotice url={trust.url} onConfirm={() => gate.confirm()} />}
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
        {create && (
          <label className="sh-field">
            <span>Invite token (hub members only)</span>
            <input name="invite" type="text" autoComplete="off" spellCheck={false} disabled={pending} maxLength={512}
              placeholder="Paste the token from Settings → Team" />
            <span className="sh-muted">Not needed on a solo install or when the core allows open registration.</span>
          </label>
        )}
        <label className="sh-field">
          <span>Password</span>
          <div className="sh-password">
            <input name="password" type={showPassword ? "text" : "password"} autoComplete={create ? "new-password" : "current-password"} required disabled={pending} />
            <button type="button" className="sh-password-toggle" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        {error && (
          <div role="alert" className="sh-form-error">
            {error}
          </div>
        )}
        {notice && <div role="status">{notice}</div>}
        <div className="sh-form-actions">
          <button type="submit" className="sh-button sh-button-primary" disabled={pending || blocked}>
            {pending ? "Please wait…" : create ? "Create account" : "Sign in"}
          </button>
          <button
            type="button"
            className="sh-button"
            disabled={pending}
            onClick={() => {
              setMode(create ? "signin" : "create");
              setError(null);
            }}
          >
            {create ? "I have an account" : canRegister ? "Create account" : "I have an invite"}
          </button>
        </div>
      </form>
    </div>
  );
}
