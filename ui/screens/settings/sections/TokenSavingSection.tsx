import { useCallback, useEffect, useState } from "react";
import type { RtkStatus } from "../host.ts";
import { RTK_TEXT, componentError, decodeRtkStatus } from "../components-model.ts";
import { useEnv } from "../context.tsx";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";

/**
 * The Mac's "Token Saving" group: whether rtk is installed, and the Homebrew install button.
 * Detection and the install both run in the host (a native dialog names the command first); the page never
 * spawns a process and never supplies a command.
 */
export default function TokenSavingSection() {
  const { host } = useEnv();
  const [status, setStatus] = useState<RtkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const can = Boolean(host.rtkStatus && host.installRtk);

  const load = useCallback(() => {
    host.rtkStatus?.().then(
      (s) => setStatus(decodeRtkStatus(s) ?? null),
      (e) => setError(componentError(e)),
    );
  }, [host]);
  useEffect(() => {
    if (can) load();
  }, [can, load]);

  if (!can) return <NeedsHost what="rtk detection" />;

  const install = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await host.installRtk!();
      const s = decodeRtkStatus(next);
      setStatus(s);
      setNotice(s?.installed ? "rtk installed." : "Nothing changed.");
      if (!s?.installed) load();
    } catch (e) {
      setError(componentError(e));
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-stack">
      <p className="st-hint">{RTK_TEXT.hint}</p>
      <ErrorText text={error} />
      <div className="st-row">
        <span className="st-label">rtk</span>
        <span className="st-status" data-tone={status?.installed ? "ok" : status ? "warning" : undefined}>
          {status === null ? RTK_TEXT.checking : status.installed ? status.version ?? "Installed" : RTK_TEXT.absent}
        </span>
        <Button disabled={busy} onClick={load}>Check again</Button>
      </div>
      {status?.installed ? <p className="st-hint">{RTK_TEXT.enable}</p> : null}
      {status && !status.installed && !status.canInstall ? <p className="st-hint">{RTK_TEXT.brewMissing}</p> : null}
      {status && !status.installed && status.canInstall ? (
        <div className="st-row">
          <Button tone="primary" disabled={busy} onClick={() => void install()}>
            {busy ? RTK_TEXT.installing : RTK_TEXT.install}
          </Button>
        </div>
      ) : null}
      {busy ? <p className="st-hint" role="status">{RTK_TEXT.installing}</p> : null}
      {notice ? <p className="st-ok" role="status">{notice}</p> : null}
    </div>
  );
}
