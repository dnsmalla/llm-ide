// Native desktop remote client: connect to another LLM-IDE host over Host API v1 and use its workspace. The project,
// files, git, agent and terminal stay on the remote host; this window only sends commands and receives one file.
import { createElement, useEffect, useRef, useState, type ComponentType } from "react";
import type { SectionProps } from "../shell/sections";
import { HostConnection, type ConnectionState } from "../../../web/src/host-api/connection.ts";
import { WorkspaceScreen } from "../../../web/src/workspace/Workspace.tsx";
import { normalizeRemoteUrl } from "./model.ts";
import "./remote.css";

// A session token is kept for this app run only; pairing again after restart is intentional.
let token: string | null = null;
const tokens = { get: () => token, set: (t: string | null) => { token = t; }, identity: () => null };



interface Project { id: string; name: string; role: string; maxMode: string }

export default function RemoteScreen(_: SectionProps) {
  const [address, setAddress] = useState(() => { try { return localStorage.getItem("llmide.remoteHost") ?? "wss://llm-ide.com/host-api/v1"; } catch { return "wss://llm-ide.com/host-api/v1"; } });
  const [pin, setPin] = useState("");
  const [state, setState] = useState<ConnectionState>({ kind: "idle" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conn = useRef<HostConnection | null>(null);

  useEffect(() => () => { conn.current?.close(); }, []);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const url = normalizeRemoteUrl(address);
      try { localStorage.setItem("llmide.remoteHost", address); } catch { /* private mode */ }
      conn.current?.close();
      const c = new HostConnection({ url, clientName: "LLM-IDE Desktop", clientVersion: "0.0.0", tokens });
      conn.current = c;
      c.onState(setState);
      const result = await c.connect(pin.trim() || undefined);
      if (result === "needsPin") throw new Error("This host withheld its token. Check the address, then pair again with its PIN.");
      if (!c.capabilities.has("read")) throw new Error("This host does not serve the read capability, so its workspace is unavailable.");
      const list = await c.send("projects.list", {}).done;
      setProjects(list.projects);
      setSelected(list.projects[0]?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (state.kind === "ready" && selected && conn.current) {
    const fake = { session: { connection: conn.current }, projects: { selectedId: selected } } as never;
    return (
      <div className="remote-root">
        <header className="remote-bar">
          <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Remote project">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span>{conn.current.hello?.hostName ?? "Remote host"}</span>
          <button type="button" onClick={() => { conn.current?.close(); conn.current = null; setState({ kind: "idle" }); setProjects([]); setSelected(null); }}>Disconnect</button>
        </header>
        {createElement(WorkspaceScreen as unknown as ComponentType<{ ctx: unknown }>, { ctx: fake })}
      </div>
    );
  }

  return (
    <div className="remote-connect">
      <h2>Remote workspace</h2>
      <p>Connect to an LLM-IDE host. Files, git, the agent and the terminal stay on that host.</p>
      <label>Host address<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="wss://host/host-api/v1" spellCheck={false} /></label>
      <label>Pairing PIN<input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" placeholder="6 digits" /></label>
      <button type="button" disabled={busy || address.trim() === ""} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button>
      {error ? <p className="remote-error" role="alert">{error}</p> : null}
      {state.kind === "connecting" || state.kind === "reconnecting" ? <p className="remote-hint">Connecting…</p> : null}
    </div>
  );
}
