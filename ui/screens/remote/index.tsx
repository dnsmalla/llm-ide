// Native desktop remote client: connect to another LLM-IDE host over Host API v1 and use its workspace. The project,
// files, git, agent and terminal stay on the remote host; this window only sends commands and receives one file.
import { useState } from "react";
import type { SectionProps } from "../shell/sections";
import { RemoteWorkspace } from "./RemoteWorkspace.tsx";
import { connectRemote, getRemote } from "./session.ts";
import "./remote.css";

export default function RemoteScreen(_: SectionProps) {
  const [active, setActive] = useState(() => getRemote());
  const [address, setAddress] = useState(() => { try { return localStorage.getItem("llmide.remoteHost") ?? "wss://llm-ide.com/host-api/v1"; } catch { return "wss://llm-ide.com/host-api/v1"; } });
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (active) return <RemoteWorkspace />;

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      try { localStorage.setItem("llmide.remoteHost", address); } catch { /* private mode */ }
      setActive(await connectRemote(address, pin));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="remote-connect">
      <h2>Remote workspace</h2>
      <p>Connect to an LLM-IDE host. Files, git, the agent and the terminal stay on that host.</p>
      <label>Host address<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="wss://host/host-api/v1" spellCheck={false} /></label>
      <label>Pairing PIN<input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" placeholder="6 digits" /></label>
      <button type="button" disabled={busy || address.trim() === ""} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button>
      {error ? <p className="remote-error" role="alert">{error}</p> : null}
    </div>
  );
}
