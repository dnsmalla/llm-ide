import { createElement, useState, type ComponentType } from "react";
import { WorkspaceScreen } from "../../../web/src/workspace/Workspace.tsx";
import { closeRemote, getRemote, setSelectedRemote } from "./session.ts";

/** The connected workspace; the Welcome card or the Remote section both land here. */
export function RemoteWorkspace() {
  const initial = getRemote();
  const [active, setActive] = useState(initial);
  const [selected, setSelected] = useState(initial?.selected ?? null);
  if (!active || !selected) return null;
  const fake = { session: { connection: active.conn }, projects: { selectedId: selected } } as never;
  return (
    <div className="remote-root">
      <header className="remote-bar">
        <select value={selected} onChange={(e) => { setSelected(e.target.value); setSelectedRemote(e.target.value); }} aria-label="Remote project">
          {active.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span>{active.conn.hello?.hostName ?? "Remote host"}</span>
        <button type="button" onClick={() => { closeRemote(); setActive(null); }}>Disconnect</button>
      </header>
      {createElement(WorkspaceScreen as unknown as ComponentType<{ ctx: unknown }>, { ctx: fake })}
    </div>
  );
}
