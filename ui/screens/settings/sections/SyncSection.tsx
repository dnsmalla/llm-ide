// Settings → Phone and web sync (desktop off): MEGA store setup (a dedicated account), connection test, on/off and
// "Publish now". The password field is write-only: it is cleared after Save and never filled from the core.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { loadSyncStatus, saveMega, testSync, setSyncEnabled, publishNow, syncErrorText, describeSyncError, type SyncStatus } from "../sync-model.ts";

export default function SyncSection(): ReactNode {
  const { client } = useEnv();
  const [status, setStatus] = useState<SyncStatus | null | undefined>(undefined);
  const [form, setForm] = useState({ email: "", password: "", folder: "llmide-sync" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null); setNote(null);
    try { await fn(); if (ok) setNote(ok); } catch (e) { setError(describeSyncError(e) ?? describeError(e)); }
    try { setStatus(await loadSyncStatus(client)); } catch { /* keep the last status */ }
  }, [client]);
  useEffect(() => { void loadSyncStatus(client).then((s) => {
    setStatus(s);
    if (s?.store) setForm((f) => ({ ...f, folder: s.store!.folder }));
  }, (e) => setError(describeError(e))); }, [client]);
  if (status === null) return null;
  const save = () => run(async () => {
    await saveMega(client, { email: form.email.trim(), password: form.password, folder: form.folder.trim() || "llmide-sync" });
    setForm((f) => ({ ...f, password: "" }));
    await testSync(client);
  }, "Saved. MEGA connection works.");
  return (
    <section className="st-stack" aria-labelledby="sync-title">
      <span className="st-label" id="sync-title">Phone and web sync</span>
      <p className="st-hint">With the desktop off, the phone and web app read an encrypted copy of your chats, meetings, plans and usage from a MEGA folder, and queue chat prompts that run when the desktop is back. MEGA only ever stores ciphertext.</p>
      <div className="st-stack" role="note">
        <p className="st-hint"><strong>Use a separate MEGA account made only for LLM-IDE</strong>, never your personal one. It will hold nothing but encrypted sync files, so a leak of its password exposes nothing readable.</p>
        <p className="st-hint">Turn off two-factor login on that account: the desktop logs in by itself in the background. Keep two-factor on for your personal account.</p>
        <p className="st-hint">The email and password are kept in this computer's encrypted vault and are never shown again.</p>
      </div>
      <label className="st-field">MEGA email
        <input className="st-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="MEGA email" autoComplete="off" spellCheck={false} />
      </label>
      <label className="st-field">MEGA password
        <input className="st-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-label="MEGA password" autoComplete="new-password" />
      </label>
      <label className="st-field">Folder name
        <input className="st-input" value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} aria-label="Folder name" spellCheck={false} />
      </label>
      <div className="st-row"><Button onClick={save} disabled={!form.email.trim() || !form.password}>Save and test</Button></div>
      {status?.store && (
        <div className="st-stack">
          <p className="st-hint">Connected account <code>{status.store.account}</code>, folder <code>{status.store.folder}</code> in its Cloud Drive.</p>
          <p className="st-hint">Desktop signing key fingerprint: <code>{status.signingFingerprint}</code></p>
          <div className="st-row"><Button onClick={() => run(() => testSync(client), "MEGA connection works.")}>Test connection</Button></div>
          <label className="st-row"><input type="checkbox" checked={status.enabled} onChange={(e) => run(() => setSyncEnabled(client, e.target.checked))} /> Sync on</label>
          <div className="st-row"><Button onClick={() => run(() => publishNow(client), "Published.")} disabled={!status.enabled}>Publish now</Button></div>
          <p className="st-hint" aria-live="polite">{status.lastError ? `Last error: ${syncErrorText(status.lastError) ?? status.lastError}` : status.lastPublishAt ? `Last published ${new Date(status.lastPublishAt).toLocaleString()}` : "Not published yet."} · {status.devices.length} device(s)</p>
        </div>
      )}
      {note && <p className="st-hint" aria-live="polite">{note}</p>}
      <ErrorText text={error} />
    </section>
  );
}
