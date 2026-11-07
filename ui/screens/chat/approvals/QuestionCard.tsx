// A question the assistant asked (AskUserQuestion). Answers go to the model, so the card says so and refuses
// secret-shaped text. Option labels and descriptions are model text: rendered as text only.
import { useEffect, useState } from "react";
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
  const [submitted, setSubmitted] = useState(false);
  const phase = ui?.phase ?? "idle";
  const locked = submitted || turnClosed || phase === "submitting" || phase === "expired";
  useEffect(() => { if (phase === "failed") setSubmitted(false); }, [phase]);
  const set = (i: number, s: Selection) => { setProblem(null); setSels((cur) => cur.map((c, j) => (j === i ? s : c))); };
  return (
    <section className="appr-card" role="group" aria-label="The assistant has a question" data-phase={phase}>
      <header className="appr-head">
        <h3 className="appr-title">{questions.length === 1 && questions[0]?.header ? sanitizeText(questions[0].header, 60).text.toUpperCase() : "Question"}</h3>
        <span className="chat-spacer" />
        <span className="chat-muted">{position} of {total}</span>
      </header>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (locked) return;
        const r = buildAnswers(questions, sels);
        if (!r.ok) { setProblem(r.reason); return; }
        setSubmitted(true);
        onAnswer(r.answers);
      }}>
        {questions.map((q, i) => {
          return (
            <fieldset key={`${i}:${q.question}`} className="appr-q" disabled={locked}>
              <legend>{q.header && <span className="appr-badge">{sanitizeText(q.header, 60).text.toUpperCase()}</span>} {sanitizeText(q.question, 600).text}</legend>
              {q.options.slice(0, MAX_OPTIONS).map((o, oi) => {
                const on = sels[i].labels.includes(o.label);
                return (
                  <button key={`${oi}:${o.label}`} type="button" className="appr-option" data-selected={on} aria-pressed={on} disabled={locked} onClick={() => set(i, toggle(sels[i], o.label, q.multiSelect))}>
                    <span className="appr-check" aria-hidden="true">{on ? "✓" : ""}</span>
                    <span><strong>{sanitizeText(o.label, 200).text}</strong>{o.description && <span className="chat-muted"> {sanitizeText(o.description, 400).text}</span>}{o.preview && <pre className="appr-pre">{sanitizeText(o.preview, 1_500).text}</pre>}</span>
                  </button>
                );
              })}
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
          <button type="submit" className="chat-btn chat-primary" disabled={locked}>{submitted ? "Submitted" : "Submit"}</button>
          <button type="button" className="chat-btn" disabled={locked} onClick={onDecline}>Decline to answer</button>
        </div>
      </form>
    </section>
  );
}
