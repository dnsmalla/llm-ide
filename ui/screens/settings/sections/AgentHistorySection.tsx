import { useEffect, useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { AgentHistoryModel, CLEAR_AGES, CLEAR_CONFIRM_WORD, clearSuccess, formatBytes, rowLabel, scopeSentence, type ClearAge } from "../agent-history-model.ts";
import { LTA_MODES, LTA_TEXT, isLtaMode, ltaNeedsRestart, needsOffConfirm, type LtaMode } from "../misc-model.ts";
import { useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import type { ClearScope } from "../decoders.ts";
import { Button, ErrorText, Field, NeedsHost, TypedConfirm } from "../ui.tsx";

export default function AgentHistorySection() {
  const { client } = useEnv();
  const m = useModel(() => new AgentHistoryModel(client));
  const s = useStore(m);
  useRefreshOnFocus(() => void m.load());
  useEffect(() => () => m.dispose(), [m]);
  const history = s.report?.groups.find((g) => g.key === "agent_history");
  const range = m.retentionRange;

  return (
    <div className="st-stack">
      <LtaControl />
      <h3 className="st-label">Storage</h3>
      <ErrorText text={s.loadError} />
      {s.report ? (
        <table className="st-table" aria-label="Storage by group">
          <thead><tr><th scope="col">Group</th><th scope="col">Rows</th><th scope="col">Size</th></tr></thead>
          <tbody>
            {s.report.groups.map((g) => (
              <tr key={g.key}>
                <th scope="row">{g.label}</th>
                <td>{g.rows.toLocaleString()}</td>
                <td>{g.bytes === null ? "n/a" : `${g.bytesApprox ? "about " : ""}${formatBytes(g.bytes)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="st-hint" role="status">Loading storage numbers...</p>}
      {s.report?.agentStoreState && s.report.agentStoreState !== "ok" ? <StatusBanner severity="warning" message={`The agent history store reports: ${s.report.agentStoreState}.`} /> : null}

      <Field label={`Keep raw history for (days, ${range.min} to ${range.max})`}>
        <div className="st-row">
          <input className="st-input" type="number" min={range.min} max={range.max} step={1} value={s.retentionDraft} onChange={(e) => m.setRetentionDraft(Math.round(Number(e.target.value) || range.min))} aria-label="Retention in days" />
          <Button tone="primary" disabled={!m.retentionChanged || s.savingRetention} onClick={() => void m.saveRetention()}>Save</Button>
        </div>
      </Field>
      {s.retentionMessage ? <p className="st-hint" role="status">{s.retentionMessage}</p> : null}

      <div className="st-row">
        <Button disabled={s.compacting || !history} onClick={() => void m.compact()}>Compact</Button>
        <Button tone="danger" disabled={!history || s.clear.kind !== "idle"} onClick={() => void m.beginClear("raw", "older30")}>Clear raw history...</Button>
        <Button tone="danger" disabled={!history || s.clear.kind !== "idle"} onClick={() => void m.beginClear("all", "all")}>Clear everything...</Button>
      </div>
      {s.compactMessage ? <p className={s.compactMessage.isError ? "st-error" : "st-ok"} role="status">{s.compactMessage.text}</p> : null}
      <ClearSheet model={m} />
    </div>
  );
}

export function ClearSheet({ model }: { model: AgentHistoryModel }) {
  const s = useStore(model);
  const c = s.clear;
  if (c.kind === "idle") return null;
  if (c.kind === "previewing") return <p className="st-hint" role="status">Counting what would be deleted...</p>;
  if (c.kind === "failed") return (
    <div className="st-stack"><ErrorText text={c.message} /><Button onClick={() => model.cancelClear()}>Close</Button></div>
  );
  if (c.kind === "cleared") return (
    <div className="st-stack"><p className="st-ok" role="status">{clearSuccess(c.result)}</p><Button onClick={() => model.cancelClear()}>Close</Button></div>
  );
  const scope: ClearScope = c.scope;
  const preview = c.kind === "confirming" ? c.preview : null;
  return (
    <div className="st-stack">
      <Field label="Which rows">
        <select className="st-select" value={s.clearAge} disabled={c.kind === "clearing"} onChange={(e) => void model.setClearAge(e.target.value as ClearAge)}>
          {CLEAR_AGES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </Field>
      {s.clearNotice ? <StatusBanner severity="warning" message={s.clearNotice} /> : null}
      {preview ? (
        <TypedConfirm
          title={preview.total === 0 ? "Nothing to delete" : `Delete ${preview.total.toLocaleString()} rows?`}
          body={
            <>
              <p>{scopeSentence(scope, s.clearAge)}</p>
              <ul>{Object.entries(preview.counts).filter(([, n]) => n > 0).map(([k, n]) => <li key={k}>{rowLabel(k)}: {n.toLocaleString()}</li>)}</ul>
            </>
          }
          word={CLEAR_CONFIRM_WORD}
          actionLabel="Delete"
          busy={false}
          onConfirm={() => void model.confirmClear()}
          onCancel={() => model.cancelClear()}
        />
      ) : <p className="st-hint" role="status">Deleting...</p>}
    </div>
  );
}

function LtaControl() {
  const { host } = useEnv();
  const [selected, setSelected] = useState<LtaMode | null>(null);
  const [pendingOff, setPendingOff] = useState(false);
  useEffect(() => {
    let live = true;
    void host.getLtaMode?.().then((m) => { if (live && isLtaMode(m)) setSelected(m); });
    return () => { live = false; };
  }, [host]);
  if (!host.getLtaMode || !host.setLtaMode) return <NeedsHost what="The chat archiving mode" />;
  if (!selected) return null;
  const launch = host.launchLtaMode?.() ?? selected;
  const choose = (m: LtaMode) => {
    if (m === selected) return;
    if (needsOffConfirm(selected, launch, m)) { setPendingOff(true); return; }
    setPendingOff(false);
    setSelected(m);
    void host.setLtaMode!(m);
  };
  return (
    <div className="st-stack" role="group" aria-label="Chat archiving">
      <h3 className="st-label">Chat archiving</h3>
      <div className="st-row" role="radiogroup" aria-label="Chat archiving mode">
        {LTA_MODES.map((m) => (
          <label key={m} className="st-row"><input type="radio" name="lta" checked={selected === m} onChange={() => choose(m)} />{LTA_TEXT.title(m)}</label>
        ))}
      </div>
      <p className="st-hint">{LTA_TEXT.explanation(selected)}</p>
      {ltaNeedsRestart(selected, launch) ? <p className="st-hint">{LTA_TEXT.restartNote}</p> : null}
      {pendingOff ? (
        <div className="st-dialog" role="alertdialog" aria-label={LTA_TEXT.offConfirmTitle}>
          <strong>{LTA_TEXT.offConfirmTitle}</strong>
          <p>{LTA_TEXT.offConfirmMessage}</p>
          <div className="st-row">
            <Button tone="danger" onClick={() => { setPendingOff(false); setSelected("off"); void host.setLtaMode!("off"); }}>Turn off</Button>
            <Button onClick={() => setPendingOff(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
