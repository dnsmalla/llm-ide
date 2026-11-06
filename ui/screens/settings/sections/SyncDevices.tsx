// Settings → Phone and web sync → "Add a phone or browser": QR (sync fields; the one-time secret lives only in this
// component's state and the QR), the 6-digit code to compare, the device list with revoke, and key rotation.
// Polls every 2 s while adding; leaving the card cancels the enrollment.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { PairingQr } from "./HostApiPairing.tsx";
import { startEnroll, pollEnrollSerially, confirmEnroll, cancelEnroll, revokeSyncDevice, rotateSyncKeys, enrollFailureText, enrollScreen, describeSyncError,
  type EnrollStart, type EnrollPoll, type SyncStatus } from "../sync-model.ts";

export default function SyncDevices({ status, onStatus }: { status: SyncStatus; onStatus: (s: SyncStatus) => void }): ReactNode {
  const { client } = useEnv();
  const [start, setStart] = useState<EnrollStart | null>(null);
  const [poll, setPoll] = useState<EnrollPoll | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);
  const active = useRef(false);
  active.current = start !== null && (poll === null || poll.phase === "waiting" || poll.phase === "confirm");

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(describeSyncError(e) ?? describeError(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    if (!start) return;
    return pollEnrollSerially(client, setPoll, (e) => setError(describeError(e)));
  }, [client, start]);
  useEffect(() => () => { if (active.current) void cancelEnroll(client).catch(() => {}); }, [client]);
  const stop = () => { setStart(null); setPoll(null); setShowLink(false); };
  const begin = (tier: "web" | "ios") => run(async () => { setPoll(null); setStart(await startEnroll(client, tier)); });
  const screen = enrollScreen(start, poll);
  useEffect(() => { // the backend restarted mid-enrollment: its QR is dead, so stop polling and say so
    if (start && screen === "start") { setStart(null); setPoll(null); setError("Adding the device stopped because LLM-IDE restarted. Start again."); }
  }, [start, screen]);

  return (
    <div className="st-stack" role="group" aria-label="Sync devices">
      <span className="st-label">Add a phone or browser</span>
      {screen === "start" || !start ? (
        <div className="st-row">
          <Button tone="primary" disabled={busy} onClick={() => void begin("ios")}>iPhone app</Button>
          <Button disabled={busy} onClick={() => void begin("web")}>Browser</Button>
        </div>
      ) : screen === "confirm" && poll ? (
        <div className="st-stack" role="status">
          <p className="st-hint">Does <strong>{poll.name}</strong> show this code?</p>
          <p className="st-pre" aria-label="Code to compare"><strong>{poll.sas}</strong></p>
          <p className="st-hint">Confirm only if the code is the same on the device in your hand. If the device shows an error, or no code, choose "Codes differ".</p>
          <div className="st-row">
            <Button tone="primary" disabled={busy} onClick={() => void run(async () => { onStatus(await confirmEnroll(client)); stop(); })}>Codes match</Button>
            <Button tone="danger" disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); stop(); })}>Codes differ</Button>
            <Button disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); setPoll(null); setStart(await startEnroll(client, "ios")); })}>Start over with a new QR</Button>
          </div>
          <p className="st-hint">The QR is shown only before the iPhone claims it. Starting over makes the old code in the iPhone useless.</p>
        </div>
      ) : screen === "failed" && poll ? (
        <div className="st-stack" role="alert">
          <p className="st-hint">{enrollFailureText(poll.code)}</p>
          <div className="st-row"><Button onClick={stop}>OK</Button></div>
        </div>
      ) : (
        <div className="st-stack" role="status">
          <PairingQr payload={start.qr} />
          <p className="st-hint">{start.tier === "ios" ? "Scan with the LLM-IDE iPhone app." : "Open this link in the browser you want to add."} The QR is replaced by the comparison code as soon as the device scans it. The code works for 2 minutes and once only. Keep this screen out of view of others.</p>
          {status.storeKind !== "box" || showLink
            ? <p className="st-pre" aria-label="Sync pairing link">{start.qr}</p> // for Box the link carries the client secret
            : <div className="st-row"><Button onClick={() => setShowLink(true)}>Show link</Button></div>}
          <div className="st-row"><Button disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); stop(); })}>Cancel</Button></div>
        </div>
      )}
      <span className="st-label">Sync devices</span>
      {status.devices.length === 0 ? <p className="st-hint">No devices yet.</p> : (
        <ul className="st-stack" aria-label="Sync devices">
          {status.devices.map((d) => (
            <li key={d.deviceId} className="st-stack">
              <div className="st-row">
                <span className="st-grow">{d.name} · {d.tier === "ios" ? "iPhone app" : "browser"}</span>
                <span className="st-hint">added {new Date(d.addedAt).toLocaleString()} · folder {d.folderHint}…</span>
                <Button tone="danger" label={`Revoke ${d.name}`} disabled={busy || confirming !== null} onClick={() => setConfirming(d.deviceId)}>Revoke…</Button>
              </div>
              {confirming === d.deviceId ? (
                <div className="st-dialog" role="alertdialog" aria-label={`Revoke ${d.name}`}>
                  <strong>Revoke {d.name}?</strong>
                  <p className="st-hint">Its sync folder is deleted and the keys of every other device are replaced. It must be added again to sync.</p>
                  <div className="st-row">
                    <button type="button" className="st-btn" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
                    <Button tone="danger" disabled={busy} onClick={() => void run(async () => { onStatus(await revokeSyncDevice(client, d.deviceId)); setConfirming(null); })}>Revoke</Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="st-hint">Lost a device while this computer is off? Delete its folder (it starts with the letters shown above) inside the sync folder in the MEGA web app. This desktop removes the device when it next starts.</p>
      <div className="st-row">
        <Button disabled={busy} onClick={() => void run(async () => { onStatus(await rotateSyncKeys(client)); })}>Rotate keys</Button>
        {status.rotationPending ? <span className="st-hint" aria-live="polite">Key rotation runs after the current sync cycle.</span> : null}
      </div>
      <ErrorText text={error} />
    </div>
  );
}
