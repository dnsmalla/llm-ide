// Plan detection and parsing, ported from the Mac (`PlanEditPolicy`, `CodeAssistant+Plan`, `PlanMarkdown`,
// `FilesystemSlug`). On the v2 engine the plan IS the reply: the client decides whether a finished reply reads as a
// plan, derives its title and steps, saves it under `llm-doc/plans/`, and sends an Execute turn with it attached.
// Conservative on purpose: a plan is long, sectioned, and enumerates work, and a reply that ends by asking the
// reader something is a proposal waiting on an answer, not a plan to carry out. Pure.

export const MIN_PLAN_BYTES = 400;
export const MIN_PLAN_STEPS = 2;
export const UNSECTIONED_PLAN_STEPS = 3;
/** Plan modes: the picker stays here until the user executes or picks another mode. */
export const PLAN_MODES: ReadonlySet<string> = new Set(["plan", "assist_plan"]);
/** The triage marker of the plan bindings (extension/llm_agent/plan/plan-pipeline.mjs, TRIAGE_CLAUSE). */
export const NOTHING_TO_EXECUTE = "Nothing to execute.";
export const MAX_PLAN_STEPS = 30;
export const PLANS_DIR = "llm-doc/plans";

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Fenced blocks blanked line by line (CommonMark: a fence closes on the same char, at least as long, no info string). */
export function blankingCodeFences(content: string): string {
  let open: { ch: string; len: number } | null = null;
  return content.split("\n").map((line) => {
    const t = line.trim();
    const ch = t[0];
    let run = 0;
    while (run < t.length && t[run] === ch) run++;
    if (open) {
      if (ch === open.ch && run >= open.len && run === t.length) open = null;
      return "";
    }
    if ((ch === "`" || ch === "~") && run >= 3) { open = { ch, len: run }; return ""; }
    return line;
  }).join("\n");
}

/** The reply opens with the triage marker: there is nothing to plan, so no Save or Execute. */
export function opensWithNothingToExecute(content: string): boolean {
  const first = (content.split("\n", 1)[0] ?? "").replaceAll("*", "").replaceAll("_", "").replace(/^[#> \t]+|[#> \t]+$/g, "").toLowerCase();
  return first.startsWith("nothing to execute");
}

function headingBody(line: string): string | null {
  let n = 0;
  while (n < line.length && line[n] === "#") n++;
  if (n < 1 || n > 6 || line[n] !== " ") return null;
  const body = line.slice(n).trim();
  return body === "" ? null : body;
}

const STEP_WORDS = ["phase", "step", "stage", "フェーズ", "ステップ", "ステージ", "段階", "手順"];
const isDigit = (c: string | undefined): boolean => c !== undefined && /\p{Nd}/u.test(c);

function startsWithStepWord(body: string): boolean {
  const lower = body.toLowerCase();
  for (const w of STEP_WORDS) {
    if (!lower.startsWith(w)) continue;
    const rest = lower.slice(w.length).replace(/^[ 　]+/, "");
    if (isDigit(rest[0])) return true;
  }
  return lower.startsWith("第") && isDigit(lower[1]);
}

function startsWithCheckbox(line: string): boolean {
  if (line[0] !== "-" && line[0] !== "*") return false;
  const rest = line.slice(1).replace(/^ +/, "");
  if (!rest.startsWith("[") || rest.length <= 3) return false;
  return ["[ ]", "[x]", "[-]"].includes(rest.slice(0, 3).toLowerCase());
}

const LIST_MARKERS = new Set([".", ")", "．", "）", "、"]);

function isStepLine(line: string): boolean {
  const h = headingBody(line);
  if (h !== null) return startsWithStepWord(h);
  if (startsWithCheckbox(line)) return true;
  let d = 0;
  while (d < line.length && isDigit(line[d])) d++;
  if (d === 0 || d > 2) return false;
  const marker = line[d];
  if (marker === undefined || !LIST_MARKERS.has(marker)) return false;
  return marker === "." || marker === ")" ? line[d + 1] === " " : true;
}

function asksSomething(line: string): boolean {
  const s = line.trim().replace(/[*`_ ]+$/g, "");
  const last = s[s.length - 1];
  return last === "?" || last === "？";
}

/** Whether an assistant reply reads as a plan: long, sectioned, enumerating work, not ending on a question. */
export function looksLikePlan(content: string): boolean {
  const trimmed = content.trim();
  if (utf8Len(trimmed) < MIN_PLAN_BYTES) return false;
  if (opensWithNothingToExecute(trimmed)) return false;
  let hasHeading = false, steps = 0, last = "", inFence = false;
  for (const raw of trimmed.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) { inFence = !inFence; continue; }
    if (inFence || line === "") continue;
    if (headingBody(line) !== null) hasHeading = true;
    const indent = raw.length - raw.replace(/^[ \t]+/, "").length;
    if (indent < 2 && isStepLine(line) && !asksSomething(line)) steps++;
    last = line;
  }
  if (asksSomething(last)) return false;
  return steps >= MIN_PLAN_STEPS && (hasHeading || steps >= UNSECTIONED_PLAN_STEPS);
}

// --- steps ------------------------------------------------------------------------------------

function stripCheckbox(text: string): string {
  const t = text.trim();
  if (!t.startsWith("[") || t.length <= 3) return t;
  return ["[ ]", "[x]", "[-]"].includes(t.slice(0, 3).toLowerCase()) ? t.slice(3).trim() : t;
}

function stepLines(content: string, patterns: RegExp[]): string[] {
  const steps: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (steps.length >= MAX_PLAN_STEPS) break;
    const indent = raw.length - raw.replace(/^[ \t]+/, "").length;
    if (indent >= 2) continue; // sub-details of the step above
    const t = raw.trim();
    if (t === "") continue;
    for (const re of patterns) {
      const m = re.exec(t);
      if (!m || m.length < 3) continue;
      const step = stripCheckbox(m[2]);
      if (step.length <= 2) continue;
      steps.push(step);
      break;
    }
  }
  return steps;
}

const STEPS_HEADING = /^(#{1,6})\s*(?:\d+[.:)]\s*)?(steps?|implementation|implementation plan|tasks?|work items?)\b(?!\s*\d).*$/i;

function stepsSection(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = STEPS_HEADING.exec(lines[i]);
    if (m) { start = i + 1; level = m[1].length; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const section = lines.slice(start, end).join("\n");
  return section.trim() === "" ? null : section;
}

/** Best-effort step list: an explicit steps section first, then Task/Phase headings, numbered lines, bullets. At most 30. */
export function parsePlanSteps(content: string): string[] {
  const prose = blankingCodeFences(content);
  const scoped = stepsSection(prose) ?? prose;
  const tasks = stepLines(scoped, [/^(#{1,4}\s*(?:Task|Phase)\s*\d+[.:)]?)\s*(.+)$/i]);
  if (tasks.length) return tasks;
  const numbered = stepLines(scoped, [/^(\d+[.)])\s+(.+)$/i, /^(#{1,4}\s*Step\s*\d*[.:)]?)\s*(.+)$/i, /^(#{1,4}\s*\d+[.:)])\s*(.+)$/i]);
  if (numbered.length) return numbered;
  return stepLines(scoped, [/^([-*])\s+(.+)$/i]);
}

export const GENERIC_EXECUTE_MESSAGE = "Execute the attached plan step by step, starting from step 1. Report progress after each step.";

/** The Execute turn's text: the parsed steps (the HOW comes from the skill the core injects for `planExecute`). */
export function executePlanMessage(content: string, title: string | null): string {
  const steps = parsePlanSteps(content);
  if (steps.length === 0) return GENERIC_EXECUTE_MESSAGE;
  const parts = ["Execute the attached approved plan."];
  if (title) parts.push(`Plan title: "${title}".`);
  parts.push("Follow the execution skill in your instructions, starting at step 1.", "Steps:");
  steps.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
  parts.push("Report what you completed.");
  return parts.join("\n");
}

// --- title and file name ------------------------------------------------------------------------

const GENERIC_HEADINGS: ReadonlySet<string> = new Set([
  "global constraints", "constraints", "context", "overview", "summary", "background", "goal", "goals", "design", "design decisions", "decisions",
  "architecture", "tech stack", "file structure", "files", "files to change", "steps", "tasks", "implementation", "implementation plan", "verification",
  "testing", "risks", "notes", "open questions", "out of scope", "deliberately out of scope", "spec", "plan",
]);

function isGenericHeading(body: string): boolean {
  const lower = body.toLowerCase();
  if (/^(task|step|phase)\s*\d/.test(lower)) return true;
  return GENERIC_HEADINGS.has(lower.replace(/^[: ]+|[: ]+$/g, ""));
}

function goalLine(lines: string[]): string | null {
  for (const line of lines) {
    const un = line.replaceAll("**", "");
    if (!un.toLowerCase().startsWith("goal:")) continue;
    const goal = un.slice("goal:".length).trim();
    // A period ends the sentence only before a space or the end ("Node.js 22" keeps its dot).
    const m = /\.(\s|$)/.exec(goal);
    const sentence = (m ? goal.slice(0, m.index) : goal).trim();
    if (sentence) return sentence;
  }
  return null;
}

/** Title for a plan reply: the H1, else the Goal line, else the first heading that names the work, else the first line. */
export function planTitle(content: string): string {
  const lines = blankingCodeFences(content).split(/\r?\n/).map((l) => l.trim());
  const first = lines.find((l) => l !== "") ?? "";
  const headings: Array<{ level: number; body: string }> = [];
  for (const line of lines) {
    let n = 0;
    while (n < line.length && line[n] === "#") n++;
    if (n < 1 || n > 6 || line[n] !== " ") continue;
    const body = line.slice(n).trim();
    if (body) headings.push({ level: n, body });
  }
  const chosen = headings.find((h) => h.level === 1)?.body ?? goalLine(lines) ?? headings.find((h) => !isGenericHeading(h.body))?.body ?? headings[0]?.body ?? first;
  return chosen.trim().slice(0, 60).trim();
}

/** `FilesystemSlug.make`: lowercase, whitespace to `-`, drop filesystem-unsafe and control characters, collapse `-`, cap. */
export function slugify(title: string, maxLength = 60, fallback = "untitled-plan"): string {
  let s = title.toLowerCase().split(/\s+/).filter(Boolean).join("-");
  s = s.replace(/[/\\:*?"<>|\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
  s = s.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/-+$/g, "");
  return s || fallback;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
export const datePrefix = (d: Date): string => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The existing plan file of this chat when a save should go INTO it (a revision replaces the plan). */
export function reusablePlanPath(existing: string | null | undefined): string | null {
  if (!existing) return null;
  const dir = `${PLANS_DIR}/`;
  if (!existing.startsWith(dir)) return null;
  const name = existing.slice(dir.length);
  return name !== "" && !name.includes("/") && name.endsWith(".md") ? existing : null;
}

/** Project-relative file the plan is saved to: always under `llm-doc/plans/`, never agent-supplied. */
export function planFilePath(title: string, now: Date, existing?: string | null): string {
  return reusablePlanPath(existing) ?? `${PLANS_DIR}/${datePrefix(now)}-${slugify(title)}.md`;
}
