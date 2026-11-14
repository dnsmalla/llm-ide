// The issue trail: what a run posts on its GitHub/GitLab issue — one comment per step and one summary at the end — so
// the issue is the one place a person reads what an agent did. Shared by every runner (the Factory board, the Loop
// screen, …); a caller names its own process ("Factory", "Refactoring").
//
// Facts only: step, result, changed file names, a safe test command, one verdict line, cost, duration, MR link. Never
// tool output or code, which may hold secrets. Untrusted names sit in code spans so they cannot mention people or render
// links. Nothing here throws into a run: a comment is a courtesy.
import { displayLine } from "../../explorer/scm/model.ts";
import { issueNumberOf } from "./factory.ts";

export type IssueProvider = "github" | "gitlab";
export interface IssueTarget { provider: IssueProvider; repo: string; number: number }
/** A work item that may be a hosted issue. */
export interface CommentItem { source: string; id: string | null; repo: string | null; provider: IssueProvider | null }

export interface TrailDeps {
  request(path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** Settings → Repositories allows this operation for the provider. */
  allowed(provider: IssueProvider, op: "commentIssue" | "createIssue"): boolean;
  /** A failed comment/create is logged, never thrown into the run. */
  onError?(line: string): void;
}

const MAX_FILES = 20;
const MAX_STEPS = 40;

/** The hosted issue a work item came from, or null when it is not one (spec, free text, unknown repo or number). */
export function issueTarget(item: CommentItem): IssueTarget | null {
  const number = item.source === "issue" ? issueNumberOf(item.id) : null;
  if (!item.provider || !item.repo || number === null) return null;
  return { provider: item.provider, repo: item.repo, number };
}

/** The issue number at the end of a GitHub (`/issues/N`) or GitLab (`/-/issues/N`) issue URL, or null. */
export function issueNumberFromUrl(url: unknown): number | null {
  const m = typeof url === "string" ? /\/issues\/(\d{1,9})\/?$/.exec(url) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The value of the report's first `Verdict:` line, one plain line of at most 120 characters, or null. */
export function verdictLine(report: string): string | null {
  const m = /^\s*verdict\s*:\s*(.+)$/im.exec(report);
  const v = m ? displayLine(m[1]!).trim().slice(0, 120) : "";
  return v || null;
}

/** A path, name or command shown in a code span: one line, and a backtick cannot close the span. */
export function code(text: string, max = 200): string {
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

function changedLine(files: readonly string[]): string {
  const shown = files.slice(0, MAX_FILES).map((p) => code(p)).join(", ");
  const more = files.length > MAX_FILES ? ` … and ${files.length - MAX_FILES} more` : "";
  return `Changed files (${files.length}): ${shown}${more}`;
}

export interface StepFacts {
  /** The runner's name, shown first: "Factory", "Refactoring", a loop's own name. */
  process: string;
  stageName: string;
  ok: boolean;
  runId: string;
  mode: string;
  iteration: number;
  changedFiles?: readonly string[] | null;
  testCommand?: string | null;
  verdict?: string | null;
  durationSeconds?: number | null;
  costUsd?: number | null;
  /** A runOnce stage that already passed is reported without pretending it ran again. */
  skipped?: boolean;
  /** The word before "verdict:" ("Review", "Readiness"); default "Review". */
  verdictLabel?: string;
}

/** One step's comment. */
export function stepCommentBody(f: StepFacts): string {
  const head = `**${displayLine(f.process).replace(/[*`]/g, "").slice(0, 60)} · ${code(f.stageName, 80)}** — ${f.skipped ? "skipped" : f.ok ? "passed" : "failed"}`;
  const lines = [head, "", `Run ${code(f.runId, 80)} (${displayLine(String(f.mode)).slice(0, 20)})${f.iteration > 1 ? `, attempt ${f.iteration}` : ""}`];
  if (f.changedFiles && f.changedFiles.length > 0) lines.push(changedLine(f.changedFiles));
  const command = safeTestCommand(f.testCommand);
  if (command) lines.push(`Test command: ${code(command)}`);
  // A verdict comes from an agent that read untrusted text: a code span keeps links, images and mentions inert.
  if (f.verdict) lines.push(`${f.verdictLabel ?? "Review"} verdict: ${code(f.verdict, 120)}`);
  const facts: string[] = [];
  if (typeof f.durationSeconds === "number" && Number.isFinite(f.durationSeconds)) facts.push(`time ${Math.max(0, Math.round(f.durationSeconds))} s`);
  if (typeof f.costUsd === "number" && Number.isFinite(f.costUsd) && f.costUsd > 0) facts.push(`cost $${f.costUsd.toFixed(2)}`);
  if (facts.length) lines.push(facts.join(" · "));
  return lines.join("\n");
}

export interface SummaryFacts {
  process: string;
  runId: string;
  /** The run's status code (runStatusCode): success, failed, aborted, error, blocked.… */
  statusCode: string;
  statusSummary: string;
  steps: readonly { name: string; ok: boolean; attempts: number }[];
  changedFiles?: readonly string[] | null;
  durationSeconds?: number | null;
  costUsd?: number | null;
  /** A runOnce stage that already passed is reported without pretending it ran again. */
  skipped?: boolean;
  /** The MR/PR this run opened, or the reason none was opened. */
  mergeRequest?: { url: string } | { notOpened: string } | null;
}

const STATUS_WORD: Record<string, string> = { success: "passed", failed: "failed", aborted: "cancelled", error: "ended with an error" };

/** The end-of-run comment: outcome, every step with its result and attempts, what changed, cost, time, and the MR. */
export function runSummaryBody(f: SummaryFacts): string {
  const word = STATUS_WORD[f.statusCode] ?? (f.statusCode.startsWith("blocked") ? "blocked" : displayLine(f.statusCode).slice(0, 40));
  const lines = [`**${displayLine(f.process).replace(/[*`]/g, "").slice(0, 60)} · run summary** — ${word}`, "", `Run ${code(f.runId, 80)}`];
  const summary = displayLine(f.statusSummary).trim();
  if (summary) lines.push(`Result: ${code(summary, 200)}`);
  if (f.steps.length > 0) {
    lines.push("", "| Step | Result | Attempts |", "|---|---|---|");
    // A "|" ends a table cell even inside a code span, so it is escaped.
    for (const s of f.steps.slice(0, MAX_STEPS)) lines.push(`| ${code(s.name, 80).replace(/\|/g, "\\|")} | ${s.ok ? "passed" : "failed"} | ${s.attempts} |`);
    if (f.steps.length > MAX_STEPS) lines.push(`| … and ${f.steps.length - MAX_STEPS} more | | |`);
    lines.push("");
  }
  lines.push(f.changedFiles && f.changedFiles.length > 0 ? changedLine(f.changedFiles) : "Changed files: none");
  const facts: string[] = [];
  if (typeof f.durationSeconds === "number" && Number.isFinite(f.durationSeconds)) facts.push(`time ${Math.max(0, Math.round(f.durationSeconds))} s`);
  if (typeof f.costUsd === "number" && Number.isFinite(f.costUsd) && f.costUsd > 0) facts.push(`cost $${f.costUsd.toFixed(2)}`);
  if (facts.length) lines.push(facts.join(" · "));
  if (f.mergeRequest && "url" in f.mergeRequest) lines.push(`Merge request: ${f.mergeRequest.url}`);
  else if (f.mergeRequest) lines.push(`Merge request: not opened — ${displayLine(f.mergeRequest.notOpened).slice(0, 300)}`);
  return lines.join("\n");
}

/** One row per stage, in first-run order, with its last result and how many times it ran. */
export function summarizeSteps(outcomes: readonly { stage: { id: string; name: string }; ok: boolean }[]): { name: string; ok: boolean; attempts: number }[] {
  const byId = new Map<string, { name: string; ok: boolean; attempts: number }>();
  for (const o of outcomes) {
    const row = byId.get(o.stage.id);
    if (row) { row.ok = o.ok; row.attempts += 1; } else byId.set(o.stage.id, { name: o.stage.name, ok: o.ok, attempts: 1 });
  }
  return [...byId.values()];
}

const quiet = async <T>(p: () => Promise<T>): Promise<T | null> => { try { return await p(); } catch { return null; } };

/** Posts `text` on the issue when commenting is allowed. True when posted; never throws. */
export async function postIssueComment(d: TrailDeps, target: IssueTarget, text: string): Promise<boolean> {
  if (!d.allowed(target.provider, "commentIssue")) return false;
  const res = await quiet(() => d.request("/kb/issues/comment", { ...target, body: text.slice(0, 20_000) }));
  return res !== null && res.status >= 200 && res.status < 300;
}

/**
 * Opens a new issue for a run that has none, when creating issues is allowed. `idem` makes a retry within ten minutes
 * return the same issue instead of a second one. The issue, or null; never throws.
 */
export async function openTrailIssue(d: TrailDeps, req: { provider: IssueProvider; repo: string; title: string; body: string; idem: string }): Promise<IssueTarget | null> {
  if (!d.allowed(req.provider, "createIssue")) return null;
  const res = await quiet(() => d.request("/kb/issues/create", { provider: req.provider, repo: req.repo, title: displayLine(req.title).slice(0, 255), body: req.body.slice(0, 20_000), idem: req.idem }));
  if (!res || res.status < 200 || res.status >= 300) return null;
  const number = issueNumberFromUrl((res.body as { url?: unknown } | null)?.url);
  return number === null ? null : { provider: req.provider, repo: req.repo, number };
}

/** A run's comments, posted one after another in call order (a slow lookup never lets a later step land first). */
export interface IssueTrail {
  readonly target: IssueTarget;
  /** Queue a comment; the producer may look things up first and return null to post nothing. */
  post(body: string | (() => Promise<string | null>)): void;
  /** Resolves when every queued comment has been tried. */
  idle(): Promise<void>;
}

/** The body of an issue a run opens for itself: what runs, and where the comments will appear. */
export function runIssueBody(o: { process: string; runId: string; goal: string | null; steps: readonly string[] }): string {
  const lines = [`**${displayLine(o.process).replace(/[*`]/g, "").slice(0, 60)}** run ${code(o.runId, 80)}, opened by LLM-IDE.`];
  const goal = displayLine(o.goal ?? "").trim();
  if (goal) lines.push("", `Goal: ${code(goal, 500)}`);
  if (o.steps.length > 0) lines.push("", "Steps:", ...o.steps.slice(0, MAX_STEPS).map((s, i) => `${i + 1}. ${code(s, 80)}`));
  lines.push("", "Each step posts a comment below. The last comment is the run summary.");
  return lines.join("\n");
}

/**
 * The trail for one run: the run's own issue when it was started from one; otherwise, when `open` is set and the run's
 * repository is known, a new issue opened for the run. Null when there is nowhere to post. Never throws.
 */
export async function trailForRun(d: TrailDeps, o: {
  item: CommentItem | null; open: boolean; repo: { provider: IssueProvider; slug: string } | null;
  process: string; runId: string; goal: string | null; steps: readonly string[];
}): Promise<IssueTrail | null> {
  const existing = o.item ? issueTarget(o.item) : null;
  if (existing) return issueTrail(d, existing);
  if (!o.open || !o.repo) return null;
  const opened = await openTrailIssue(d, {
    provider: o.repo.provider, repo: o.repo.slug, title: `${o.process} run ${o.runId}`,
    // The core accepts 16 to 64 letters, digits, _ or -.
    body: runIssueBody(o), idem: `trail-${o.runId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64).padEnd(16, "0"),
  });
  return opened ? issueTrail(d, opened) : null;
}

export function issueTrail(d: TrailDeps, target: IssueTarget): IssueTrail {
  let chain: Promise<void> = Promise.resolve();
  return {
    target,
    post(body) {
      chain = chain.then(async () => {
        const text = typeof body === "string" ? body : await quiet(body);
        if (text && !(await postIssueComment(d, target, text))) d.onError?.(`issue comment failed for ${target.repo}#${target.number}`);
      }).then(() => undefined, () => undefined);
    },
    idle: () => chain,
  };
}
