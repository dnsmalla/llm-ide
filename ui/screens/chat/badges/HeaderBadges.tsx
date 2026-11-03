// Header extras of the Chat screen: subagent chip of the last turn, route history.
import { RouteHistory, SubagentChip } from "./Badges";
import { summarizeSubagents } from "./subagents";
import type { AssistantMessage, ChatState } from "../state";
import type { CoreTransport } from "../transport";

export function HeaderBadges({ chatId, state, core }: { chatId: string; state: ChatState; core: CoreTransport }) {
  const last = [...state.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
  return (
    <>
      <SubagentChip summary={summarizeSubagents(last)} />
      <RouteHistory core={core} chatId={chatId} />
    </>
  );
}
