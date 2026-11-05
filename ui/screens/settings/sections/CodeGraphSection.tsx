// Code Graph auto-update: a host timer regenerates the code+memory graph on project open/switch and every N
// minutes. File-watch debouncing is still Mac-only; this card says so instead of claiming full parity.
import { useEffect, useState } from "react";
import { useEnv } from "../context.tsx";
import { Button, ErrorText, Field, NeedsHost } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

export default function CodeGraphSection() {
  const { host } = useEnv();
  const [minutes, setMinutes] = useState<number | null>(null);
  const [draft, setDraft] = useState("0");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!host.getGraphAutoUpdate) return;
    let live = true;
    host.getGraphAutoUpdate().then((v) => { if (live) { setMinutes(v); setDraft(String(v)); } }, () => { if (live) setError("The host could not read the Code Graph setting."); });
    return () => { live = false; };
  }, [host]);

  if (!host.getGraphAutoUpdate || !host.setGraphAutoUpdate) return <NeedsHost what="The Code Graph timer, stored on this computer" />;
  if (minutes === null) return error ? <ErrorText text={error} /> : <p className="st-hint" role="status">Reading the Code Graph setting...</p>;

  const normalize = (raw: string): number => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return 0;
    return v === 0 ? 0 : Math.max(5, Math.min(1440, Math.round(v)));
  };
  const save = async () => {
    const target = normalize(draft);
    setMinutes(target);
    setDraft(String(target));
    setBusy(true);
    setError(null);
    try {
      setMinutes(await host.setGraphAutoUpdate!(target));
      setSaved(true);
    } catch {
      setError("The Code Graph setting could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-stack">
      <p className="st-hint">The host refreshes the code graph when a project opens or switches, then on this interval while the app runs. 0 turns it off. File edits are not watched yet; use Generate in Graph for an immediate refresh.</p>
      <Field label="Refresh every (minutes)" hint="0 = off, otherwise 5-1440">
        <input className="st-input" type="text" inputMode="numeric" value={draft} aria-label="Code Graph refresh interval in minutes" onChange={(e) => {
          setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 4));
          setSaved(false);
        }} onBlur={() => { const v = normalize(draft); setDraft(String(v)); setMinutes(v); }} />
      </Field>
      <div className="st-row">
        <Button tone="primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
        {saved ? <span className="st-ok" role="status">Saved; the running timer uses it from now on.</span> : null}
      </div>
      {error ? <ErrorText text={error} /> : null}
      <PartialNote id="code-graph" />
    </div>
  );
}
