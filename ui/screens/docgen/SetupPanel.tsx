// Setup: template, command, per-run request, input estimate and the Generate / Cancel control.
import { useEffect, useState, type ReactNode } from "react";
import type { DocCommand, DocTemplate, FitReport } from "./model.ts";
import { MAX_COMMAND, MAX_PROMPT } from "./model.ts";
import type { RunState } from "./run.ts";
import { fitSentence } from "./SourcePanel";

export interface SetupPanelProps {
  surface: "doc" | "visual";
  templates: readonly DocTemplate[];
  commands: readonly DocCommand[];
  truncated: boolean;
  templateId: string | null;
  commandId: string | null;
  command: string;
  prompt: string;
  fit: FitReport | null;
  sourceCount: number;
  run: RunState;
  onTemplate: (id: string | null) => void;
  onCommandPick: (id: string | null) => void;
  onCommandText: (text: string) => void;
  onPrompt: (text: string) => void;
  onManage: () => void;
  onGenerate: () => void;
  onCancel: () => void;
}

export function SetupPanel(p: SetupPanelProps): ReactNode {
  const tpl = p.templates.find((t) => t.id === p.templateId) ?? null;
  const hasShape = (tpl !== null && tpl.sections.length > 0) || p.command.trim() !== "";
  const busy = p.run.phase === "reading" || p.run.phase === "generating";
  const missing = !hasShape ? "Choose a template or write a command." : p.sourceCount === 0 ? "Select at least one source." : null;
  const noun = p.surface === "visual" ? "visual" : "document";
  return (
    <section className="dg-setup" aria-label="Setup">
      <fieldset className="dg-group" disabled={busy}>
        <legend>Template</legend>
        <div className="dg-bar">
          <label className="dg-field dg-grow">
            <span className="dg-sr">Template</span>
            <select value={p.templateId ?? ""} onChange={(e) => p.onTemplate(e.target.value || null)}>
              <option value="">No template</option>
              {p.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="dg-btn" onClick={p.onManage}>
            Manage templates
          </button>
        </div>
        {tpl && <p className="dg-muted">Sections: {tpl.sections.length ? tpl.sections.join(", ") : "none (a template needs at least one ## section)"}</p>}
        {p.truncated && <p className="dg-muted">There are more templates than the core lists (2,000).</p>}
      </fieldset>
      <fieldset className="dg-group" disabled={busy}>
        <legend>Command</legend>
        <label className="dg-field">
          <span>Saved command</span>
          <select value={p.commandId ?? ""} onChange={(e) => p.onCommandPick(e.target.value || null)}>
            <option value="">Custom</option>
            {p.commands.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="dg-field">
          <span>Instruction (optional with a template)</span>
          <textarea rows={3} value={p.command} maxLength={MAX_COMMAND} onChange={(e) => p.onCommandText(e.target.value)} />
        </label>
      </fieldset>
      <fieldset className="dg-group" disabled={busy}>
        <legend>This run</legend>
        <label className="dg-field">
          <span>Request (optional)</span>
          <textarea rows={2} value={p.prompt} maxLength={MAX_PROMPT} onChange={(e) => p.onPrompt(e.target.value)} placeholder="Keep it short; write for the finance team; answer in Japanese" />
        </label>
        <p className="dg-muted">
          {p.prompt.length}/{MAX_PROMPT.toLocaleString("en")}. Say here which language to write in; the core has no separate language setting for documents.
        </p>
      </fieldset>
      <p className="dg-muted">Source text goes only to the model provider you chose in Settings; nothing else leaves this computer.</p>
      {p.fit && p.sourceCount > 0 && <p className="dg-muted">{fitSentence(p.fit)}</p>}
      <div className="dg-actions">
        {!busy ? (
          <button type="button" className="dg-btn dg-primary" disabled={missing !== null} aria-describedby={missing ? "dg-missing" : undefined} onClick={p.onGenerate}>
            Generate {noun}
          </button>
        ) : (
          <button type="button" className="dg-btn" onClick={p.onCancel}>
            Cancel
          </button>
        )}
        {missing && !busy && (
          <span id="dg-missing" className="dg-muted">
            {missing}
          </span>
        )}
      </div>
    </section>
  );
}

/** Seconds since `startedAt`, ticking once a second while mounted. */
export function Elapsed({ since }: { since: number | null }): ReactNode {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (since === null || now === null) return null;
  return <span>{Math.max(0, Math.round((now - since) / 1000))} s</span>;
}
