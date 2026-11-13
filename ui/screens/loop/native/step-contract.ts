// What a successful skill call must have left behind, judged from its reply and the files it reports. Pure: the caller
// reads the plan and checks paths, and no model is involved. A reply that breaks the contract fails the stage, so the
// repair agent sees both the message and the reply.
import { pathInside } from "./input-path.ts";

export interface SkillResultInput {
  skillId: string;
  reply: string;
  changedPaths: readonly string[];
  createdPaths: readonly string[];
  /** The refactor plan's text, or null when it is missing or unreadable. */
  readPlan(): Promise<string | null>;
  /** Whether a path (relative to the same root as the changed paths) exists. */
  exists(path: string): Promise<boolean>;
  /** false for an edited prompt: only the empty-reply rule applies. Defaults to true. */
  structured?: boolean;
  /** The Loop's folder ("" = the whole repository): the scope rules below apply only when it is set. */
  inputPath?: string;
  /** Changed or created code paths outside the input path, and whether each is only an import update. */
  outside?: { path: string; importOnly: boolean }[];
}

const PLANNER = "skills/refactor-planner";
const TEST_WRITER = "skills/test-gap-writer";
const APPLY = "skills/refactor-apply";
const CONFORM = "skills/refactor-conform";

const BATCH_HEADER = /^###\s+R(\d+)\b.*\(status:\s*(todo|done|skipped|blocked)\)\s*$/;
const COVERED = /^\s*Covered:\s*(\S+)/;
const APPLIED = /Applied:\s*R(\d+)/;
const CONFORMED = /Conformed:\s*R\d+/;

const lines = (text: string): string[] => text.split(/\r?\n/);
const cut80 = (line: string): string => line.slice(0, 80);
const normal = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
/** A path that is code: not the Loop's own llm-doc batch notes, system data, or a Factory report. */
const isCodePath = (p: string): boolean => {
  const n = normal(p);
  return !(n.startsWith("llm-doc/loop/") || n.startsWith("system/") || n.startsWith(".factory/") || n.includes("/.factory/"));
};

async function checkPlanner(input: SkillResultInput): Promise<string | null> {
  const plan = await input.readPlan();
  if (plan === null) return "the plan file was not written";
  const ls = lines(plan);
  if (!ls.some((l) => BATCH_HEADER.test(l))) return "the plan has no batch";
  const bad = ls.find((l) => /^### R/.test(l) && !BATCH_HEADER.test(l));
  return bad === undefined ? null : `the plan heading "${cut80(bad)}" has no valid status`;
}

async function checkTestWriter(input: SkillResultInput): Promise<string | null> {
  const covered = lines(input.reply).flatMap((l) => {
    const m = COVERED.exec(l);
    // The path is the first word: `Covered: a.py — x`, `Covered: a.py, b.py — x`, `Covered: **a.py**`, `Covered: ./a.py`.
    return m ? [m[1].replace(/[`*]/g, "").replace(/^_+|_+$/g, "").replace(/[,;:]+$/, "").replace(/^\.\//, "")] : [];
  });
  if (covered.length === 0) return "the reply has no 'Covered:' line";
  for (const path of covered) {
    if (path === "none") continue;
    if (!(await input.exists(path))) return `Covered names ${path} but that file does not exist`;
  }
  return null;
}

async function checkApply(input: SkillResultInput): Promise<string | null> {
  const m = APPLIED.exec(input.reply);
  if (!m) return "the reply has no 'Applied: R<n>' line";
  const id = `R${m[1]}`;
  const plan = await input.readPlan();
  if (plan === null) return "the plan file was not written";
  const head = lines(plan).find((l) => new RegExp(`^###\\s+R${m[1]}\\b`).test(l));
  if (head === undefined) return `the plan has no batch ${id}`;
  const status = /\(status:\s*([^)]*?)\s*\)/.exec(head)?.[1] ?? "no status";
  if (status !== "done" && status !== "skipped") return `the plan still shows ${id} as ${status} after Apply`;
  if (status === "done" && ![...input.changedPaths, ...input.createdPaths].some(isCodePath)) return `Apply marked ${id} done but changed no code`;
  return null;
}

/**
 * The file paths on one plan `- Files:` value. A real planner writes notes beside them (`tax.py` (new), `a.py` (moved from
 * b.py)), so parenthesised notes are dropped and only words that look like a path (a `.` or `/` in them) are kept.
 */
export function planFiles(value: string): string[] {
  // Only a parenthesised note after a space is dropped, so a path segment like `app/(auth)/page.tsx` is kept.
  return value.replace(/(^|\s)\([^)]*\)/g, " ").replace(/[`*]/g, "").split(/[\s,;]+/)
    .map((w) => normal(w.replace(/[.:]+$/, ""))).filter((w) => w !== "" && w !== "none" && (/[./]/.test(w) || EXTENSIONLESS.test(w)));
}
/** Common files with no extension that a plan may list. */
const EXTENSIONLESS = /^(Makefile|GNUmakefile|Dockerfile|Containerfile|Procfile|Gemfile|Rakefile|Podfile|Brewfile|Justfile|Vagrantfile|LICENSE|CODEOWNERS)$/;

/** Every `- Files:` entry of every batch must be inside the input path. */
function checkPlannerScope(plan: string, scope: string): string | null {
  let batch = "";
  for (const l of lines(plan)) {
    const head = /^###\s+(R\d+)\b/.exec(l);
    if (head) { batch = head[1]; continue; }
    const m = /^\s*-\s*Files:\s*(.*)$/.exec(l);
    if (!m || batch === "") continue;
    for (const file of planFiles(m[1])) {
      if (!pathInside(scope, file)) return `batch ${batch} lists ${file}, which is outside the input path ${scope}`;
    }
  }
  return null;
}

/** Scope rules for a Loop with an input path. Applied to edited prompts too: they guard writes, not the reply's format. */
async function checkScope(input: SkillResultInput): Promise<string | null> {
  const scope = input.inputPath ?? "";
  if (scope === "") return null;
  if (input.skillId === PLANNER) {
    const plan = await input.readPlan();
    return plan === null ? null : checkPlannerScope(plan, scope);
  }
  if (input.skillId === APPLY || input.skillId === CONFORM) {
    const bad = (input.outside ?? []).find((o) => !o.importOnly);
    if (bad === undefined) return null;
    return `${input.skillId === APPLY ? "Apply" : "Conform"} changed ${bad.path}, which is outside the input path ${scope} and is more than an import update`;
  }
  return null;
}

const REPLY_SKILLS: ReadonlySet<string> = new Set(["skills/refactor-planner", "skills/refactor-apply", "skills/refactor-conform", "skills/test-gap-writer", "skills/test-structure-setup"]);

async function checkStructure(input: SkillResultInput): Promise<string | null> {
  switch (input.skillId) {
    case PLANNER: return checkPlanner(input);
    case TEST_WRITER: return checkTestWriter(input);
    case APPLY: return checkApply(input);
    case CONFORM: return CONFORMED.test(input.reply) ? null : "the reply has no 'Conformed: R<n>' line";
    default: return null;
  }
}

/** null = the result is fine. Otherwise one plain sentence saying what is wrong. */
export async function checkSkillResult(input: SkillResultInput): Promise<string | null> {
  // Factory and custom agents report through the files they write (their own gates judge those) and may end on a tool
  // call with no text, so "no reply" is a failure only for the skills whose contract is a reply.
  if (REPLY_SKILLS.has(input.skillId) && input.reply.trim() === "") return "the agent returned no reply";
  const structural = input.structured === false ? null : await checkStructure(input);
  return structural ?? checkScope(input);
}
