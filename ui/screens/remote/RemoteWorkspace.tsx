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
  const [worktrees, setWorktrees] = useState<{ name: string; branch: string; dirty: boolean }[] | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtMessage, setWtMessage] = useState<string | null>(null);
  const [wtDiff, setWtDiff] = useState<string | null>(null);
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

  const wtCall = async (action: "list" | "diff" | "merge" | "remove", name = "") => {
    if (!active.host.projectPath) { setWtMessage("Add a remote project path in Welcome first."); return; }
    setWtBusy(true); setWtMessage(null);
    try {
      const raw = await invokeHost<string>("remote_ssh_worktree", {
        target: { host: active.host.sshHost, port: active.host.port, user: active.host.user, keyPath: active.host.keyPath },
        action, path: active.host.projectPath, name,
      });
      const parsed = JSON.parse(raw) as { worktrees?: { name: string; branch: string; dirty: boolean }[]; merged?: boolean; removed?: boolean; stat?: string; patch?: string; truncated?: boolean };
      if (action === "list") setWorktrees(parsed.worktrees ?? []);
      else if (action === "diff") setWtDiff(`${parsed.stat || ""}\n\n${parsed.patch || ""}${parsed.truncated ? "\n… truncated" : ""}`);
      else { setWtMessage(parsed.merged ? "Merged." : parsed.removed ? "Removed." : raw); await wtCall("list"); }
    } catch (e) { setWtMessage(e instanceof Error ? e.message : String(e)); }
    finally { setWtBusy(false); }
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
        <button type="button" disabled={wtBusy || !active.host.projectPath} onClick={() => void wtCall("list")}>Worktrees</button>
        <button type="button" onClick={() => { closeRemote(); setActive(null); }}>Disconnect</button>
      </header>
      {loopResult ? <pre className="remote-loop-result" aria-live="polite">{loopResult}</pre> : null}
      {worktrees ? (
        <div className="remote-worktrees">
          <div className="remote-worktrees-head"><strong>Loop worktrees</strong><button type="button" onClick={() => setWorktrees(null)}>Close</button></div>
          {wtMessage ? <p className="remote-wt-msg">{wtMessage}</p> : null}
          {worktrees.length === 0 ? <p className="remote-wt-msg">No worktrees.</p> : worktrees.map((w) => (
            <div className="remote-wt-row" key={w.name}>
              <span>{w.name} · {w.branch}{w.dirty ? " · uncommitted" : ""}</span>
              <button type="button" disabled={wtBusy} onClick={() => void wtCall("diff", w.name)}>Diff</button>
              <button type="button" disabled={wtBusy} onClick={() => void wtCall("merge", w.name)}>Merge</button>
              <button type="button" disabled={wtBusy || w.dirty} onClick={() => void wtCall("remove", w.name)}>Remove</button>
            </div>
          ))}
          {wtDiff ? <pre className="remote-wt-diff">{wtDiff}</pre> : null}
        </div>
      ) : null}
      {createElement(WorkspaceScreen as unknown as ComponentType<{ ctx: unknown }>, { ctx: fake })}
    </div>
  );
}
