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
  for (const seg of path.split("/").slice(0, -1)) { atDir = atDir ? `${atDir}/${seg}` : seg; try { await fs.create(atDir, "dir"); } catch { /* already exists, or the write below reports the real failure */ } }
  await fs.write(path, renderSummary(loop, outcome, at), { expected_hash: null });
  return path;
}

export interface RunArchiveFs extends SummaryFs {
  read(path: string, max?: number): Promise<{ status: string; text: string | null }>;
}

/** One folder per run under llm-doc/loop/, holding run.md and the plan it produced. */
export function archiveDir(loop: LoopDefinition, at: Date): string {
  return summaryPath(loop, at).replace(/\.md$/, "");
}

const PLAN_CANDIDATES = [
  "llm-doc/loop/refactor/REFACTOR.md",
  "llm-doc/loop/test/TEST-MAP.md",
  "llm-doc/loop/test/TEST-STRUCTURE.md",
  ".factory/PLAN.md",
  ".factory/READINESS.md",
  ".factory/REVIEW.md",
];

function withTimings(outcome: LoopRunOutcome): string {
  const lines: string[] = ["## Stage timings", ""];
  for (const o of outcome.stages) {
    const seconds = typeof o.durationMs === "number" ? `${Math.round(o.durationMs / 1000)}s` : "—";
    const cost = o.usage?.costUsd ? ` · $${o.usage.costUsd.toFixed(2)}` : "";
    lines.push(`- ${o.ok ? "✓" : "✗"} **${o.stage.name}** — ${seconds}${cost}`);
  }
  return lines.join("\n") + "\n";
}

/** Persist every run: run.md (summary, per-stage time/cost, full log) plus the plan file(s) it wrote. Never throws. */
export async function writeRunArchive(fs: RunArchiveFs, loop: LoopDefinition, outcome: LoopRunOutcome, log: readonly string[], at = new Date(), runPrefix = "", inputPath = ""): Promise<string | null> {
  try {
    const dir = archiveDir(loop, at);
    let part = "";
    for (const seg of dir.split("/")) { part = part ? `${part}/${seg}` : seg; try { await fs.create(part, "dir"); } catch { /* already exists, or the write below reports the real failure */ } }
    const fence = "~~~~";
    const body = [
      renderSummary(loop, outcome, at).trimEnd(),
      "",
      withTimings(outcome),
      "",
      "## Run log",
      "",
      fence,
      ...log.map((l) => l.replace(/\r/g, "")),
      fence,
      "",
    ].join("\n");
    await fs.write(`${dir}/run.md`, body, { expected_hash: null });
    const copied: string[] = [];
    for (const rel of PLAN_CANDIDATES) {
      try {
        let text: string | null = null;
        for (const candidate of [rel, ...(inputPath ? [`${inputPath}/${rel}`] : [])]) {
          const r = await fs.read(runPrefix ? `${runPrefix}/${candidate}` : candidate, 4_000_000);
          if (r.status === "ok" && typeof r.text === "string") { text = r.text; break; }
        }
        if (text === null) continue;
        const name = rel.startsWith(".factory/") ? rel.replace(".factory/", "") : rel.split("/").pop()!;
        await fs.write(`${dir}/${name}`, text, { expected_hash: null });
        copied.push(name);
      } catch { /* not produced by this loop */ }
    }
    if (copied.length) await fs.write(`${dir}/README.md`, `Run archive for ${loop.name}.\\n\\n- run.md — summary, timings and full log\\n${copied.map((n) => `- ${n}`).join("\\n")}\\n`, { expected_hash: null });
    return dir;
  } catch { return null; }
}
