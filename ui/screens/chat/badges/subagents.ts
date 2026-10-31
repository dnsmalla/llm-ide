// Subagent activity of the last turn, derived from its tool calls (never stored): plugin subagents are reached
// through the `ask-subagent` tool, MCP-prefixed on the v2 engine (`mcp__llmide__ask-subagent`).
import type { AssistantMessage, ToolPart } from "../state";
import { safeLine } from "../slash/sanitize";

export type SubagentState = "running" | "done" | "error" | "stopped";
export interface SubagentRun { id: number; name: string | null; state: SubagentState }
export interface SubagentSummary { runs: SubagentRun[]; running: number; label: string }

export const isSubagentTool = (name: string | null): boolean => name !== null && /(^|__)ask-subagent$/.test(name);

function nameOf(t: ToolPart): string | null {
  if (t.argsTruncated) return null;
  try { const v = (JSON.parse(t.args) as { name?: unknown }).name; return typeof v === "string" ? safeLine(v, 60) || null : null; } catch { return null; }
}

export function summarizeSubagents(m: AssistantMessage | undefined): SubagentSummary {
  const runs: SubagentRun[] = [];
  if (m) {
    for (const p of m.parts) {
      if (p.kind !== "tool" || !isSubagentTool(p.name)) continue;
      const turnOpen = m.status === "streaming";
      const state: SubagentState = p.result ? (p.result.isError ? "error" : "done") : turnOpen ? "running" : "stopped";
      runs.push({ id: p.index, name: nameOf(p), state });
    }
  }
  const running = runs.filter((r) => r.state === "running").length;
  const n = runs.length;
  const label = n === 0 ? "" : running > 0 ? `${running} of ${n} agent${n === 1 ? "" : "s"} running` : `${n} agent${n === 1 ? "" : "s"}`;
  return { runs, running, label };
}
