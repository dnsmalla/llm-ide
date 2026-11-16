// SSH server home: what the app shows in ssh mode instead of the local Welcome page. It names the server and its link
// state, offers Open folder…, lists the recent folders on the server and holds Disconnect and Stop server. The view is
// a plain function over props (tested to markup); the container owns the models and reads the live link from the core
// status, as the toolbar does. The password lives in the container's state only, so it goes when the page unmounts.
import { useEffect, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import "./server-home.css";
import { useModel, useStore } from "../settings/context.tsx";
import { Button, ErrorText, Field } from "../settings/ui.tsx";
import { SshServerModel, SSH_FOREIGN_TEXT, type SshServerIo } from "../settings/ssh-server-model.ts";
import { StopConfirm } from "../settings/sections/SshServerParts.tsx";
import { useStoreSelector } from "../shell/hooks.ts";
import { coreStatusStore } from "../shell/runtime.ts";
import type { RemoteProject, WorkspaceIo, OpenFlowDeps } from "../remote-folder/model.ts";
import { ServerRecentModel } from "../remote-folder/model.ts";

/** The same sentence the dialog gives under the password field: the password is not kept. */
export const SERVER_PASSWORD_HINT = "Used only for this connection. It is never saved.";

/** The header's state label for each link state, using the wording of the toolbar and the status view. */
export function serverLinkLabel(link: string | null): { tone: "ok" | "busy" | "warn" | "error" | "off"; text: string } {
  switch (link) {
    case "connected": return { tone: "ok", text: "SSH server connected" };
    case "connecting": return { tone: "busy", text: "Connecting to the SSH server…" };
    case "reconnecting": return { tone: "warn", text: "Reconnecting to the SSH server…" };
    case "needs_password": return { tone: "warn", text: "Enter the server password to connect" };
    case "failed": return { tone: "error", text: "SSH server unreachable" };
    default: return { tone: "off", text: "Not connected to the SSH server" };
  }
}

/** One recent folder as a row shows it. */
export interface RecentRow {
  path: string;
  name: string;
  missing: boolean;
}

export interface ServerHomeViewProps {
  /** The live link state (`connected`, `needs_password`, ...); null before the first answer. */
  link: string | null;
  host: string;
  /** `<user> · LLM-IDE server <version> · Claude <version>`, already joined; empty parts are not in it. */
  identity: string;
  /** Text the server answered for the link (a failed connection), shown under the state. */
  statusError: string | null;
  busy: boolean;
  /** Error of the last action on this page (host text, already a sentence). */
  error: string | null;
  password: string;
  onPassword(value: string): void;
  onConnectPassword(): void;
  onDisconnect(): void;
  stopConfirm: boolean;
  onAskStop(): void;
  onConfirmStop(): void;
  onCancelStop(): void;
  /** Another computer started the server: only an explicit "anyway" repeats the stop. */
  foreign: boolean;
  onStopAnyway(): void;
  onDismissForeign(): void;
  /** The open server folder, if any. */
  folder: { name: string } | null;
  onContinue(): void;
  onOpenPicker(): void;
  recent: RecentRow[];
  onOpenRecent(path: string): void;
  onRemoveRecent(path: string): void;
}

export function ServerHomeView(p: ServerHomeViewProps): ReactNode {
  const label = serverLinkLabel(p.link);
  const linkUp = p.link === "connected" || p.link === "connecting" || p.link === "reconnecting";
  const connected = p.link === "connected";
  return (
    <div className="sh-home st-root" aria-label="SSH server">
      <header className="sh-home-head">
        <div className="sh-home-title">
          <h2 className="wc-h2">{`Connected to ${p.host}`}</h2>
          <p className="sh-home-state" data-tone={label.tone}>
            <span className="sh-home-dot" aria-hidden="true" />
            <span role="status">{label.text}</span>
          </p>
        </div>
        <div className="sh-home-actions">
          {linkUp ? <Button disabled={p.busy} onClick={p.onDisconnect}>Disconnect</Button> : null}
          <Button tone="danger" disabled={p.busy} onClick={p.onAskStop}>Stop server</Button>
        </div>
      </header>
      {p.identity ? <p className="sh-home-identity">{p.identity}</p> : null}
      {p.statusError && p.link === "failed" ? <p className="wc-text wc-muted">{p.statusError}</p> : null}
      <ErrorText text={p.error} />

      {p.stopConfirm ? (
        <StopConfirm host={p.host} busy={p.busy} onConfirm={p.onConfirmStop} onCancel={p.onCancelStop} />
      ) : null}
      {p.foreign ? (
        <div className="st-dialog" role="alertdialog" aria-label="Another computer started the server">
          <StatusBanner severity="warning" message={SSH_FOREIGN_TEXT} />
          <div className="st-row">
            <Button tone="danger" disabled={p.busy} onClick={p.onStopAnyway}>Stop it anyway</Button>
            <Button disabled={p.busy} onClick={p.onDismissForeign}>Cancel</Button>
          </div>
        </div>
      ) : null}

      {p.link === "needs_password" ? (
        <section className="sh-home-section sh-home-password" aria-label="Server password">
          <Field label="Password" hint={SERVER_PASSWORD_HINT}>
            <input
              className="st-input"
              type="password"
              value={p.password}
              onChange={(e) => p.onPassword(e.currentTarget.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <div className="st-row">
            <Button tone="primary" disabled={p.busy || p.password.length === 0} onClick={p.onConnectPassword}>Connect</Button>
          </div>
        </section>
      ) : null}

      <section className="sh-home-section" aria-labelledby="sh-home-open-title">
        <h3 id="sh-home-open-title" className="wc-eyebrow">{p.folder ? "Open folder" : "Folder"}</h3>
        {p.folder ? (
          <p className="wc-text">
            <span className="wc-muted">Current folder: </span>
            <strong>{p.folder.name}</strong>
          </p>
        ) : null}
        <div className="st-row">
          <Button tone="primary" disabled={p.busy || !connected} onClick={p.onOpenPicker}>Open folder…</Button>
          {p.folder ? <Button disabled={p.busy} onClick={p.onContinue}>Continue</Button> : null}
        </div>
        {!connected ? <p className="wc-text wc-muted">Connect to the server to open a folder.</p> : null}
      </section>

      <section className="sh-home-section" aria-labelledby="sh-home-recent-title">
        <h3 id="sh-home-recent-title" className="wc-eyebrow">Recent folders on this server</h3>
        {p.recent.length === 0 ? (
          <p className="wc-text wc-muted">No folders opened on this server yet.</p>
        ) : (
          <ul className="sh-home-recent">
            {p.recent.map((r) => (
              <li key={r.path} className="sh-home-row" data-missing={r.missing ? "true" : undefined}>
                <button type="button" className="sh-home-open" disabled={p.busy || r.missing} title={r.path} onClick={() => p.onOpenRecent(r.path)}>
                  <span className="sh-home-name">{r.name}</span>
                  <span className="sh-home-path">{r.path}</span>
                  {r.missing ? <span className="sh-home-note">This folder is no longer on the server.</span> : null}
                </button>
                {r.missing ? <Button disabled={p.busy} onClick={() => p.onRemoveRecent(r.path)}>Remove</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export interface ServerHomeProps {
  io: SshServerIo;
  workspace: WorkspaceIo;
  deps: OpenFlowDeps;
  /** The open server folder (the project), or null. */
  folder: { name: string } | null;
  onOpenPicker(): void;
  /** Goes to the project's sections (Continue, or a folder opened from the recent list). */
  onOpened(project: RemoteProject): void;
  onContinue(): void;
}

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** The server home page: the models and the live link. Its state is the page's own, so a fresh mount starts clean. */
export function ServerHome({ io, workspace, deps, folder, onOpenPicker, onOpened, onContinue }: ServerHomeProps): ReactNode {
  const m = useModel(() => new SshServerModel(io));
  const s = useStore(m);
  const recentModel = useModel(() => new ServerRecentModel(workspace, deps));
  const rs = useStore(recentModel);
  const coreLink = useStoreSelector(coreStatusStore, (x) => x.status?.link ?? null);
  const [password, setPassword] = useState("");
  const [stopConfirm, setStopConfirm] = useState(false);

  useEffect(() => {
    void m.load();
    void recentModel.load();
  }, [m, recentModel]);
  // The link changes on its own (reconnects); the server's identity is read again when it does.
  useEffect(() => {
    if (coreLink !== null) void m.refreshStatus();
  }, [coreLink, m]);
  // The password is for the prompt it answered: it goes when the server no longer asks for it.
  useEffect(() => {
    if (coreLink !== "needs_password") setPassword("");
  }, [coreLink]);

  const pw = password.length > 0 ? password : undefined;
  const link: string | null = coreLink ?? s.status?.link ?? null;
  const status = s.status;
  const host = (status?.host || s.host).trim();
  const identity = [status?.user, status?.version ? `LLM-IDE server ${status.version}` : "", status?.claude ? `Claude ${status.claude}` : ""]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" · ");
  const busy = s.busy !== null || rs.busy;

  const connectPassword = async () => {
    const answer = await m.connectWithTest(pw);
    if (answer?.link === "connected") setPassword("");
  };
  const openRecent = (path: string) => {
    void recentModel.open(path).then((project) => {
      if (project) onOpened(project);
    });
  };

  return (
    <ServerHomeView
      link={link}
      host={host}
      identity={identity}
      statusError={status?.error ?? null}
      busy={busy}
      error={s.error ?? rs.error}
      password={password}
      onPassword={setPassword}
      onConnectPassword={() => void connectPassword()}
      onDisconnect={() => void m.disconnect()}
      stopConfirm={stopConfirm}
      onAskStop={() => setStopConfirm(true)}
      onConfirmStop={() => { setStopConfirm(false); void m.stopServer(pw); }}
      onCancelStop={() => setStopConfirm(false)}
      foreign={s.foreign !== null}
      onStopAnyway={() => void m.stopServer(pw, { force: true })}
      onDismissForeign={() => m.dismissForeign()}
      folder={folder}
      onContinue={onContinue}
      onOpenPicker={onOpenPicker}
      recent={rs.paths.map((path) => ({ path, name: basename(path), missing: rs.missing.includes(path) }))}
      onOpenRecent={openRecent}
      onRemoveRecent={(path) => void recentModel.forget(path)}
    />
  );
}
