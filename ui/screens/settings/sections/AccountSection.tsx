import { useState } from "react";
import { call } from "../core-api.ts";
import { decodeMe, type Me } from "../decoders.ts";
import { describeError } from "../errors.ts";
import { accountLine, SIGN_OUT_TEXT } from "../misc-model.ts";
import { SecretField } from "../secret-field.ts";
import { useEnv, useModel, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText, Field, NeedsHost, SecretInput } from "../ui.tsx";

export default function AccountSection() {
  const { client, host } = useEnv();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [confirmOut, setConfirmOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const password = useModel(() => new SecretField());

  const load = () => {
    call(client, "GET", "/auth/me").then((b) => { setMe(decodeMe(b)); setError(null); }, (e) => { setMe(null); setError(e && (e as { status?: number }).status === 401 ? null : describeError(e)); });
  };
  useRefreshOnFocus(load);

  const signIn = async () => {
    if (!host.signIn || busy) return;
    setBusy(true);
    try {
      await host.signIn(email.trim(), password.take());
      setResetKey((k) => k + 1);
      setError(null);
      load();
    } catch (e) {
      setResetKey((k) => k + 1);
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setConfirmOut(false);
    try {
      await host.signOut?.();
      setMe(null);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="st-stack">
      <ErrorText text={error} />
      <p><span className="st-label">Account </span>{accountLine(me)}</p>
      {me ? (
        <>
          {host.signOut ? <Button tone="danger" onClick={() => setConfirmOut(true)}>Sign out...</Button> : <NeedsHost what="Signing out" />}
          {confirmOut ? (
            <div className="st-dialog" role="alertdialog" aria-label={SIGN_OUT_TEXT.title}>
              <strong>{SIGN_OUT_TEXT.title}</strong>
              <p>{SIGN_OUT_TEXT.message}</p>
              <div className="st-row"><Button tone="danger" onClick={() => void signOut()}>Sign out</Button><Button onClick={() => setConfirmOut(false)}>Cancel</Button></div>
            </div>
          ) : null}
        </>
      ) : host.signIn ? (
        <form className="st-stack" onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
          <Field label="Email"><input className="st-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <SecretInput label="Password" field={password} resetKey={resetKey} />
          <div className="st-row"><Button tone="primary" disabled={busy || !email.trim()} onClick={() => void signIn()}>Sign in</Button></div>
        </form>
      ) : <NeedsHost what="Signing in" />}
    </div>
  );
}
