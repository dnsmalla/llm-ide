import { useCallback, useEffect, useState } from "react";
import {
  ALL_FEATURES,
  FEATURES,
  FEATURE_TEXT,
  PRESETS,
  compiledFeatures,
  dependentsOf,
  featureDef,
  presetFor,
  shellBus,
  validateFeatures,
  type AppFeature,
} from "@llmide/screens/shell";
import { useEnv } from "../context.tsx";
import { ErrorText, NeedsHost } from "../ui.tsx";
import { TOOLBAR_IDS, readHiddenToolbar, writeHiddenToolbar } from "../../shell/toolbar-model";
import { SECTIONS } from "../../shell/sections";
import { savedProfileNotice } from "./feature-profile-notice";

const label = (f: AppFeature): string => featureDef(f).label;
const names = (list: readonly AppFeature[]): string => list.map(label).join(", ");

/**
 * The Mac's Workspace profile: presets and one switch per feature, with the dependency rule (disabling File Explorer
 * also disables Graph, Gantt and Doc Gen) applied exactly as `AppFeature.validated` does. A feature the running core
 * has but this build did not compile cannot be switched on. Changes are stored at once and apply at the next start,
 * like the host's other prefs — the core's `LLMIDE_FEATURES` is fixed when it spawns.
 */
export function FeatureProfileSection() {
  const { host } = useEnv();
  const [stored, setStored] = useState<Set<AppFeature> | null>(null);
  const [launch, setLaunch] = useState<Set<AppFeature> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const compiled = compiledFeatures();

  const load = useCallback(() => {
    host.getFeatureProfile?.().then(
      (p) => {
        setStored(validateFeatures(p.stored.length ? p.stored : ALL_FEATURES));
        setLaunch(validateFeatures(p.launch.length ? p.launch : ALL_FEATURES));
      },
      (e) => setError(e instanceof Error ? e.message : "The feature profile could not be read."),
    );
  }, [host]);
  useEffect(() => {
    if (host.getFeatureProfile) load();
  }, [host, load]);

  if (!host.getFeatureProfile || !host.setFeatureProfile) return <NeedsHost what="The feature profile" />;
  if (!stored || !launch) return <p className="st-hint" role="status">Reading the feature profile...</p>;

  // `dropped` is shown with the confirmation: setting it separately was overwritten by the "Saved" notice after the await.
  const save = async (next: Set<AppFeature>, dropped: readonly AppFeature[] = []) => {
    const valid = validateFeatures(next);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const p = await host.setFeatureProfile!([...valid]);
      setStored(validateFeatures(p.stored.length ? p.stored : ALL_FEATURES));
      setLaunch(validateFeatures(p.launch.length ? p.launch : ALL_FEATURES));
      setNotice(savedProfileNotice(names(dropped)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The feature profile could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = (f: AppFeature, on: boolean) => {
    const next = new Set(stored);
    if (on) {
      next.add(f);
      // Turning a feature on pulls its required dependencies in.
      for (const req of featureDef(f).requires) next.add(req);
    } else {
      next.delete(f);
    }
    const valid = validateFeatures(next);
    const dropped = [...next].filter((x) => !valid.has(x));
    void save(valid, dropped);
  };

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p || !p.features) return;
    void save(new Set(p.features));
  };

  const currentPreset = presetFor(stored);
  const pending = [...stored].sort().join(",") !== [...launch].sort().join(",");
  return (
    <div className="st-stack">
      <label className="st-field">
        <span className="st-label">Profile</span>
        <select className="st-select" value={currentPreset} disabled={saving} onChange={(e) => applyPreset(e.currentTarget.value)}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <span className="st-hint">Presets are shortcuts for the switches below; “Custom” means a hand-picked set.</span>
      </label>

      <div className="st-stack" role="group" aria-label="Features">
        {FEATURES.map((f) => {
          const isCompiled = compiled.has(f.id);
          const on = stored.has(f.id);
          const running = launch.has(f.id);
          const drops = dependentsOf(f.id);
          return (
            <div key={f.id} className="st-field" data-feature={f.id}>
              <label className="st-row">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={on}
                  aria-label={f.label}
                  checked={on}
                  disabled={saving || !isCompiled}
                  onChange={(e) => toggle(f.id, e.target.checked)}
                />
                <span>{f.label}</span>
                {!isCompiled ? <span className="st-status" data-tone="warning">{FEATURE_TEXT.compiledOut}</span> : null}
                {isCompiled && on !== running ? <span className="st-status">{FEATURE_TEXT.pending}</span> : null}
              </label>
              <p className="st-hint">Turns off {f.removes}.</p>
              {f.requires.length ? <p className="st-hint">Needs {names(f.requires)}.</p> : null}
              {drops.length && on ? <p className="st-hint">Turning this off also turns off {names(drops)}.</p> : null}
            </div>
          );
        })}
      </div>

      <p className="st-hint">{FEATURE_TEXT.pending}: the core starts with the saved set, so a change takes effect at the next start. This build compiled in {FEATURES.filter((f) => compiled.has(f.id)).map((f) => f.label).join(", ")}.</p>
      <div className="st-row">
        <button type="button" className="st-btn" onClick={() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "build" })}>
          Compile a smaller build…
        </button>
        <button type="button" className="st-btn" disabled={saving} onClick={load}>Reload</button>
      </div>
      {pending ? <p className="st-ok" role="status">Saved — restart to apply.</p> : null}
      {notice ? <p className="st-ok" role="status">{notice}</p> : null}
      <ErrorText text={error} />
      <p className="st-hint">Running now: {FEATURES.filter((f) => launch.has(f.id)).map((f) => f.label).join(", ")}.</p>

      <div className="st-stack">
        <span className="st-label">Toolbar items</span>
        <p className="st-hint">Hide a section from the top toolbar. It stays reachable from deep links and keyboard shortcuts.</p>
        {TOOLBAR_IDS.map((id) => {
          const label = SECTIONS.find((x) => x.id === id)?.label ?? id;
          return (
            <label key={id} className="st-row">
              <input
                type="checkbox"
                checked={!readHiddenToolbar().has(id)}
                onChange={(e) => {
                  const next = readHiddenToolbar();
                  if (e.target.checked) next.delete(id); else next.add(id);
                  writeHiddenToolbar(next);
                  window.dispatchEvent(new Event("llmide-toolbar"));
                  setNotice("Toolbar updated.");
                }}
              />
              <span>{label}</span>
            </label>
          );
        })}
        <button type="button" className="st-btn" onClick={() => { writeHiddenToolbar([]); window.dispatchEvent(new Event("llmide-toolbar")); setNotice("All toolbar items shown."); }}>Show all toolbar items</button>
      </div>
    </div>
  );
}
