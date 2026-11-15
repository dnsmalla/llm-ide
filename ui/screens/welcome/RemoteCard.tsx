// Welcome → Remote hosts: add several SSH hosts, test SSH, connect/close/reopen a Host API workspace.
import { useState } from "react";
import { invokeHost } from "../shell/host";
import { shellBus } from "../shell/bus";
import { activeHostId, addHost, closeRemote, connectSavedHost, loadHosts, removeHost, type RemoteHost } from "../remote/session.ts";

interface SshResult { uname: string; node: boolean; hostKeyType: string; fingerprint: string }
const EMPTY = { name: "", sshHost: "", port: "22", user: "root", keyPath: "", api: "wss://llm-ide.com/host-api/v1", projectPath: "" };

export function RemoteCard() {
  const [hosts, setHosts] = useState<RemoteHost[]>(() => loadHosts());
  const [active, setActive] = useState<string | null>(() => activeHostId());
  const [adding, setAdding] = useState(hosts.length === 0);
  const [form, setForm] = useState(EMPTY);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ssh, setSsh] = useState<Record<string, SshResult>>({});

  const test = async (h: RemoteHost) => {
    setBusy(`ssh:${h.id}`); setError(null);
    try {
      const r = await invokeHost<unknown>("remote_ssh_test", { target: { host: h.sshHost, port: h.port, user: h.user, keyPath: h.keyPath } }) as Partial<SshResult>;
      if (typeof r?.uname !== "string" || typeof r?.fingerprint !== "string") throw new Error("The host returned an SSH result this app cannot read.");
      setSsh((cur) => ({ ...cur, [h.id]: r as SshResult }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const openSsh = async (h: RemoteHost) => {
    if (!h.projectPath.trim()) { setError("Add the remote project path first."); return; }
    setBusy(`sshopen:${h.id}`); setError(null);
    try {
      const raw = await invokeHost<string>("remote_ssh_project", { target: { host: h.sshHost, port: h.port, user: h.user, keyPath: h.keyPath }, action: "open", path: h.projectPath.trim() });
      const r = JSON.parse(raw) as { url?: string; pin?: string };
      if (typeof r.url !== "string" || typeof r.pin !== "string") throw new Error("The host did not return a workspace URL and PIN.");
      await connectSavedHost({ ...h, api: r.url }, r.pin);
      setActive(h.id);
      shellBus.publish({ type: "goto-section", section: "remote" });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const connect = async (h: RemoteHost) => {
    setBusy(`open:${h.id}`); setError(null);
    try {
      await connectSavedHost(h, pins[h.id] ?? "");
      setActive(h.id);
      shellBus.publish({ type: "goto-section", section: "remote" });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const close = () => { closeRemote(); setActive(null); };

  const add = () => {
    if (!form.name.trim() || !form.sshHost.trim() || !form.user.trim() || !form.keyPath.trim() || !form.api.trim()) { setError("Fill the name, SSH host, user, key path and workspace address."); return; }
    const next = addHost({ name: form.name.trim(), sshHost: form.sshHost.trim(), port: Number(form.port) || 22, user: form.user.trim(), keyPath: form.keyPath.trim(), api: form.api.trim(), projectPath: form.projectPath.trim() });
    setHosts(next); setForm(EMPTY); setAdding(false); setError(null);
  };

  return (
    <section className="wc-card wc-remote" aria-labelledby="wc-remote-title">
      <div className="wc-remote-head">
        <div>
          <h2 id="wc-remote-title" className="wc-h2">Remote hosts</h2>
          <p className="wc-text wc-muted">Add SSH hosts and connect to their workspace. Files stay on the host.</p>
        </div>
        <button type="button" className="sh-button" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "Add host"}</button>
      </div>

      {hosts.length === 0 && !adding ? <p className="wc-text wc-muted">No remote hosts yet.</p> : null}
      <ul className="wc-remote-list">
        {hosts.map((h) => (
          <li key={h.id} className="wc-remote-row" data-active={active === h.id || undefined}>
            <div className="wc-remote-text">
              <strong>{h.name}</strong>
              <span>{h.user}@{h.sshHost}:{h.port} · {h.api}</span>
              {h.projectPath ? <span>project: {h.projectPath}</span> : null}
              {ssh[h.id] ? <span className="wc-remote-ok" role="status">SSH OK · {ssh[h.id].uname} · node {ssh[h.id].node ? "present" : "missing"} · {ssh[h.id].hostKeyType} {ssh[h.id].fingerprint}</span> : null}
            </div>
            <div className="wc-remote-actions">
              <button type="button" className="sh-button" disabled={busy !== null} onClick={() => void test(h)}>{busy === `ssh:${h.id}` ? "Testing…" : "Test SSH"}</button>
              {active === h.id ? (
                <button type="button" className="sh-button" onClick={() => close()}>Close</button>
              ) : (
                <>
                  <input className="wc-remote-pin" type="password" inputMode="numeric" placeholder="PIN" value={pins[h.id] ?? ""} onChange={(e) => setPins((cur) => ({ ...cur, [h.id]: e.target.value }))} aria-label={`Pairing PIN for ${h.name}`} />
                  <button type="button" className="sh-button" disabled={busy !== null} onClick={() => void connect(h)}>{busy === `open:${h.id}` ? "Opening…" : "Open API"}</button>
                  <button type="button" className="sh-button sh-button-primary" disabled={busy !== null || !h.projectPath} onClick={() => void openSsh(h)}>{busy === `sshopen:${h.id}` ? "Opening…" : "Open SSH"}</button>
                </>
              )}
              <button type="button" className="sh-button" disabled={busy !== null} onClick={() => setHosts(removeHost(h.id))}>Remove</button>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="wc-remote-add">
          <div className="wc-remote-grid">
            <label className="sh-field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production" /></label>
            <label className="sh-field"><span>SSH host</span><input value={form.sshHost} onChange={(e) => setForm({ ...form, sshHost: e.target.value })} placeholder="72.62.76.92" spellCheck={false} /></label>
            <label className="sh-field"><span>Port</span><input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} inputMode="numeric" /></label>
            <label className="sh-field"><span>User</span><input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} /></label>
            <label className="sh-field wc-remote-wide"><span>Key path</span><input value={form.keyPath} onChange={(e) => setForm({ ...form, keyPath: e.target.value })} placeholder="/Users/you/.ssh/id_ed25519" spellCheck={false} /></label>
            <label className="sh-field wc-remote-wide"><span>Workspace Host API</span><input value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })} spellCheck={false} /></label>
            <label className="sh-field wc-remote-wide"><span>Remote project path</span><input value={form.projectPath} onChange={(e) => setForm({ ...form, projectPath: e.target.value })} placeholder="/srv/llmide/projects/demo" spellCheck={false} /></label>
          </div>
          <button type="button" className="sh-button sh-button-primary" onClick={add}>Save host</button>
        </div>
      ) : null}
      {error ? <p className="sh-form-error" role="alert">{error}</p> : null}
    </section>
  );
}
