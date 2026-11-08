import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call } from "../core-api.ts";
import { decodeHealth, type Health } from "../decoders.ts";
import type { BackendConfig, CoreLogText, DiagnosticsInfo, LegacyImportReport, LegacyImportStatus, SettingsHost } from "../host.ts";
import { canOfferImport, legacyImportSummary } from "../legacy-import-model.ts";
import { describeError } from "../errors.ts";
import { LOG_POLL_MS, LOG_TEXT, componentError, shortPath, singleFlight } from "../components-model.ts";
import { parseBackendUrl } from "../project-model.ts";
import { serverRows } from "../notices.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's "Server & Backend" group: the core's status, version, identity and log file, plus the log itself
 * (the Mac's live log viewer). Start, Stop and Kill & Restart are offered when the host can run them; the app owns the core.
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
  const [coreBusy, setCoreBusy] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement | null>(null);

  // One read at a time: a poll that fires while the last read is still running is dropped (see singleFlight).
  const loadLog = useMemo(
    () =>
      singleFlight(async () => {
        if (!host.coreLog) return;
        try {
          const l = await host.coreLog();
          setLog(l);
          setLogError(null);
        } catch (e) {
          setLogError(componentError(e));
        }
      }),
    [host],
  );

  const load = () => {
    host.diagnostics().then(setInfo, () => setInfo(null));
    call(client, "GET", "/health").then((b) => { setHealth(decodeHealth(b)); setError(null); }, (e) => { setHealth(null); setError(describeError(e)); }).finally(() => setLoaded(true));
    loadLog();
  };
  useRefreshOnFocus(load);
  // The group mounts only while it is open, so the log follows exactly while the user can see it.
  useEffect(() => {
    if (!host.coreLog) return;
    const id = window.setInterval(loadLog, LOG_POLL_MS);
    return () => window.clearInterval(id);
  }, [host, loadLog]);
  useEffect(() => {
    const el = logRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [log, follow]);
  const rows = serverRows(info, health);

  const coreAction = async (what: "start" | "stop" | "restart") => {
    const fn = what === "start" ? host.coreStart : what === "stop" ? host.coreStop : host.coreRestart;
    if (!fn) return;
    setCoreBusy(what);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(what === "stop" ? "Core stopped." : what === "restart" ? "Core restarted." : "Core starting…");
      load();
    } catch (e) {
      setError(componentError(e));
    } finally {
      setCoreBusy(null);
    }
  };

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

      <div className="st-note">
        <span className="st-label">Managed backend</span>
        {host.getBackendConfig && host.setBackendConfig ? <BackendForm host={host} onSaved={load} /> : null}
        {info?.coreUrl ? (
          <div className="st-row">
            <span className="st-hint">Server URL</span>
            <code className="st-pre st-grow">{info.coreUrl}</code>
            <Button onClick={() => void host.copyText(info.coreUrl ?? "").then(() => setNotice("Copied."), () => setLogError("The clipboard is not available."))}>Copy</Button>
          </div>
        ) : <p className="st-hint">Server URL: starting…</p>}
        <p className="st-hint">
          The default backend is the core bundled inside the app. Turn on a source checkout to run the core from a
          checkout with its own Node binary, project folder and loopback port — the same layout the Mac's Backend
          card edits. Changes to those paths apply on Kill &amp; Restart; the launch toggle applies on the next app start.
        </p>
        {host.coreStart || host.coreStop || host.coreRestart ? (
          <div className="st-row">
            {info?.coreState === "stopped" || info?.coreState === "failed" || !info ? (
              <Button tone="primary" disabled={coreBusy !== null} onClick={() => void coreAction("start")}>{coreBusy === "start" ? "Starting…" : "Start backend"}</Button>
            ) : (
              <>
                <Button disabled={coreBusy !== null} onClick={() => void coreAction("stop")}>{coreBusy === "stop" ? "Stopping…" : "Stop backend"}</Button>
                <Button disabled={coreBusy !== null} onClick={() => void coreAction("restart")}>{coreBusy === "restart" ? "Restarting…" : "Kill & Restart"}</Button>
              </>
            )}
            <span className="st-hint">Stop leaves the app open; Start brings the core back. Kill &amp; Restart stops and starts it in one step.</span>
          </div>
        ) : null}
        {notice ? <p className="st-ok" role="status">{notice}</p> : null}
      </div>

      <LegacyImportCard host={host} />

      {host.coreLog ? (
        <div className="st-stack">
          <span className="st-label">{LOG_TEXT.title}</span>
          <p className="st-hint">{LOG_TEXT.hint}</p>
          {log?.path ? <p className="st-hint">{shortPath(log.path)}</p> : null}
          <pre ref={logRef} className="st-log" aria-label="Backend log" tabIndex={0}>{log && log.text.length > 0 ? log.text : LOG_TEXT.empty}</pre>
          <div className="st-row">
            <button type="button" role="checkbox" aria-checked={follow} className="st-btn" onClick={() => setFollow((f) => !f)}>{LOG_TEXT.autoScroll}</button>
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


/** The Mac's editable backend fields: source checkout, node, extension folder, loopback URL and launch toggle. */
function BackendForm({ host, onSaved }: { host: SettingsHost; onSaved: () => void }) {
  const [cfg, setCfg] = useState<BackendConfig | null>(null);
  const [url, setUrl] = useState("http://127.0.0.1:3457");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    host.getBackendConfig?.().then((c) => {
      setCfg(c);
      setUrl(c.port > 0 ? `http://127.0.0.1:${c.port}` : "http://127.0.0.1:3457");
    }, () => setCfg(null));
  }, [host]);
  useEffect(load, [load]);

  if (!cfg) return <p className="st-hint" role="status">Reading the backend settings...</p>;

  const parsePort = (): number | string => {
    if (!cfg.source) return 0;
    const parsed = parseBackendUrl(url);
    return "error" in parsed ? parsed.error : parsed.port;
  };

  const save = async () => {
    const port = parsePort();
    if (typeof port === "string") { setError(port); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const next = await host.setBackendConfig!({ source: cfg.source, port, autoStart: cfg.autoStart });
      setCfg(next);
      setNotice("Backend settings saved. They apply on the next app start.");
      onSaved();
    } catch (e) {
      setError(componentError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="st-stack">
      <label className="st-row">
        <input type="checkbox" checked={cfg.source} onChange={(e) => setCfg({ ...cfg, source: e.target.checked })} />
        <span>Use a source checkout instead of the bundled core</span>
      </label>
      {cfg.source ? (
        <>
          <label className="st-field">
            <span className="st-label">Node binary</span>
            <div className="st-row">
              <input className="st-input st-grow" value={cfg.node} placeholder="Auto-detect (/opt/homebrew/bin/node)" spellCheck={false} readOnly />
              {host.pickNode ? <Button onClick={() => void host.pickNode!().then((p) => p && load())}>Browse…</Button> : null}
            </div>
          </label>
          <label className="st-field">
            <span className="st-label">Project folder (extension)</span>
            <div className="st-row">
              <input className="st-input st-grow" value={cfg.dir} placeholder="Auto-detect: <checkout>/extension" spellCheck={false} readOnly />
              {host.pickBackendDir ? <Button onClick={() => void host.pickBackendDir!().then((p) => p && load())}>Browse…</Button> : null}
            </div>
          </label>
          <label className="st-field">
            <span className="st-label">Server URL</span>
            <input className="st-input" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:3457" />
            <span className="st-hint">Loopback only. The source backend listens on this port; the bundled core uses 3456-3459.</span>
          </label>
        </>
      ) : null}
      <label className="st-row">
        <input type="checkbox" checked={cfg.autoStart} onChange={(e) => setCfg({ ...cfg, autoStart: e.target.checked })} />
        <span>Start backend on app launch</span>
      </label>
      <div className="st-row">
        <Button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save backend settings"}</Button>
      </div>
      {notice ? <p className="st-ok" role="status">{notice}</p> : null}
      <ErrorText text={error} />
    </div>
  );
}


/**
 * Settings → Server & Backend → "Old Mac app data": the explicit, one-time import of the retired
 * Mac app's data folder. Read-only status first; the button is the only way in. Replacing a
 * non-empty desktop folder asks for a native confirmation in the host (and the helper writes a
 * verified backup before the switch). Nothing here imports on its own.
 */
function LegacyImportCard({ host }: { host: SettingsHost }) {
  const [status, setStatus] = useState<LegacyImportStatus | null>(null);
  const [report, setReport] = useState<LegacyImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!host.legacyImportStatus) return;
    host.legacyImportStatus().then(
      (v) => { setStatus(v); setError(null); },
      (e) => setError(componentError(e)),
    );
  }, [host]);
  useEffect(load, [load]);

  if (!host.legacyImportStatus || !host.runLegacyImport) return null;
  const shown = report ?? status;
  const summary = shown ? legacyImportSummary(shown) : null;
  const offer = canOfferImport(shown) && !busy;
  const replacing = shown?.action === "force";

  const run = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await host.runLegacyImport!(force);
      setReport(r);
      setStatus(r);
      // A completed import changed the DB; the backend status above is now stale.
      if (r.status === "completed") load();
    } catch (e) {
      setError(componentError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-note">
      <span className="st-label">Old Mac app data</span>
      {summary ? (
        <p className="st-row" role="status">
          <span className="st-status" data-tone={summary.tone === "ok" ? "ok" : summary.tone === "muted" ? undefined : "warning"}>{summary.title}</span>
          <span className="st-hint st-grow">{summary.detail}</span>
        </p>
      ) : <p className="st-hint" role="status">Reading the old data folder...</p>}
      {shown?.legacy.path ? <p className="st-hint">From {shown.legacy.path}{shown.target.path ? ` to ${shown.target.path}` : ""}</p> : null}
      {shown?.notes?.length ? <p className="st-hint">{shown.notes.join(" ")}</p> : null}
      {report?.keychainBackup ? <p className="st-hint">Previous keychain secrets backed up to {report.keychainBackup}.</p> : null}
      <div className="st-row">
        {offer ? (
          <Button
            tone={replacing ? "danger" : "primary"}
            disabled={busy}
            onClick={() => void run(Boolean(replacing))}
          >
            {busy ? "Importing…" : replacing ? "Replace with old Mac app data…" : "Import old Mac app data…"}
          </Button>
        ) : null}
        <Button disabled={busy} onClick={load}>{busy ? "Working…" : "Refresh"}</Button>
        <span className="st-hint">
          {replacing
            ? "The desktop database is backed up first; the old folder is never changed."
            : "Runs once. The old folder is never changed; the desktop core restarts afterwards."}
        </span>
      </div>
      <ErrorText text={error} />
    </div>
  );
}
