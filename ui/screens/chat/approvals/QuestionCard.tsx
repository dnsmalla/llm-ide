// A question the assistant asked (AskUserQuestion). Answers go to the model, so the card says so and refuses
// secret-shaped text. Option labels and descriptions are model text: rendered as text only.
import { useState } from "react";
import type { PendingApproval } from "../state";
import { MAX_FREE_TEXT, MAX_OPTIONS, MAX_QUESTIONS, SECRET_NOTE, buildAnswers, emptySelections, toggle, type Selection } from "./questions";
import { sanitizeText } from "./sanitize";
import type { CardUi } from "./machine";

export interface QuestionCardProps {
  approval: PendingApproval;
  ui: CardUi | undefined;
  position: number;
  total: number;
  turnClosed: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  onDecline: () => void;
}

export function QuestionCard({ approval, ui, position, total, turnClosed, onAnswer, onDecline }: QuestionCardProps) {
  const questions = (approval.questions ?? []).slice(0, MAX_QUESTIONS);
  const [sels, setSels] = useState<Selection[]>(() => emptySelections(questions.length));
  const [problem, setProblem] = useState<string | null>(null);
  const phase = ui?.phase ?? "idle";
  const locked = turnClosed || phase === "submitting" || phase === "expired";
  const set = (i: number, s: Selection) => { setProblem(null); setSels((cur) => cur.map((c, j) => (j === i ? s : c))); };
  return (
    <section className="appr-card" role="group" aria-label="The assistant has a question" data-phase={phase}>
      <header className="appr-head">
        <h3 className="appr-title">Question</h3>
        <span className="chat-spacer" />
        <span className="chat-muted">{position} of {total}</span>
      </header>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (locked) return;
        const r = buildAnswers(questions, sels);
        if (!r.ok) { setProblem(r.reason); return; }
        onAnswer(r.answers);
      }}>
        {questions.map((q, i) => {
          const name = `q${i}-${approval.requestId}`;
          return (
            <fieldset key={i} className="appr-q" disabled={locked}>
              <legend>{q.header && <span className="appr-badge">{sanitizeText(q.header, 60).text}</span>} {sanitizeText(q.question, 600).text}</legend>
              {q.options.slice(0, MAX_OPTIONS).map((o) => (
                <label key={o.label} className="appr-opt">
                  <input type={q.multiSelect ? "checkbox" : "radio"} name={name} checked={sels[i].labels.includes(o.label)} onChange={() => set(i, toggle(sels[i], o.label, q.multiSelect))} />
                  <span>
                    {sanitizeText(o.label, 200).text}
                    {o.description && <span className="chat-muted"> {sanitizeText(o.description, 400).text}</span>}
                    {o.preview && <pre className="appr-pre">{sanitizeText(o.preview, 1_500).text}</pre>}
                  </span>
                </label>
              ))}
              <label className="appr-opt">
                <span className="chat-muted">Other</span>
                <input className="chat-input" aria-label={`Other answer for: ${sanitizeText(q.question, 100).text}`} maxLength={MAX_FREE_TEXT} value={sels[i].other}
                  onChange={(e) => set(i, { labels: q.multiSelect ? sels[i].labels : [], other: e.target.value })} />
              </label>
            </fieldset>
          );
        })}
        <p className="chat-muted" role="note">{SECRET_NOTE}</p>
        {(problem || ui?.error) && <p role="alert" className="chat-error">{problem ?? ui?.error}</p>}
        <div className="appr-actions">
          <button type="submit" className="chat-btn chat-primary" disabled={locked}>Send answer</button>
          <button type="button" className="chat-btn" disabled={locked} onClick={onDecline}>Decline to answer</button>
        </div>
      </form>
    </section>
  );
}
