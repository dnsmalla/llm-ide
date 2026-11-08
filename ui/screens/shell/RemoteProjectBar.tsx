// Remote mode's project picker: the hub's projects with the caller's effective role. It never reads a
// local folder; selecting one scopes every project-scoped request to that project id.
import { useEffect, useState, type ReactNode } from "react";
import { core, coreStatusStore } from "./runtime";
import { RemoteProjects, type RemoteProject } from "./remote-projects";
import { setRemoteProjectId } from "./remote-selection";

// Selection is in memory only: the token-storage invariant allows web storage for the theme,
// section id and home section only. A reload starts from the first hub project.
const memory = new Map<string, string>();
const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); } };

export function RemoteProjectBar(): ReactNode {
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const status = coreStatusStore.getSnapshot().status;
    const key = status?.url ? status.url.replace(/\/[^/]+$/, "") : "hub";
    const store = new RemoteProjects(core, storage, key);
    let live = true;
    void store.whenReady().then(() => {
      if (!live) return;
      setProjects(store.getState().projects);
      setSelected(store.getState().selectedId);
      setRemoteProjectId(store.getState().selectedId);
      setError(store.getState().error);
    });
    const off = store.subscribe(() => { if (!live) return; setProjects(store.getState().projects); setSelected(store.getState().selectedId); setError(store.getState().error); });
    return () => { live = false; off(); };
  }, []);
  if (error) return <span className="sh-hint" role="status">Hub projects: {error}</span>;
  if (projects.length === 0) return <span className="sh-hint" role="status">Loading hub projects…</span>;
  const role = projects.find((p) => p.id === selected)?.role ?? "viewer";
  return (
    <label className="sh-row" aria-label="Hub project">
      <span className="sh-hint">Project</span>
      <select className="sh-input" value={selected ?? ""} onChange={(e) => { const id = e.currentTarget.value; setSelected(id); setRemoteProjectId(id); }}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <span className="sh-hint">{role}</span>
    </label>
  );
}
