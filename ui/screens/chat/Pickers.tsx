// Mode picker, model picker, permission chip and the cap chip popover. Native selects keep them keyboard
// and screen-reader complete; the cap popover is a labelled dialog region.
import { useState } from "react";
import {
  CAP_APPROXIMATION_NOTE, CAP_COUNTED_NOTE, CAP_NOT_ENFORCED, CAP_PRESETS, MODES, PERMISSION_MODES, PLAIN_CHAT_TITLE, RAISE_LIMIT_HELP, capLevel, coldSwitchWarning, compactTokens,
  meterText, modelDefaultLabel, modelPickerValue, parseLimit, plainChatDetail, raisedLimit, toolsBadge, type ModelGroup, type ModelPickerRoute, type PermissionMode, type PlainChatReason, type RouteView,
} from "./route";

export function ModePicker({ value, resolved, onChange, disabled }: { value: string; resolved?: string | null; onChange: (m: string) => void; disabled?: boolean }) {
  const shown = MODES.find((m) => m.id === value);
  return (
    <label className="chat-pick">
      <span className="chat-pick-label">Mode</span>
      <select aria-label="Mode" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} title={shown?.hint}>
        {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {value === "auto" && resolved && resolved !== "auto" && <span className="chat-muted" aria-live="polite">running as {resolved}</span>}
    </label>
  );
}

export function ModelPicker({ groups, provider, model, onChange, plainChat, loading, route }: {
  groups: readonly ModelGroup[]; provider: string | null; model: string | null;
  onChange: (provider: string, model: string) => void; plainChat?: PlainChatReason | null; loading?: boolean;
  /** The chat's route: with the router on, an unpinned chat shows "Not pinned (the composer's model)". */
  route?: ModelPickerRoute | null;
}) {
  const value = modelPickerValue(route, provider, model);
  const listed = groups.flatMap((g) => g.models);
  const composerLabel = provider && model ? (listed.find((m) => m.provider === provider && m.model === model)?.label ?? model) : null;
  // A pinned model that is not in the lists (a retired id) still shows as chosen, as the Mac's "Current" group does.
  const unlisted = value !== "" && !listed.some((m) => `${m.provider}|${m.model}` === value) ? value : null;
  return (
    <div className="chat-pick">
      <label>
        <span className="chat-pick-label">Model</span>
        <select aria-label="Model" value={value} disabled={loading} onChange={(e) => { const [p, ...m] = e.target.value.split("|"); if (p) onChange(p, m.join("|")); else onChange("", ""); }}>
          <option value="">{modelDefaultLabel(route, composerLabel)}</option>
          {unlisted && <optgroup label="Current"><option value={unlisted}>{unlisted.split("|").slice(1).join("|")}</option></optgroup>}
          {groups.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.models.map((m) => (
                <option key={`${m.provider}|${m.model}`} value={`${m.provider}|${m.model}`}>
                  {m.label}{g.catalog && m.toolsSupported !== undefined ? `  (${toolsBadge(m.toolsSupported)})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {groups.filter((g) => g.note).map((g) => <span key={g.id} className="chat-muted">{g.label}: {g.note}</span>)}
      {plainChat && <span className="chat-note" role="note" title={plainChatDetail(plainChat)}>{PLAIN_CHAT_TITLE}</span>}
    </div>
  );
}

/** "Applies to your next message: X" under the model picker (the Mac's pending-switch line). */
export function PendingSwitchNote({ pending }: { pending: { model: string } | null | undefined }) {
  if (!pending) return null;
  return <span className="chat-note" role="status">Applies to your next message: {pending.model || "Not pinned"}</span>;
}

export function PermissionChip({ value, onChange }: { value: PermissionMode; onChange: (m: PermissionMode) => void }) {
  const shown = PERMISSION_MODES.find((m) => m.id === value);
  return (
    <label className="chat-pick" data-bypass={value === "bypass"}>
      <span className="chat-pick-label">Permissions</span>
      <select aria-label="Permission mode" value={value} title={shown?.hint} onChange={(e) => onChange(e.target.value as PermissionMode)}>
        {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </label>
  );
}

/** What the cap meter counts, and that the limit is approximate. The Mac shows the same sentence in its popover. */
export function CapNotes({ used, tokenLimit, capEnforced }: { used: number; tokenLimit?: number | null; capEnforced?: boolean }) {
  return (
    <>
      <p className="chat-muted">Billable tokens used: {compactTokens(used)}.</p>
      <p className="chat-muted">{CAP_COUNTED_NOTE} {CAP_APPROXIMATION_NOTE}</p>
      {tokenLimit != null && capEnforced === false && <p className="chat-note" role="note">{CAP_NOT_ENFORCED}</p>}
    </>
  );
}

export interface CapChipProps {
  route: RouteView | null;
  /** The router is off on this core: the chip is not offered. */
  onSetLimit: (limit: number | null) => Promise<{ coldSwitch?: boolean; estimatedPrefillTokens?: number } | void>;
  disabled?: boolean;
}

export function CapChip({ route, onSetLimit, disabled }: CapChipProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!route || !route.enabled) return null;
  const used = route.used.billable;
  const level = capLevel(used, route.tokenLimit);
  const apply = async (limit: number | null) => {
    setErr(null);
    try { await onSetLimit(limit); setOpen(false); } catch (e) { setErr(e instanceof Error ? e.message : "Could not save the limit"); }
  };
  return (
    <div className="chat-cap" data-level={level}>
      <button type="button" className="chat-chip-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={`Token limit ${meterText(used, route.tokenLimit)}`}
        disabled={disabled} onClick={() => { setText(route.tokenLimit ? String(route.tokenLimit) : ""); setOpen(!open); }}>
        {meterText(used, route.tokenLimit, route.used.cacheRead)}
      </button>
      {open && (
        <div role="dialog" aria-label="Session token limit" className="chat-popover">
          <CapNotes used={used} tokenLimit={route.tokenLimit} capEnforced={route.capEnforced} />
          <div className="chat-presets" role="group" aria-label="Limit presets">
            {CAP_PRESETS.map((p) => <button key={p} type="button" className="chat-btn" onClick={() => void apply(p)}>{compactTokens(p)}</button>)}
            <button type="button" className="chat-btn" onClick={() => void apply(null)}>No limit</button>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); const v = parseLimit(text); if (v === undefined) setErr("Enter a number such as 200k or 1.5m."); else void apply(v); }}>
            <input className="chat-input" aria-label="Limit in tokens" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 200k" />
            <button type="submit" className="chat-btn">Set</button>
          </form>
          {level === "reached" && route.tokenLimit !== null && (
            <button type="button" className="chat-btn" title={RAISE_LIMIT_HELP} onClick={() => void apply(raisedLimit(route.tokenLimit!, used))}>Raise to {compactTokens(raisedLimit(route.tokenLimit, used))}</button>
          )}
          <p className="chat-muted">{coldSwitchWarning(0)}</p>
          {err && <p role="alert" className="chat-error">{err}</p>}
        </div>
      )}
    </div>
  );
}
