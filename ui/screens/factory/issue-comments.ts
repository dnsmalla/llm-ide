// The comment the Factory posts on an issue after each step, so the issue shows what the run did. Facts only (step,
// result, changed file names, test command, review verdict line): never tool output or code, which may hold secrets.
import { displayLine } from "../explorer/scm/model.ts";
import { issueNumberOf, type FactoryRole, type RunMode } from "../loop/native/factory.ts";

export interface CommentItem { source: string; id: string | null; repo: string | null; provider: "github" | "gitlab" | null }
export interface IssueTarget { provider: "github" | "gitlab"; repo: string; number: number }

export interface StageCommentFacts {
  stageName: string; role: FactoryRole | null; ok: boolean; runId: string; mode: RunMode | string; iteration: number;
  changedFiles?: readonly string[] | null; testCommand?: string | null; verdict?: string | null;
}

const MAX_FILES = 20;

/** The hosted issue a work item came from, or null when it is not one (spec, free text, unknown repo or number). */
export function issueTarget(item: CommentItem): IssueTarget | null {
  const number = item.source === "issue" ? issueNumberOf(item.id) : null;
  if (!item.provider || !item.repo || number === null) return null;
  return { provider: item.provider, repo: item.repo, number };
}

/** The value of the report's first `Verdict:` line, one plain line of at most 120 characters, or null. */
export function verdictLine(report: string): string | null {
  const m = /^\s*verdict\s*:\s*(.+)$/im.exec(report);
  const v = m ? displayLine(m[1]!).trim().slice(0, 120) : "";
  return v || null;
}

/** A path or command shown in a code span: one line, and a backtick cannot close the span. */
function code(text: string, max = 200): string {
  return "`" + displayLine(text).replace(/`/g, "'").slice(0, max) + "`";
}

/**
 * A test command safe to show on a possibly public issue, or null. Commands often carry secrets in leading `NAME=value`
 * assignments, `--flag=value` options or URL credentials, so anything with `=` or `://` is not shown at all.
 */
export function safeTestCommand(command: string | null | undefined): string | null {
  const c = displayLine(command ?? "").trim();
  if (!c || c.includes("=") || c.includes("://") || /\$\{?[A-Za-z_]/.test(c)) return null;
  return c.slice(0, 120);
}

export function stageCommentBody(f: StageCommentFacts): string {
  const head = `**Factory · ${code(f.stageName, 80)}** — ${f.ok ? "passed" : "failed"}`;
  const lines = [head, "", `Run ${code(f.runId, 80)} (${displayLine(String(f.mode)).slice(0, 20)})${f.iteration > 1 ? `, attempt ${f.iteration}` : ""}`];
  if (f.changedFiles && f.changedFiles.length > 0) {
    const shown = f.changedFiles.slice(0, MAX_FILES).map((p) => code(p)).join(", ");
    const more = f.changedFiles.length > MAX_FILES ? ` … and ${f.changedFiles.length - MAX_FILES} more` : "";
    lines.push(`Changed files (${f.changedFiles.length}): ${shown}${more}`);
  }
  const command = safeTestCommand(f.testCommand);
  if (command) lines.push(`Test command: ${code(command)}`);
  // The verdict comes from an agent that read untrusted issue text: a code span keeps links, images and mentions inert.
  if (f.verdict) lines.push(`${f.role === "intake" || f.role === "intakeGate" ? "Readiness" : "Review"} verdict: ${code(f.verdict, 120)}`);
  return lines.join("\n");
}
