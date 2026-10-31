// Header extras of the Chat screen: mode badge, subagent chip of the last turn, route history.
import { ModeBadge, RouteHistory, SubagentChip } from "./Badges";
import { summarizeSubagents } from "./subagents";
import type { AssistantMessage, ChatState } from "../state";
import type { CoreTransport } from "../transport";

export function HeaderBadges({ chatId, mode, state, core }: { chatId: string; mode: string; state: ChatState; core: CoreTransport }) {
  const last = [...state.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
  return (
    <>
      <ModeBadge mode={mode} resolved={state.resolvedMode} />
      <SubagentChip summary={summarizeSubagents(last)} />
      <RouteHistory core={core} chatId={chatId} />
    </>
  );
}
