// Settings → Self-Heal: the daily automatic fix run's switch, time and last result (settings/self-heal-auto.ts). The
// Shell does the runs; this only edits the saved switch and time and shows what the last automatic run said.
import { useState } from "react";
import { Field, Switch } from "../ui.tsx";
import { loadAutoConfig, loadAutoState, readAutoConfig, saveAutoConfig, type AutoConfig } from "../self-heal-auto.ts";

const AUTO_HINT =
  "Runs Try to fix by itself once a day at this time, only while the app is open and only when there are new incidents. You get a notification when a fix is ready to review; nothing is applied without you.";

export default function SelfHealAutoControls() {
  const [config, setConfig] = useState<AutoConfig>(loadAutoConfig);
  const [saveFailed, setSaveFailed] = useState(false);
  const last = loadAutoState().last;
  const save = (next: AutoConfig) => {
    setConfig(next);
    setSaveFailed(!saveAutoConfig(next));
  };
  return (
    <div className="st-stack">
      <Switch label="Try to fix automatically every day" checked={config.enabled} onChange={(on) => save({ ...config, enabled: on })} hint={AUTO_HINT} />
      {config.enabled ? (
        <Field label="Time">
          <input className="st-input" type="time" value={config.time} aria-label="Daily Self-Heal time" onChange={(e) => save(readAutoConfig(JSON.stringify({ enabled: true, time: e.target.value })))} />
        </Field>
      ) : null}
      {saveFailed ? <p className="st-hint" role="alert">This setting could not be saved in this window.</p> : null}
      {last ? <p className="st-hint">{`Last automatic run: ${new Date(last.at).toLocaleString()} — ${last.message}`}</p> : null}
    </div>
  );
}
