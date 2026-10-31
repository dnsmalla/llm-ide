import { useState } from "react";
import { call } from "../core-api.ts";
import { decodeHealth, type Health } from "../decoders.ts";
import type { DiagnosticsInfo } from "../host.ts";
import { describeError } from "../errors.ts";
import { serverRows } from "../notices.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/** The Mac's "Server & Backend" group, read-only on the desktop: the core's status, version, identity and log file. */
export default function ServerSection() {
  const { client, host } = useEnv();
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = () => {
    host.diagnostics().then(setInfo, () => setInfo(null));
    call(client, "GET", "/health").then((b) => { setHealth(decodeHealth(b)); setError(null); }, (e) => { setHealth(null); setError(describeError(e)); }).finally(() => setLoaded(true));
  };
  useRefreshOnFocus(load);
  const rows = serverRows(info, health);
  return (
    <div className="st-stack">
      <ErrorText text={error} />
      {loaded ? (
        <dl className="st-stack" aria-label="Backend status">
          {rows.map((r) => (
            <div key={r.label} className="st-row"><dt className="st-label">{r.label}</dt><dd><span className="st-status" data-tone={r.tone}>{r.value}</span></dd></div>
          ))}
        </dl>
      ) : <p className="st-hint" role="status">Loading...</p>}
      <div className="st-row"><Button label="Refresh backend status" onClick={load}>Refresh</Button></div>
      <PartialNote id="server" />
    </div>
  );
}
