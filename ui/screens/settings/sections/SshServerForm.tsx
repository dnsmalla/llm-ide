// The SSH server form, shared by the Settings card and the Welcome connect dialog so the two cannot drift: the fields,
// the sign-in method, the password (and its optional Keychain checkbox), the live link line, the host-key fingerprint,
// the progress of the one Connect button and the take-over question. A caller adds what only it needs (Settings:
// Disconnect, Stop, Uninstall; Welcome: the switch step). Nothing here knows which caller shows it. The password is a
// prop from the caller's memory; it is never stored in the model.
import { useEffect, useRef, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { ErrorText, Field, Button } from "../ui.tsx";
import { SSH_TAKE_OVER_TEXT, sshBadgeText, sshBundleBlock, type SshServerModel, type SshServerState } from "../ssh-server-model.ts";
import type { SshServerStatus } from "../host.ts";
import { FingerprintBlock, TestSummary } from "./SshServerParts.tsx";
import { SshSwitchPrompt } from "./SshSwitchPrompt.tsx";

export interface SshServerFormProps {
  m: SshServerModel;
  s: SshServerState;
  /** Memory only: held by the caller while it is mounted. */
  password: string;
  onPassword: (value: string) => void;
  /** The Welcome dialog for a remembered server: the saved fields show read-only. */
  readOnly?: boolean;
  /** Focus the password field when the form opens (a password server from the Welcome list). */
  focusPassword?: boolean;
  /** The confirmed switch to the SSH server (save the mode, restart). Shown only for a saved link that waits for it. */
  onSwitch?: () => Promise<void>;
  /** Called after a Connect that attached the link, so the caller can close itself. */
  onConnected?: () => void;
  /** Called after a Connect that saved the server but needs the app to restart to use it (the Welcome dialog switches). */
  onRestartRequired?: () => void;
  /** Takes the place of Connect while the link is up (Settings shows Disconnect there). */
  linkActions?: ReactNode;
  /** Connect is off while the caller needs an answer first (the Welcome switch confirmation). */
  disableActions?: boolean;
}

/** What the password hint says for each state of the Keychain checkbox. Both callers show the same words. */
export const PASSWORD_HINT_NOT_SAVED = "Used for this connection only. It is not saved unless you tick the box below.";
export const PASSWORD_HINT_SAVED = "Saved in the Keychain on this computer after a good sign-in. App files never hold it.";
export const PASSWORD_HINT_STORED = "The saved password is used when this field is empty. Type one to replace it.";
export const PASSWORD_HINT_REMOVE = "The saved password is removed from the Keychain when you connect.";
export const REMEMBER_PASSWORD_LABEL = "Remember password in Keychain";

/** One plain line for the step Connect is on, or null when it is idle. */
export function connectStepText(s: Pick<SshServerState, "busy" | "test">): string | null {
  if (s.busy === "test") return "Checking the server…";
  if (s.busy === "confirm") return "Trusting the host key…";
  if (s.busy !== "connect") return null;
  // The host runs install, start and connect as one call, so this is one step; the probe says which work it holds.
  return s.test?.installedVersion ? "Updating the server part if needed, starting it and connecting…" : "Installing the server part, starting it and connecting…";
}

/** The question after Connect found a server part this desktop did not start. Only the Take over click repeats it. */
function TakeOverPrompt({ busy, onTakeOver, onCancel }: { busy: boolean; onTakeOver: () => void; onCancel: () => void }): ReactNode {
  return (
    <div className="st-dialog" role="alertdialog" aria-label="Take over the running server part">
      <StatusBanner severity="warning" message={SSH_TAKE_OVER_TEXT} />
      <div className="st-row">
        <Button tone="danger" disabled={busy} onClick={onTakeOver}>Take over</Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** The password field. It takes focus when the server asks for the password again, or when the caller asks for it. */
function PasswordInput({ value, onChange, focus, hint, placeholder }: { value: string; onChange: (v: string) => void; focus: boolean; hint: string; placeholder?: string }): ReactNode {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <Field label="Password" hint={hint}>
      <input
        ref={ref}
        className="st-input"
        type="password"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={focus}
      />
    </Field>
  );
}

/**
 * The live link as one line (or the error the host gave). `restart_required` is a saved change, not an error: the
 * Settings card offers the switch here; the Welcome dialog has no `onSwitch` and shows its own switch step.
 */
function LinkLine({ s, host, onSwitch }: { s: SshServerState; host: string; onSwitch?: () => Promise<void> }): ReactNode {
  const link = s.status?.link ?? null;
  switch (link) {
    case "connected":
      return <div className="st-row"><span className="st-status" data-tone="ok" role="status">{sshBadgeText("connected", host)}</span></div>;
    case "reconnecting":
      return <div className="st-row"><span className="st-status" data-tone="warning" role="status">{sshBadgeText("reconnecting", host)}</span></div>;
    case "connecting":
      return <p className="st-hint" role="status">Connecting…</p>;
    case "needs_password":
      return <p className="st-hint" role="status">{`Enter the password to reconnect to ${host}.`}</p>;
    case "stopped":
      return <p className="st-hint" role="status">The server part is stopped. Connect to use it again.</p>;
    case "failed":
      return <ErrorText text={s.status?.error ?? "The SSH connection could not be opened."} />;
    case "restart_required":
      if (!onSwitch) return null;
      return <SshSwitchPrompt host={host} onSwitch={onSwitch} />;
    default:
      return null;
  }
}

export function SshServerForm({ m, s, password, onPassword, readOnly = false, focusPassword = false, onSwitch, onConnected, onRestartRequired, linkActions, disableActions = false }: SshServerFormProps): ReactNode {
  const noBundle = sshBundleBlock(s.status);
  const busy = s.busy !== null;
  const pw = password.length > 0 ? password : undefined;
  const link = s.status?.link ?? null;
  const host = (s.status?.host || s.host).trim();
  const linkUp = link === "connected" || link === "connecting" || link === "reconnecting";
  const needsPassword = link === "needs_password";
  const trusted = s.test?.trusted === true;
  const set = (field: "host" | "port" | "user" | "keyPath") => (e: { currentTarget: HTMLInputElement }) => m.setField(field, e.currentTarget.value);
  // One Connect: it checks the server, connects and (for a new key) asks for the host-key click on the way. A password
  // login needs a typed password or a stored one.
  const connectBlocked = busy || (s.auth === "password" && pw === undefined && !s.passwordSaved);
  const finish = (status: SshServerStatus | null) => {
    // A Keychain warning stays on screen: the caller's next step (close, restart) would hide it before it is read.
    if (status?.warning) return;
    if (status?.link === "connected") onConnected?.();
    else if (status?.link === "restart_required") onRestartRequired?.();
  };
  const connect = async () => finish(await m.connectWithTest(pw));
  const takeOver = async () => finish(await m.connectWithTest(pw, { takeOver: true }));
  const step = connectStepText(s);
  const passwordHint = s.rememberPassword
    ? (s.passwordSaved ? PASSWORD_HINT_STORED : PASSWORD_HINT_SAVED)
    : (s.passwordSaved ? PASSWORD_HINT_REMOVE : PASSWORD_HINT_NOT_SAVED);

  return (
    <>
      <Field label="Host or IP">
        <input className="st-input" value={s.host} onChange={set("host")} readOnly={readOnly} placeholder="server.example.com" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.host ?? null} />
      </Field>
      <Field label="SSH port" hint="The default is 22.">
        <input className="st-input" type="number" min={1} max={65535} value={s.port} onChange={set("port")} readOnly={readOnly} inputMode="numeric" autoComplete="off" />
        <ErrorText text={s.fieldErrors.port ?? null} />
      </Field>
      <Field label="SSH user">
        <input className="st-input" value={s.user} onChange={set("user")} readOnly={readOnly} placeholder="deploy" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.user ?? null} />
      </Field>

      <div className="st-stack">
        <span className="st-label">Sign in with</span>
        <div className="st-stack" role="radiogroup" aria-label="Sign in with">
          <label className="st-row">
            <input type="radio" name="ssh-auth" value="key" checked={s.auth === "key"} disabled={readOnly} onChange={() => { onPassword(""); m.setAuth("key"); }} />
            <span>Key file</span>
          </label>
          <label className="st-row">
            <input type="radio" name="ssh-auth" value="password" checked={s.auth === "password"} disabled={readOnly} onChange={() => m.setAuth("password")} />
            <span>Password</span>
          </label>
        </div>
        {s.auth === "key" ? (
          <Field label="Private key path" hint="The path to your private key file. Only the path is saved; the key stays where it is.">
            <input className="st-input" value={s.keyPath} onChange={set("keyPath")} readOnly={readOnly} placeholder="/Users/you/.ssh/id_ed25519" autoComplete="off" spellCheck={false} />
            <ErrorText text={s.fieldErrors.keyPath ?? null} />
          </Field>
        ) : (
          <>
            <PasswordInput
              value={password}
              onChange={onPassword}
              focus={needsPassword || focusPassword}
              hint={passwordHint}
              placeholder={s.passwordSaved ? "Saved in Keychain" : undefined}
            />
            <label className="st-row">
              <input type="checkbox" checked={s.rememberPassword} onChange={(e) => m.setRemember(e.currentTarget.checked)} />
              <span>{REMEMBER_PASSWORD_LABEL}</span>
            </label>
          </>
        )}
      </div>

      <LinkLine s={s} host={host} onSwitch={onSwitch} />

      {s.test !== null && !trusted ? <FingerprintBlock test={s.test} busy={busy} onTrust={() => void m.trustAndConnect(pw).then(finish)} /> : null}
      {/* The facts show as soon as the probe returns (the trust step alone carries none). */}
      {s.test !== null && trusted && s.test.os !== null ? <TestSummary test={s.test} /> : null}
      {step !== null ? <p className="st-hint" role="status">{step}</p> : null}
      {s.status?.warning ? <p className="st-hint" role="status" data-tone="warning">{s.status.warning}</p> : null}
      {s.foreign === "connect" ? <TakeOverPrompt busy={busy} onTakeOver={() => void takeOver()} onCancel={() => m.dismissForeign()} /> : null}

      {noBundle !== null ? <p className="st-hint" role="status">{noBundle}</p> : null}
      <div className="st-row">
        {linkUp ? linkActions : <Button tone="primary" disabled={connectBlocked || disableActions || noBundle !== null} onClick={() => void connect()}>Connect</Button>}
      </div>

      <ErrorText text={s.error} />
    </>
  );
}
