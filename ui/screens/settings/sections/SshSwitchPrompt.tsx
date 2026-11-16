// Settings → SSH server, after a saved link: the switch step. Saved is not yet in use, so the app keeps its mode until the
// user confirms. Confirm saves the SSH mode and restarts; Cancel changes nothing. The Welcome dialog has its own step.
import { useState, type ReactNode } from "react";
import { Button, ErrorText } from "../ui.tsx";
import { sshServerErrorText } from "../ssh-server-model.ts";
import { switchQuestion } from "../../welcome/ssh-recent.ts";

export function SshSwitchPrompt({ host, onSwitch }: { host: string; onSwitch: () => Promise<void> }): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doSwitch = async () => {
    setSwitching(true);
    setError(null);
    try {
      await onSwitch();
    } catch (e) {
      setError(sshServerErrorText(e));
      setSwitching(false);
    }
  };
  return (
    <div className="st-note" role="status">
      <p className="st-ok">The connection works. Switch to this server to work on it in the app.</p>
      {confirming ? (
        <div className="st-note" role="alertdialog" aria-label="Switch to this server">
          <p>{switchQuestion(host)}</p>
          <div className="st-row">
            <Button tone="primary" disabled={switching} onClick={() => void doSwitch()}>Switch</Button>
            <Button disabled={switching} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="st-row">
          <Button tone="primary" disabled={switching} onClick={() => setConfirming(true)}>Switch to this server now</Button>
        </div>
      )}
      <ErrorText text={error} />
    </div>
  );
}
