import { useEffect, useState } from "react";
import { call } from "../core-api.ts";
import { decodeMe, type Me } from "../decoders.ts";
import { describeError } from "../errors.ts";
import { accountLine, SIGN_OUT_TEXT } from "../misc-model.ts";
import { SecretField } from "../secret-field.ts";
import { useEnv, useModel, useRefreshOnFocus } from "../context.tsx";
import { mintPin } from "./HostApiPairing.tsx";
import { invokeHost } from "../../shell/host";
import { Button, ErrorText, Field, NeedsHost, SecretInput } from "../ui.tsx";

// Same text as DESKTOP_EXISTS in desktop/src-tauri/src/account_oauth.rs.
const DESKTOP_EXISTS = "This account already has a desktop.";

interface CloudAccount { signedIn: boolean; email: string | null }

function decodeCloud(v: unknown): CloudAccount {
  const r = v && typeof v === "object" ? v as Record<string, unknown> : {};
  return { signedIn: r.signed_in === true, email: typeof r.email === "string" ? r.email : null };
}


interface LinkRequest {
  requestId: string;
  state: string;
  kind: string;
  label: string;
  sas: string | null;
  commitmentOk: boolean | null;
}

function decodeLinkRequests(v: unknown): LinkRequest[] {
  const array = Array.isArray(v) ? v : [];
  return array.flatMap((raw) => {
    const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof r.requestId !== "string" || typeof r.state !== "string") return [];
    return [{
      requestId: r.requestId,
      state: r.state,
      kind: typeof r.kind === "string" ? r.kind : "device",
      label: typeof r.label === "string" ? r.label : "Device",
      sas: typeof r.sas === "string" ? r.sas : null,
      commitmentOk: typeof r.commitmentOk === "boolean" ? r.commitmentOk : null,
    }];
  });
}

function LinkRequests() {
  const { client } = useEnv();
  const [requests, setRequests] = useState<LinkRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    invokeHost<unknown>("account_link_requests").then((v) => { setRequests(decodeLinkRequests(v)); setError(null); },
      (e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, []);
  const act = async (request: LinkRequest, action: "approve" | "deny" | "confirm") => {
    setBusy(`${request.requestId}:${action}`); setError(null);
    try {
      if (action === "confirm") {
        const { pin } = await mintPin(client);
        await invokeHost("account_link_confirm", { requestId: request.requestId, sas: request.sas, pin });
      } else {
        await invokeHost(`account_link_${action}`, { requestId: request.requestId });
      }
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  if (error) return <ErrorText text={error} />;
  if (requests.length === 0) return <p className="st-hint">No phone or browser is waiting to link.</p>;
  return (
    <div className="st-stack" aria-live="polite">
      {requests.map((r) => (
        <div className="st-dialog" key={r.requestId} aria-label={`Link request from ${r.label}`}>
          <strong>{r.label}</strong> <span className="st-hint">wants to link as {r.kind}</span>
          {r.commitmentOk === false ? <ErrorText text="The device's keys do not match its commitment. Deny this request." /> : null}
          {r.state === "keys" && r.sas ? (
            <>
              <p className="st-hint">Compare this code with the one shown on the device. Only confirm if they match.</p>
              <p className="link-sas" style={{ fontSize: 24, letterSpacing: ".2em", fontWeight: 700 }}>{r.sas}</p>
            </>
          ) : r.state === "approved" ? <p className="st-hint">Waiting for the device's keys…</p> : <p className="st-hint">Approve only if you started this link.</p>}
          <div className="st-row">
            {r.state === "pending" ? <Button tone="primary" disabled={busy !== null} onClick={() => void act(r, "approve")}>Allow</Button> : null}
            {r.state === "keys" && r.commitmentOk ? <Button tone="primary" disabled={busy !== null} onClick={() => void act(r, "confirm")}>Codes match — confirm</Button> : null}
            {r.state !== "keys" ? <Button disabled={busy !== null} onClick={() => void act(r, "deny")}>Deny</Button> : <Button disabled={busy !== null} onClick={() => void act(r, "deny")}>Deny</Button>}
          </div>
        </div>
      ))}
    </div>
  );
}


function RelayCard() {
  const [status, setStatus] = useState<{ connected: boolean; devicesOnline: number; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    invokeHost<unknown>("relay_status").then((v) => {
      const r = v && typeof v === "object" ? v as Record<string, unknown> : {};
      setStatus({ connected: r.connected === true, devicesOnline: typeof r.devicesOnline === "number" ? r.devicesOnline : 0, enabled: r.enabled === true });
    }, () => setStatus({ connected: false, devicesOnline: 0, enabled: false }));
  }, []);
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError(null);
    try {
      const v = await invokeHost<unknown>("relay_set_enabled", { enabled });
      const r = v && typeof v === "object" ? v as Record<string, unknown> : {};
      setStatus({ connected: r.connected === true, devicesOnline: typeof r.devicesOnline === "number" ? r.devicesOnline : 0, enabled: r.enabled === true });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="st-stack">
      <span className="st-label">Relay</span>
      <p className="st-hint">Carry ciphertext between this desktop and your linked devices. Off means no outbound relay connection.</p>
      {error ? <ErrorText text={error} /> : null}
      <div className="st-row">
        <Button tone={status?.connected ? "danger" : "primary"} disabled={busy} onClick={() => void toggle(!(status?.enabled ?? false))}>
          {status?.enabled ? "Turn off relay" : "Turn on relay"}
        </Button>
        {status?.connected ? <span className="st-hint">{status.devicesOnline} device{status.devicesOnline === 1 ? "" : "s"} online</span> : null}
      </div>
    </div>
  );
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
          <div className="st-stack"><span className="st-label">Device linking</span><LinkRequests /></div>
          <RelayCard />
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
