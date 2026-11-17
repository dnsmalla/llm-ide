import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { CoreError, isAbortError, type CoreClient } from "./core";
import { describeCoreErrorFor } from "./core-explain";
import { host, type CoreStatus } from "./host";
import {
  clearSavedLoginRejected,
  savedLoginNote,
  savedLoginRejected,
  setSavedLoginNote,
  subscribeSavedLoginNote,
  subscribeSavedLoginRejected,
} from "./saved-login-state";
import type { StatusHint, StatusView } from "./status-view";
import type { TrustGate } from "./trust-gate";

/** Shown when the core is not the one this app started: the login is used for this sign-in only, not saved. */
const NOTE_NOT_SAVED_ADOPTED = "This core is not the one the app started, so your login was not saved.";
/** Shown when an unticked sign-in could not clear a login saved earlier. */
const NOTE_FORGET_FAILED = "Could not remove the saved login; open Settings → Account to forget it.";

function codeOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : "";
}

/** Text for a host command failure (the host sends `{code, message}`); anything else reads as a generic failure. */
function hostErrorText(e: unknown): string {
  const code = codeOf(e);
  if (code === "keychain_unavailable") return "Could not save your login on this computer. Untick “Keep me signed in” to sign in without saving.";
  if (code === "login_rejected") return "The email or password is incorrect.";
  if (code === "untrusted_core") return NOTE_NOT_SAVED_ADOPTED;
  const message = (e as { message?: unknown })?.message;
  return code !== "" && typeof message === "string" ? message : "Sign-in failed.";
}

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
export function CoreDownPanel({ view, onRetry, onStart, onOpenSettings }: { view: StatusView; onRetry: () => void; onStart?: () => void; onOpenSettings?: () => void }) {
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
        {/* Ssh mode: the server may need its password typed again, and signing in is not required to reach Settings. */}
        {onOpenSettings ? <button type="button" className="sh-button" onClick={onOpenSettings}>Open Settings</button> : null}
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
  // Local mode only: the checkbox offers to keep the login on this computer. A hub login is never kept here.
  const localMode = getStatus?.()?.mode === "local";
  const rejectedLogin = useSyncExternalStore(subscribeSavedLoginRejected, savedLoginRejected, () => false);
  const savedNote = useSyncExternalStore(subscribeSavedLoginNote, savedLoginNote, () => null);

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
    setSavedLoginNote(null);
    // Read before the reset below. The checkbox is absent (and so unchecked) outside local mode.
    const keepSignedIn = localMode && data.get("keepSignedIn") !== null;
    try {
      if (mode === "create") {
        await client.register(email, password, displayName || undefined, ctl.signal, invite || undefined);
        setNotice("Account created. Signing in…");
      }
      if (keepSignedIn) {
        // The host signs in with the core and stores the login only when the core accepts the password. This webview
        // then adopts the verified refresh token, so the password is sent once. A keychain failure stops the sign-in
        // here (the message says to untick the box), rather than signing in without the login being kept.
        let refresh: string | null = null;
        try {
          refresh = await host.localLoginSave(email, password);
        } catch (err) {
          if (codeOf(err) !== "untrusted_core") throw err;
          // An adopted (dev) core cannot hold the login: sign in normally, and say the login was not kept.
          setSavedLoginNote(NOTE_NOT_SAVED_ADOPTED);
        }
        if (refresh) await client.restoreSession(refresh, ctl.signal);
        else await client.login(email, password, ctl.signal);
      } else {
        if (localMode) {
          // Unticked: a login saved earlier must not survive this sign-in. A failed forget is only a warning, and only
          // when the login is still saved; the sign-in itself goes on.
          let forgotten = true;
          try {
            await host.localLoginForget();
          } catch {
            forgotten = false;
          }
          if (!forgotten) {
            let stillSaved = true;
            try {
              stillSaved = (await host.localLoginStatus()).saved;
            } catch {
              stillSaved = true;
            }
            if (stillSaved) setSavedLoginNote(NOTE_FORGET_FAILED);
          }
        }
        await client.login(email, password, ctl.signal);
      }
      clearSavedLoginRejected();
      form.reset();
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof CoreError ? describeCoreErrorFor(err, getStatus ? getStatus() : null) : hostErrorText(err));
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
      <p className="sh-panel-text sh-muted">
        The account lives on the LLM-IDE core you connect to.{" "}
        {localMode
          ? "With “Keep me signed in” ticked, the email, password and session are kept in this computer's keychain and reused at every start. Untick it to sign in again each time the app starts. Signing out forgets the saved login."
          : "You sign in again each time the app starts."}
      </p>
      {savedNote ? <div role="status" className="sh-panel-text">{savedNote}</div> : null}
      {rejectedLogin && !error ? (
        <div role="status" className="sh-panel-text">Your saved login was rejected. Sign in again to update it.</div>
      ) : null}
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
        {localMode && (
          <label className="sh-field">
            <input name="keepSignedIn" type="checkbox" defaultChecked disabled={pending} />
            <span>Keep me signed in on this computer</span>
          </label>
        )}
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
