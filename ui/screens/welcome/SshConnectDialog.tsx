// Welcome → Connect to SSH server: the dialog over the Welcome page. It is the same SSH form as Settings, in a modal,
// plus the switch step that appears once the connection works while the app is not yet working on the server.
// The password lives in this dialog's state only: closing the dialog unmounts it, and the password goes with it.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import "../settings/settings.css";
import { Button, ErrorText } from "../settings/ui.tsx";
import { SshServerForm } from "../settings/sections/SshServerForm.tsx";
import { sshServerErrorText, type SshServerModel, type SshServerState } from "../settings/ssh-server-model.ts";
import { escapeTarget, switchQuestion } from "./ssh-recent.ts";

/** Here the password is dropped when the dialog closes, so the Settings hint ("kept until you quit") would be wrong. */
const DIALOG_PASSWORD_HINT = "Used only for this connection. It is never saved.";

export interface SwitchStepProps {
  host: string;
  confirming: boolean;
  switching: boolean;
  switchError: string | null;
  onAsk: () => void;
  onCancel: () => void;
  onSwitch: () => void;
  /**
   * Focus targets. A button that unmounts takes the focus with it, and then Escape never reaches the dialog. So
   * focus moves to these containers, which stay mounted while their step is shown.
   */
  askRef?: RefObject<HTMLDivElement | null> | null;
  confirmRef?: RefObject<HTMLDivElement | null> | null;
}

/**
 * The switch step: a button, then the confirmation. Only the confirmation's Switch restarts the app; pressing the
 * button alone changes nothing on this computer.
 */
export function SwitchStep({ host, confirming, switching, switchError, onAsk, onCancel, onSwitch, askRef, confirmRef }: SwitchStepProps): ReactNode {
  return (
    <div className="st-note" role="status">
      <p className="st-ok">The connection works. Switch to this server to work on it in the app.</p>
      {confirming ? (
        <div ref={confirmRef ?? undefined} tabIndex={-1} className="st-note" role="alertdialog" aria-label="Switch to this server">
          <p>{switchQuestion(host)}</p>
          <div className="st-row">
            <Button tone="primary" disabled={switching} onClick={onSwitch}>Switch</Button>
            <Button disabled={switching} onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div ref={askRef ?? undefined} tabIndex={-1} className="st-row">
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
  askRef?: RefObject<HTMLDivElement | null> | null;
  confirmRef?: RefObject<HTMLDivElement | null> | null;
}

export function SshConnectDialogView(p: SshConnectDialogViewProps): ReactNode {
  // While the switch is offered, Test and Connect are off: a second connect would start under the question.
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
            passwordHint={DIALOG_PASSWORD_HINT}
            disableActions={restart}
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
              askRef={p.askRef}
              confirmRef={p.confirmRef}
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
  const askRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  // The dialog takes focus when it opens, except for a password server: there the form focuses the password field.
  // It takes focus again after Edit details, which unmounts the link that had it.
  useEffect(() => {
    if (!readOnly) cardRef.current?.focus();
  }, [readOnly]);
  // Focus follows the switch step: the button that opened the confirmation goes away, so the confirmation takes focus,
  // and Cancel hands it back to the button. The ref check keeps the first render (and a strict-mode re-run) out of it.
  const shownConfirming = useRef(confirming);
  useEffect(() => {
    if (shownConfirming.current === confirming) return;
    shownConfirming.current = confirming;
    (confirming ? confirmRef : askRef).current?.focus();
  }, [confirming]);
  const doSwitch = async () => {
    // Focus leaves the Switch button before it is disabled, so it stays on the confirmation.
    confirmRef.current?.focus();
    setSwitching(true);
    setSwitchError(null);
    try {
      await onSwitch();
    } catch (e) {
      setSwitchError(sshServerErrorText(e));
      setSwitching(false);
      confirmRef.current?.focus();
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
        // A switch that is running finishes on its own: Escape must not take its confirmation away mid-restart.
        if (switching) return;
        if (escapeTarget(confirming) === "confirmation") setConfirming(false);
        else onClose();
      }}
      cardRef={cardRef}
      askRef={askRef}
      confirmRef={confirmRef}
    />
  );
}
