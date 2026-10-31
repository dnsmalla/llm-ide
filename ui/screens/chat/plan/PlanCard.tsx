// The plan card under the last reply of a plan turn: Save plan, Edit, Execute plan, Refine in chat. The plan text is
// the model's reply (untrusted): rendered through the safe markdown view or as plain text in the editor, never as HTML.
import { useState } from "react";
import { Markdown } from "../MarkdownView";
import type { PlanActionState } from "./controller";
import type { PlanCard as Card } from "./card";
import { safeLine } from "../slash/sanitize";

export const PREVIEW_LINES_COLLAPSED = 12;

export interface PlanCardProps {
  card: Extract<Card, { kind: "plan" }>;
  state: PlanActionState;
  canSave: boolean;
  /** The plan text is cut at the core's attachment cap when executed. */
  onSave: (title: string, content: string, replace?: boolean) => void;
  onExecute: (title: string, content: string) => void;
  onRefine: (title: string) => void;
  onOpenLink?: (href: string) => void;
  onCopy?: (text: string) => void;
}

export function PlanCardView(p: PlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(p.card.title);
  const [body, setBody] = useState(p.card.content);
  const lines = p.card.content.split("\n");
  const shown = expanded ? p.card.content : lines.slice(0, PREVIEW_LINES_COLLAPSED).join("\n");
  const saving = p.state.save.status === "saving";
  const saved = p.state.save.status === "saved" ? p.state.save.path : null;
  const nSteps = p.card.steps.length;
  const heading = safeLine(p.card.title, 80) || "Plan";
  return (
    <section className="chat-plan" aria-label={`Plan: ${heading}`}>
      <header className="chat-plan-head">
        <strong>{heading}</strong>
        <span className="chat-muted">{nSteps > 0 ? `${nSteps} step${nSteps === 1 ? "" : "s"}` : "no numbered steps"}</span>
        {saved && <span className="chat-muted" role="status">Saved to {saved}</span>}
        {p.state.executed && <span className="chat-muted" role="status">Executing</span>}
      </header>
      {!editing && (
        <>
          <div className="chat-plan-body"><Markdown text={shown} onOpenLink={p.onOpenLink} onCopy={p.onCopy} /></div>
          {lines.length > PREVIEW_LINES_COLLAPSED && (
            <button type="button" className="chat-link-btn" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : `Show all ${lines.length} lines`}
            </button>
          )}
        </>
      )}
      {editing && (
        <div role="group" aria-label="Edit plan" className="chat-plan-edit">
          <label className="chat-muted" htmlFor="plan-title">Title</label>
          <input id="plan-title" className="chat-input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          <label className="chat-muted" htmlFor="plan-body">Plan</label>
          <textarea id="plan-body" className="chat-textarea" rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="chat-plan-actions">
            <button type="button" className="chat-btn chat-primary" disabled={saving || !p.canSave || body.trim() === ""} onClick={() => { p.onSave(title.trim() || p.card.title, body, true); setEditing(false); }}>Save edits</button>
            <button type="button" className="chat-btn" onClick={() => { setEditing(false); setBody(p.card.content); setTitle(p.card.title); }}>Cancel</button>
          </div>
        </div>
      )}
      {p.state.save.status === "error" && <p role="alert" className="chat-error">{p.state.save.message}</p>}
      {!p.canSave && saved === null && <p className="chat-muted">Open a project to save this plan to llm-doc/plans/.</p>}
      <div className="chat-plan-actions">
        <button type="button" className="chat-btn" disabled={saving || saved !== null || !p.canSave || editing} onClick={() => p.onSave(p.card.title, p.card.content)}>
          {saving ? "Saving…" : saved ? "Saved" : "Save plan"}
        </button>
        <button type="button" className="chat-btn" disabled={editing || p.state.executed} onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className="chat-btn" disabled={p.state.executed} onClick={() => p.onRefine(p.card.title)}>Refine in chat</button>
        <button type="button" className="chat-btn chat-primary" disabled={p.state.executed || editing} onClick={() => p.onExecute(p.card.title, p.card.content)}>Execute plan</button>
      </div>
    </section>
  );
}

/** "Nothing to execute." answer: no actions, a clear label. */
export function NothingToExecuteChip() {
  return <p className="chat-muted chat-plan-nothing" role="status">Nothing to execute. This answer needs no changes, so there is no plan to save.</p>;
}
