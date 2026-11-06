// Status-bar inbox for command-bus jobs (docs/spec/command-bus.md sections 3 and 9): what waits for the desktop's
// approval, and the scheduled jobs. Shown only while the core sees this UI as the desktop class. All text is rendered as
// text; the nonce stays in memory and is sent only with Approve.
import { memo, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { core } from "../runtime";
import { useCoreSession } from "../use-shell";
import { busApi, buildScheduleInput, type BusSchedule, type PendingApproval, type ScheduleInput } from "./bus-api";
import { confirmFor, decodeSourceNames, sourceLabel, summarizeApproval, type SourceNames } from "./summary";
import { inboxStore } from "./inbox-store";

const api = busApi((path, init) => core.requestRaw(path, init ?? {}));
const HOURS = [1, 3, 6, 12, 24] as const;

export function PendingList({ items, names, busy, onApprove, onDeny }: {
  items: PendingApproval[]; names: SourceNames; busy: string | null;
  onApprove: (a: PendingApproval, confirmed: boolean) => void; onDeny: (a: PendingApproval) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  if (!items.length) return <p className="sh-activity-empty">Nothing is waiting for your approval</p>;
  return (
    <ul className="sh-inbox-list" aria-label="Waiting for your approval">
      {items.map((a) => {
        const s = summarizeApproval(a, names);
        const ok = !s.needsConfirm || checked[a.id] === true;
        return (
          <li key={a.id} className="sh-inbox-row">
            <strong>{s.title}</strong>
            <span className="sh-activity-kind">Asked by {s.origin} · {a.tier}</span>
            <ul className="sh-inbox-lines">{s.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            {s.needsConfirm && (
              <label className="sh-inbox-confirm">
                <input type="checkbox" checked={checked[a.id] === true} onChange={(e) => setChecked({ ...checked, [a.id]: e.target.checked })} />
                I checked the project and issue ids above
              </label>
            )}
            <div className="sh-inbox-actions">
              <button type="button" disabled={busy !== null || !ok} onClick={() => onApprove(a, ok)}>Approve</button>
              <button type="button" disabled={busy !== null} onClick={() => onDeny(a)}>Deny</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ScheduleList({ items, names, nowMs, busy, onDelete }: {
  items: BusSchedule[]; names: SourceNames; nowMs: number; busy: string | null; onDelete: (s: BusSchedule) => void;
}) {
  if (!items.length) return <p className="sh-activity-empty">No scheduled jobs</p>;
  return (
    <ul className="sh-inbox-list" aria-label="Scheduled jobs">
      {items.map((s) => {
        const ids = Array.isArray(s.args.sourceIds) ? s.args.sourceIds.filter((x): x is string => typeof x === "string") : [];
        const live = s.standing && s.standingUntil !== null && Date.parse(s.standingUntil) > nowMs;
        return (
          <li key={s.id} className="sh-inbox-row">
            <strong>Sync sources every {s.intervalHours} {s.intervalHours === 1 ? "hour" : "hours"}</strong>
            <span className="sh-activity-kind">
              {live ? `Runs without asking until ${new Date(s.standingUntil as string).toLocaleDateString()}` : "Asks you on each run"}
              {s.lastRunAt ? ` · last approved run ${new Date(s.lastRunAt).toLocaleString()}` : ""}
            </span>
            <ul className="sh-inbox-lines">
              {ids.length ? ids.map((id) => <li key={id}>{sourceLabel(id, names)}</li>) : <li>Every connected Google Calendar, Google Drive and iCal source</li>}
            </ul>
            <div className="sh-inbox-actions">
              <button type="button" disabled={busy !== null} onClick={() => onDelete(s)}>Delete (revokes)</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ScheduleForm({ names, onCreate }: { names: SourceNames; onCreate: (input: ScheduleInput) => Promise<void> }) {
  const [hours, setHours] = useState(6);
  const [picked, setPicked] = useState<string[]>([]);
  const [standing, setStanding] = useState(false);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const ids = Object.keys(names).sort();
  const submit = async () => {
    const r = buildScheduleInput({ hours, sourceIds: picked, standing, days });
    if (!r.ok) { setError(r.message); return; }
    setError(null);
    await onCreate(r.input);
  };
  return (
    <form className="sh-inbox-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="New scheduled sync">
      <label>Every{" "}
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {HOURS.map((n) => <option key={n} value={n}>{n} {n === 1 ? "hour" : "hours"}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Sources (none ticked = every connected source)</legend>
        {ids.map((id) => (
          <label key={id}>
            <input type="checkbox" checked={picked.includes(id)} onChange={(e) => setPicked(e.target.checked ? [...picked, id] : picked.filter((x) => x !== id))} />
            {sourceLabel(id, names)}
          </label>
        ))}
      </fieldset>
      <label className="sh-inbox-confirm">
        <input type="checkbox" checked={standing} onChange={(e) => setStanding(e.target.checked)} />
        Run without asking for{" "}
        <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days" /> days: only the sources ticked above, at most once per interval. Deleting the schedule revokes it.
      </label>
      {error && <p className="sh-warning" role="alert">{error}</p>}
      <button type="submit">Create schedule</button>
    </form>
  );
}

export const BusInbox = memo(function BusInbox() {
  const { signedIn } = useCoreSession();
  const snap = useSyncExternalStore(inboxStore.subscribe, inboxStore.getSnapshot);
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<SourceNames>({});
  const [schedules, setSchedules] = useState<BusSchedule[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!signedIn) return undefined;
    inboxStore.start();
    return () => inboxStore.stop();
  }, [signedIn]);

  // The tray's approvals line and an approval notification's click open this inbox.
  useEffect(() => {
    const show = () => setOpen(true);
    globalThis.addEventListener?.("llmide:open-inbox", show);
    return () => { globalThis.removeEventListener?.("llmide:open-inbox", show); };
  }, []);

  const reload = useCallback(async () => {
    await inboxStore.refresh();
    const [g, i] = await api.sourceLists();
    setNames(decodeSourceNames(g, i));
    setSchedules(await api.schedules().catch(() => []));
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, reload]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Hidden unless the core treats this UI as the desktop class (a 403 TIER_DENIED otherwise).
  if (!signedIn || snap.error === "TIER_DENIED") return null;
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "failed"); } finally { setBusy(null); void reload(); }
  };
  const count = snap.items.length;
  return (
    <div className="sh-menu-root" ref={root}>
      <button type="button" className="sh-statusbar-item sh-bell" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
        aria-label={count ? `Approvals, ${count} waiting` : "Approvals and scheduled jobs"} title="Approvals and scheduled jobs" onClick={() => setOpen((v) => !v)}>
        Jobs{count ? <span className="sh-bell-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span> : null}
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label="Approvals and scheduled jobs" tabIndex={-1} className="sh-menu sh-menu-up sh-menu-end sh-activity sh-inbox"
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
          <div className="sh-activity-scroll">
            {error && <p className="sh-activity-note sh-warning" role="status">That did not work ({error}). The list was reloaded.</p>}
            <h3 className="sh-activity-day">Waiting for you</h3>
            <PendingList items={snap.items} names={names} busy={busy}
              onApprove={(a, confirmed) => void act(a.id, () => api.approve(a, a.tier === "T2" && confirmed ? { confirm: confirmFor(a) } : {}))}
              onDeny={(a) => void act(a.id, () => api.deny(a.id))} />
            <h3 className="sh-activity-day">Scheduled jobs</h3>
            <ScheduleList items={schedules} names={names} nowMs={Date.now()} busy={busy} onDelete={(s) => void act(s.id, () => api.deleteSchedule(s.id))} />
            <ScheduleForm names={names} onCreate={(input) => act("new", () => api.createSchedule(input))} />
          </div>
        </div>
      )}
    </div>
  );
});
