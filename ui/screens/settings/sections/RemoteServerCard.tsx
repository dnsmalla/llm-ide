// Settings → Server & Backend → Remote server.
//
// Primary flow (URL-first): a running hub's https URL, the hub email/password, Connect, Test
// connection and Sign out. The desktop host performs `/auth/login`, stores the refresh token in the
// OS keychain bound to the URL + pinned identity, and records remote mode; the app then restarts.
// A public-CA certificate needs no pin. SSH deploy/update/uninstall live under an explicit Advanced
// disclosure and are hidden by default.
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { call } from "../core-api.ts";
import { decodeMe, type Me } from "../decoders.ts";
import { useEnv, useModel, useStore } from "../context.tsx";
import { ErrorText, Field } from "../ui.tsx";
import { LOCAL_COPY, REMOTE_TEXT, RemoteServerModel, type RemoteServerIo, type RemoteServerState } from "../remote-model.ts";
import type { ServerMode } from "../host.ts";
import RemoteDeployCard from "./RemoteDeployCard.tsx";
import { SSH_LOCAL_CONFIRM } from "../ssh-server-model.ts";
import { projectStore } from "../../shell/project-store.ts";
import { closeServerConnection } from "../../shell/close-server.ts";

/**
 * The mode this launch actually runs. In an SSH or hub session the live mode is the truth: a launch in SSH mode writes
 * the saved mode back to Local, so the saved mode alone would hide the session. Otherwise the saved mode is the answer.
 */
export function appliedModeFrom(live: ServerMode | null | undefined, saved: ServerMode): ServerMode {
  return live === "ssh" || live === "remote" ? live : saved;
}

/**
 * Choosing Local leaves the hub or the SSH server, so it asks first. An SSH session asks too, but leaving it does not save
 * a mode (the saved mode is already Local): it closes the connection like Close server does.
 */
export function localChoiceNeedsConfirm(applied: ServerMode | null): boolean {
  return applied === "remote" || applied === "ssh";
}

/** `vite dev`/`tauri dev` only: release builds must use a public domain, never localhost. */
const DEV = (() => {
  try { return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV); } catch { return false; }
})();

function RemoteFields({ m, s }: { m: RemoteServerModel; s: RemoteServerState }): ReactNode {
  const set = (field: "host" | "port" | "user" | "keyPath" | "label") => (e: ChangeEvent<HTMLInputElement>) => m.setField(field, e.currentTarget.value);
  return (
    <div className="st-stack">
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
      <Field label="Private key path" hint={REMOTE_TEXT.keyOnly}>
        <input className="st-input" value={s.keyPath} onChange={set("keyPath")} placeholder="/Users/you/.ssh/id_ed25519" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.keyPath ?? null} />
      </Field>
      <Field label="Label (optional)" hint="A name for this server, e.g. production or staging.">
        <input className="st-input" value={s.label} onChange={set("label")} placeholder="production" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.label ?? null} />
      </Field>
    </div>
  );
}

function TestResult({ m, s }: { m: RemoteServerModel; s: RemoteServerState }): ReactNode {
  if (s.testing) return <p className="st-hint" role="status">Testing SSH…</p>;
  if (!s.result) return null;
  const r = s.result;
  return (
    <div className="st-note" role="status" aria-label="SSH test result">
      <p className="st-ok">Connected to {r.user}@{r.host}:{r.port}.</p>
      <dl className="st-stack">
        <div className="st-row"><dt className="st-label">Host key</dt><dd><span className="st-status" data-tone="ok">{r.hostKeyType}</span></dd></div>
        <div className="st-row"><dt className="st-label">Fingerprint</dt><dd><code className="st-pre" style={{ userSelect: "text", wordBreak: "break-all" }}>{r.fingerprint}</code></dd></div>
        <div className="st-row"><dt className="st-label">uname</dt><dd>{r.uname}</dd></div>
        <div className="st-row">
          <dt className="st-label">Node</dt>
          <dd>{r.node ? <span className="st-status" data-tone="ok">{r.nodeVersion ?? r.nodePath ?? "found"}</span> : <span className="st-status" data-tone="warning">not found</span>}</dd>
        </div>
      </dl>
      {!r.node ? <p className="st-hint">Node is not on the remote host's PATH; the deploy ships its own pinned Node, so this is informational.</p> : null}
      <div className="st-row">
        <button type="button" className="st-btn" data-tone={s.confirmed ? undefined : "primary"} disabled={s.confirming || s.confirmed} onClick={() => void m.confirm()}>
          {s.confirmed ? "Fingerprint confirmed" : s.confirming ? "Confirming…" : "Confirm fingerprint"}
        </button>
        <span className="st-hint">{s.confirmed ? "This app session may now deploy, update or uninstall on this host." : "Compare it with the server operator's fingerprint before confirming."}</span>
      </div>
      <p className="st-hint">{REMOTE_TEXT.testHint}</p>
    </div>
  );
}

/** The hub card's one-line status. Exported for the SSR test; `ssh` is the SSH server card's job, so this line only points there. */
export function ConnectionState({ s, me, applied }: { s: RemoteServerState; me: Me | null; applied: ServerMode | null }): ReactNode {
  if (applied === "ssh") return <p className="st-hint" role="status">Using the <strong>SSH server</strong>. Connecting to a hub switches the backend after a restart.</p>;
  if (applied !== "remote") return <p className="st-hint" role="status">Using <strong>Local desktop</strong>. Connecting to a hub switches the backend after a restart.</p>;
  const user = me ? `${me.email} (${me.role})` : s.hubLogin ? `${s.hubLogin.user.email} (${s.hubLogin.role})` : null;
  if (user) return <p className="st-ok" role="status">Connected as {user}. {s.hubLogin ? `${s.hubLogin.projects.length} project${s.hubLogin.projects.length === 1 ? "" : "s"} available.` : ""}</p>;
  return <p className="st-hint" role="status">Remote mode is selected. Sign in under Remote server if you are not connected.</p>;
}

/**
 * The server-mode card. Hidden behind a "needs the desktop host" note in a plain browser. It always shows the mode choice
 * and what concerns the switch itself (this launch's mode, the leave-confirm, notices); below that only the chosen
 * mode's settings render: the hub fields here, or `modeSettings` (Server & Backend passes the managed-backend block for
 * Local and the SSH server card for SSH). Hidden modes are not rendered, but this component stays mounted so the hub
 * model and typed email survive a switch. `chosen` / `onChoose` come from Server & Backend; without them the choice follows
 * the saved mode. Choosing a mode is a UI change only; nothing restarts or stops the core until the user acts.
 */
export default function RemoteServerCard({ chosen, onChoose, live, modeSettings }: { chosen?: ServerMode; onChoose?: (mode: ServerMode) => void; live?: ServerMode | null; modeSettings?: ReactNode } = {}): ReactNode {
  const { host, client } = useEnv();
  const available = Boolean(host.getRemoteServer && host.setRemoteServer && host.remoteHubCheck && host.remoteHubLogin);
  const io = useMemo<RemoteServerIo>(() => ({
    load: () => host.getRemoteServer!(),
    save: (config) => host.setRemoteServer!(config),
    test: (config) => host.testRemoteSsh ? host.testRemoteSsh(config) : Promise.reject(new Error("The SSH test needs the desktop host.")),
    confirm: host.confirmRemoteSshHostKey ? (config, type, fingerprint) => host.confirmRemoteSshHostKey!(config, type, fingerprint) : undefined,
    check: host.remoteHubCheck ? (hubUrl) => host.remoteHubCheck!(hubUrl) : undefined,
    login: host.remoteHubLogin ? (hubUrl, email, password) => host.remoteHubLogin!(hubUrl, email, password) : undefined,
    signOut: host.remoteSessionClear ? () => host.remoteSessionClear!() : undefined,
    logoutCore: host.signOut ? () => host.signOut!() : undefined,
    restart: host.restartApp ? () => host.restartApp!() : undefined,
    unpin: host.remoteTlsUnpin ? (hubUrl) => host.remoteTlsUnpin!(hubUrl) : undefined,
  }), [host]);
  const m = useModel(() => new RemoteServerModel(io));
  const s = useStore(m);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [appliedMode, setAppliedMode] = useState<ServerMode | null>(null);
  const [confirmLocal, setConfirmLocal] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tls, setTls] = useState<{ fingerprint: string; webPki: boolean; error: string | null; busy: boolean }>({ fingerprint: "", webPki: false, error: null, busy: false });

  // Load once per mount. A focus refresh would discard fields the user is still editing.
  useEffect(() => {
    if (available) void m.load();
  }, [available, m]);
  // The mode this launch actually runs (not the form's temporary radio selection). Switching back
  // to Local only restarts when the app is genuinely in remote mode.
  useEffect(() => {
    if (!s.loaded || appliedMode !== null) return;
    setAppliedMode(appliedModeFrom(live, s.mode));
  }, [s.loaded, s.mode, appliedMode, live]);

  // In remote mode the live account (email + role) comes from the hub itself.
  useEffect(() => {
    if (!available || s.mode !== "remote" || !s.loaded) { setMe(null); return; }
    let live = true;
    call(client, "GET", "/auth/me").then((b) => { if (live) setMe(decodeMe(b)); }, () => { if (live) setMe(null); });
    return () => { live = false; };
  }, [available, client, s.mode, s.loaded, s.hubLogin]);

  const probe = async () => {
    if (!host.remoteTlsProbe) return;
    setTls({ fingerprint: "", webPki: false, error: null, busy: true });
    try {
      const r = await host.remoteTlsProbe(s.hubUrl.trim());
      setTls({ fingerprint: r.fingerprint, webPki: r.webPki === true, error: null, busy: false });
    } catch (e) {
      setTls({ fingerprint: "", webPki: false, error: e instanceof Error ? e.message : "The TLS probe failed.", busy: false });
    }
  };
  const trust = async () => {
    if (!host.remoteTlsPin || !tls.fingerprint) return;
    try {
      await host.remoteTlsPin(s.hubUrl.trim(), tls.fingerprint);
      await m.load();
      setTls({ fingerprint: "", webPki: false, error: null, busy: false });
      setNotice("Certificate pin saved. Public CA trust is still used first.");
    } catch (e) {
      setTls({ fingerprint: tls.fingerprint, webPki: tls.webPki, error: e instanceof Error ? e.message : "The pin could not be saved.", busy: false });
    }
  };
  const connect = async () => {
    setNotice(null);
    const login = await m.connect(email, password, DEV);
    if (login) {
      setPassword("");
      setAppliedMode("remote");
      setNotice(`Connected as ${login.user.email} (${login.role}). Restarting into remote mode…`);
    } else {
      setPassword("");
    }
  };
  // Leaving an SSH session: no mode is saved (it is Local already); the connection closes and the app restarts.
  const closeSshSession = async () => {
    try {
      const left = await closeServerConnection(projectStore.guardLeave, () => (host.restartApp ? host.restartApp() : Promise.reject(new Error("Restarting needs the desktop host."))));
      if (left) setNotice("Closing the SSH connection. Restarting into Local desktop…");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The app could not restart.");
    }
  };
  const switchLocal = async () => {
    setConfirmLocal(false);
    if (appliedMode === "ssh") {
      await closeSshSession();
      return;
    }
    const ok = await m.switchToLocal();
    if (ok) {
      setAppliedMode("local");
      onChoose?.("local");
      setNotice("Local mode saved. Restarting the core on this computer…");
    }
  };

  // Without the host the hub card is unusable, but the chosen mode's own settings (e.g. the managed backend) still show.
  if (!available) return <><p className="st-hint">Remote server mode needs the desktop host, which is not connected in this build.</p>{modeSettings}</>;

  const busy = s.hubBusy !== null;
  const shown: ServerMode = chosen ?? s.mode;
  const connected = Boolean(me || s.hubLogin);
  const advancedId = "remote-advanced-panel";

  return (
    <div className="st-stack">
    <div className="st-note" role="group" aria-label="Server mode">
      <span className="st-label">Server mode</span>
      <div className="st-stack" role="radiogroup" aria-label="Server mode">
        <label className="st-row">
          <input
            type="radio"
            name="server-mode"
            value="local"
            checked={shown === "local"}
            onChange={() => {
              // Leaving the hub or the SSH server is explicit: it asks first, then restarts the core on this computer.
              if (localChoiceNeedsConfirm(appliedMode)) setConfirmLocal(true);
              else { m.setMode("local"); onChoose?.("local"); }
            }}
          />
          <span>Local desktop</span>
        </label>
        <label className="st-row">
          <input type="radio" name="server-mode" value="remote" checked={shown === "remote"} onChange={() => { m.setMode("remote"); onChoose?.("remote"); }} />
          <span>Remote server</span>
        </label>
        <label className="st-row">
          <input type="radio" name="server-mode" value="ssh" checked={shown === "ssh"} onChange={() => onChoose?.("ssh")} />
          <span>SSH server</span>
        </label>
      </div>

      <ConnectionState s={s} me={me} applied={appliedMode} />
      {shown === "local" ? <p className="st-hint">{LOCAL_COPY}</p> : null}

      {confirmLocal ? (
        <div className="st-dialog" role="alertdialog" aria-label="Switch to Local desktop">
          <strong>Switch to Local desktop?</strong>
          <p>{appliedMode === "ssh" ? SSH_LOCAL_CONFIRM : REMOTE_TEXT.localConfirm}</p>
          <div className="st-row">
            <button type="button" className="st-btn" data-tone="danger" disabled={busy} onClick={() => void switchLocal()}>Switch to Local</button>
            <button type="button" className="st-btn" onClick={() => setConfirmLocal(false)}>Cancel</button>
          </div>
        </div>
      ) : null}

      {appliedMode === "remote" || appliedMode === "ssh" ? (
        <div className="st-row">
          <button type="button" className="st-btn" data-tone="danger" disabled={busy} onClick={() => setConfirmLocal(true)}>Switch to Local desktop…</button>
          <span className="st-hint">{appliedMode === "ssh" ? "Explicit: the SSH server is left behind and the local core restarts." : "Explicit: the hub is left behind and the local core restarts."}</span>
        </div>
      ) : null}

      {/* With Remote chosen these lines stay beside the buttons that cause them (Connect, Save), further down. */}
      {shown !== "remote" && notice ? <p className="st-ok" role="status">{notice}</p> : null}
      {shown !== "remote" ? <ErrorText text={s.error} /> : null}
    </div>

    {shown !== "remote" ? modeSettings : null}

    {shown === "remote" ? (
    <div className="st-note" role="group" aria-label="Remote server">
      <span className="st-label">Remote server</span>
      <p className="st-hint">{REMOTE_TEXT.hint}</p>

      <Field label="Server URL" hint="The https:// address of a running hub. Public domain only; localhost is accepted in development builds.">
        <input className="st-input" value={s.hubUrl} onChange={(e) => m.setHubUrl(e.currentTarget.value)} placeholder="https://hub.example.com" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.hubUrl ?? null} />
      </Field>
      <Field label="Email" hint="Your account on that hub.">
        <input className="st-input" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoComplete="username" spellCheck={false} />
        <ErrorText text={s.fieldErrors.email ?? null} />
      </Field>
      <Field label="Password" hint="Sent to the hub once, never stored by the app.">
        <input className="st-input" type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" />
        <ErrorText text={s.fieldErrors.password ?? null} />
      </Field>

      <div className="st-row">
        <button type="button" className="st-btn" data-tone="primary" disabled={busy || !s.hubUrl.trim() || !email.trim() || !password} onClick={() => void connect()}>
          {s.hubBusy === "connect" ? "Connecting…" : "Connect"}
        </button>
        <button type="button" className="st-btn" disabled={busy || !s.hubUrl.trim()} onClick={() => void m.checkConnection(DEV)}>
          {s.hubBusy === "check" ? "Testing…" : "Test connection"}
        </button>
        {connected || appliedMode === "remote" ? (
          <button type="button" className="st-btn" data-tone="danger" disabled={busy} onClick={() => void m.signOut()}>Sign out</button>
        ) : null}
      </div>

      {s.hubCheck ? (
        <p className="st-ok" role="status" aria-label="Connection test result">
          Reachable: {s.hubCheck.hub ? "hub" : "server"} API {s.hubCheck.apiVersion}, database {s.hubCheck.dbOk ? "OK" : "not ready"}. {s.hubCheck.webPki ? "Certificate trusted by a public CA; no pin needed." : "Using your saved certificate pin."}
        </p>
      ) : null}
      <ErrorText text={s.hubError} />
      {notice ? <p className="st-ok" role="status">{notice}</p> : null}

      <div className="st-row">
        <button type="button" className="st-btn" aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "Hide" : "Show"} {REMOTE_TEXT.advanced}
        </button>
        <span className="st-hint">{REMOTE_TEXT.advancedHint}</span>
      </div>

      {advanced ? (
        <div id={advancedId} className="st-note" role="group" aria-label={REMOTE_TEXT.advanced}>
          <span className="st-label">{REMOTE_TEXT.advanced}</span>
          <p className="st-hint">Deploying overwrites server files. Use this only when you operate the server; connecting to an existing hub above needs none of it.</p>
          <RemoteFields m={m} s={s} />
          <div className="st-row">
            <button type="button" className="st-btn" disabled={s.testing || s.saving} onClick={() => void m.test()}>
              {s.testing ? "Testing…" : "Test SSH"}
            </button>
            <span className="st-hint">The first connection learns the host key and shows its fingerprint.</span>
          </div>
          <TestResult m={m} s={s} />
          <div className="st-note">
            <span className="st-label">Hub certificate pin (optional)</span>
            <p className="st-hint">{REMOTE_TEXT.pinHint}</p>
            <p className="st-hint">{s.tlsPin ? `Pinned: ${s.tlsPin}. If the hub certificate changed, probe again and trust the new pin, or remove the pin.` : "Public-CA trust. No pin is stored."}</p>
            <div className="st-row">
              <button type="button" className="st-btn" disabled={tls.busy || !s.hubUrl.trim()} onClick={() => void probe()}>{tls.busy ? "Probing…" : "Probe certificate"}</button>
              {tls.fingerprint ? <button type="button" className="st-btn" data-tone="primary" onClick={() => void trust()}>Trust this certificate</button> : null}
              {s.tlsPin ? <button type="button" className="st-btn" onClick={() => void m.unpin(DEV)}>Use public-CA trust</button> : null}
            </div>
            {tls.fingerprint ? (
              <p className="st-pre" style={{ userSelect: "text", wordBreak: "break-all" }}>
                {tls.fingerprint}{tls.webPki ? " (public CA — pinning is optional)" : ""}
              </p>
            ) : null}
            <ErrorText text={tls.error} />
          </div>
          <RemoteDeployCard config={m.config()} />
          <div className="st-row">
            <button type="button" className="st-btn" data-tone="primary" disabled={s.saving || s.testing} onClick={() => void m.saveAdvanced()}>
              {s.saving ? "Saving…" : "Save SSH settings"}
            </button>
            <span className="st-hint">Deploy changes apply to the server; a mode change applies after a restart.</span>
          </div>
        </div>
      ) : null}

      {s.saved && !advanced ? <p className="st-ok" role="status">Saved.</p> : null}
      <ErrorText text={s.error} />
      {s.loadFailed ? <p className="st-hint">The saved remote settings could not be read. You can enter them again and connect.</p> : null}
    </div>
    ) : null}
    </div>
  );
}
