import { useCallback, useState } from "react";
import { call } from "../core-api.ts";
import { decodeHealth, type Health } from "../decoders.ts";
import type { CoreLogText, DiagnosticsInfo } from "../host.ts";
import { describeError } from "../errors.ts";
import { LOG_TEXT, componentError, shortPath } from "../components-model.ts";
import { serverRows } from "../notices.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's "Server & Backend" group: the core's status, version, identity and log file, plus the log itself
 * (the Mac's live log viewer). Starting/stopping the backend by hand is not offered: the app owns the core.
 */
export default function ServerSection() {
  const { client, host } = useEnv();
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [log, setLog] = useState<CoreLogText | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadLog = useCallback(() => {
    if (!host.coreLog) return;
    host.coreLog().then((l) => { setLog(l); setLogError(null); }, (e) => setLogError(componentError(e)));
  }, [host]);

  const load = () => {
    host.diagnostics().then(setInfo, () => setInfo(null));
    call(client, "GET", "/health").then((b) => { setHealth(decodeHealth(b)); setError(null); }, (e) => { setHealth(null); setError(describeError(e)); }).finally(() => setLoaded(true));
    loadLog();
  };
  useRefreshOnFocus(load);
  const rows = serverRows(info, health);

  const copyLog = async () => {
    try {
      await host.copyText(log?.text ?? "");
      setNotice("Copied.");
    } catch {
      setLogError("The clipboard is not available.");
    }
  };
  const clearLog = async () => {
    if (!host.clearCoreLog) return;
    try {
      await host.clearCoreLog();
      setConfirmClear(false);
      setNotice(LOG_TEXT.cleared);
      loadLog();
    } catch (e) {
      setLogError(componentError(e));
    }
  };

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

      {host.coreLog ? (
        <div className="st-stack">
          <span className="st-label">{LOG_TEXT.title}</span>
          <p className="st-hint">{LOG_TEXT.hint}</p>
          {log?.path ? <p className="st-hint">{shortPath(log.path)}</p> : null}
          <pre className="st-log" aria-label="Backend log" tabIndex={0}>{log && log.text.length > 0 ? log.text : LOG_TEXT.empty}</pre>
          <div className="st-row">
            <Button onClick={loadLog}>Refresh log</Button>
            <Button onClick={() => void copyLog()} disabled={!log || log.text.length === 0}>Copy</Button>
            {host.clearCoreLog ? (
              confirmClear ? (
                <>
                  <Button tone="danger" onClick={() => void clearLog()}>Clear log</Button>
                  <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
                </>
              ) : (
                <Button onClick={() => setConfirmClear(true)} disabled={!log?.exists}>{LOG_TEXT.clear}</Button>
              )
            ) : null}
          </div>
          {confirmClear ? <p className="st-hint" role="alert">{LOG_TEXT.clearConfirm}</p> : null}
          {notice ? <p className="st-ok" role="status">{notice}</p> : null}
          <ErrorText text={logError} />
        </div>
      ) : null}

      <PartialNote id="server" />
    </div>
  );
}
