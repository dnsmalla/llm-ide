// Read-only git changes for the selected host project.
import { useCallback, useEffect, useState } from "react";
import type { HostLink } from "../host-api/connection.ts";
import { gitDiff, gitStatus } from "./api.ts";
import { statusLabel } from "./model.ts";
import "./changes.css";

interface Entry { path: string; x: string; y: string; status: string; from?: string }
interface Status { branch: string; ahead: number; behind: number; clean: boolean; entries: Entry[] }

export function Changes({ link, projectId, onOpen, onClose }: { link: HostLink; projectId: string; onOpen(path: string): void; onClose(): void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void gitStatus(link, projectId).then((s) => {
      if (!live) return;
      setStatus(s);
      setSelected((cur) => cur && s.entries.some((e) => e.path === cur) ? cur : s.entries[0]?.path ?? null);
    }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [link, projectId, tick]);

  useEffect(() => {
    if (!selected) { setPatch(""); setTruncated(false); return; }
    let live = true;
    void gitDiff(link, projectId, selected).then((d) => {
      if (live) { setPatch(d.patch); setTruncated(d.truncated); }
    }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [link, projectId, selected]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  if (error) return <div className="chg-pane"><p className="ws-error" role="alert">{error}</p><button type="button" onClick={refresh}>Retry</button></div>;
  if (!status) return <div className="chg-pane"><p className="ws-hint">Reading changes…</p></div>;
  return (
    <div className="chg-pane">
      <header className="chg-head">
        <strong>{status.branch}</strong>
        {status.ahead > 0 ? <span>↑{status.ahead}</span> : null}
        {status.behind > 0 ? <span>↓{status.behind}</span> : null}
        <button type="button" onClick={onClose}>Files</button>
        <button type="button" onClick={refresh}>Refresh</button>
      </header>
      {status.clean ? <p className="ws-hint">No changes.</p> : (
        <div className="chg-body">
          <ul className="chg-list">
            {status.entries.map((e) => (
              <li key={e.path}>
                <button type="button" className={e.path === selected ? "ws-on" : undefined} onClick={() => setSelected(e.path)}>
                  <b data-s={statusLabel(e.x, e.y)}>{statusLabel(e.x, e.y)}</b> {e.path}
                </button>
                <button type="button" className="chg-open" onClick={() => onOpen(e.path)}>Open</button>
              </li>
            ))}
          </ul>
          <div className="chg-diff">
            {truncated ? <p className="ws-hint">Diff truncated at 256 KiB.</p> : null}
            <pre>{patch || "No textual diff."}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
