// App-wide Loop defaults: the budgets and policy a newly detected project's default loops inherit. These are host
// prefs, not project files: an existing loop is never changed. The Mac keeps the same card in Settings.
import { useEffect, useState } from "react";
import { useEnv } from "../context.tsx";
import type { LoopDefaults } from "../../shell/host-prefs.ts";
import { Button, ErrorText, Field, NeedsHost, Switch } from "../ui.tsx";

const POLICY: { id: LoopDefaults["protectedPathPolicy"]; label: string }[] = [
  { id: "revert", label: "Revert the edit and stop" },
  { id: "stop", label: "Leave it and stop" },
  { id: "warn", label: "Warn and continue" },
  { id: "off", label: "No check" },
];

export default function LoopDefaultsSection() {
  const { host } = useEnv();
  const [draft, setDraft] = useState<LoopDefaults | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!host.getLoopDefaults) return;
    let live = true;
    host.getLoopDefaults().then((d) => { if (live) setDraft(d); }, () => { if (live) setError("The host could not read the Loop defaults."); });
    return () => { live = false; };
  }, [host]);

  if (!host.getLoopDefaults || !host.setLoopDefaults) {
    return <NeedsHost what="The Loop defaults, stored on this computer" />;
  }
  if (!draft) {
    return error ? <ErrorText text={error} /> : <p className="st-hint" role="status">Reading the Loop defaults...</p>;
  }

  const n = (key: keyof LoopDefaults, value: string, min: number, max: number) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    setDraft({ ...draft, [key]: Math.max(min, Math.min(max, Math.round(v))) });
    setSaved(false);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setDraft(await host.setLoopDefaults!(draft));
      setSaved(true);
    } catch {
      setError("The Loop defaults could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-stack">
      <p className="st-hint">These apply the first time a project's default loops are added. A project that already has a loop keeps it; edit that loop in the Loop screen.</p>
      <Field label="Max iterations" hint="1-100">
        <input className="st-input" type="number" min={1} max={100} value={draft.maxIterations} onChange={(e) => n("maxIterations", e.target.value, 1, 100)} aria-label="Max iterations" />
      </Field>
      <Field label="Stop after consecutive failures" hint="1-20">
        <input className="st-input" type="number" min={1} max={20} value={draft.consecutiveFailureStop} onChange={(e) => n("consecutiveFailureStop", e.target.value, 1, 20)} aria-label="Stop after consecutive failures" />
      </Field>
      <Field label="Wall-clock limit (minutes)" hint="0 = no limit">
        <input className="st-input" type="number" min={0} max={1440} value={draft.wallClockMinutes} onChange={(e) => n("wallClockMinutes", e.target.value, 0, 1440)} aria-label="Wall-clock limit in minutes" />
      </Field>
      <Field label="Repairs per stage" hint="0-20">
        <input className="st-input" type="number" min={0} max={20} value={draft.maxRepairsPerStage} onChange={(e) => n("maxRepairsPerStage", e.target.value, 0, 20)} aria-label="Repairs per stage" />
      </Field>
      <Field label="Pause timeout (minutes)" hint="0 = no limit">
        <input className="st-input" type="number" min={0} max={240} value={draft.pauseTimeoutMinutes} onChange={(e) => n("pauseTimeoutMinutes", e.target.value, 0, 240)} aria-label="Pause timeout in minutes" />
      </Field>
      <Field label="If a repair edits a protected path" hint="Tests, build files, and system/ are protected.">
        <select className="st-select" value={draft.protectedPathPolicy} onChange={(e) => { setDraft({ ...draft, protectedPathPolicy: e.target.value as LoopDefaults["protectedPathPolicy"] }); setSaved(false); }} aria-label="Protected path policy">
          {POLICY.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Field>
      {draft.protectedPathPolicy === "off" ? <p className="st-warning" role="alert">With no check, a repair can delete the failing test and the run will report success.</p> : null}
      <Switch label="Write a run summary note to the Library" checked={draft.writeSummaryNote} onChange={(v) => { setDraft({ ...draft, writeSummaryNote: v }); setSaved(false); }} />
      {error ? <ErrorText text={error} /> : null}
      <div className="st-actions">
        <Button tone="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving..." : "Save loop defaults"}</Button>
        {saved ? <span className="st-ok" role="status">Saved.</span> : null}
      </div>
    </div>
  );
}
