// The plan area under the conversation: the plan card of the last plan reply, or the "Nothing to execute." chip.
import { useSyncExternalStore } from "react";
import { effectivePlan, planCardFor } from "./card";
import { buildExecuteTurn, type ExecuteTurn } from "./execute";
import { NothingToExecuteChip, PlanCardView } from "./PlanCard";
import type { PlanController } from "./controller";
import type { ChatState } from "../state";

export interface PlanAreaProps {
  chatId: string;
  state: ChatState;
  /** The picked mode ("auto" follows the server's resolved mode). */
  mode: string;
  plans: PlanController;
  /** Starts the Execute turn (the caller switches the picker to Execute and sends it). */
  onExecute: (turn: ExecuteTurn) => void;
  onRefine: (title: string) => void;
  onOpenLink?: (href: string) => void;
  onCopy?: (text: string) => void;
}

export function PlanArea(p: PlanAreaProps) {
  useSyncExternalStore(p.plans.subscribe, p.plans.getVersion, p.plans.getVersion);
  const effective = p.mode === "auto" ? p.state.resolvedMode : p.mode;
  const card = planCardFor(p.state, { mode: effective });
  if (card.kind === "nothing") return <NothingToExecuteChip />;
  if (card.kind !== "plan") return null;
  const st = p.plans.get(p.chatId, card.messageId);
  const plan = effectivePlan(card, st.edited);
  return (
    <PlanCardView
      card={plan} state={st} canSave={p.plans.canSave} onOpenLink={p.onOpenLink} onCopy={p.onCopy}
      onSave={(title, content, replace) => void p.plans.save(p.chatId, card.messageId, title, content, replace === true)}
      onRefine={p.onRefine}
      onExecute={(title, content) => {
        p.plans.markExecuted(p.chatId, card.messageId);
        p.onExecute(buildExecuteTurn({ title, content, savedPath: p.plans.savedPath(p.chatId, card.messageId) }));
      }}
    />
  );
}

/** Composer seed for "Refine in chat": the plan is named, since a transcript can hold several. */
export function refineSeed(title: string): string {
  const t = title.trim();
  return t === "" ? "Revise the plan: " : `Revise the plan "${t}": `;
}
