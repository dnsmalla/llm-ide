// Settings > General > Notifications: one switch per category (host prefs `notifications`, applies at once) and the
// tray-missing note. A Settings card (register-card.ts), so no Settings section file changes.
import { useEffect, useState } from "react";
import { invokeHost, isHostAvailable } from "../host";
import { decodePrefsView, type NotifyPrefs } from "../host-prefs";
import { ErrorText, Switch } from "../../settings/ui.tsx";
import { NOTIFY_SWITCHES, trayNote } from "./notify";

export function NotificationsBody({ prefs, note, error, onChange }: { prefs: NotifyPrefs | null; note: string | null; error: string | null; onChange(key: keyof NotifyPrefs, on: boolean): void }) {
  return (
    <div className="st-stack">
      <p className="st-hint">Notifications say only what happened, for example “A Loop run passed.”, and never chat text, file names, meeting captions or device names. Your system’s Focus or Do Not Disturb setting still applies.</p>
      {prefs ? NOTIFY_SWITCHES.map((s) => <Switch key={s.key} label={s.label} hint={s.hint} checked={prefs[s.key]} onChange={(v) => onChange(s.key, v)} />) : null}
      {note ? <p className="st-hint" role="status">{note}</p> : null}
      {error ? <ErrorText text={error} /> : null}
    </div>
  );
}

export default function NotificationsCard() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isHostAvailable()) { setError("Notifications need the LLM-IDE desktop app."); return undefined; }
    let live = true;
    invokeHost<unknown>("get_prefs").then((v) => { const p = decodePrefsView(v); if (live) setPrefs(p ? p.stored.notifications : null); }, () => { if (live) setError("Notification settings are not available."); });
    invokeHost<unknown>("tray_status").then((v) => { if (live) setNote(trayNote(v)); }, () => undefined);
    return () => { live = false; };
  }, []);
  const onChange = async (key: keyof NotifyPrefs, on: boolean) => {
    if (!prefs) return;
    setError(null);
    try {
      const v = decodePrefsView(await invokeHost<unknown>("set_prefs", { patch: { notifications: { ...prefs, [key]: on } } }));
      if (v) setPrefs(v.stored.notifications);
    } catch {
      setError("The setting was not saved.");
    }
  };
  return <NotificationsBody prefs={prefs} note={note} error={error} onChange={(k, v) => void onChange(k, v)} />;
}
