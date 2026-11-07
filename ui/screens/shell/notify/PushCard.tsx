// Settings > General > Phone and web push: which paired devices receive pushes, and the Apple Push key the iPhone needs
// (routes GET /host-api/push/status, PUT and DELETE /host-api/push/apns; contract schema/http/host-api.schema.json). The
// key goes to this computer's vault and is never shown again. A Settings card (register-card.ts).
import { useCallback, useEffect, useState } from "react";
import { ApiError, call } from "../../settings/core-api.ts";
import { useEnv } from "../../settings/context.tsx";
import { Button, ErrorText, Field } from "../../settings/ui.tsx";

export interface PushDevice { deviceId: string; name: string; kind: "webpush" | "apns"; lastResult: string | null; lastAt: number | null }
export interface PushStatus { served: boolean; apns: { configured: boolean; keyId: string | null; teamId: string | null }; devices: PushDevice[] }

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

export function decodePushStatus(v: unknown): PushStatus | null {
  const o = obj(v);
  const a = obj(o?.apns);
  if (!o || typeof o.served !== "boolean" || !a || typeof a.configured !== "boolean" || !Array.isArray(o.devices)) return null;
  const devices: PushDevice[] = [];
  for (const d of o.devices.slice(0, 20)) {
    const r = obj(d);
    const deviceId = str(r?.deviceId, 64);
    const name = str(r?.name, 120);
    if (!r || !deviceId || name === null || (r.kind !== "webpush" && r.kind !== "apns")) continue;
    devices.push({ deviceId, name, kind: r.kind, lastResult: str(r.lastResult, 80), lastAt: typeof r.lastAt === "number" ? r.lastAt : null });
  }
  return { served: o.served, apns: { configured: a.configured, keyId: str(a.keyId, 10), teamId: str(a.teamId, 10) }, devices };
}

export function resultLabel(r: string | null): string {
  if (r === null) return "Nothing sent yet";
  if (r === "ok") return "Last push accepted by the push service";
  if (r === "rate_limited") return "Held back: too many pushes this hour";
  if (r === "APNS_NOT_CONFIGURED") return "Waiting for the Apple Push key below";
  return "Last push failed";
}

const ID_RE = /^[A-Z0-9]{10}$/;

export function PushBody({ status, error, onSave, onRemove }: { status: PushStatus | null; error: string | null; onSave(v: { key: string; keyId: string; teamId: string }): void; onRemove(): void }) {
  const [key, setKey] = useState("");
  const [keyId, setKeyId] = useState("");
  const [teamId, setTeamId] = useState("");
  if (!status) return <p className="st-hint">Push needs this computer's Host API (Settings → Mobile) on a backend started with LLMIDE_HOST_API_PUSH=1.</p>;
  const ready = key.includes("BEGIN PRIVATE KEY") && ID_RE.test(keyId) && ID_RE.test(teamId);
  return (
    <div className="st-stack">
      <p className="st-hint">While this computer runs, it can tell your paired phone and web app when an approval waits, a long task ends or sync needs you, and only while you are away from this window. A push says only what happened, for example “A Loop run passed.”, never chat text, file names or device names. Turn it on in the web app or the iPhone app after pairing.</p>
      {!status.served ? <p className="st-hint" role="status">This backend does not send pushes. Start it with LLMIDE_HOST_API_PUSH=1, then pair each device again.</p> : null}
      {status.devices.length
        ? <ul className="st-list">{status.devices.map((d) => <li key={d.deviceId}>{d.name} · {d.kind === "apns" ? "iPhone" : "Web app"} · {resultLabel(d.lastResult)}</li>)}</ul>
        : <p className="st-hint">No paired device has turned push on yet.</p>}
      {status.apns.configured ? (
        <div className="st-row">
          <p className="st-hint">Apple Push key {status.apns.keyId} (team {status.apns.teamId}) is saved.</p>
          <Button tone="danger" onClick={onRemove}>Remove key</Button>
        </div>
      ) : (
        <>
          <Field label="Apple Push key (.p8)" hint="From developer.apple.com → Keys, with Apple Push Notifications service enabled. Stored in this computer's vault and never shown again.">
            <input type="file" accept=".p8" aria-label="Apple Push key file" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void f.text().then(setKey); }} />
          </Field>
          <Field label="Key ID"><input value={keyId} maxLength={10} aria-label="Key ID" onChange={(e) => setKeyId(e.currentTarget.value.trim().toUpperCase())} /></Field>
          <Field label="Team ID"><input value={teamId} maxLength={10} aria-label="Team ID" onChange={(e) => setTeamId(e.currentTarget.value.trim().toUpperCase())} /></Field>
          <Button tone="primary" disabled={!ready} onClick={() => { onSave({ key, keyId, teamId }); setKey(""); }}>Save key</Button>
        </>
      )}
      {error ? <ErrorText text={error} /> : null}
    </div>
  );
}

export default function PushCard() {
  const { client } = useEnv();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // shortcut: no HOST_PROOF_REQUIRED retry (HostApiPairing has one); reopening Settings reloads.
  const reload = useCallback(async () => {
    try { setStatus(decodePushStatus(await call(client, "GET", "/host-api/push/status"))); } catch (e) {
      setStatus(null);
      if (!(e instanceof ApiError && (e.code === "HOST_API_DISABLED" || e.code === "HOST_PROOF_REQUIRED"))) setError("Push status is not available.");
    }
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);
  const save = async (v: { key: string; keyId: string; teamId: string }) => {
    setError(null);
    try { await call(client, "PUT", "/host-api/push/apns", v); } catch (e) {
      setError(e instanceof ApiError && e.code === "VALIDATION_FAILED" ? "That key, Key ID or Team ID is not valid." : "The key was not saved.");
    }
    await reload();
  };
  const remove = async () => {
    setError(null);
    try { await call(client, "DELETE", "/host-api/push/apns"); } catch { setError("The key was not removed."); }
    await reload();
  };
  return <PushBody status={status} error={error} onSave={(v) => void save(v)} onRemove={() => void remove()} />;
}
