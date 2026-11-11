// Settings → Phone and browser → Live Chat pairing: a Host API v1 client (iPhone or web) with THIS desktop's core
// (routes POST /host-api/pin, GET /host-api/devices, DELETE /host-api/devices/:id; contract schema/http/host-api.schema.json).
// The routes need the bus host proof, which the shell's core client attaches; a core started without
// LLMIDE_HOST_API_TLS=1 or LLMIDE_HOST_API_DEV=1 answers 404 HOST_API_DISABLED and an adopted core (no proof) 403 HOST_PROOF_REQUIRED:
// the card then shows a hint instead of nothing. The five capabilities are desktop prefs applied at the NEXT core
// start (core_env_pairs → LLMIDE_HOST_API_*). The PIN lives in component state only: never persisted, logged or sent anywhere.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { ApiError, call, type CoreClient } from "../core-api.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText, Switch } from "../ui.tsx";

/** `fingerprint`: the TLS listener's certificate pin (`sha256:` + 43 base64url characters); null for the dev listener.
 *  `addresses`: this computer's IPv4s for the pairing QR, best first; [] for the dev listener (or an older core). */
export interface HostPin { pin: string; expiresAt: number; port: number; fingerprint: string | null; addresses: string[] }
export interface HostDevice { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$/;
const HIDDEN = new Set(["HOST_API_DISABLED", "HOST_PROOF_REQUIRED"]);

export function decodePin(v: unknown): HostPin {
  if (isRecord(v) && typeof v.pin === "string" && /^[0-9]{6}$/.test(v.pin) && Number.isInteger(v.expiresAt)
    && Number.isInteger(v.port) && (v.port as number) > 0 && (v.port as number) < 65536
    && (v.fingerprint == null || (typeof v.fingerprint === "string" && /^sha256:[A-Za-z0-9_-]{43}$/.test(v.fingerprint)))
    && (v.addresses === undefined || (Array.isArray(v.addresses) && v.addresses.every((a) => typeof a === "string" && IPV4_RE.test(a))))) {
    return { pin: v.pin, expiresAt: v.expiresAt as number, port: v.port as number, fingerprint: (v.fingerprint as string | undefined) ?? null,
      addresses: (v.addresses as string[] | undefined) ?? [] };
  }
  throw new ApiError(0, "BAD_RESPONSE");
}

export function decodeDevices(v: unknown): HostDevice[] {
  if (!isRecord(v) || !Array.isArray(v.devices)) throw new ApiError(0, "BAD_RESPONSE");
  return v.devices.filter((d): d is HostDevice => isRecord(d) && typeof d.deviceId === "string" && typeof d.name === "string"
    && typeof d.pairedAt === "number" && typeof d.lastSeenAt === "number");
}

/** Retry delays while the core answers HOST_PROOF_REQUIRED: the shell fetches the bus proof from the host
 *  asynchronously after the core is ready, so the first probe can race it. HOST_API_DISABLED never retries. */
export const PROOF_RETRY_MS: readonly number[] = [300, 1000, 2000, 4000];

/** The paired devices, or null when this core does not serve the Host API to this UI (the card hides). */
export async function loadDevices(client: CoreClient, { retryMs = PROOF_RETRY_MS, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), alive = () => true }: {
  retryMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; alive?: () => boolean;
} = {}): Promise<HostDevice[] | null> {
  for (let i = 0; ; i++) {
    try {
      return decodeDevices(await call(client, "GET", "/host-api/devices"));
    } catch (e) {
      if (!(e instanceof ApiError) || !HIDDEN.has(e.code)) throw e;
      if (e.code !== "HOST_PROOF_REQUIRED" || i >= retryMs.length || !alive()) return null;
    }
    await sleep(retryMs[i]);
  }
}

/** The phone's pairing QR (same items as the Mac's `MobileConnectionInfo.qrPayload`), or null unless the PIN came from
 *  a TLS listener with an address. No `port`: this host has no v2 link, and a QR-pinned phone dials only v1. Every
 *  value is validated by decodePin (digits, dotted IPv4, base64url + `sha256:`), so none needs escaping. */
export function pairingPayload(p: HostPin): string | null {
  if (!p.fingerprint || p.addresses.length === 0) return null;
  return `llmide://pair?ip=${p.addresses[0]}&pin=${p.pin}&h1port=${p.port}&h1fp=${p.fingerprint}&api=1`;
}

/** The payload as an inline SVG: dark modules on a fixed white field (with the 4-module quiet zone), so a dark theme
 *  never inverts it into a code the camera cannot read. */
export function PairingQr({ payload }: { payload: string }): ReactNode {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return (
    <svg role="img" aria-label="Pairing QR code for this computer" viewBox={`0 0 ${n + 8} ${n + 8}`} width={208} height={208}
      shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 4 }}>
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

export const mintPin = async (client: CoreClient): Promise<HostPin> => decodePin(await call(client, "POST", "/host-api/pin"));

export async function revokeDevice(client: CoreClient, deviceId: string): Promise<boolean> {
  const b = await call(client, "DELETE", `/host-api/devices/${encodeURIComponent(deviceId)}`);
  return isRecord(b) && b.revoked === true;
}

const remaining = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function RevokeConfirm({ device, busy, onCancel, onRevoke }: { device: HostDevice; busy: boolean; onCancel: () => void; onRevoke: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="st-dialog" role="alertdialog" aria-label={`Revoke ${device.name}`}>
      <strong>Revoke {device.name}?</strong>
      <p className="st-hint">It is disconnected now and must pair again with a new PIN.</p>
      <div className="st-row">
        <button ref={cancel} type="button" className="st-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <Button tone="danger" disabled={busy} onClick={onRevoke}>Revoke</Button>
      </div>
    </div>
  );
}

export function HostApiPairingView({ devices, pin, now, busy, error, confirming, onShowPin, onAskRevoke, onCancelRevoke, onRevoke }: {
  devices: HostDevice[];
  pin: HostPin | null;
  now: number;
  busy: boolean;
  error: string | null;
  confirming: string | null;
  onShowPin: () => void;
  onAskRevoke: (deviceId: string) => void;
  onCancelRevoke: () => void;
  onRevoke: (deviceId: string) => void;
}): ReactNode {
  const live = pin && pin.expiresAt > now ? pin : null;
  const qr = live ? pairingPayload(live) : null;
  return (
    <div className="st-stack" role="group" aria-label="Host API pairing">
      <span className="st-label">Live Chat pairing (desktop must be on)</span>
      {live ? (
        <div className="st-stack" role="status">
          <p className="st-pre" aria-label="Pairing PIN"><strong>{live.pin}</strong></p>
          <p className="st-hint">{live.fingerprint ? "wss://<this computer>" : "ws://127.0.0.1"}:{live.port}/host-api/v1 · expires in {remaining(live.expiresAt - now)} · one use</p>
          {qr ? (
            <>
              <PairingQr payload={qr} />
              <p className="st-hint">Scan with the LLM-IDE iPhone app. The phone pins the certificate fingerprint below.</p>
              <p className="st-pre" aria-label="Pairing link" style={{ userSelect: "text", wordBreak: "break-all" }}>{qr}</p>
            </>
          ) : null}
          {live.fingerprint
            ? <p className="st-pre" aria-label="Certificate fingerprint" style={{ userSelect: "text" }}>Fingerprint: {live.fingerprint}</p>
            : <p className="st-hint">Development only: the listener is plaintext on 127.0.0.1 and serves this computer alone.</p>}
        </div>
      ) : null}
      <div className="st-row">
        <Button tone="primary" disabled={busy} onClick={onShowPin}>{live ? "New pairing PIN" : "Show pairing PIN"}</Button>
      </div>
      <span className="st-label">Paired devices</span>
      {devices.length === 0 ? <p className="st-hint">No devices are paired.</p> : (
        <ul className="st-stack" aria-label="Paired devices">
          {devices.map((d) => (
            <li key={d.deviceId} className="st-stack">
              <div className="st-row">
                <span className="st-grow">{d.name}</span>
                <span className="st-hint">last seen {new Date(d.lastSeenAt).toLocaleString()}</span>
                <Button tone="danger" label={`Revoke ${d.name}`} disabled={busy || confirming !== null} onClick={() => onAskRevoke(d.deviceId)}>Revoke…</Button>
              </div>
              {confirming === d.deviceId ? <RevokeConfirm device={d} busy={busy} onCancel={onCancelRevoke} onRevoke={() => onRevoke(d.deviceId)} /> : null}
            </li>
          ))}
        </ul>
      )}
      <ErrorText text={error} />
    </div>
  );
}

/** The five Host API v1 capabilities the desktop passes to the core it spawns (desktop prefs, exact `1`). */
export interface HostApiPrefs {
  hostApiTls: boolean; hostApiRead: boolean; hostApiCompose: boolean; hostApiPush: boolean; hostApiToolApprovals: boolean;
}

/** The capability switches. All five apply at the NEXT core start; the pairing listener is the first one. */
export function HostApiSettingsView({ prefs, onSave }: { prefs: HostApiPrefs; onSave: (patch: Partial<HostApiPrefs>) => void }): ReactNode {
  return (
    <div className="st-stack" role="group" aria-label="Host API settings">
      <span className="st-label">Host API</span>
      <Switch label="Serve the pairing listener (TLS)" checked={prefs.hostApiTls}
        hint="Pinned TLS on all interfaces (port 3016+), so a phone or browser on your network can pair." onChange={(v) => onSave({ hostApiTls: v })} />
      <Switch label="Let paired devices read chats, history and usage" checked={prefs.hostApiRead} onChange={(v) => onSave({ hostApiRead: v })} />
      <Switch label="Let paired devices compose chats (modes, models, new chat)" checked={prefs.hostApiCompose} onChange={(v) => onSave({ hostApiCompose: v })} />
      <Switch label="Send push notifications to paired devices" checked={prefs.hostApiPush} onChange={(v) => onSave({ hostApiPush: v })} />
      <Switch label="Let paired devices answer tool approvals" checked={prefs.hostApiToolApprovals} onChange={(v) => onSave({ hostApiToolApprovals: v })} />
      <p className="st-hint">Applies on the next core start.</p>
    </div>
  );
}

/** Shown instead of an empty card when this core does not serve the Host API to this window (404 HOST_API_DISABLED or
 *  a missing host proof, e.g. an adopted core). */
export const PAIRING_UNAVAILABLE_HINT = "The pairing listener is off. Turn on \u201cServe the pairing listener (TLS)\u201d above, then restart the core to pair a phone or browser.";

export default function HostApiPairing(): ReactNode {
  const { client, host } = useEnv();
  const [devices, setDevices] = useState<HostDevice[] | null>(null);
  const [prefs, setPrefs] = useState<HostApiPrefs | null>(null);
  const [pin, setPin] = useState<HostPin | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    let live = true;
    void host.getExtraPrefs?.().then((p) => {
      if (live) setPrefs({ hostApiTls: p.hostApiTls, hostApiRead: p.hostApiRead, hostApiCompose: p.hostApiCompose, hostApiPush: p.hostApiPush, hostApiToolApprovals: p.hostApiToolApprovals });
    });
    return () => { live = false; };
  }, [host]);
  const savePrefs = async (patch: Partial<HostApiPrefs>) => {
    if (!prefs) return;
    const before = prefs;
    // The switch must not show a value the host refused to store (R-020 B#8).
    setPrefs({ ...prefs, ...patch });
    try { await host.setExtraPrefs?.(patch); } catch (e) { setPrefs(before); setError(describeError(e)); }
  };
  const refresh = useCallback(async () => {
    // A failed first load keeps the card hidden; a later failure keeps the last list and shows why.
    try {
      const d = await loadDevices(client, { alive: () => alive.current });
      if (alive.current) setDevices(d);
    } catch (e) { if (alive.current) setError(describeError(e)); }
  }, [client]);
  // On mount and on window focus: a core restarted with the flag, or a proof that arrived late, shows the card.
  useRefreshOnFocus(() => void refresh());
  useEffect(() => {
    if (!pin) return;
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= pin.expiresAt) setPin(null);
    }, 1000);
    return () => window.clearInterval(t);
  }, [pin]);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await f(); } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  };
  return (
    <div className="st-stack">
      {prefs && host.getExtraPrefs ? <HostApiSettingsView prefs={prefs} onSave={(patch) => void savePrefs(patch)} /> : null}
      {devices === null
        ? <p className="st-hint" role="status">{PAIRING_UNAVAILABLE_HINT}</p>
        : <HostApiPairingView
            devices={devices} pin={pin} now={now} busy={busy} error={error} confirming={confirming}
            onShowPin={() => void run(async () => { const p = await mintPin(client); setNow(Date.now()); setPin(p); })}
            onAskRevoke={setConfirming}
            onCancelRevoke={() => setConfirming(null)}
            onRevoke={(id) => void run(async () => { await revokeDevice(client, id); setConfirming(null); await refresh(); })}
          />}
    </div>
  );
}
