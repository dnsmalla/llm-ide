// Settings → Server & Backend → SSH server: the card's layout. Everything it shows comes from SshServerModel's state
// and the two UI-only values the card owns (the password, which confirmation is open). It holds no host answer itself.
import { useEffect, useRef, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { ErrorText, Field, Button } from "../ui.tsx";
import { SSH_FOREIGN_TEXT, sshBadgeText, type SshServerModel, type SshServerState } from "../ssh-server-model.ts";

/** Which confirmation is open, and the host it was opened for (a dialog never follows a host change). */
export interface SshDialog { kind: "stop" | "uninstall"; host: string }
import { FingerprintBlock, StopConfirm, TestSummary, UninstallConfirm } from "./SshServerParts.tsx";

const HINT = "Work on a server you can sign in to with SSH. The app installs its server part in your home folder there. No domain, certificate or administrator access is needed.";
const KEY_HINT = "Creates a key on this computer and adds it to the server so the password is not needed again.";

export interface SshServerViewProps {
  m: SshServerModel;
  s: SshServerState;
  /** Memory only: held by the card while it is mounted, never sent to the model's state. */
  password: string;
  onPassword: (value: string) => void;
  dialog: SshDialog | null;
  onDialog: (kind: SshDialog["kind"] | null) => void;
  onRestart: () => void;
}

/** The password field. It takes focus when the server asks for the password again (a reconnect after a restart). */
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

/** The live link as one line (or the error the host gave). `restart_required` is a saved change, not an error. */
function LinkLine({ s, host, onRestart }: { s: SshServerState; host: string; onRestart: () => void }): ReactNode {
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

export function SshServerView({ m, s, password, onPassword, dialog, onDialog, onRestart }: SshServerViewProps): ReactNode {
  const busy = s.busy !== null;
  const pw = password.length > 0 ? password : undefined;
  const link = s.status?.link ?? null;
  const host = (s.status?.host || s.host).trim();
  const linkUp = link === "connected" || link === "connecting" || link === "reconnecting";
  const needsPassword = link === "needs_password";
  const trusted = s.test?.trusted === true;
  // Stop and Uninstall only for a server that is installed (the last trusted test says so) or that the live link knows.
  const installed = s.test?.trusted === true && typeof s.test.installedVersion === "string";
  const serverKnown = installed || (link !== null && link !== "off");
  // A dialog counts only while it is for the host now in the form.
  const open = dialog !== null && dialog.host === s.host.trim() ? dialog.kind : null;
  const set = (field: "host" | "port" | "user" | "keyPath") => (e: { currentTarget: HTMLInputElement }) => m.setField(field, e.currentTarget.value);
  const connectBlocked = busy || !(trusted || needsPassword) || (s.auth === "password" && pw === undefined);

  return (
    <div className="st-note" role="group" aria-label="SSH server">
      <span className="st-label">SSH server</span>
      <p className="st-hint">{HINT}</p>

      <Field label="Host or IP">
        <input className="st-input" value={s.host} onChange={set("host")} placeholder="server.example.com" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.host ?? null} />
      </Field>
      <Field label="SSH port" hint="The default is 22.">
        <input className="st-input" type="number" min={1} max={65535} value={s.port} onChange={set("port")} inputMode="numeric" autoComplete="off" />
        <ErrorText text={s.fieldErrors.port ?? null} />
      </Field>
      <Field label="SSH user">
        <input className="st-input" value={s.user} onChange={set("user")} placeholder="deploy" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.user ?? null} />
      </Field>

      <div className="st-stack">
      <span className="st-label">Sign in with</span>
      <div className="st-stack" role="radiogroup" aria-label="Sign in with">
        <label className="st-row">
          <input type="radio" name="ssh-auth" value="key" checked={s.auth === "key"} onChange={() => { onPassword(""); m.setAuth("key"); }} />
          <span>Key file</span>
        </label>
        <label className="st-row">
          <input type="radio" name="ssh-auth" value="password" checked={s.auth === "password"} onChange={() => m.setAuth("password")} />
          <span>Password</span>
        </label>
      </div>
      {s.auth === "key" ? (
        <Field label="Private key path" hint="The path to your private key file. Only the path is saved; the key stays where it is.">
          <input className="st-input" value={s.keyPath} onChange={set("keyPath")} placeholder="/Users/you/.ssh/id_ed25519" autoComplete="off" spellCheck={false} />
          <ErrorText text={s.fieldErrors.keyPath ?? null} />
        </Field>
      ) : (
        <PasswordInput value={password} onChange={onPassword} focus={needsPassword} />
      )}
      </div>

      <LinkLine s={s} host={host} onRestart={onRestart} />

      {s.test !== null && !trusted ? <FingerprintBlock test={s.test} busy={busy} onTrust={() => void m.trustAndTest(pw)} /> : null}
      {s.test !== null && trusted ? <TestSummary test={s.test} /> : null}

      <div className="st-row">
        <Button disabled={busy} onClick={() => void m.test(pw)}>{s.busy === "test" ? "Testing…" : "Test"}</Button>
        {linkUp ? (
          <Button disabled={busy} onClick={() => void m.disconnect()}>Disconnect</Button>
        ) : (
          <Button tone="primary" disabled={connectBlocked} onClick={() => void m.connectWithTest(pw)}>Connect</Button>
        )}
      </div>

      {s.auth === "password" && link === "connected" ? (
        <div className="st-note">
          <div className="st-row">
            <Button disabled={busy || pw === undefined} onClick={() => { if (pw !== undefined) void m.installKey(pw); }}>Use a key from now on</Button>
            <span className="st-hint">{KEY_HINT}</span>
          </div>
          {pw === undefined ? <p className="st-hint">Enter the server password above to use this.</p> : null}
        </div>
      ) : null}

      {serverKnown ? (
        <div className="st-row">
          <Button disabled={busy} onClick={() => onDialog("stop")}>Stop server</Button>
          <Button tone="danger" disabled={busy} onClick={() => onDialog("uninstall")}>Uninstall…</Button>
        </div>
      ) : null}
      {open === "stop" ? (
        <StopConfirm
          host={s.host.trim()}
          busy={busy}
          onCancel={() => onDialog(null)}
          onConfirm={() => { onDialog(null); void m.stopServer(pw); }}
        />
      ) : null}
      {open === "uninstall" ? (
        <UninstallConfirm
          host={s.host.trim()}
          busy={busy}
          onCancel={() => onDialog(null)}
          onConfirm={(typed) => { onDialog(null); void m.uninstall(pw, typed); }}
        />
      ) : null}
      {/* The host refused a stop or uninstall because another computer started the core: only an explicit "anyway" repeats it. */}
      {s.foreign !== null ? (
        <div className="st-dialog" role="alertdialog" aria-label="Another computer started the server">
          <StatusBanner severity="warning" message={SSH_FOREIGN_TEXT} />
          <div className="st-row">
            <Button
              tone="danger"
              disabled={busy}
              onClick={() => {
                if (s.foreign === "stop") void m.stopServer(pw, { force: true });
                else if (s.foreign === "uninstall") void m.uninstall(pw, s.host.trim(), { force: true });
              }}
            >
              {s.foreign === "stop" ? "Stop it anyway" : "Uninstall anyway"}
            </Button>
            <Button disabled={busy} onClick={() => m.dismissForeign()}>Cancel</Button>
          </div>
        </div>
      ) : null}

      <ErrorText text={s.error} />
    </div>
  );
}
