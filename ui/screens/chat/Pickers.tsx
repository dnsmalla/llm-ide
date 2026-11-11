// Mode picker, model picker, permission chip and the cap chip popover. Native selects keep them keyboard
// and screen-reader complete; the cap popover is a labelled dialog region.
import { useState } from "react";
import { EFFORT_AUTO, effortLabel } from "./effort";
import { validateModelId, type UserModels } from "./custom-models";
import {
  CAP_APPROXIMATION_NOTE, CAP_COUNTED_NOTE, capChipText, CAP_NOT_ENFORCED, CAP_PRESETS, MODES, PERMISSION_MODES, PLAIN_CHAT_TITLE, RAISE_LIMIT_HELP, capLevel, coldSwitchWarning, compactTokens,
  MORE_PROVIDERS_HINT, meterText, modelDefaultLabel, modelOptionText, modelPickerValue, parseLimit, plainChatDetail, raisedLimit, type ModelGroup, type ModelPickerRoute, type PermissionMode, type PlainChatReason, type RouteView,
} from "./route";

export function ModePicker({ value, resolved, onChange, disabled, modes = MODES }: { value: string; resolved?: string | null; onChange: (m: string) => void; disabled?: boolean; modes?: readonly (typeof MODES)[number][] }) {
  const shown = modes.find((m) => m.id === value) ?? MODES.find((m) => m.id === value);
  return (
    <label className="chat-pick">
      <span className="chat-pick-label">Mode</span>
      <select aria-label="Mode" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} title={shown?.hint}>
        {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {value === "auto" && resolved && resolved !== "auto" && <span className="chat-muted" aria-live="polite">running as {resolved}</span>}
    </label>
  );
}

export function ModelPicker({ groups, provider, model, onChange, plainChat, loading, route, addGroup, onAdd, userModels, onRemove, onConnectProvider }: {
  groups: readonly ModelGroup[]; provider: string | null; model: string | null;
  onChange: (provider: string, model: string) => void; plainChat?: PlainChatReason | null; loading?: boolean;
  /** The chat's route: with the router on, an unpinned chat shows "Not pinned (the composer's model)". */
  route?: ModelPickerRoute | null;
  /** "Add model…": the connection the id joins (none for a custom provider = no button), and what happens with the id. */
  addGroup?: ModelGroup | null; onAdd?: (groupId: string, id: string) => void;
  /** The user's added ids; the selected one can be removed (a refused id is dropped this way). */
  userModels?: UserModels; onRemove?: (groupId: string, id: string) => void;
  /** No model is available: open Settings → Providers to add a key. */
  onConnectProvider?: () => void;
}) {
  const value = modelPickerValue(route, provider, model);
  const listed = groups.flatMap((g) => g.models);
  if (!loading && listed.length === 0 && onConnectProvider) {
    return <div className="chat-model-empty"><button type="button" className="chat-btn" onClick={onConnectProvider}>Connect a provider</button><span className="chat-muted">Add a model key in Settings → Providers.</span></div>;
  }
  const removable = groups.find((g) => g.provider === provider && (userModels?.[g.id] ?? []).includes(model ?? ""));
  const composerLabel = provider && model ? (listed.find((m) => m.provider === provider && m.model === model)?.label ?? model) : null;
  // A pinned model that is not in the lists (a retired id) still shows as chosen, as the Mac's "Current" group does.
  const unlisted = value !== "" && !listed.some((m) => `${m.provider}|${m.model}` === value) ? value : null;
  const unlistedModel = unlisted?.split("|").slice(1).join("|") ?? "";
  const unlistedProvider = unlisted?.split("|")[0] ?? "";
  const unlistedLabel = unlisted ? `${groups.find((g) => g.provider === unlistedProvider || g.models.some((m) => m.provider === unlistedProvider))?.label ?? unlistedProvider} · ${unlistedModel}` : null;
  // What the core will run when nothing is pinned: the SDK's first model is its default.
  const autoGroup = groups.find((g) => g.id === "anthropic") ?? groups[0];
  const autoModel = autoGroup?.models[0];
  const detected = autoModel ? `${autoGroup.label} · ${autoModel.label}` : null;
  return (
    <div className="chat-pick">
      <label>
        <span className="chat-pick-label">Model</span>
        <select aria-label="Model" value={value} disabled={loading} onChange={(e) => { const [p, ...m] = e.target.value.split("|"); if (p) onChange(p, m.join("|")); else onChange("", ""); }}>
          <option value="">{modelDefaultLabel(route, composerLabel, detected)}</option>
          {unlisted && <optgroup label="Current (not in the provider list)"><option value={unlisted}>{unlistedLabel}</option></optgroup>}
          {groups.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.models.map((m) => (
                <option key={`${m.provider}|${m.model}`} value={`${m.provider}|${m.model}`}>
                  {modelOptionText(g, m, value === `${m.provider}|${m.model}`)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {unlisted && <span className="chat-note" role="note">This chat is pinned to “{unlistedModel}”, which is not in the provider’s current model list. It is sent as-is; choose a listed model to use the provider’s current one.</span>}
      {groups.filter((g) => g.note).map((g) => <span key={g.id} className="chat-muted">{g.label}: {g.note}</span>)}
      {groups.length > 0 && groups.every((g) => g.id === "anthropic") && <span className="chat-muted chat-more-providers">{MORE_PROVIDERS_HINT}</span>}
      {plainChat && <span className="chat-note" role="note" title={plainChatDetail(plainChat)}>{PLAIN_CHAT_TITLE}</span>}
      {addGroup && onAdd && <AddModelControl groupLabel={addGroup.label} onAdd={(id) => onAdd(addGroup.id, id)} />}
      {removable && onRemove && model && <button type="button" className="chat-link-btn" onClick={() => onRemove(removable.id, model)}>Remove {model}</button>}
    </div>
  );
}

/** "Add model…" and its dialog. Its own state, so the picker itself stays a plain function of its props. */
export function AddModelControl({ groupLabel, onAdd }: { groupLabel: string; onAdd: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="chat-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}aria-label="Add model…" title="Add model…">＋</button>
      {open && <AddModelDialog groupLabel={groupLabel} onCancel={() => setOpen(false)} onAdd={(id) => { setOpen(false); onAdd(id); }} />}
    </>
  );
}

/** The Mac's "Add a model" alert as an inline dialog: one model id for the connection; the id is checked here, the core decides the rest. */
export function AddModelDialog({ groupLabel, onAdd, onCancel }: { groupLabel: string; onAdd: (id: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div role="dialog" aria-label="Add a model" className="chat-popover">
      <form onSubmit={(e) => { e.preventDefault(); const v = validateModelId(text); if (v.ok) onAdd(v.id); else setErr(v.message); }}>
        <p className="chat-muted">Adds a model id under {groupLabel}. It is sent to the core as typed; the core or the provider decides whether it runs.</p>
        <input className="chat-input" aria-label="Model id" value={text} onChange={(e) => { setText(e.target.value); setErr(null); }}
          placeholder="model id, e.g. gpt-5 / claude-opus-4-9 / gemini-2.5-pro" autoFocus />
        <button type="submit" className="chat-btn">Add</button>
        <button type="button" className="chat-btn" onClick={onCancel}>Cancel</button>
      </form>
      {err && <p role="alert" className="chat-error">{err}</p>}
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
        title="This chat's model and token limit" disabled={disabled} onClick={() => { setText(route.tokenLimit ? String(route.tokenLimit) : ""); setOpen(!open); }}>
        {capChipText(route)}
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

/** The Mac's "Effort" section as its own chip. Hidden when the model offers no levels; a level the model lacks is shown as Auto. */
export function EffortPicker({ levels, value, onChange, disabled }: { levels: readonly string[]; value: string; onChange: (level: string) => void; disabled?: boolean }) {
  if (levels.length === 0) return null;
  return (
    <label className="chat-pick">
      <span className="chat-pick-label">Effort</span>
      <select aria-label="Effort" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {[EFFORT_AUTO, ...levels].map((l) => <option key={l} value={l}>{effortLabel(l)}</option>)}
      </select>
    </label>
  );
}
