// The Execute turn for an approved plan: mode `execute`, `planExecute: true` (the core then injects the plan
// execution skill), the plan attached (its saved file when there is one, else `plan: <title>`), and the parsed
// steps in the message. The plan text is cut to the core's per-file attachment cap and the cut is reported.
import { MAX_TEXT_CHARS_PER_FILE } from "../attach/limits";
import { executePlanMessage } from "./detect";

export interface ExecuteTurn {
  text: string;
  options: { mode: "execute"; planExecute: true; attachments: Array<{ path: string; content: string }> };
  /** The plan was longer than the core reads; the tail is not seen by the agent. */
  truncated: boolean;
}

export function buildExecuteTurn(plan: { title: string; content: string; savedPath: string | null }): ExecuteTurn {
  const label = plan.savedPath ?? `plan: ${plan.title || "saved plan"}`.slice(0, 120);
  const truncated = plan.content.length > MAX_TEXT_CHARS_PER_FILE;
  return {
    text: executePlanMessage(plan.content, plan.title || null),
    options: { mode: "execute", planExecute: true, attachments: [{ path: label, content: plan.content.slice(0, MAX_TEXT_CHARS_PER_FILE) }] },
    truncated,
  };
}
