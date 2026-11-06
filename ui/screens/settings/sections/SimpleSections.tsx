// Appearance, Workspace, Features: small sections that share one file (one lazy chunk each
// is not worth it for a few lines; the heavy ones have their own files).
import { useEffect, useState } from "react";
import { HOME_CHOICES, readHome, SECTIONS, storeHome } from "@llmide/screens/shell";
import { call } from "../core-api.ts";
import { decodeHealth, type Health } from "../decoders.ts";
import { describeError } from "../errors.ts";
import { featureRows, THEME_CHOICES } from "../misc-model.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import type { SettingsHost, ThemeChoice } from "../host.ts";
import { Button, ErrorText, NeedsHost, Switch } from "../ui.tsx";

export function AppearanceSection() {
  const { host } = useEnv();
  const [theme, setTheme] = useState<ThemeChoice | null>(host.getTheme?.() ?? null);
  if (!host.getTheme || !host.setTheme) return <NeedsHost what="The theme choice" />;
  return (
    <div className="st-stack" role="radiogroup" aria-label="Theme">
      {THEME_CHOICES.map((t) => (
        <label key={t.id} className="st-row">
          <input type="radio" name="theme" checked={theme === t.id} onChange={() => { setTheme(t.id); host.setTheme!(t.id); }} />
          {t.label}
        </label>
      ))}
    </div>
  );
}

export function WorkspaceSection() {
  const { host } = useEnv();
  const [notes, setNotes] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [home, setHome] = useState(() => readHome());
  useEffect(() => {
    let live = true;
    void host.notesFolderPath?.().then((p) => { if (live) { setNotes(p); setAsked(true); } });
    return () => { live = false; };
  }, [host]);
  const project = host.activeProjectPath?.() ?? null;
  return (
    <div className="st-stack">
      <div className="st-grid-2">
        <div className="st-info-card"><span className="st-label">Active project</span>{host.activeProjectPath ? <p>{project ?? "No project is open."}</p> : <NeedsHost what="The active project" />}</div>
        <div className="st-info-card"><span className="st-label">Notes folder</span>{host.notesFolderPath ? <p>{asked ? notes ?? "Not chosen yet." : "Loading..."}</p> : <NeedsHost what="The notes folder" />}</div>
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

export function FeaturesSection() {
  const { client, host } = useEnv();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = () => {
    call(client, "GET", "/health").then((b) => { setHealth(decodeHealth(b)); setError(null); }, (e) => setError(describeError(e))).finally(() => setLoaded(true));
  };
  useRefreshOnFocus(load);
  const rows = featureRows(health);
  return (
    <div className="st-stack">
      <ErrorText text={error} />
      {loaded ? <p>{rows.note}</p> : <p className="st-hint" role="status">Loading...</p>}
      {rows.enabled.length > 0 ? <ul aria-label="Enabled features">{rows.enabled.map((f) => <li key={f}>{f}</li>)}</ul> : null}
      <Button label="Reload features" onClick={load}>Reload</Button>
      <TerminalToggle host={host} />
    </div>
  );
}

function TerminalToggle({ host }: { host: SettingsHost }) {
  const { getExtraPrefs, setExtraPrefs } = host;
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void getExtraPrefs?.().then((p) => { if (live) setOn(p.terminal); });
    return () => { live = false; };
  }, [getExtraPrefs]);
  if (!getExtraPrefs || !setExtraPrefs) return <NeedsHost what="The Terminal switch" />;
  if (on === null) return null;
  return <Switch label="Terminal" checked={on} hint="Applies next launch." onChange={(v) => { setOn(v); void setExtraPrefs({ terminal: v }); }} />;
}
