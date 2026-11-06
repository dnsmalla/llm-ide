import { useEffect, useState } from "react";
import AboutSection from "./AboutSection.tsx";
import { PartialNote } from "./NoticeSections.tsx";
import { useEnv } from "../context.tsx";
import { Switch, ErrorText } from "../ui.tsx";
import { updateErrorText, updateSummary, type UpdateStatusView } from "../updates-model.ts";

/** The Mac's "Updates & About" group: the signed-update switch, Check now and Install, then version and diagnostics. */
export default function UpdatesSection() {
  const { host } = useEnv();
  const [on, setOn] = useState<boolean | null>(null);
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    host.getUpdateChecks?.().then((v) => { if (live) setOn(v); }, () => {});
    host.updateStatus?.().then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [host]);
  const run = async (f: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await f(); } catch (e) { setErr(updateErrorText(e)); } finally { setBusy(false); }
  };
  const usable = status?.configured === true && status.installKind === "self";
  return (
    <div className="st-stack">
      {host.updateStatus ? (
        <div className="st-stack">
          <p className="st-hint" role="status">{updateSummary(status)}</p>
          {host.getUpdateChecks && host.setUpdateChecks && on !== null && status?.configured ? (
            <Switch label="Check for updates automatically" hint="Once a day. Only signed LLM-IDE releases are offered, and installing always asks first."
              checked={on} onChange={(v) => void run(async () => { setOn(await host.setUpdateChecks!(v)); })} />
          ) : null}
          {usable ? (
            <div className="st-row">
              <button type="button" disabled={busy} onClick={() => void run(async () => setStatus(await host.checkForUpdate!()))}>Check Now</button>
              {status?.available ? (
                <button type="button" disabled={busy} onClick={() => void run(async () => { await host.installUpdate!(); })}>Install {status.available.version} and Restart</button>
              ) : null}
            </div>
          ) : null}
          {status?.available?.notes ? <pre className="st-hint">{status.available.notes}</pre> : null}
          {err ? <ErrorText text={err} /> : null}
        </div>
      ) : null}
      <AboutSection />
      <PartialNote id="updates" />
    </div>
  );
}
