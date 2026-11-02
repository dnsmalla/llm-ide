// Optional run summary note, the desktop counterpart of the Mac's `writeSummaryNote` budget: one markdown note per
// finished run under llm-doc/loop/<yyyy>/<MM>/, with the goal, result, iterations and stage outcomes. It never
// changes the run's pass/fail result.
import type { FsApi } from "../../explorer/fs";
import type { LoopDefinition } from "./model.ts";
import { runStatusCode, type LoopRunOutcome } from "./runner.ts";

export type SummaryFs = Pick<FsApi, "create" | "write">;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "loop";
}

export function summaryPath(loop: LoopDefinition, at: Date): string {
  const yyyy = at.getUTCFullYear(); const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `llm-doc/loop/${yyyy}/${mm}/${stamp}-${slug(loop.name)}.md`;
}

export function renderSummary(loop: LoopDefinition, outcome: LoopRunOutcome, at: Date): string {
  const lines = [
    "---", `title: "${loop.name} loop run"`, "loop: " + JSON.stringify(loop.name), `run_at: ${at.toISOString()}`,
    `status: ${runStatusCode(outcome)}`, `iterations: ${outcome.iterationsUsed}`, "---", "",
    `# ${loop.name}`, "", loop.goal ? `**Goal:** ${loop.goal}` : "", loop.acceptanceCriteria ? `**Acceptance:** ${loop.acceptanceCriteria}` : "",
    "", `**Result:** ${outcome.passed ? "passed" : "failed"} — ${outcome.statusSummary}`, "", "## Stages", "",
  ];
  for (const o of outcome.stages) lines.push(`- ${o.ok ? "✓" : "✗"} **${o.stage.name}** (${o.stage.severity})`);
  return lines.join("\n") + "\n";
}

export async function writeSummaryNote(fs: SummaryFs, loop: LoopDefinition, outcome: LoopRunOutcome, at = new Date()): Promise<string> {
  const path = summaryPath(loop, at);
  let atDir = "";
  for (const seg of path.split("/").slice(0, -1)) { atDir = atDir ? `${atDir}/${seg}` : seg; try { await fs.create(atDir, "dir"); } catch (e) { if ((e as { code?: string })?.code !== "exists") throw e; } }
  await fs.write(path, renderSummary(loop, outcome, at), { expected_hash: null });
  return path;
}
