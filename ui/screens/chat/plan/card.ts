// The plan card model: derived from the chat state (the last finished assistant reply), never stored. A plan turn
// produces either a plan (Save / Edit / Execute / Refine), the "Nothing to execute." answer (a plain chip, no actions),
// or an ordinary reply (nothing).
import { assistantText, type ChatState } from "../state";
import { PLAN_MODES, looksLikePlan, opensWithNothingToExecute, parsePlanSteps, planTitle } from "./detect";

export type PlanCard =
  | { kind: "none" }
  | { kind: "nothing"; messageId: string }
  | { kind: "plan"; messageId: string; title: string; content: string; steps: string[] };

export interface PlanContext {
  /** The picked mode, or the one the server resolved for the last turn. */
  mode: string | null;
  /** An earlier turn of this chat ran a plan mode. */
  sessionPlanning?: boolean;
}

export function sessionIsPlanning(modes: ReadonlyArray<string | null | undefined>): boolean {
  return modes.some((m) => typeof m === "string" && PLAN_MODES.has(m));
}

/** Plan actions show on the LAST message only, once it is complete and the chat is idle. */
export function planCardFor(state: Pick<ChatState, "messages" | "phase">, ctx: PlanContext): PlanCard {
  if (state.phase !== "idle") return { kind: "none" };
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant" || last.status !== "done") return { kind: "none" };
  const planning = (ctx.mode !== null && PLAN_MODES.has(ctx.mode)) || ctx.sessionPlanning === true;
  if (!planning) return { kind: "none" };
  const content = assistantText(last);
  if (opensWithNothingToExecute(content)) return { kind: "nothing", messageId: last.id };
  if (!looksLikePlan(content)) return { kind: "none" };
  return { kind: "plan", messageId: last.id, title: planTitle(content), content, steps: parsePlanSteps(content) };
}

/** The plan as the user last edited it (title, text, steps), else the reply's own. */
export function effectivePlan(card: Extract<PlanCard, { kind: "plan" }>, edited: { title: string; content: string } | null): Extract<PlanCard, { kind: "plan" }> {
  return edited ? { ...card, title: edited.title, content: edited.content, steps: parsePlanSteps(edited.content) } : card;
}
