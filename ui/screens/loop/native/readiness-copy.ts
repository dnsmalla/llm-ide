// The app (not the agent) copies a Factory run's .factory/READINESS.md to llm-doc/factory/<yyyy>/<MM>/ after the run
// (spec A3), so the Review Conflicts tree shows it. This is the only write a Factory run makes outside its worktree.
import type { FsApi } from "../../explorer/fs";

export type ReadinessFs = Pick<FsApi, "read" | "create" | "write">;

/** `llm-doc/factory/<yyyy>/<MM>/<runId>-readiness.md`, in UTC like the Loop summary notes. */
export function readinessCopyPath(runId: string, at: Date): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `llm-doc/factory/${yyyy}/${mm}/${runId}-readiness.md`;
}

function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
}

/** Copies the run's readiness report. False when the run wrote none; other read/write failures throw. */
export async function copyReadiness(fs: ReadinessFs, runRootPrefix: string, runId: string, at: Date): Promise<boolean> {
  const source = `${runRootPrefix ? `${runRootPrefix}/` : ""}.factory/READINESS.md`;
  let text: string;
  try {
    const r = await fs.read(source, 1_000_000);
    if (r.status !== "ok" || r.text === null) return false;
    text = r.text;
  } catch (e) {
    if (codeOf(e) === "not_found" || codeOf(e) === "missing") return false;
    throw e;
  }
  const path = readinessCopyPath(runId, at);
  let dir = "";
  for (const seg of path.split("/").slice(0, -1)) {
    dir = dir ? `${dir}/${seg}` : seg;
    try { await fs.create(dir, "dir"); } catch (e) { if (codeOf(e) !== "exists") throw e; }
  }
  await fs.write(path, text, { expected_hash: null });
  return true;
}
