import { useState } from "react";
import { AgentSdkModel, SDK_TEXT, sdkLogText } from "../app-model.ts";
import { useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import { Button, ErrorText, TypedConfirm } from "../ui.tsx";

const v = (x: string | null | undefined): string => x ?? "Unknown";

/** The Mac's "Claude Agent SDK" group: running / installed / latest version and the in-place update. */
export default function AgentSdkSection() {
  const { client } = useEnv();
  const m = useModel(() => new AgentSdkModel(client));
  const s = useStore(m);
  const [confirming, setConfirming] = useState(false);
  useRefreshOnFocus(() => void m.load(false));
  const st = s.status;
  const log = sdkLogText(s.result?.log ?? null);
  return (
    <div className="st-stack">
      <p className="st-hint">{SDK_TEXT.hint}</p>
      <ErrorText text={s.error} />
      {st ? (
        <dl className="st-stack" aria-label="Agent SDK versions">
          <div className="st-row"><dt className="st-label">Running</dt><dd>{v(st.running)}</dd></div>
          {st.restartNeeded ? <div className="st-row"><dt className="st-label">Installed</dt><dd>{v(st.installed)}</dd></div> : null}
          <div className="st-row"><dt className="st-label">Latest</dt><dd>{v(st.latest)}</dd></div>
        </dl>
      ) : s.error ? null : <p className="st-hint" role="status">Loading...</p>}
      {st?.error ? <p className="st-hint">Could not check for updates: {st.error}</p> : null}
      {st && !st.canUpdate ? <p className="st-hint">{SDK_TEXT.remoteOff}</p> : null}
      {st?.restartNeeded || s.result?.restartNeeded ? <p className="st-hint" role="status">{SDK_TEXT.restartNote}</p> : null}
      {s.result ? <p className={s.result.ok ? "st-ok" : "st-error"} role="status">{s.result.ok ? (s.result.rolledBack ? "The update did not load and was rolled back." : `Updated to ${v(s.result.to)}.`) : "The update did not run."}</p> : null}
      {log ? <pre className="st-pre" aria-label="Update log">{log}</pre> : null}
      {s.updating ? <p className="st-hint" role="status">Updating. Downloading can take a few minutes...</p> : null}
      <div className="st-row">
        <Button label="Check now" disabled={s.checking || s.updating} onClick={() => void m.load(true)}>Check now</Button>
        {st?.updateAvailable && st.canUpdate ? <Button tone="primary" disabled={s.updating} onClick={() => setConfirming(true)}>{`Update to ${v(st.latest)}...`}</Button> : null}
      </div>
      {confirming ? (
        <TypedConfirm
          title="Update the Claude Agent SDK?"
          body={<p>{SDK_TEXT.confirmBody}</p>}
          word={SDK_TEXT.confirmWord}
          actionLabel="Update"
          busy={s.updating}
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); void m.update(); }}
        />
      ) : null}
    </div>
  );
}
