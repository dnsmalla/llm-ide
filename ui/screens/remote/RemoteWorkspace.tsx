import { createElement, useState, type ComponentType } from "react";
import { WorkspaceScreen } from "../../../web/src/workspace/Workspace.tsx";
import { invokeHost } from "../shell/host";
import { closeRemote, getRemote, setSelectedRemote } from "./session.ts";
import "./remote.css";

/** The connected workspace; the Welcome card or the Remote section both land here. */
export function RemoteWorkspace() {
  const initial = getRemote();
  const [active, setActive] = useState(initial);
  const [selected, setSelected] = useState(initial?.selected ?? null);
  const [loopBusy, setLoopBusy] = useState(false);
  const [loopResult, setLoopResult] = useState<string | null>(null);
  const [loopName, setLoopName] = useState("");
  if (!active || !selected) return null;
  const fake = { session: { connection: active.conn }, projects: { selectedId: selected } } as never;

  const runLoop = async () => {
    if (!active.host.projectPath) { setLoopResult("Add a remote project path in Welcome first."); return; }
    setLoopBusy(true); setLoopResult(null);
    try {
      const raw = await invokeHost<string>("remote_ssh_loop", {
        target: { host: active.host.sshHost, port: active.host.port, user: active.host.user, keyPath: active.host.keyPath },
        path: active.host.projectPath, loopName: loopName.trim(),
      });
      setLoopResult(raw);
    } catch (e) { setLoopResult(e instanceof Error ? e.message : String(e)); }
    finally { setLoopBusy(false); }
  };

  return (
    <div className="remote-root">
      <header className="remote-bar">
        <select value={selected} onChange={(e) => { setSelected(e.target.value); setSelectedRemote(e.target.value); }} aria-label="Remote project">
          {active.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span>{active.conn.hello?.hostName ?? "Remote host"}</span>
        <input className="remote-loop-name" value={loopName} onChange={(e) => setLoopName(e.target.value)} placeholder="Loop name (blank = primary)" aria-label="Loop name" />
        <button type="button" disabled={loopBusy || !active.host.projectPath} onClick={() => void runLoop()}>{loopBusy ? "Running loop…" : "Run loop"}</button>
        <button type="button" onClick={() => { closeRemote(); setActive(null); }}>Disconnect</button>
      </header>
      {loopResult ? <pre className="remote-loop-result" aria-live="polite">{loopResult}</pre> : null}
      {createElement(WorkspaceScreen as unknown as ComponentType<{ ctx: unknown }>, { ctx: fake })}
    </div>
  );
}
