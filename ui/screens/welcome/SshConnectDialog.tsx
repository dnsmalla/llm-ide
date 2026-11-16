// Welcome → Connect to SSH server: the dialog over the Welcome page. It is the same SSH form as Settings, in a modal,
// plus the switch step that appears once the connection works while the app is not yet working on the server.
// The password lives in this dialog's state only: closing the dialog unmounts it, and the password goes with it.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import "../settings/settings.css";
import { Button, ErrorText } from "../settings/ui.tsx";
import { SshServerForm } from "../settings/sections/SshServerForm.tsx";
import { sshServerErrorText, type SshServerModel, type SshServerState } from "../settings/ssh-server-model.ts";
import { switchQuestion } from "./ssh-recent.ts";

export interface SwitchStepProps {
  host: string;
  confirming: boolean;
  switching: boolean;
  switchError: string | null;
  onAsk: () => void;
  onCancel: () => void;
  onSwitch: () => void;
}

/**
 * The switch step: a button, then the confirmation. Only the confirmation's Switch restarts the app; pressing the
 * button alone changes nothing on this computer.
 */
export function SwitchStep({ host, confirming, switching, switchError, onAsk, onCancel, onSwitch }: SwitchStepProps): ReactNode {
  return (
    <div className="st-note" role="status">
      <p className="st-ok">The connection works. Switch to this server to work on it in the app.</p>
      {confirming ? (
        <div className="st-note" role="alertdialog" aria-label="Switch to this server">
          <p>{switchQuestion(host)}</p>
          <div className="st-row">
            <Button tone="primary" disabled={switching} onClick={onSwitch}>Switch</Button>
            <Button disabled={switching} onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="st-row">
          <Button tone="primary" disabled={switching} onClick={onAsk}>Switch to this server now</Button>
        </div>
      )}
      <ErrorText text={switchError} />
    </div>
  );
}

export interface SshConnectDialogViewProps {
  m: SshServerModel;
  s: SshServerState;
  password: string;
  onPassword: (value: string) => void;
  /** A remembered server opened for its password: the saved fields show read-only until "Edit details". */
  readOnly: boolean;
  onEditDetails: () => void;
  /** Focus goes to the password field (a password server from the list). */
  passwordOnly: boolean;
  confirming: boolean;
  switching: boolean;
  switchError: string | null;
  onAskSwitch: () => void;
  onCancelSwitch: () => void;
  onSwitch: () => void;
  onClose: () => void;
  onConnected: () => void;
  /** Escape: the wrapper decides whether it closes the switch confirmation or the dialog. */
  onEscape: () => void;
  cardRef: RefObject<HTMLDivElement | null> | null;
}

export function SshConnectDialogView(p: SshConnectDialogViewProps): ReactNode {
  const restart = p.s.status?.link === "restart_required";
  const host = (p.s.status?.host || p.s.host).trim();
  return (
    <div className="wc-modal">
      <div
        className="wc-modal-card wc-ssh-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wc-ssh-dialog-title"
        tabIndex={-1}
        ref={p.cardRef ?? undefined}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          p.onEscape();
        }}
      >
        <div className="wc-modal-head">
          <h2 id="wc-ssh-dialog-title" className="wc-h2">Connect to SSH server</h2>
        </div>
        <div className="wc-modal-body st-root wc-ssh-form">
          {p.readOnly ? (
            <p className="wc-text wc-muted">
              Only the password is needed. <button type="button" className="wc-link" onClick={p.onEditDetails}>Edit details</button>
            </p>
          ) : null}
          <SshServerForm
            m={p.m}
            s={p.s}
            password={p.password}
            onPassword={p.onPassword}
            readOnly={p.readOnly}
            focusPassword={p.passwordOnly}
            onConnected={p.onConnected}
          />
          {restart ? (
            <SwitchStep
              host={host}
              confirming={p.confirming}
              switching={p.switching}
              switchError={p.switchError}
              onAsk={p.onAskSwitch}
              onCancel={p.onCancelSwitch}
              onSwitch={p.onSwitch}
            />
          ) : null}
        </div>
        <div className="wc-modal-foot st-root wc-ssh-foot">
          <Button onClick={p.onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

export interface SshConnectDialogProps {
  m: SshServerModel;
  s: SshServerState;
  passwordOnly: boolean;
  onClose: () => void;
  onConnected: () => void;
  /** Restarts the app to work on the server. Called only after the user confirms the switch. */
  onSwitch: () => Promise<void>;
}

export function SshConnectDialog({ m, s, passwordOnly, onClose, onConnected, onSwitch }: SshConnectDialogProps): ReactNode {
  const [password, setPassword] = useState("");
  const [readOnly, setReadOnly] = useState(passwordOnly);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // For a password server the form focuses the password field; otherwise the dialog takes focus so Escape works at once.
  useEffect(() => {
    if (!passwordOnly) cardRef.current?.focus();
  }, [passwordOnly]);
  const doSwitch = async () => {
    setSwitching(true);
    setSwitchError(null);
    try {
      await onSwitch();
    } catch (e) {
      setSwitchError(sshServerErrorText(e));
      setSwitching(false);
    }
  };
  return (
    <SshConnectDialogView
      m={m}
      s={s}
      password={password}
      onPassword={setPassword}
      readOnly={readOnly}
      onEditDetails={() => setReadOnly(false)}
      passwordOnly={passwordOnly}
      confirming={confirming}
      switching={switching}
      switchError={switchError}
      onAskSwitch={() => setConfirming(true)}
      onCancelSwitch={() => setConfirming(false)}
      onSwitch={() => void doSwitch()}
      onClose={onClose}
      onConnected={onConnected}
      onEscape={() => {
        if (confirming) setConfirming(false);
        else onClose();
      }}
      cardRef={cardRef}
    />
  );
}
