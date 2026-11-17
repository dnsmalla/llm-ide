import { useEffect, useState, useSyncExternalStore } from "react";
import { describeError } from "../errors.ts";
import { useModel } from "../context.tsx";
import type { SettingsHost } from "../host.ts";
import { SecretField } from "../secret-field.ts";
import { Button, ErrorText, Field, SecretInput } from "../ui.tsx";
import {
  clearSavedLoginForgetFailed,
  savedLoginForgetFailed,
  savedLoginNote,
  subscribeSavedLoginForgetFailed,
  subscribeSavedLoginNote,
} from "../../shell/saved-login-state.ts";

/**
 * The login kept on this computer (local mode). It shows the saved email and never the password. "Change" verifies a
 * new email and password with the local core before anything is stored (the host does that). "Forget" removes the
 * saved login only; the current session stays signed in until the user signs out.
 */
export function SavedLoginRow({ host }: { host: SettingsHost }) {
  const [saved, setSaved] = useState<{ saved: boolean; email: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const password = useModel(() => new SecretField());
  // Set when sign-out could not remove the login; cleared by a successful Forget here.
  const forgetFailed = useSyncExternalStore(subscribeSavedLoginForgetFailed, savedLoginForgetFailed, () => false);
  // The last sign-in's note (not saved on an adopted core, or a login that could not be removed).
  const note = useSyncExternalStore(subscribeSavedLoginNote, savedLoginNote, () => null);

  const load = () => {
    if (!host.localLoginStatus) return;
    host.localLoginStatus().then(setSaved, (e) => setError(describeError(e)));
  };
  useEffect(() => {
    // Read on mount. AccountSection remounts this row after each sign-out, so the status is read again then.
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!host.localLoginStatus) return null;

  const change = async () => {
    if (!host.localLoginChange || busy || !email.trim()) return;
    setBusy(true);
    try {
      await host.localLoginChange(email.trim(), password.take());
      setEditing(false);
      setEmail("");
      setError(null);
      load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setResetKey((k) => k + 1);
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!host.localLoginForget || busy) return;
    setBusy(true);
    try {
      await host.localLoginForget();
      clearSavedLoginForgetFailed();
      setError(null);
      load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-stack">
      <ErrorText text={error} />
      {forgetFailed ? <p role="alert">Sign-out could not remove the saved login from this computer. Forget it below.</p> : null}
      {note ? <p role="status">{note}</p> : null}
      <p><span className="st-label">Saved login </span>{saved?.saved ? (saved.email ?? "Saved") : "Not saved"}</p>
      <div className="st-row">
        {host.localLoginChange ? <Button onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Change"}</Button> : null}
        {(saved?.saved || forgetFailed) && host.localLoginForget ? <Button tone="danger" disabled={busy} onClick={() => void forget()}>Forget</Button> : null}
      </div>
      {editing ? (
        <form className="st-stack" onSubmit={(e) => { e.preventDefault(); void change(); }}>
          <Field label="Email"><input className="st-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <SecretInput label="Password" field={password} resetKey={resetKey} />
          <div className="st-row"><Button tone="primary" disabled={busy || !email.trim()} onClick={() => void change()}>Verify and save</Button></div>
        </form>
      ) : null}
    </div>
  );
}
