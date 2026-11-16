// Welcome → Connect to SSH server: the card that opens the connect dialog. It replaces the old entry that only linked
// to Settings. Connecting itself happens in SshConnectDialog; this card never talks to the host.
import type { ReactNode } from "react";

const HINT = "Work on a server you can sign in to with SSH. The app installs its server part in your home folder there. No domain, certificate or administrator access is needed.";

export interface SshConnectCardProps {
  onConnect: () => void;
  /** A one-line result of the last connect from the list (for example the server's name), or null. */
  notice: string | null;
}

export function SshConnectCard({ onConnect, notice }: SshConnectCardProps): ReactNode {
  return (
    <section className="wc-card wc-remote" aria-labelledby="wc-ssh-title">
      <span className="wc-card-kicker">Connect</span>
      <div className="wc-remote-head">
        <div>
          <h2 id="wc-ssh-title" className="wc-h2">Connect to SSH server</h2>
          <p className="wc-text wc-muted">{HINT}</p>
        </div>
        <button type="button" className="sh-button sh-button-primary wc-ssh-connect" onClick={onConnect}>Connect…</button>
      </div>
      {notice ? <p className="wc-ssh-notice" role="status">{notice}</p> : null}
    </section>
  );
}
