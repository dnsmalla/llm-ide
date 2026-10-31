import { useEffect, useState } from "react";
import { THEME_CHOICES } from "../misc-model.ts";
import { LANGUAGES, PREFS_TEXT, UserPrefsModel, isLanguage } from "../app-model.ts";
import { useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import type { ThemeChoice } from "../host.ts";
import { ErrorText, Field, NeedsHost, Switch } from "../ui.tsx";
import AccountSection from "./AccountSection.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/** The Mac's "General" group: Appearance, synced preferences (language, native plugins), plus Account (the desktop has no account menu yet). */
export default function GeneralSection() {
  const { client, host } = useEnv();
  const [theme, setTheme] = useState<ThemeChoice | null>(null);
  useEffect(() => { setTheme(host.getTheme?.() ?? null); }, [host]);
  const m = useModel(() => new UserPrefsModel(client));
  const s = useStore(m);
  useRefreshOnFocus(() => void m.load());
  const p = s.prefs;
  return (
    <div className="st-stack">
      <div className="st-stack" role="radiogroup" aria-label="Theme">
        <span className="st-label">Appearance</span>
        {host.getTheme && host.setTheme ? THEME_CHOICES.map((t) => (
          <label key={t.id} className="st-row">
            <input type="radio" name="theme" checked={theme === t.id} onChange={() => { setTheme(t.id); host.setTheme!(t.id); }} />
            {t.label}
          </label>
        )) : <NeedsHost what="The theme choice" />}
        <p className="st-hint">The theme applies at once and is remembered on this computer.</p>
      </div>
      <div className="st-stack">
        <span className="st-label">Preferences (synced)</span>
        <ErrorText text={s.error} />
        {p ? (
          <>
            <Field label="Language" hint={PREFS_TEXT.languageHint}>
              <select className="st-select" value={isLanguage(p.language) ? p.language : "en"} disabled={s.saving} onChange={(e) => void m.setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </Field>
            <Switch label={PREFS_TEXT.nativeTitle} hint={PREFS_TEXT.nativeHint} checked={p.nativePlugins ?? true} disabled={s.saving} onChange={(v) => void m.setNativePlugins(v)} />
            {s.saved ? <p className="st-ok" role="status">Saved.</p> : null}
          </>
        ) : s.error ? null : <p className="st-hint" role="status">Loading...</p>}
      </div>
      <div className="st-stack">
        <AccountSection />
      </div>
      <PartialNote id="general" />
    </div>
  );
}
