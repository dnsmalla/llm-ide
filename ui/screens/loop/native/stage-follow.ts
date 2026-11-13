// The Loop log marks a stage start with `$ <stage name>`. Follow it so the Process pane selects the stage that is
// actually running, instead of leaving the first stage selected for the whole run.
import type { LoopStage } from "./model.ts";

export function stageIdForLogLine(stages: readonly LoopStage[], line: string): string | null {
  if (!line.startsWith("$ ")) return null;
  const name = line.slice(2).trim();
  if (name === "") return null;
  return stages.find((s) => s.enabled && s.name === name)?.id ?? null;
}
