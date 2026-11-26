// Welcome → Recent SSH servers: one row per saved login, with Connect and a small menu (Edit, Forget). The view is a
// plain function over props so it can be rendered and tested; the wrapper only keeps which menu or confirmation is
// open. The list renders nothing when there are no servers, so an older host without the command shows no section.
import { useState, type ReactNode } from "react";
import { InlineConfirm } from "@llmide/ui-kit";
import { sshServerErrorText, type SshRecentServer } from "../settings/ssh-server-model.ts";
import { forgetQuestion, recentKey, type RowMessage } from "./ssh-recent.ts";

export interface RecentSshServersViewProps {
  servers: SshRecentServer[];
  busy: boolean;
  message: RowMessage | null;
  menuKey: string | null;
  forgetKey: string | null;
  forgetError: { key: string; text: string } | null;
  onToggleMenu: (key: string | null) => void;
  onAskForget: (key: string) => void;
  onCancelForget: () => void;
  onForget: (entry: SshRecentServer) => void;
  onEdit: (entry: SshRecentServer) => void;
  onConnect: (entry: SshRecentServer) => void;
}

export function RecentSshServersView(p: RecentSshServersViewProps): ReactNode {
  if (p.servers.length === 0) return null;
  return (
    <section className="wc-ssh-recent" aria-labelledby="wc-ssh-recent-title">
      <div className="wc-recents-head">
        <h2 id="wc-ssh-recent-title" className="wc-eyebrow">Recent SSH servers</h2>
        <span className="wc-muted">{p.servers.length}</span>
      </div>
      <ul className="wc-ssh-recent-list">
        {p.servers.map((e) => {
          const key = recentKey(e);
          const menuOpen = p.menuKey === key;
          const asking = p.forgetKey === key;
          const message = p.message?.key === key ? p.message : null;
          const error = p.forgetError?.key === key ? p.forgetError.text : null;
          return (
            <li key={key} className="wc-ssh-row" data-auth={e.auth}>
              <div className="wc-ssh-row-main">
                <span className="wc-ssh-name">{key}</span>
                <span className="wc-ssh-auth">{e.auth === "key" ? "Key file" : e.passwordSaved ? "Password (in Keychain)" : "Password"}</span>
              </div>
              <div className="wc-ssh-row-actions">
                <button type="button" className="sh-button sh-button-primary" disabled={p.busy} onClick={() => p.onConnect(e)}>Connect</button>
                <button
                  type="button"
                  className="sh-button wc-ssh-more"
                  disabled={p.busy}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={`More actions for ${key}`}
                  onClick={() => p.onToggleMenu(menuOpen ? null : key)}
                >
                  ⋯
                </button>
              </div>
              {menuOpen ? (
                <div className="wc-ssh-menu" role="menu">
                  <button type="button" role="menuitem" className="sh-button" disabled={p.busy} onClick={() => { p.onToggleMenu(null); p.onEdit(e); }}>Edit</button>
                  <button type="button" role="menuitem" className="sh-button" disabled={p.busy} onClick={() => p.onAskForget(key)}>Forget</button>
                </div>
              ) : null}
              {asking ? (
                <InlineConfirm label={`Forget ${key}`} className="wc-ssh-confirm">
                  <p>{forgetQuestion(e)}</p>
                  <div className="wc-ssh-row-actions">
                    <button type="button" className="sh-button sh-button-danger" disabled={p.busy} onClick={() => p.onForget(e)}>Forget</button>
                    <button type="button" className="sh-button" disabled={p.busy} onClick={p.onCancelForget}>Cancel</button>
                  </div>
                </InlineConfirm>
              ) : null}
              {message ? <p className="wc-ssh-row-msg" data-tone={message.tone} role="status">{message.text}</p> : null}
              {error ? <p className="wc-ssh-row-msg" data-tone="error" role="alert">{error}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface RecentSshServersProps {
  servers: SshRecentServer[];
  busy: boolean;
  message: RowMessage | null;
  onConnect: (entry: SshRecentServer) => void;
  onEdit: (entry: SshRecentServer) => void;
  /** Resolves when the host has forgotten the server; a rejection is shown on the row. */
  onForget: (entry: SshRecentServer) => Promise<void>;
}

/** Holds which row's menu or confirmation is open. Everything it shows comes from RecentSshServersView. */
export function RecentSshServers(props: RecentSshServersProps): ReactNode {
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [forgetKey, setForgetKey] = useState<string | null>(null);
  const [forgetError, setForgetError] = useState<{ key: string; text: string } | null>(null);
  const forget = async (entry: SshRecentServer) => {
    setForgetKey(null);
    setForgetError(null);
    try {
      await props.onForget(entry);
    } catch (e) {
      setForgetError({ key: recentKey(entry), text: sshServerErrorText(e) });
    }
  };
  return (
    <RecentSshServersView
      servers={props.servers}
      busy={props.busy}
      message={props.message}
      menuKey={menuKey}
      forgetKey={forgetKey}
      forgetError={forgetError}
      onToggleMenu={setMenuKey}
      onAskForget={(key) => { setMenuKey(null); setForgetKey(key); }}
      onCancelForget={() => setForgetKey(null)}
      onForget={(entry) => void forget(entry)}
      onEdit={props.onEdit}
      onConnect={props.onConnect}
    />
  );
}
