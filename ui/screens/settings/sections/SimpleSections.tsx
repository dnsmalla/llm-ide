// Appearance, Workspace, Features: small sections that share one file (one lazy chunk each
// is not worth it for a few lines; the heavy ones have their own files).
import { useEffect, useState } from "react";
import { call } from "../core-api.ts";
import { decodeHealth, type Health } from "../decoders.ts";
import { describeError } from "../errors.ts";
import { featureRows, THEME_CHOICES } from "../misc-model.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import type { ThemeChoice } from "../host.ts";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";

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
      <p className="st-hint">The theme applies at once and is remembered on this computer.</p>
    </div>
  );
}

export function WorkspaceSection() {
  const { host } = useEnv();
  const [notes, setNotes] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    let live = true;
    void host.notesFolderPath?.().then((p) => { if (live) { setNotes(p); setAsked(true); } });
    return () => { live = false; };
  }, [host]);
  const project = host.activeProjectPath?.() ?? null;
  return (
    <div className="st-stack">
      <div className="st-stack">
        <span className="st-label">Active project</span>
        {host.activeProjectPath ? <p>{project ?? "No project is open."}</p> : <NeedsHost what="The active project" />}
      </div>
      <div className="st-stack">
        <span className="st-label">Notes folder</span>
        {host.notesFolderPath ? <p>{asked ? notes ?? "Not chosen yet." : "Loading..."}</p> : <NeedsHost what="The notes folder" />}
        {host.pickFolder && host.notesFolderPath ? <p className="st-hint">Changing the notes folder is done from the Library, which owns the move of existing notes.</p> : null}
      </div>
    </div>
  );
}

export function FeaturesSection() {
  const { client } = useEnv();
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
      <p className="st-hint">This list is read-only. Features are chosen when the backend starts.</p>
      <Button label="Reload features" onClick={load}>Reload</Button>
    </div>
  );
}
