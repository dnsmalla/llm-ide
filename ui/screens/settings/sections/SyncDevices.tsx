// Settings → Phone and web sync → "Add a phone or browser": QR (sync fields; the one-time secret lives only in this
// component's state and the QR), the 6-digit code to compare, the device list with revoke, and key rotation.
// Polls every 2 s while adding; leaving the card keeps it alive so the code survives navigation.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { invokeHost, isHostAvailable } from "../../shell/host.ts";
import { PairingQr, loadDevices, revokeDevice } from "./HostApiPairing.tsx";
import AlsoRevoke, { ALSO_LOADING_NOTE, isAlsoLoading, type AlsoState } from "./AlsoRevoke.tsx";
import { LIVE_UNAVAILABLE_NOTE, SEPARATE_LISTS_HINT, liveCandidates, runRevokes, summarizeRevokes } from "../device-link-model.ts";
import { startEnroll, pollEnrollSerially, confirmEnroll, cancelEnroll, revokeSyncDevice, rotateSyncKeys, markSyncPasswordChanged, enrollFailureText, enrollScreen, describeSyncError,
  type EnrollStart, type EnrollPoll, type SyncStatus } from "../sync-model.ts";

// Kept outside React on purpose: navigating within Settings unmounts this card. The desktop must keep the pending
// enrollment so the 6-digit code is still here when the user returns; the core expires it on its own timer.
let keptStart: EnrollStart | null = null;
let keptPoll: EnrollPoll | null = null;

export default function SyncDevices({ status, onStatus }: { status: SyncStatus; onStatus: (s: SyncStatus) => void }): ReactNode {
  const { client } = useEnv();
  const [start, setStartState] = useState<EnrollStart | null>(keptStart);
  const [poll, setPollState] = useState<EnrollPoll | null>(keptPoll);
  const setStart = (v: EnrollStart | null) => { keptStart = v; setStartState(v); };
  const setPoll = (v: EnrollPoll | null) => { keptPoll = v; setPollState(v); };
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // C5: a revoked phone keeps a working MEGA session until the account password changes; remind, then record it.
  const [passwordNotice, setPasswordNotice] = useState(false);
  const [passwordDone, setPasswordDone] = useState(false);
  const [also, setAlso] = useState<AlsoState | null>(null);
  const [alsoChecked, setAlsoChecked] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const askSeq = useRef(0);
  const [showLink, setShowLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const { host } = useEnv();

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(describeSyncError(e) ?? describeError(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    if (!start) return;
    return pollEnrollSerially(client, setPoll, (e) => setError(describeError(e)));
  }, [client, start]);
  const stop = () => { setStart(null); setPoll(null); setShowLink(false); setError(null); };
  const begin = (tier: "web" | "ios") => run(async () => { setPoll(null); setStart(await startEnroll(client, tier)); });
  const screen = enrollScreen(start, poll);
  useEffect(() => {
    if (status.enabled || !keptStart) return;
    keptStart = null; keptPoll = null; setStartState(null); setPollState(null);
    void cancelEnroll(client).catch(() => {});
  }, [client, status.enabled]);
  useEffect(() => { // the backend restarted mid-enrollment: its QR is dead, so stop polling and say so
    if (start && screen === "start") { setStart(null); setPoll(null); setError("Adding the device stopped because LLM-IDE restarted. Start again."); }
  }, [start, screen]);

  const closeConfirm = () => { askSeq.current++; setConfirming(null); setAlso(null); setAlsoChecked([]); };
  // Which Live Chat devices could be the same phone: read fresh when the confirmation opens. A null list (pairing listener
  // off) or any failure only turns the extra list into a note; the sync revoke never depends on it.
  const askRevoke = (d: SyncStatus["devices"][number]) => {
    const seq = ++askSeq.current;
    setConfirming(d.deviceId); setAlso(null); setAlsoChecked([]); setNotice(null);
    void loadDevices(client).catch(() => null).then((live) => {
      if (askSeq.current !== seq) return;
      const candidates = live ? liveCandidates(d, live) : [];
      setAlso({ candidates, unavailable: live === null });
      setAlsoChecked(candidates.filter((c) => c.checked).map((c) => c.deviceId));
    });
  };
  const toggleAlso = (id: string) => setAlsoChecked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const revokeSelected = async (d: SyncStatus["devices"][number]) => {
    const extras = (also?.candidates ?? []).filter((c) => alsoChecked.includes(c.deviceId));
    let latest: SyncStatus | null = null;
    const outcomes = await runRevokes([
      { label: d.name, run: async () => { latest = await revokeSyncDevice(client, d.deviceId); return true; } },
      ...extras.map((c) => ({ label: `${c.label} (Live Chat)`, run: () => revokeDevice(client, c.deviceId) })),
    ], (e) => describeSyncError(e) ?? describeError(e));
    const summary = summarizeRevokes(outcomes);
    if (latest) onStatus(latest);
    if (outcomes[0].ok) { closeConfirm(); setPasswordNotice(true); }
    if (summary.ok) setNotice(extras.length ? summary.text : null);
    else setError(summary.text);
  };

  return (
    <div className="st-stack" role="group" aria-label="Sync devices">
      <span className="st-label">Add a device for offline sync (read-only)</span>
      {screen === "start" || !start ? (
        <div className="st-row">
          <Button tone="primary" disabled={busy} onClick={() => void begin("ios")}>Add iPhone for offline sync</Button>
          <Button disabled={busy} onClick={() => void begin("web")}>Add browser for offline sync</Button>
        </div>
      ) : screen === "confirm" && poll ? (
        <div className="st-stack" role="status">
          <p className="st-hint">Does <strong>{poll.name}</strong> show this code?</p>
          <p className="st-pre" aria-label="Code to compare"><strong>{poll.sas}</strong></p>
          <p className="st-hint">Confirm only if the code is the same on the device in your hand. If the device shows an error, or no code, choose "Codes differ".</p>
          <div className="st-row">
            <Button tone="primary" disabled={busy} onClick={() => void run(async () => { onStatus(await confirmEnroll(client)); stop(); })}>Codes match</Button>
            <Button tone="danger" disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); stop(); })}>Codes differ</Button>
            <Button disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); const tier = start?.tier ?? "ios"; setPoll(null); setStart(await startEnroll(client, tier)); })}>Start over</Button>
          </div>
          <p className="st-hint">Starting over makes a new pairing code; the old one stops working on the device.</p>
        </div>
      ) : screen === "failed" && poll ? (
        <div className="st-stack" role="alert">
          <p className="st-hint">{enrollFailureText(poll.code)}</p>
          <div className="st-row"><Button onClick={stop}>OK</Button></div>
        </div>
      ) : (
        <div className="st-stack" role="status">
          {start.tier === "ios" ? (
            <>
              <PairingQr payload={start.qr} />
              <p className="st-hint">Scan with the LLM-IDE iPhone app. The QR is replaced by the comparison code as soon as the iPhone claims it. The code works for 2 minutes and once only. Keep this screen out of view of others.</p>
            </>
          ) : (
            <>
              <p className="st-hint">Open the pairing link in the browser you want to add. There is nothing to scan with a camera.</p>
              {(status.storeKind !== "box" || showLink) && <div className="st-row">
                <Button tone="primary" disabled={busy} onClick={() => void run(async () => {
                  if (isHostAvailable()) await invokeHost("open_external_url", { url: start.qr });
                  else globalThis.open?.(start.qr, "_blank", "noopener,noreferrer");
                })}>Open in browser</Button>
                <Button disabled={busy} onClick={() => void host.copyText(start.qr).then(() => setCopied(true), () => setCopied(false))}>{copied ? "Copied" : "Copy link"}</Button>
              </div>}
              <p className="st-hint">The link opens the web app and starts pairing. It is replaced by the comparison code as soon as the browser claims it.</p>
            </>
          )}
          {status.storeKind !== "box" || showLink
            // For Box the link carries the Box app's client secret: shown, copied or opened only after "Show link".
            ? <p className="st-pre" aria-label="Sync pairing link">{start.qr}</p>
            : <div className="st-row"><Button onClick={() => setShowLink(true)}>Show link</Button></div>}
          <div className="st-row"><Button disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); stop(); })}>Cancel</Button></div>
        </div>
      )}
      <span className="st-label">Sync devices</span>
      {status.devices.length === 0 ? <p className="st-hint">No devices yet.</p> : (
        <ul className="st-device-list" aria-label="Sync devices">
          {status.devices.map((d) => (
            <li key={d.deviceId} className="st-device-card">
              <div className="st-row">
                <span className="st-grow">{d.name} · {d.tier === "ios" ? "iPhone app" : "browser"}</span>
                <span className="st-hint">added {new Date(d.addedAt).toLocaleString()} · folder {d.folderHint}…</span>
                <Button tone="danger" label={`Revoke ${d.name}`} disabled={busy || confirming !== null} onClick={() => askRevoke(d)}>Revoke…</Button>
              </div>
              {confirming === d.deviceId ? (
                <div className="st-dialog" role="alertdialog" aria-label={`Revoke ${d.name}`}>
                  <strong>Revoke {d.name}?</strong>
                  <p className="st-hint">Its sync folder is deleted and the keys of every other device are replaced. It must be added again to sync.</p>
                  <AlsoRevoke heading="Also unpair from Live Chat" note={LIVE_UNAVAILABLE_NOTE} state={also} checked={alsoChecked} busy={busy} onToggle={toggleAlso} />
                  <div className="st-row">
                    <button type="button" className="st-btn" onClick={closeConfirm} disabled={busy}>Cancel</button>
                    <Button tone="danger" disabled={busy || isAlsoLoading(also)} onClick={() => void run(() => revokeSelected(d))}>Revoke</Button>
                    {isAlsoLoading(also) ? <span className="st-hint">{ALSO_LOADING_NOTE}</span> : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="st-hint">{SEPARATE_LISTS_HINT}</p>
      {notice ? <p className="st-hint" role="status">{notice}</p> : null}
      {passwordNotice ? (
        <div className="st-dialog" role="note" aria-label="Change the sync password">
          <strong>
            Change the {status.storeKind === "mega" ? "MEGA" : status.storeKind === "box" ? "Box" : "storage"} account
            password now; the phone still holds a session.
          </strong>
          <p className="st-hint">Revoking the device deletes its folder and rotates the keys, but a copy already on the phone can stay logged in. Changing the account password ends it.</p>
          <label className="st-row">
            <input
              type="checkbox"
              checked={passwordDone}
              disabled={busy}
              onChange={() => void run(async () => { onStatus(await markSyncPasswordChanged(client)); setPasswordDone(true); setPasswordNotice(false); })}
            />
            <span>Done — the password is changed</span>
          </label>
        </div>
      ) : null}
      <p className="st-hint">Lost a device while this computer is off? Delete its folder (it starts with the letters shown above) inside the sync folder in the MEGA web app. This desktop removes the device when it next starts.</p>
      <div className="st-row">
        <Button disabled={busy} onClick={() => void run(async () => { onStatus(await rotateSyncKeys(client)); })}>Rotate keys</Button>
        {status.rotationPending ? <span className="st-hint" aria-live="polite">Key rotation runs after the current sync cycle.</span> : null}
      </div>
      <ErrorText text={error} />
    </div>
  );
}
