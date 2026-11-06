// Settings → Phone and web sync (desktop off): choose the storage (MEGA, own server or Box; a dedicated account for MEGA and Box), connection test, on/off and "Publish now". Secrets are write-only: the MEGA password field is cleared after
// Save and never filled from the core, and the SSH private key never leaves the core. Saving the other storage kind
// unlinks every device, so the card asks first.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { loadSyncStatus, saveMega, saveSftp, testSync, setSyncEnabled, publishNow, syncErrorText, describeSyncError, storeSummary, isSftpStore,
  type SyncStatus, type StoreKind, type SftpSetup, STORE_CHOICES } from "../sync-model.ts";
import SyncDevices from "./SyncDevices.tsx";
import SyncOwnServer from "./SyncOwnServer.tsx";
import SyncBoxForm from "./SyncBoxForm.tsx";

export default function SyncSection(): ReactNode {
  const { client } = useEnv();
  const [status, setStatus] = useState<SyncStatus | null | undefined>(undefined);
  const [kind, setKind] = useState<StoreKind>("mega");
  const [form, setForm] = useState({ email: "", password: "", folder: "llmide-sync" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null); setNote(null);
    try { await fn(); if (ok) setNote(ok); } catch (e) { setError(describeSyncError(e, kind) ?? describeError(e)); }
    try { setStatus(await loadSyncStatus(client)); } catch { /* keep the last status */ }
  }, [client, kind]);
  useEffect(() => { void loadSyncStatus(client).then((s) => {
    setStatus(s);
    if (s?.storeKind === "sftp") setKind("sftp");
    else if (s?.storeKind === "box") setKind("box");
    else if (s?.store && !isSftpStore(s.store)) { const folder = s.store.folder; setForm((f) => ({ ...f, folder })); }
  }, (e) => setError(describeError(e))); }, [client]);
  if (status === null) return null;
  const configured = status?.storeKind === "mega" || status?.storeKind === "sftp" || status?.storeKind === "box" ? status.storeKind : null;
  /** Saving another kind than the configured one unlinks every device: ask first. */
  const guarded = (fn: () => Promise<void>) => { if (configured && configured !== kind) setPending(() => fn); else void fn(); };
  const saveMegaNow = () => run(async () => {
    await saveMega(client, { email: form.email.trim(), password: form.password, folder: form.folder.trim() || "llmide-sync" });
    setForm((f) => ({ ...f, password: "" }));
    await testSync(client);
  }, "Saved. MEGA connection works.");
  const saveSftpNow = (cfg: SftpSetup) => run(() => saveSftp(client, cfg), "Saved. Install the key below on the server, then press Test connection.");
  const working = kind === "sftp" ? "Your server answers." : kind === "box" ? "Box connection works." : "MEGA connection works.";
  return (
    <section className="st-stack" aria-labelledby="sync-title">
      <span className="st-label" id="sync-title">Phone and web sync</span>
      <p className="st-hint">With the desktop off, the phone and web app read an encrypted copy of your chats, meetings, plans and usage from your sync storage, and queue chat prompts that run when the desktop is back. The storage only ever holds ciphertext.</p>
      <fieldset className="st-stack">
        <legend className="st-label">Storage</legend>
        {STORE_CHOICES.map((c) => (
          <label key={c.kind} className="st-row">
            <input type="radio" name="sync-store" checked={kind === c.kind} onChange={() => setKind(c.kind)} /> {c.label}
          </label>
        ))}
      </fieldset>
      {kind === "mega" ? (
        <>
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
          <div className="st-row"><Button onClick={() => guarded(saveMegaNow)} disabled={!form.email.trim() || !form.password}>Save and test</Button></div>
        </>
      ) : (
        kind === "box" ? <SyncBoxForm folder={status?.storeKind === "box" && status.store && "folder" in status.store ? status.store.folder : "llmide-sync"} switching={!!status?.storeKind && status.storeKind !== "box" && status.devices.length > 0} run={run} onConnect={guarded} /> : <SyncOwnServer status={status} onSave={(cfg) => guarded(() => saveSftpNow(cfg))} />
      )}
      {pending && (
        <div className="st-dialog" role="alertdialog" aria-label="Switch sync storage">
          <strong>Switch sync storage?</strong>
          <p className="st-hint">Every phone and browser is unlinked and must be added again. The files in the old storage stay there; delete them yourself.</p>
          <div className="st-row">
            <button type="button" className="st-btn" onClick={() => setPending(null)}>Cancel</button>
            <Button tone="danger" onClick={() => { const fn = pending; setPending(null); void fn(); }}>Switch</Button>
          </div>
        </div>
      )}
      {status?.store && configured === kind && (
        <div className="st-stack">
          <p className="st-hint">{storeSummary(status)}</p>
          <p className="st-hint">Desktop signing key fingerprint: <code>{status.signingFingerprint}</code></p>
          <div className="st-row"><Button onClick={() => run(() => testSync(client), working)}>Test connection</Button></div>
          <label className="st-row"><input type="checkbox" checked={status.enabled} onChange={(e) => run(() => setSyncEnabled(client, e.target.checked))} /> Sync on</label>
          <div className="st-row"><Button onClick={() => run(() => publishNow(client), "Published.")} disabled={!status.enabled}>Publish now</Button></div>
          {status.enabled ? <SyncDevices status={status} onStatus={(s) => setStatus(s)} /> : <p className="st-hint">Turn sync on to add a phone or browser.</p>}
          <p className="st-hint" aria-live="polite">{status.lastError ? `Last error: ${syncErrorText(status.lastError, status.storeKind) ?? status.lastError}` : status.lastPublishAt ? `Last published ${new Date(status.lastPublishAt).toLocaleString()}` : "Not published yet."} · {status.devices.length} device(s)</p>
        </div>
      )}
      {note && <p className="st-hint" aria-live="polite">{note}</p>}
      <ErrorText text={error} />
    </section>
  );
}
