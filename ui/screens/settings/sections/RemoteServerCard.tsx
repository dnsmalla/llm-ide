// Settings → Server & Backend → Remote server (phase 1).
//
// The choice and the non-secret SSH fields are stored as desktop prefs (prefs.json, 0600); "Test SSH" calls the
// host command `remote_ssh_test`, which runs system ssh with a fixed argv. The private key's CONTENTS are never
// read by the webview and never stored; only the path the user typed is kept. No password support in phase 1.
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { useEnv, useModel, useStore } from "../context.tsx";
import { ErrorText, Field } from "../ui.tsx";
import { LOCAL_COPY, REMOTE_TEXT, RemoteServerModel, type RemoteServerIo, type RemoteServerState } from "../remote-model.ts";
import RemoteDeployCard from "./RemoteDeployCard.tsx";

function RemoteFields({ m, s }: { m: RemoteServerModel; s: RemoteServerState }): ReactNode {
  const set = (field: "host" | "port" | "user" | "keyPath" | "label" | "hubUrl") => (e: ChangeEvent<HTMLInputElement>) => m.setField(field, e.currentTarget.value);
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
      <Field label="Hub URL" hint="The https:// address of the hub; probe its certificate before switching modes.">
        <input className="st-input" value={s.hubUrl} onChange={set("hubUrl")} placeholder="https://hub.example.com" autoComplete="off" spellCheck={false} />
        <ErrorText text={s.fieldErrors.hubUrl ?? null} />
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
      {!r.node ? <p className="st-hint">Node is not on the remote host's PATH. Phase 2 deploy needs Node 20+ there.</p> : null}
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

/** The card. Hidden behind a "needs the desktop host" note in a plain browser. */
export default function RemoteServerCard(): ReactNode {
  const { host } = useEnv();
  const available = Boolean(host.getRemoteServer && host.setRemoteServer && host.testRemoteSsh);
  const io = useMemo<RemoteServerIo>(() => ({
    load: () => host.getRemoteServer!(),
    save: (config) => host.setRemoteServer!(config),
    test: (config) => host.testRemoteSsh!(config),
  }), [host]);
  const m = useModel(() => new RemoteServerModel(io));
  const s = useStore(m);
  const [tls, setTls] = useState<{ fingerprint: string; error: string | null; busy: boolean }>({ fingerprint: "", error: null, busy: false });
  const probe = async () => {
    if (!host.remoteTlsProbe) return;
    setTls({ fingerprint: "", error: null, busy: true });
    try { const r = await host.remoteTlsProbe(s.hubUrl.trim()); setTls({ fingerprint: r.fingerprint, error: null, busy: false }); }
    catch (e) { setTls({ fingerprint: "", error: e instanceof Error ? e.message : "The TLS probe failed.", busy: false }); }
  };
  const trust = async () => {
    if (!host.remoteTlsPin || !tls.fingerprint) return;
    try { await host.remoteTlsPin(s.hubUrl.trim(), tls.fingerprint); await m.load(); setTls({ fingerprint: "", error: null, busy: false }); }
    catch (e) { setTls({ fingerprint: tls.fingerprint, error: e instanceof Error ? e.message : "The pin could not be saved.", busy: false }); }
  };
  // Load once per mount. A focus refresh would discard fields the user is still editing.
  useEffect(() => {
    if (available) void m.load();
  }, [available, m]);

  if (!available) return <p className="st-hint">Remote server mode needs the desktop host, which is not connected in this build.</p>;

  return (
    <div className="st-note" role="group" aria-label="Remote server">
      <span className="st-label">Remote server</span>
      <p className="st-hint">{REMOTE_TEXT.hint}</p>

      <div className="st-stack" role="radiogroup" aria-label="Server mode">
        <label className="st-row">
          <input type="radio" name="server-mode" value="local" checked={s.mode === "local"} onChange={() => m.setMode("local")} />
          <span>Local desktop</span>
        </label>
        <label className="st-row">
          <input type="radio" name="server-mode" value="remote" checked={s.mode === "remote"} onChange={() => m.setMode("remote")} />
          <span>Remote server</span>
        </label>
      </div>

      {s.mode === "local" ? (
        <p className="st-hint">{LOCAL_COPY}</p>
      ) : (
        <>
          <RemoteFields m={m} s={s} />
          <div className="st-row">
            <button type="button" className="st-btn" disabled={s.testing || s.saving} onClick={() => void m.test()}>
              {s.testing ? "Testing…" : "Test SSH"}
            </button>
            <span className="st-hint">The first connection learns the host key and shows its fingerprint.</span>
          </div>
          <TestResult m={m} s={s} />
          <div className="st-note">
            <span className="st-label">Hub certificate</span>
            <p className="st-hint">{s.tlsPin ? `Pinned: ${s.tlsPin}. If the hub certificate changed, re-probe it and trust the new pin; the app refuses a connection until you do.` : "Not pinned yet. Probe the hub, compare the fingerprint, then trust it."}</p>
            <div className="st-row">
              <button type="button" className="st-btn" disabled={tls.busy || !s.hubUrl.trim()} onClick={() => void probe()}>{tls.busy ? "Probing…" : s.tlsPin ? "Re-probe TLS" : "Probe TLS"}</button>
              {tls.fingerprint ? <button type="button" className="st-btn" data-tone="primary" onClick={() => void trust()}>Trust this certificate</button> : null}
            </div>
            {tls.fingerprint ? <p className="st-pre" style={{ userSelect: "text", wordBreak: "break-all" }}>{tls.fingerprint}</p> : null}
            <ErrorText text={tls.error} />
          </div>
          <RemoteDeployCard config={m.config()} />
          <div className="st-row">
            <button type="button" className="st-btn" data-tone="primary" disabled={s.saving || s.testing} onClick={() => void m.save().then(() => host.restartApp?.())}>
              Save and restart in {s.mode === "remote" ? "remote" : "local"} mode
            </button>
            <span className="st-hint">Mode changes apply on the next app start.</span>
          </div>
        </>
      )}

      <ErrorText text={s.error} />
      <div className="st-row">
        <button type="button" className="st-btn" data-tone="primary" disabled={s.saving || s.testing} onClick={() => void m.save()}>
          {s.saving ? "Saving…" : "Save server settings"}
        </button>
        {s.saved ? <span className="st-ok" role="status">Saved. Phase 2 will deploy and run the backend remotely.</span> : null}
      </div>
      {s.loadFailed ? <p className="st-hint">The saved remote settings could not be read. You can enter them again and save.</p> : null}
    </div>
  );
}
