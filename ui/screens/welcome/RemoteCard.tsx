// Welcome → Remote: add an SSH host (test it) and connect to a Host API workspace. SSH proves the machine is reachable;
// the workspace itself travels over the pinned Host API, because source stays on the host.
import { useState } from "react";
import { invokeHost } from "../shell/host";
import { shellBus } from "../shell/bus";
import { connectRemote } from "../remote/session.ts";

interface SshResult { host: string; port: number; user: string; hostKeyType: string; fingerprint: string; uname: string; node: boolean }
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const load = (k: string, fallback: string) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };

export function RemoteCard() {
  const [host, setHost] = useState(() => load("llmide.sshHost", ""));
  const [port, setPort] = useState(() => load("llmide.sshPort", "22"));
  const [user, setUser] = useState(() => load("llmide.sshUser", "root"));
  const [keyPath, setKeyPath] = useState(() => load("llmide.sshKey", ""));
  const [sshBusy, setSshBusy] = useState(false);
  const [ssh, setSsh] = useState<SshResult | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [api, setApi] = useState(() => load("llmide.remoteHost", "wss://llm-ide.com/host-api/v1"));
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testSsh = async () => {
    setSshBusy(true); setSshError(null); setSsh(null);
    store("llmide.sshHost", host); store("llmide.sshPort", port); store("llmide.sshUser", user); store("llmide.sshKey", keyPath);
    try {
      const result = await invokeHost<unknown>("remote_ssh_test", { target: { host: host.trim(), port: Number(port), user: user.trim(), keyPath: keyPath.trim() } });
      const r = result as Partial<SshResult>;
      if (typeof r?.fingerprint !== "string" || typeof r.uname !== "string") throw new Error("The host returned an SSH result this app cannot read.");
      setSsh(r as SshResult);
    } catch (e) { setSshError(e instanceof Error ? e.message : String(e)); }
    finally { setSshBusy(false); }
  };

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      store("llmide.remoteHost", api);
      await connectRemote(api, pin);
      shellBus.publish({ type: "goto-section", section: "remote" });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="wc-card wc-remote" aria-labelledby="wc-remote-title">
      <h2 id="wc-remote-title" className="wc-h2">Remote host</h2>
      <p className="wc-text wc-muted">Add an SSH host and test it, then connect to its workspace. The project stays on the server.</p>
      <div className="wc-remote-grid">
        <label className="sh-field"><span>SSH host</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="72.62.76.92" spellCheck={false} /></label>
        <label className="sh-field"><span>Port</span><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" /></label>
        <label className="sh-field"><span>User</span><input value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <label className="sh-field wc-remote-wide"><span>Key path</span><input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="/Users/you/.ssh/id_ed25519" spellCheck={false} /></label>
      </div>
      <button type="button" className="sh-button" disabled={sshBusy || !host.trim() || !user.trim() || !keyPath.trim()} onClick={() => void testSsh()}>{sshBusy ? "Testing SSH…" : "Test SSH"}</button>
      {ssh ? <p className="wc-remote-ok" role="status">SSH OK · {ssh.uname} · node {ssh.node ? "present" : "missing"} · {ssh.hostKeyType} {ssh.fingerprint}</p> : null}
      {sshError ? <p className="sh-form-error" role="alert">{sshError}</p> : null}

      <div className="wc-remote-sep" />
      <label className="sh-field"><span>Workspace Host API</span><input value={api} onChange={(e) => setApi(e.target.value)} placeholder="wss://host/host-api/v1" spellCheck={false} /></label>
      <label className="sh-field"><span>Pairing PIN</span><input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" placeholder="6 digits" /></label>
      <button type="button" className="sh-button sh-button-primary" disabled={busy || !api.trim()} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect workspace"}</button>
      {error ? <p className="sh-form-error" role="alert">{error}</p> : null}
    </section>
  );
}
