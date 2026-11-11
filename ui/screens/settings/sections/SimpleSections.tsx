// Appearance, Workspace, Features: small sections that share one file (one lazy chunk each
// is not worth it for a few lines; the heavy ones have their own files).
import { useEffect, useState } from "react";
import { HOME_CHOICES, readHome, SECTIONS, storeHome } from "@llmide/screens/shell";
import { shellBus } from "../../shell/bus";
import { useEnv } from "../context.tsx";
import type { SettingsHost } from "../host.ts";
import { Button, NeedsHost, Switch } from "../ui.tsx";

export function WorkspaceSection() {
  const { host } = useEnv();
  const [home, setHome] = useState(() => readHome());
  const project = host.activeProjectPath?.() ?? null;
  return (
    <div className="st-stack">
      <div className="st-info-card"><span className="st-label">Active project</span>{host.activeProjectPath ? <p>{project ?? "No project is open."}</p> : <NeedsHost what="The active project" />}</div>
      <div className="st-row">
        <Button onClick={() => shellBus.publish({ type: "goto-section", section: "library" })}>Open Library connectors</Button>
        <span className="st-hint">Source credentials and syncing live in Library, not duplicated here.</span>
      </div>
      <label className="st-field">
        <span className="st-label">Home page</span>
        <select
          className="st-select"
          value={home}
          onChange={(e) => {
            const id = e.currentTarget.value;
            if (!(HOME_CHOICES as readonly string[]).includes(id)) return;
            const next = id as (typeof HOME_CHOICES)[number];
            setHome(next);
            storeHome(next);
          }}
        >
          {SECTIONS.filter((s) => (HOME_CHOICES as readonly string[]).includes(s.id)).map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <span className="st-hint">Applies at once.</span>
      </label>
    </div>
  );
}

export function TerminalToggle({ host }: { host: SettingsHost }) {
  const { getExtraPrefs, setExtraPrefs } = host;
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void getExtraPrefs?.().then((p) => { if (live) setOn(p.terminal); });
    return () => { live = false; };
  }, [getExtraPrefs]);
  if (!getExtraPrefs || !setExtraPrefs) return <NeedsHost what="The Terminal switch" />;
  if (on === null) return null;
  return <Switch label="Terminal" checked={on} hint="Opens a shell inside the app after a native confirmation. Applies next launch." onChange={(v) => { setOn(v); void setExtraPrefs({ terminal: v }); }} />;
}
