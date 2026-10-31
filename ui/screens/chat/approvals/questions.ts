// Question cards (AskUserQuestion). The answers dictionary is keyed by the question text and passed verbatim to the
// SDK; multi-select answers are the chosen labels sorted and comma-joined (the Mac's ApprovalQuestionCard format).
import type { Question } from "../events";
import { looksSecret } from "./redact";
import { sanitizeText } from "./sanitize";

export const MAX_FREE_TEXT = 2_000;
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 20;
export const SECRET_NOTE = "Your answers are sent to the model. Do not enter passwords, keys or other secrets.";

export interface Selection { labels: readonly string[]; other: string }
export type Selections = readonly Selection[];

export const emptySelections = (n: number): Selection[] => Array.from({ length: n }, () => ({ labels: [], other: "" }));

export function toggle(sel: Selection, label: string, multi: boolean): Selection {
  const has = sel.labels.includes(label);
  if (multi) return { ...sel, labels: has ? sel.labels.filter((l) => l !== label) : [...sel.labels, label] };
  return { ...sel, labels: has ? [] : [label], other: has ? sel.other : "" };
}

export type AnswersResult = { ok: true; answers: Record<string, string> } | { ok: false; reason: string };

export function buildAnswers(questions: readonly Question[], sels: Selections): AnswersResult {
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const s = sels[i] ?? { labels: [], other: "" };
    const other = s.other.trim();
    if (s.labels.length === 0 && !other) return { ok: false, reason: "Answer every question." };
    if (other.length > MAX_FREE_TEXT) return { ok: false, reason: `Keep an answer under ${MAX_FREE_TEXT} characters.` };
    if (other && looksSecret(other)) return { ok: false, reason: "That looks like a secret. Remove it: answers are sent to the model." };
    const allowed = new Set(q.options.map((o) => o.label));
    const chosen = s.labels.filter((l) => allowed.has(l));
    const parts = [...chosen].sort();
    // Free text replaces the choice for single select; it is added for multi select.
    const value = q.multiSelect ? [...parts, ...(other ? [sanitizeText(other, MAX_FREE_TEXT).text] : [])].join(",") : other ? sanitizeText(other, MAX_FREE_TEXT).text : parts[0] ?? "";
    if (!value) return { ok: false, reason: "Answer every question." };
    answers[q.question] = value;
  }
  return { ok: true, answers };
}
