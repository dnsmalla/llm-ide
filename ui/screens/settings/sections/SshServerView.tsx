// Settings → Server & Backend → SSH server: the card's layout. The fields, the sign-in method, the link line, the
// fingerprint and Test / Connect come from SshServerForm (shared with the Welcome dialog). This view adds only what
// managing the server needs: Disconnect, the key switch, Stop and Uninstall, and the foreign-core prompt.
// Everything it shows comes from SshServerModel's state and the two UI-only values the card owns (the password, which
// confirmation is open). It holds no host answer itself.
import type { ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Button } from "../ui.tsx";
import { SSH_FOREIGN_TEXT, type SshServerModel, type SshServerState } from "../ssh-server-model.ts";
import { StopConfirm, UninstallConfirm } from "./SshServerParts.tsx";
import { SshServerForm } from "./SshServerForm.tsx";

/** Which confirmation is open, and the host it was opened for (a dialog never follows a host change). */
export interface SshDialog { kind: "stop" | "uninstall"; host: string }

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
  onSwitch: () => Promise<void>;
}

export function SshServerView({ m, s, password, onPassword, dialog, onDialog, onSwitch }: SshServerViewProps): ReactNode {
  const busy = s.busy !== null;
  const pw = password.length > 0 ? password : undefined;
  const link = s.status?.link ?? null;
  // Stop and Uninstall only for a server that is installed (the last trusted test says so) or that the live link knows.
  const installed = s.test?.trusted === true && typeof s.test.installedVersion === "string";
  const serverKnown = installed || (link !== null && link !== "off");
  // A dialog counts only while it is for the host now in the form.
  const open = dialog !== null && dialog.host === s.host.trim() ? dialog.kind : null;

  return (
    <div className="st-note" role="group" aria-label="SSH server">
      <span className="st-label">SSH server</span>
      <p className="st-hint">{HINT}</p>

      <SshServerForm
        m={m}
        s={s}
        password={password}
        onPassword={onPassword}
        onSwitch={onSwitch}
        linkActions={<Button disabled={busy} onClick={() => void m.disconnect()}>Disconnect</Button>}
      />

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
      {s.foreign === "stop" || s.foreign === "uninstall" ? (
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
    </div>
  );
}
