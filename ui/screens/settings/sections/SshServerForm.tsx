// The SSH server form, shared by the Settings card and the Welcome connect dialog so the two cannot drift: the fields,
// the sign-in method, the password, the live link line, the host-key fingerprint and the Test / Connect row. A caller
// adds what only it needs (Settings: Disconnect, Stop, Uninstall; Welcome: the switch step). Nothing here knows which
// caller shows it. The password is a prop from the caller's memory; it is never stored in the model.
import { useEffect, useRef, type ReactNode } from "react";
import { ErrorText, Field, Button } from "../ui.tsx";
import { sshBadgeText, type SshServerModel, type SshServerState } from "../ssh-server-model.ts";
import { FingerprintBlock, TestSummary } from "./SshServerParts.tsx";

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
  /** Settings only: a saved change needs a restart. The Welcome dialog shows its own switch step instead. */
  onRestart?: () => void;
  /** Called after a Connect that attached the link, so the caller can close itself. */
  onConnected?: () => void;
  /** Takes the place of Connect while the link is up (Settings shows Disconnect there). */
  linkActions?: ReactNode;
}

/** The password field. It takes focus when the server asks for the password again, or when the caller asks for it. */
function PasswordInput({ value, onChange, focus }: { value: string; onChange: (v: string) => void; focus: boolean }): ReactNode {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <Field label="Password" hint="Kept only until you quit the app. It is never saved.">
      <input
        ref={ref}
        className="st-input"
        type="password"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
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
 * Settings card offers the restart here; the Welcome dialog has no `onRestart` and shows its own switch step.
 */
function LinkLine({ s, host, onRestart }: { s: SshServerState; host: string; onRestart?: () => void }): ReactNode {
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
      if (!onRestart) return null;
      return (
        <div className="st-note">
          <p className="st-ok" role="status">Saved. Restart the app to switch to this server.</p>
          <div className="st-row">
            <Button onClick={onRestart}>Restart the app</Button>
          </div>
        </div>
      );
    default:
      return null;
  }
}

export function SshServerForm({ m, s, password, onPassword, readOnly = false, focusPassword = false, onRestart, onConnected, linkActions }: SshServerFormProps): ReactNode {
  const busy = s.busy !== null;
  const pw = password.length > 0 ? password : undefined;
  const link = s.status?.link ?? null;
  const host = (s.status?.host || s.host).trim();
  const linkUp = link === "connected" || link === "connecting" || link === "reconnecting";
  const needsPassword = link === "needs_password";
  const trusted = s.test?.trusted === true;
  const set = (field: "host" | "port" | "user" | "keyPath") => (e: { currentTarget: HTMLInputElement }) => m.setField(field, e.currentTarget.value);
  // Connect needs a trusted host key from the last test (or a password the server asks for again).
  const connectBlocked = busy || !(trusted || needsPassword) || (s.auth === "password" && pw === undefined);
  const connect = async () => {
    const status = await m.connectWithTest(pw);
    if (status?.link === "connected") onConnected?.();
  };

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
          <PasswordInput value={password} onChange={onPassword} focus={needsPassword || focusPassword} />
        )}
      </div>

      <LinkLine s={s} host={host} onRestart={onRestart} />

      {s.test !== null && !trusted ? <FingerprintBlock test={s.test} busy={busy} onTrust={() => void m.trustAndTest(pw)} /> : null}
      {s.test !== null && trusted ? <TestSummary test={s.test} /> : null}

      <div className="st-row">
        <Button disabled={busy} onClick={() => void m.test(pw)}>{s.busy === "test" ? "Testing…" : "Test"}</Button>
        {linkUp ? linkActions : <Button tone="primary" disabled={connectBlocked} onClick={() => void connect()}>Connect</Button>}
      </div>

      <ErrorText text={s.error} />
    </>
  );
}
