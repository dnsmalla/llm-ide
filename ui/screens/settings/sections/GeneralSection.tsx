import { useEffect, useState } from "react";
import { THEME_CHOICES, TRAY_TEXT } from "../misc-model.ts";
import { LANGUAGES, PREFS_TEXT, UserPrefsModel, isLanguage, type PrefsState } from "../app-model.ts";
import { useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import type { ThemeChoice } from "../host.ts";
import { ErrorText, Field, NeedsHost, Switch } from "../ui.tsx";
import { TerminalToggle } from "./SimpleSections.tsx";
import AccountSection from "./AccountSection.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The synced preferences (Mac: "Preferences (synced)"). Controls stay disabled while unloaded or saving. "Saving…"
 * shows during a save, and a failed first load offers Retry (the Mac's Retry button) instead of a dead error line.
 */
export function PrefsBlock({ m, s }: { m: Pick<UserPrefsModel, "load" | "setLanguage" | "setNativePlugins">; s: PrefsState }) {
  const p = s.prefs;
  return (
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
          {s.saving ? <p className="st-hint" role="status">Saving…</p> : null}
          {s.saved ? <p className="st-ok" role="status">Saved.</p> : null}
        </>
      ) : s.error ? (
        <button type="button" className="st-btn" onClick={() => void m.load()}>Retry</button>
      ) : (
        <p className="st-hint" role="status">Loading...</p>
      )}
    </div>
  );
}

/** The Mac's "General" group: Appearance, the menu-bar icon, synced preferences (language, native plugins), plus Account. */
export default function GeneralSection() {
  const { client, host } = useEnv();
  const [theme, setTheme] = useState<ThemeChoice | null>(null);
  useEffect(() => { setTheme(host.getTheme?.() ?? null); }, [host]);
  const [devTools, setDevToolsState] = useState(() => host.getDevTools?.() ?? false);
  const [trayIcon, setTrayIcon] = useState<boolean | null>(null);
  const [trayError, setTrayError] = useState<string | null>(null);
  useEffect(() => {
    if (!host.getTrayIcon) return;
    let live = true;
    host.getTrayIcon().then((v) => { if (live) setTrayIcon(v); }, () => { if (live) setTrayIcon(null); });
    return () => { live = false; };
  }, [host]);
  const toggleTray = async (on: boolean) => {
    if (!host.setTrayIcon) return;
    setTrayIcon(on); // optimistic; corrected by the host's answer
    setTrayError(null);
    try {
      setTrayIcon(await host.setTrayIcon(on));
    } catch {
      setTrayError("The host could not change the menu-bar icon.");
      try { setTrayIcon(await host.getTrayIcon?.() ?? null); } catch { /* leave as is */ }
    }
  };
  const m = useModel(() => new UserPrefsModel(client));
  const s = useStore(m);
  useRefreshOnFocus(() => void m.load());
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
      {host.getTrayIcon && host.setTrayIcon ? (
        <div className="st-stack">
          {trayIcon === null ? (
            <p className="st-hint" role="status">Reading the menu-bar setting...</p>
          ) : (
            <Switch label={TRAY_TEXT.label} hint={TRAY_TEXT.hint} checked={trayIcon} onChange={(v) => void toggleTray(v)} />
          )}
          {trayError ? <ErrorText text={trayError} /> : null}
        </div>
      ) : null}
      <PrefsBlock m={m} s={s} />
      <TerminalToggle host={host} />
      {host.getDevTools && host.setDevTools ? (
        <div className="st-stack">
          <Switch
            label="Show developer tools"
            hint="Adds the developer-only Spike item (Phase 0 benchmarks) to the toolbar. Kept on this computer."
            checked={devTools}
            onChange={(v) => { setDevToolsState(v); host.setDevTools!(v); }}
          />
        </div>
      ) : null}
      <div className="st-stack">
        <AccountSection />
      </div>
      <PartialNote id="general" />
    </div>
  );
}
