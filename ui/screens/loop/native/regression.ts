// Native Regression sweep: re-verifies `status: fixed` fault reports. A fault with a saved verify command is checked
// by running that command; a legacy fault is re-asked through the loop-agent and compared to its saved response.
// The semantic judge is injected by the screen (deps.judge), and a failed sweep is repaired by the generic runner repair;
// without a judge a textual mismatch is reported, never silently passed.
import type { FsApi } from "../../explorer/fs";

export interface FaultReport { rel: string; prompt: string; response: string; verify: string | null }
export type RegressionFs = Pick<FsApi, "read" | "list">;
export interface RegressionDeps {
  ask(prompt: string): Promise<string>;
  /** Same-meaning judge over the saved and fresh answers. Absent = exact text comparison. */
  judge?(saved: string, fresh: string): Promise<boolean>;
  verify(fault: FaultReport): Promise<{ ok: boolean; output: string }>;
}
export interface RegressionResult { passed: boolean; checked: number; failures: string[]; notes: string[] }

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
  }
  return t;
}

export function parseFault(text: string): Omit<FaultReport, "rel"> | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const fm = text.slice(3, end).split("\n");
  const fields: Record<string, string> = {};
  for (const line of fm) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = unquote(m[2]);
  }
  if (fields.status !== "fixed") return null;
  if (!fields.prompt || !fields.response) return null;
  return { prompt: fields.prompt, response: fields.response, verify: fields.verify?.trim() || null };
}

async function fixedFaults(fs: RegressionFs, base: string, out: FaultReport[] = []): Promise<FaultReport[]> {
  let entries;
  try { entries = (await fs.list(base)).entries; } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.kind === "dir") await fixedFaults(fs, e.path, out);
    else if (e.kind === "file" && e.name.endsWith(".md")) {
      try {
        const r = await fs.read(e.path, 2_000_000);
        if (r.status === "ok" && r.text) {
          const f = parseFault(r.text);
          if (f) out.push({ rel: e.path, ...f });
        }
      } catch { /* unreadable fault is skipped */ }
    }
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export async function runRegression(fs: RegressionFs, faultsRoot: string, deps: RegressionDeps): Promise<RegressionResult> {
  const faults = await fixedFaults(fs, faultsRoot);
  const failures: string[] = [];
  const notes: string[] = [];
  for (const f of faults) {
    if (f.verify) {
      const r = await deps.verify(f);
      if (!r.ok) failures.push(`${f.rel}: verify failed${r.output ? ` — ${r.output.slice(0, 300)}` : ""}`);
      else notes.push(`${f.rel}: verify passed`);
    } else {
      try {
        const fresh = await deps.ask(f.prompt);
        if (norm(fresh) !== norm(f.response)) {
          if (deps.judge && (await deps.judge(f.response, fresh))) notes.push(`${f.rel}: unchanged (same meaning)`);
          else failures.push(`${f.rel}: response changed`);
        } else notes.push(`${f.rel}: unchanged`);
      } catch (e) {
        failures.push(`${f.rel}: could not re-ask (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  return { passed: failures.length === 0, checked: faults.length, failures, notes };
}

/** Marks a fixed fault open again after a run exhausted repair. Keeps the notes body untouched. */
export async function reopenFault(fs: RegressionFs & { write: FsApi["write"] }, rel: string): Promise<boolean> {
  let text: string;
  let hash: string | null;
  try { const r = await fs.read(rel, 2_000_000); if (r.status !== "ok" || !r.text) return false; text = r.text; hash = r.hash; } catch { return false; }
  if (!/^status:\s*fixed\s*$/m.test(text)) return false;
  const next = text.replace(/^status:\s*fixed\s*$/m, "status: open");
  // The host refuses a write over a file edited since this read, so a changed fault is never clobbered.
  try { await fs.write(rel, next, { expected_hash: hash }); return true; } catch { return false; }
}

/** The fault paths a failed sweep names (`system/faults/a.md: verify failed`), each once, in output order. */
export function faultPathsFromOutput(output: string): string[] {
  return [...new Set(Array.from(output.matchAll(/^([^\n:]+\.md):/gm), (m) => m[1].trim()))];
}
