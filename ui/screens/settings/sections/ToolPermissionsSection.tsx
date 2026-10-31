import { useState } from "react";
import { TOOL_PERMISSIONS_TEXT, groupRules, ruleKey, ruleLabel, ToolPermissionsModel } from "../app-model.ts";
import { useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import { Button, ErrorText, TypedConfirm } from "../ui.tsx";

/** The Mac's "Tool permissions" group: the "Always allow" rules, per project, revocable. */
export default function ToolPermissionsSection() {
  const { client } = useEnv();
  const m = useModel(() => new ToolPermissionsModel(client));
  const s = useStore(m);
  const [confirmAll, setConfirmAll] = useState(false);
  useRefreshOnFocus(() => void m.load());
  const empty = s.perms.rules.length === 0 && s.perms.legacy.length === 0;
  return (
    <div className="st-stack">
      <p className="st-hint">{TOOL_PERMISSIONS_TEXT.hint}</p>
      <ErrorText text={s.error} />
      {!s.loaded ? <p className="st-hint" role="status">Loading...</p> : null}
      {s.loaded && !s.loadFailed && empty ? <p className="st-hint">{TOOL_PERMISSIONS_TEXT.empty}</p> : null}
      {groupRules(s.perms.rules).map((g) => (
        <div key={g.project} className="st-stack" role="group" aria-label={`Rules for ${g.project}`}>
          <span className="st-label">{g.project}</span>
          {g.rules.map((r) => (
            <div key={ruleKey(r)} className="st-row">
              <span className="st-grow">{ruleLabel(r)}</span>
              <span className="st-hint">Allowed {r.grantedAt.slice(0, 10)}</span>
              <Button disabled={s.busy} label={`Revoke ${ruleLabel(r)} in ${g.project}`} onClick={() => void m.revokeRule(r)}>Revoke</Button>
            </div>
          ))}
        </div>
      ))}
      {s.perms.legacy.length > 0 ? (
        <div className="st-stack" role="group" aria-label={TOOL_PERMISSIONS_TEXT.legacyTitle}>
          <span className="st-label">{TOOL_PERMISSIONS_TEXT.legacyTitle}</span>
          {s.perms.legacy.map((g) => (
            <div key={g.toolName} className="st-row">
              <span className="st-grow">{g.toolName}</span>
              <Button disabled={s.busy} label={`Remove older grant ${g.toolName}`} onClick={() => void m.removeLegacy(g)}>Remove</Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="st-row">
        <Button label={s.loadFailed ? "Retry" : "Refresh"} onClick={() => void m.load()}>{s.loadFailed ? "Retry" : "Refresh"}</Button>
        {!empty ? <Button tone="danger" disabled={s.busy} onClick={() => setConfirmAll(true)}>Revoke all...</Button> : null}
      </div>
      {confirmAll ? (
        <TypedConfirm
          title="Revoke every always-allow rule?"
          body={<p>{TOOL_PERMISSIONS_TEXT.revokeAllBody}</p>}
          word="REVOKE"
          actionLabel="Revoke all"
          busy={s.busy}
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => { setConfirmAll(false); void m.revokeAll(); }}
        />
      ) : null}
    </div>
  );
}
