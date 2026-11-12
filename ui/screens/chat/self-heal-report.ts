// `/self-heal <what is wrong>` in Chat: the user tells Self-Heal about a problem the model could not solve. The report
// (their words plus the last exchange as data) becomes one Self-Heal incident; fixing stays the manual "Try to fix"
// run in Settings → Self-Heal, which shows its cost first. Pure apart from the injected `report`, so it is tested with node.
import type { Message } from "./state";

/** The incident category of a report made from Chat; the core never treats it as an environment problem. */
export const CHAT_REPORT_CATEGORY = "chat report";
const DESCRIPTION_MAX = 600;
const USER_MAX = 500;
const ASSISTANT_MAX = 800;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The visible text of an assistant reply (its text parts only; tool steps are left out). */
function assistantText(m: Extract<Message, { role: "assistant" }>): string {
  return m.parts.map((p) => (p.kind === "text" ? p.sealed.join("") + p.open : "")).join("");
}

/** The message stored with the incident: the description first, then the last user and assistant turns, labelled as data. */
export function buildChatReport(description: string, messages: readonly Message[]): string {
  const lastUser = [...messages].reverse().find((m): m is Extract<Message, { role: "user" }> => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant");
  const lines = [`Reported from Chat: ${clip(oneLine(description), DESCRIPTION_MAX)}`];
  if (lastUser) lines.push(`Last user message (data): ${clip(oneLine(lastUser.text), USER_MAX)}`);
  if (lastAssistant) {
    const text = oneLine(assistantText(lastAssistant));
    if (text) lines.push(`Last assistant reply (data): ${clip(text, ASSISTANT_MAX)}`);
  }
  return lines.join("\n");
}

export interface ReportDeps {
  /** Records one chat report; false when Self-Heal is off (a release build). */
  report: (message: string) => Promise<boolean>;
  /** How many reports are still waiting to reach the core. */
  pending: () => number;
}

/** What the user sees after `/self-heal …`. */
export async function reportFromChat(deps: ReportDeps, description: string, messages: readonly Message[]): Promise<string> {
  const d = oneLine(description);
  if (!d) return "Describe what is wrong: /self-heal <what is wrong>.";
  if (!(await deps.report(buildChatReport(d, messages)))) {
    return "Self-Heal is only available in debug desktop builds, so nothing was recorded.";
  }
  return deps.pending() > 0
    ? "Saved. It reaches Self-Heal as soon as the core is reachable. Then open Settings → Self-Heal → Try to fix."
    : "Reported to Self-Heal. Open Settings → Self-Heal and press Try to fix; it runs one agent in a separate worktree and changes nothing until you review the fix.";
}
