import { useEffect, useState } from "react";
import { call } from "../core-api.ts";
import { decodeMe, type Me } from "../decoders.ts";
import { describeError } from "../errors.ts";
import { accountLine, SIGN_OUT_TEXT } from "../misc-model.ts";
import { SecretField } from "../secret-field.ts";
import { useEnv, useModel, useRefreshOnFocus } from "../context.tsx";
import { invokeHost } from "../../shell/host";
import { Button, ErrorText, Field, NeedsHost, SecretInput } from "../ui.tsx";

// Same text as DESKTOP_EXISTS in desktop/src-tauri/src/account_oauth.rs.
const DESKTOP_EXISTS = "This account already has a desktop.";

interface CloudAccount { signedIn: boolean; email: string | null }

function decodeCloud(v: unknown): CloudAccount {
  const r = v && typeof v === "object" ? v as Record<string, unknown> : {};
  return { signedIn: r.signed_in === true, email: typeof r.email === "string" ? r.email : null };
}

function CloudAccountCard() {
  const [status, setStatus] = useState<CloudAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offerReplace, setOfferReplace] = useState(false);
  useEffect(() => {
    let live = true;
    invokeHost<unknown>("account_status").then((v) => { if (live) setStatus(decodeCloud(v)); }, () => { if (live) setStatus({ signedIn: false, email: null }); });
    return () => { live = false; };
  }, []);
  const signIn = async () => {
    setBusy(true); setError(null);
    try { setStatus(decodeCloud(await invokeHost("account_sign_in"))); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  // replace (design 4.7) signs in again in the browser first; offered only after "already has a desktop".
  const register = async (replace: boolean) => {
    setBusy(true); setError(null); setNotice(null); setOfferReplace(false);
    try {
      setStatus(decodeCloud(await invokeHost("account_register_desktop", { replace })));
      setNotice(replace ? "This computer is now your account's desktop. Link your phones and browsers again." : "This desktop is registered with your LLM-IDE account.");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setOfferReplace(!replace && message.startsWith(DESKTOP_EXISTS));
    } finally { setBusy(false); }
  };
  const signOut = async () => {
    setBusy(true); setError(null); setNotice(null);
    try { setStatus(decodeCloud(await invokeHost("account_sign_out"))); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="st-stack" aria-label="LLM-IDE account">
      <span className="st-label">LLM-IDE account</span>
      <p className="st-hint">Link phones and browsers to this desktop. Your meetings, code and chats stay on this computer.</p>
      {error ? <ErrorText text={error} /> : null}
      {notice ? <p className="st-hint" role="status">{notice}</p> : null}
      {status === null ? <p className="st-hint" role="status">Reading the account…</p> : status.signedIn ? (
        <div className="st-stack">
          <p><span className="st-label">Signed in as </span>{status.email ?? "this account"}</p>
          <div className="st-row"><Button tone="primary" disabled={busy} onClick={() => void register(false)}>Register this desktop</Button><Button disabled={busy} onClick={() => void signOut()}>Sign out of LLM-IDE</Button></div>
          {offerReplace ? (
            <div className="st-stack">
              <p className="st-hint">Replacing signs out the old desktop and unlinks every phone and browser. You sign in with your passkey again first.</p>
              <div className="st-row"><Button tone="danger" disabled={busy} onClick={() => void register(true)}>Replace this account's desktop</Button></div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="st-row"><Button tone="primary" disabled={busy} onClick={() => void signIn()}>{busy ? "Waiting for the browser…" : "Sign in with a passkey"}</Button></div>
      )}
    </section>
  );
}

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
      <CloudAccountCard />
      <hr className="st-rule" />
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
