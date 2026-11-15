// Welcome → SSH server: the entry to the SSH server set-up. The set-up itself lives in Settings → Server & Backend, so
// this card only opens that page; it never connects or installs anything on its own.
import { shellBus } from "../shell/bus";

/** Where "Set up" leads: the Server & Backend group, scrolled to its server card. */
export const SSH_SETUP_TARGET = { section: "settings", anchor: "server" } as const;

export function SshServerEntry() {
  return (
    <section className="wc-card wc-remote" aria-labelledby="wc-ssh-title">
      <span className="wc-card-kicker">Connect</span>
      <div className="wc-remote-head">
        <div>
          <h2 id="wc-ssh-title" className="wc-h2">SSH server</h2>
          <p className="wc-text wc-muted">Work on a server you can sign in to with SSH. The app installs its server part in your home folder there. No domain, certificate or administrator access is needed.</p>
        </div>
        <button type="button" className="sh-button sh-button-primary" onClick={() => shellBus.publish({ type: "goto-section", ...SSH_SETUP_TARGET })}>Set up</button>
      </div>
    </section>
  );
}
