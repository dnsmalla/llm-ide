import { useEffect, useState } from "react";
import { useEnv } from "../context.tsx";
import { applyBypassSkip, BYPASS_SKIP_TEXT } from "../bypass-skip-model.ts";
import { ErrorText, Switch } from "../ui.tsx";

/** "Don't ask before Bypass": shown only with a desktop host. Turning it on opens the host's own dialog. */
export default function BypassSkipSwitch() {
  const { host } = useEnv();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    host.getBypassSkipConfirm?.().then((v) => { if (live) setOn(v); }, () => {});
    return () => { live = false; };
  }, [host]);
  if (!host.getBypassSkipConfirm || !host.setBypassSkipConfirm || on === null) return null;
  const change = async (v: boolean) => {
    setBusy(true);
    setError(null);
    try { const r = await applyBypassSkip(host, v, on); setOn(r.value); setError(r.error); } finally { setBusy(false); }
  };
  return (
    <div className="st-stack">
      <span className="st-label">Bypass</span>
      <Switch label={BYPASS_SKIP_TEXT.label} hint={BYPASS_SKIP_TEXT.hint} checked={on} disabled={busy} onChange={(v) => void change(v)} />
      <ErrorText text={error} />
    </div>
  );
}
