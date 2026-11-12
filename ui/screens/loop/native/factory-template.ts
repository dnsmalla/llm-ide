// The project's editable Factory process: `system/factory-template.json`, a small versioned file where every step names
// its role. The Factory's own steps keep their fixed skill, verdict file and repair rules (so factoryRole keeps
// recognising them); a person changes names, prompts, commands, timeouts, budgets and adds custom steps. The validator
// below is authoritative (schema/factory/template.v1.schema.json documents the same format) and points every problem
// at its exact line. Pure apart from the two fs helpers at the end.
import type { FsApi } from "../../explorer/fs";
import { DETECTED_STRUCTURE, DETECTED_TEST } from "./environment.ts";
import { FACTORY_BUILT_IN_STAGES, FACTORY_TEMPLATE, factoryRole, isCustomStage, type FactoryRole } from "./factory.ts";
import type { LoopDefinition, LoopStage } from "./model.ts";

export const TEMPLATE_FILE = "system/factory-template.json";

export type TemplateRole = FactoryRole | "custom";
export interface TemplateStage {
  role: TemplateRole;
  name?: string;
  kind?: "shellCommand" | "skill" | "artifactCheck";
  skill?: string;
  verdictPath?: string;
  verdictLine?: string;
  enabled?: boolean;
  severity?: "blocking" | "advisory";
  command?: string;
  timeoutMinutes?: number;
  prompt?: string;
}
export interface TemplateBudget { maxIterations?: number; maxCostUsd?: number; wallClockMinutes?: number }
export interface FactoryTemplate { version: 1; budget?: TemplateBudget; stages: TemplateStage[] }
export interface TemplateError { path: string; line: number; message: string }
export type TemplateParse = { ok: true; template: FactoryTemplate } | { ok: false; errors: TemplateError[] };

const BUILT_IN: readonly FactoryRole[] = ["setup", "intake", "intakeGate", "plan", "implement", "verify", "review", "reviewGate"];
const ROLES: readonly TemplateRole[] = [...BUILT_IN, "custom"];
const REQUIRED: readonly FactoryRole[] = ["implement", "verify", "review", "reviewGate"];
const ORDER: readonly [FactoryRole, FactoryRole][] = [["implement", "verify"], ["verify", "review"], ["review", "reviewGate"]];
const PROMPT_ROLES = new Set<TemplateRole>(["intake", "plan", "implement", "review"]);
const COMMAND_ROLES = new Set<TemplateRole>(["setup", "verify"]);
const STAGE_KEYS = new Set(["role", "name", "kind", "skill", "verdictPath", "verdictLine", "enabled", "severity", "command", "timeoutMinutes", "prompt"]);
const SKILL = /^(skills\/)?[a-z0-9][a-z0-9-]{0,63}$/;
// The Factory's own gates read these; a custom check on them would be taken for that gate.
const RESERVED_VERDICTS = new Set([".factory/READINESS.md", ".factory/REVIEW.md"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BETWEEN_REVIEW_AND_GATE = 'a custom skill step cannot come between "review" and "reviewGate" (it could change Review\'s report)';

/** Why a custom verdict file is refused, or null: a relative path under .factory/ with no "..". */
function verdictPathProblem(p: string): string | null {
  if (p.length > 200 || !p.startsWith(".factory/") || p.includes("\\") || p.split("/").some((seg) => seg === ".." || seg === "") || /[\r\n]/.test(p)) return 'a relative path under ".factory/" of at most 200 characters, without ".."';
  if (RESERVED_VERDICTS.has(p)) return `"${p}" belongs to the Factory's own gate`;
  return null;
}
const MAX_STAGES = 30;
const MAX_TEXT = 200_000;

const builtInStage = (role: FactoryRole): LoopStage => FACTORY_BUILT_IN_STAGES.find((s) => factoryRole(s) === role)!;
const defaultName = (role: FactoryRole): string => builtInStage(role).name;

// ---- a JSON reader that remembers the line of every value ----------------------------------------------------------

class SyntaxProblem extends Error {
  readonly line: number;
  readonly column: number;
  constructor(line: number, column: number, message: string) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

function readJson(s: string): { value: unknown; lines: Map<string, number> } {
  let i = 0;
  let line = 1;
  let col = 1;
  const lines = new Map<string, number>();
  const fail = (what: string): never => { throw new SyntaxProblem(line, col, `${what} at line ${line}, column ${col}`); };
  const step = () => { if (s[i] === "\n") { line++; col = 1; } else col++; i++; };
  const ws = () => { while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) step(); };
  const str = (): string => {
    step();
    let out = "";
    for (;;) {
      if (i >= s.length) fail("unterminated string");
      const c = s[i]!;
      if (c === '"') { step(); return out; }
      if (c < " ") fail("a control character inside a string (use \\n for a new line)");
      if (c === "\\") {
        step();
        const e = s[i];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e !== undefined && e in simple) { out += simple[e]; step(); continue; }
        if (e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); for (let k = 0; k < 5; k++) step(); continue; }
        fail("an invalid escape in a string");
      }
      out += c;
      step();
    }
  };
  const value = (path: string, depth: number): unknown => {
    if (depth > 32) fail("nesting too deep");
    ws();
    lines.set(path, line);
    const c = s[i];
    if (c === "{") {
      step();
      const o: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      ws();
      if (s[i] === "}") { step(); return o; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail("expected a quoted key");
        const keyLine = line;
        const k = str();
        if (FORBIDDEN_KEYS.has(k)) { line = keyLine; fail(`key "${k}" is not allowed`); }
        if (Object.prototype.hasOwnProperty.call(o, k)) { line = keyLine; fail(`duplicate key "${k}"`); }
        ws();
        if (s[i] !== ":") fail('expected ":" after a key');
        step();
        o[k] = value(path ? `${path}.${k}` : k, depth + 1);
        ws();
        if (s[i] === ",") { step(); continue; }
        if (s[i] === "}") { step(); return o; }
        fail('expected "," or "}"');
      }
    }
    if (c === "[") {
      step();
      const a: unknown[] = [];
      ws();
      if (s[i] === "]") { step(); return a; }
      for (;;) {
        a.push(value(`${path}[${a.length}]`, depth + 1));
        ws();
        if (s[i] === ",") { step(); continue; }
        if (s[i] === "]") { step(); return a; }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (s.startsWith(word, i)) { for (let k = 0; k < word.length; k++) step(); return v; }
    }
    const m = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    m.lastIndex = i;
    const n = m.exec(s);
    if (n) { for (let k = 0; k < n[0].length; k++) step(); return Number(n[0]); }
    return fail(i >= s.length ? "the file ends too early" : `unexpected "${c}"`);
  };
  const v = value("", 0);
  ws();
  if (i < s.length) fail("unexpected text after the end");
  return { value: v, lines };
}

// ---- validation --------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

export function parseFactoryTemplate(text: string): TemplateParse {
  if (text.length > MAX_TEXT) return { ok: false, errors: [{ path: "", line: 1, message: "the file is larger than 200,000 characters" }] };
  let read: { value: unknown; lines: Map<string, number> };
  try {
    read = readJson(text);
  } catch (e) {
    if (e instanceof SyntaxProblem) return { ok: false, errors: [{ path: "", line: e.line, message: `not valid JSON: ${e.message}` }] };
    throw e;
  }
  const errors: TemplateError[] = [];
  const lineOf = (path: string): number => {
    let p = path;
    while (p) {
      const l = read.lines.get(p);
      if (l !== undefined) return l;
      const up = p.replace(/(\.[^.[\]]+|\[\d+\])$/, "");
      p = up === p ? "" : up;
    }
    return read.lines.get("") ?? 1;
  };
  const err = (path: string, message: string) => errors.push({ path, line: lineOf(path), message });
  const root = read.value;
  if (!isObj(root)) {
    err("", "the file must be a JSON object with \"version\" and \"stages\"");
    return { ok: false, errors };
  }
  for (const k of Object.keys(root)) if (!["version", "budget", "stages"].includes(k)) err(k, `unknown key (allowed: version, budget, stages)`);
  if (root.version !== 1) err("version", "version must be 1");
  let budget: TemplateBudget | undefined;
  if (root.budget !== undefined) {
    if (!isObj(root.budget)) err("budget", "budget must be an object");
    else {
      budget = {};
      const b = root.budget;
      for (const k of Object.keys(b)) if (!["maxIterations", "maxCostUsd", "wallClockMinutes"].includes(k)) err(`budget.${k}`, "unknown key (allowed: maxIterations, maxCostUsd, wallClockMinutes)");
      if (b.maxIterations !== undefined) { if (isInt(b.maxIterations, 1, 50)) budget.maxIterations = b.maxIterations; else err("budget.maxIterations", "a whole number from 1 to 50"); }
      if (b.maxCostUsd !== undefined) { if (typeof b.maxCostUsd === "number" && b.maxCostUsd >= 0 && b.maxCostUsd <= 1000) budget.maxCostUsd = b.maxCostUsd; else err("budget.maxCostUsd", "a number of US dollars from 0 to 1000 (0 = no limit)"); }
      if (b.wallClockMinutes !== undefined) { if (isInt(b.wallClockMinutes, 1, 1440)) budget.wallClockMinutes = b.wallClockMinutes; else err("budget.wallClockMinutes", "a whole number of minutes from 1 to 1440"); }
    }
  }
  const stages: TemplateStage[] = [];
  if (!Array.isArray(root.stages)) err("stages", "stages must be a list of steps");
  else if (root.stages.length === 0) err("stages", "the Factory needs at least its implement, verify, review and reviewGate steps");
  else if (root.stages.length > MAX_STAGES) err("stages", `at most ${MAX_STAGES} steps`);
  else root.stages.forEach((raw, i) => { const st = checkStage(raw, `stages[${i}]`, err); if (st) stages.push(st); });
  if (Array.isArray(root.stages) && root.stages.length > 0 && root.stages.length <= MAX_STAGES && stages.length === root.stages.length) checkProcess(stages, err);
  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, template: { version: 1, ...(budget ? { budget } : {}), stages } };
}

function checkStage(raw: unknown, at: string, err: (path: string, message: string) => void): TemplateStage | null {
  if (!isObj(raw)) { err(at, "each step must be an object with a \"role\""); return null; }
  let bad = false;
  const e = (path: string, message: string) => { bad = true; err(path, message); };
  for (const k of Object.keys(raw)) if (!STAGE_KEYS.has(k)) e(`${at}.${k}`, `unknown key (allowed: ${[...STAGE_KEYS].join(", ")})`);
  const role = raw.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
    e(`${at}.role`, `unknown role ${JSON.stringify(role ?? null)} (expected one of ${ROLES.join(", ")})`);
    return null;
  }
  const r = role as TemplateRole;
  const custom = r === "custom";
  const kind = raw.kind;
  if (kind !== undefined && !custom) e(`${at}.kind`, 'only a "custom" step has a kind');
  if (custom && kind !== "shellCommand" && kind !== "skill" && kind !== "artifactCheck") e(`${at}.kind`, 'a custom step needs "kind": "shellCommand", "skill" or "artifactCheck"');
  const shell = custom && kind === "shellCommand";
  const skillStep = custom && kind === "skill";
  const checkStep = custom && kind === "artifactCheck";
  const out: TemplateStage = { role: r };
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim() === "" || raw.name.length > 80 || /[\r\n]/.test(raw.name)) e(`${at}.name`, "a name is one line of 1 to 80 characters");
    else out.name = raw.name;
  } else if (custom) e(`${at}.name`, "a custom step needs a name");
  if (custom && (kind === "shellCommand" || kind === "skill" || kind === "artifactCheck")) out.kind = kind;
  if (raw.skill !== undefined) {
    if (!skillStep) e(`${at}.skill`, 'only a custom step with "kind": "skill" has a skill');
    else if (typeof raw.skill !== "string" || !SKILL.test(raw.skill)) e(`${at}.skill`, 'a skill name such as "doc-writer" or "skills/doc-writer" (lower-case letters, digits and -)');
    else out.skill = raw.skill;
  } else if (skillStep) e(`${at}.skill`, "a custom skill step needs a skill");
  for (const k of ["verdictPath", "verdictLine"] as const) {
    if (raw[k] !== undefined && !checkStep) e(`${at}.${k}`, 'only a custom "artifactCheck" step has it');
  }
  if (checkStep) {
    if (typeof raw.verdictPath !== "string") e(`${at}.verdictPath`, 'a verdict check needs a verdictPath, e.g. ".factory/LINT.md"');
    else { const why = verdictPathProblem(raw.verdictPath); if (why) e(`${at}.verdictPath`, why); else out.verdictPath = raw.verdictPath; }
    if (typeof raw.verdictLine !== "string" || raw.verdictLine.trim() === "" || raw.verdictLine.length > 200 || /[\r\n]/.test(raw.verdictLine)) e(`${at}.verdictLine`, 'a verdict check needs a verdictLine: the one line (at most 200 characters) that passes it, e.g. "Verdict: clean"');
    else out.verdictLine = raw.verdictLine;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") e(`${at}.enabled`, "true or false");
    else if (!raw.enabled && (REQUIRED as readonly string[]).includes(r)) e(`${at}.enabled`, `the "${r}" step cannot be turned off`);
    else out.enabled = raw.enabled;
  }
  if (raw.severity !== undefined) {
    if (raw.severity !== "blocking" && raw.severity !== "advisory") e(`${at}.severity`, '"blocking" or "advisory"');
    else if (raw.severity === "advisory" && (REQUIRED as readonly string[]).includes(r)) e(`${at}.severity`, `the "${r}" step must stay blocking`);
    else out.severity = raw.severity;
  }
  const commandAllowed = COMMAND_ROLES.has(r) || shell;
  if (raw.command !== undefined) {
    if (!commandAllowed) e(`${at}.command`, `not allowed for a "${r}" step${custom ? " of this kind" : ""}`);
    else if (typeof raw.command !== "string" || raw.command.length > 500 || /[\r\n]/.test(raw.command)) e(`${at}.command`, "a command is one line of at most 500 characters");
    else out.command = raw.command;
  }
  const command = (out.command ?? "").trim();
  if (shell && !command) e(`${at}.command`, "a custom shell step needs a command");
  if (r === "setup" && out.enabled === true && !command) e(`${at}.command`, 'an enabled "setup" step needs a command');
  if (r === "verify" && out.command !== undefined && !command) e(`${at}.command`, 'the "verify" step needs a test command, or "auto" for the detected one');
  if (raw.prompt !== undefined) {
    if (!(PROMPT_ROLES.has(r) || skillStep)) e(`${at}.prompt`, `not allowed for a "${r}" step${custom ? " of this kind" : ""}`);
    else if (typeof raw.prompt !== "string" || raw.prompt.length > 20_000) e(`${at}.prompt`, "a prompt is text of at most 20,000 characters");
    else out.prompt = raw.prompt;
  }
  if (raw.timeoutMinutes !== undefined) {
    if (!isInt(raw.timeoutMinutes, 1, 240)) e(`${at}.timeoutMinutes`, "a whole number of minutes from 1 to 240");
    else out.timeoutMinutes = raw.timeoutMinutes;
  }
  return bad ? null : out;
}

function checkProcess(stages: TemplateStage[], err: (path: string, message: string) => void): void {
  const at = (i: number) => `stages[${i}].role`;
  const first = new Map<TemplateRole, number>();
  stages.forEach((s, i) => {
    if (s.role !== "custom" && first.has(s.role)) err(at(i), `only one "${s.role}" step is allowed`);
    else if (!first.has(s.role)) first.set(s.role, i);
  });
  for (const r of REQUIRED) if (!first.has(r)) err("stages", `missing a "${r}" step`);
  const gate = first.get("intakeGate");
  if (gate !== undefined && !((first.get("intake") ?? Infinity) < gate)) err(at(gate), '"intakeGate" needs an "intake" step before it');
  for (const [a, b] of ORDER) {
    const ia = first.get(a);
    const ib = first.get(b);
    if (ia !== undefined && ib !== undefined && ib < ia) err(at(ib), `"${b}" must come after "${a}"`);
  }
  const last = first.get("reviewGate");
  if (last !== undefined && last !== stages.length - 1) err(at(last), '"reviewGate" must be the last step');
  const review = first.get("review");
  // The gate reads Review's report; an agent step in between could rewrite it, and .factory/ is never guarded.
  if (review !== undefined && last !== undefined) {
    stages.forEach((s, i) => { if (i > review && i < last && s.role === "custom" && s.kind === "skill") err(at(i), BETWEEN_REVIEW_AND_GATE); });
  }
  const names = new Map<string, number>();
  stages.forEach((s, i) => {
    const name = (s.name ?? (s.role === "custom" ? "" : defaultName(s.role))).trim();
    const key = name.toLowerCase();
    if (!key) return;
    if (names.has(key)) err(s.name !== undefined ? `stages[${i}].name` : at(i), `name "${name}" is used twice`);
    else names.set(key, i);
  });
}

// ---- format, default, migration, apply -----------------------------------------------------------------------------

const STAGE_ORDER: (keyof TemplateStage)[] = ["role", "name", "kind", "skill", "enabled", "severity", "verdictPath", "verdictLine", "command", "timeoutMinutes", "prompt"];

export function formatFactoryTemplate(t: FactoryTemplate): string {
  const stages = t.stages.map((s) => Object.fromEntries(STAGE_ORDER.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])));
  const budget = t.budget ? Object.fromEntries((["maxIterations", "maxCostUsd", "wallClockMinutes"] as const).filter((k) => t.budget![k] !== undefined).map((k) => [k, t.budget![k]])) : undefined;
  return JSON.stringify({ version: 1, ...(budget ? { budget } : {}), stages }, null, 2) + "\n";
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface DroppedStep { name: string; reason: string }

/**
 * The template a Factory loop is (migration of an existing loop.json, and the default from the built-in loop). Anything
 * the template cannot hold is listed in `dropped` with its reason, never left out silently.
 */
export function templateFromLoop(loop: LoopDefinition): { template: FactoryTemplate; dropped: DroppedStep[] } {
  const sorted = [...loop.config.stages].sort((a, b) => a.order - b.order);
  const dropped: DroppedStep[] = [];
  const drop = (s: LoopStage, reason: string) => dropped.push({ name: s.name, reason });
  const primary = new Map<FactoryRole, LoopStage>();
  for (const role of BUILT_IN) {
    const own = sorted.filter((s) => factoryRole(s) === role);
    const pick = own.find((s) => s.id === builtInStage(role).id) ?? own[0];
    if (pick) primary.set(role, pick);
  }
  const timeout = (s: LoopStage): number | undefined => (s.timeoutSeconds ? clamp(Math.round(s.timeoutSeconds / 60), 1, 240) : undefined);
  const stages: TemplateStage[] = [];
  const reviewAt = sorted.indexOf(primary.get("review")!);
  const gateAt = sorted.indexOf(primary.get("reviewGate")!);
  for (const [index, s] of sorted.entries()) {
    const role = factoryRole(s);
    const required = role !== null && (REQUIRED as readonly string[]).includes(role);
    if (role && primary.get(role) === s) {
      const b = builtInStage(role);
      const out: TemplateStage = { role };
      if (s.name !== b.name) out.name = s.name;
      const command = s.command ?? "";
      const enabledDefault = role === "setup" ? command.trim() !== "" : b.enabled;
      if (!s.enabled && required) drop(s, `the "${role}" step cannot be turned off; it runs again`);
      else if (s.enabled !== enabledDefault) out.enabled = s.enabled;
      if (s.severity === "advisory") {
        if (required) drop(s, `advisory severity: the "${role}" step must stay blocking, so it blocks again`);
        else out.severity = "advisory";
      }
      if (role === "setup" && command.trim()) out.command = command;
      if (role === "verify") out.command = command.trim() && command !== DETECTED_TEST ? command : "auto";
      if (PROMPT_ROLES.has(role)) { if (s.prompt && s.prompt !== b.prompt) out.prompt = s.prompt; }
      else if (s.prompt?.trim() && s.prompt !== b.prompt) drop(s, `its prompt: a "${role}" step has no prompt, so it is not kept`);
      const t = timeout(s);
      if (t) out.timeoutMinutes = t;
      stages.push(out);
      continue;
    }
    if (role === "intakeGate" || role === "reviewGate") { drop(s, `a second "${role}" step is not allowed`); continue; }
    if (s.kind !== "shellCommand" && s.kind !== "skill" && s.kind !== "artifactCheck") { drop(s, `a "${s.kind}" step cannot be written in the template`); continue; }
    if (s.kind === "skill" && reviewAt >= 0 && gateAt > reviewAt && index > reviewAt && index < gateAt) { drop(s, BETWEEN_REVIEW_AND_GATE); continue; }
    if (s.testOp) drop(s, `its testOp "${s.testOp}": a custom step has none, so it is not kept`);
    const out: TemplateStage = { role: "custom", name: s.name, kind: s.kind };
    if (s.kind === "artifactCheck") {
      const v = s.check && isObj(s.check.verdict) ? s.check.verdict : null;
      const path = typeof v?.path === "string" ? v.path : null;
      const lineText = typeof v?.line === "string" ? v.line : null;
      if (!path || !lineText || verdictPathProblem(path) || lineText.length > 200 || /[\r\n]/.test(lineText) || Object.keys(s.check ?? {}).length !== 1) {
        drop(s, "its check is not a single verdict line in a file under .factory/");
        continue;
      }
      out.verdictPath = path;
      out.verdictLine = lineText;
    } else if (s.check) drop(s, "its check: a shell or skill step has none, so it is not kept");
    // An undetected Structure verify is written as "auto" and stays off until detection finds a command.
    const autoShell = s.kind === "shellCommand" && s.command === DETECTED_STRUCTURE;
    if (s.kind === "shellCommand") {
      if (!s.command?.trim()) { drop(s, "it has no command"); continue; }
      out.command = autoShell ? "auto" : s.command;
    }
    if (s.kind === "skill") {
      const skill = s.skillId?.startsWith("skills/") ? s.skillId.slice(7) : s.skillId;
      if (!skill || !SKILL.test(skill)) { drop(s, `its skill "${s.skillId ?? ""}" is not a skills/<name> skill`); continue; }
      out.skill = skill;
      if (s.prompt) out.prompt = s.prompt;
    }
    if (!s.enabled && !(autoShell && s.disabledByDetection)) out.enabled = false;
    if (s.severity === "advisory") out.severity = "advisory";
    const t = timeout(s);
    if (t) out.timeoutMinutes = t;
    stages.push(out);
  }
  const c = loop.config;
  return {
    template: {
      version: 1,
      budget: {
        maxIterations: clamp(c.maxIterations, 1, 50),
        maxCostUsd: clamp(c.maxCostUsd ?? 0, 0, 1000),
        wallClockMinutes: clamp(Math.round((c.wallClockBudgetSeconds ?? 7200) / 60), 1, 1440),
      },
      stages,
    },
    dropped,
  };
}

export function defaultFactoryTemplate(): FactoryTemplate {
  return templateFromLoop({ id: "factory", name: "Factory", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: "factory", runsOnSchedule: false, config: structuredClone(FACTORY_TEMPLATE.config) }).template;
}

const OLD_DEFAULT_ROLES = ["setup", "intake", "intakeGate", "plan", "implement", "verify", "review", "reviewGate"];

/**
 * A project's Factory loop that is still the previous built-in default (Intake first, nothing else edited) moves to the
 * current default, keeping its Set up and Verify commands and its budget. Anything edited keeps its own steps.
 */
export function upgradeOldDefault(t: FactoryTemplate): FactoryTemplate | null {
  if (t.stages.length !== OLD_DEFAULT_ROLES.length || t.stages.some((s, i) => s.role !== OLD_DEFAULT_ROLES[i])) return null;
  const edited = t.stages.some((s) => Object.keys(s).some((k) => !(k === "role" || (s.role === "setup" && (k === "command" || k === "enabled")) || (s.role === "verify" && k === "command"))));
  if (edited) return null;
  const next = defaultFactoryTemplate();
  const keep = (role: TemplateRole) => t.stages.find((s) => s.role === role)!;
  return { ...next, ...(t.budget ? { budget: t.budget } : {}), stages: next.stages.map((s) => (s.role === "setup" || s.role === "verify" ? { ...keep(s.role) } : s)) };
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "step";

/** The Factory loop with the template's steps and budget. Deterministic: an unchanged template yields an unchanged loop. */
export function applyTemplate(loop: LoopDefinition, t: FactoryTemplate, detectedTest: string | null, detectedStructure: string | null = null): LoopDefinition {
  const existing = [...loop.config.stages].sort((a, b) => a.order - b.order);
  const used = new Set<LoopStage>();
  const own = (role: FactoryRole) => {
    const candidates = existing.filter((s) => !used.has(s) && factoryRole(s) === role);
    return candidates.find((s) => s.id === builtInStage(role).id) ?? candidates[0] ?? null;
  };
  let customs = 0;
  const stages = t.stages.map((ts, order): LoopStage => {
    const timeoutSeconds = ts.timeoutMinutes ? ts.timeoutMinutes * 60 : null;
    if (ts.role !== "custom") {
      const b = builtInStage(ts.role);
      const prev = own(ts.role);
      if (prev) used.add(prev);
      const command = ts.role === "setup" ? ts.command ?? "" : ts.role === "verify" ? (!ts.command || ts.command === "auto" ? detectedTest ?? DETECTED_TEST : ts.command) : b.command;
      const enabled = ts.enabled ?? (ts.role === "setup" ? (command ?? "").trim() !== "" : b.enabled);
      return {
        ...structuredClone(b), ...(prev ?? {}),
        kind: b.kind, skillId: b.skillId, check: b.check === null ? null : structuredClone(b.check), targetPath: b.targetPath, outputPath: b.outputPath,
        runOnce: b.runOnce, allowsRepair: b.allowsRepair, severity: ts.severity ?? "blocking",
        name: ts.name ?? b.name, enabled, prompt: PROMPT_ROLES.has(ts.role) ? ts.prompt ?? b.prompt : b.prompt, command, timeoutSeconds, order,
        disabledByDetection: ts.role === "setup" && enabled ? null : prev?.disabledByDetection ?? b.disabledByDetection,
      };
    }
    customs++;
    const kind = ts.kind!;
    const prev = existing.find((s) => !used.has(s) && s.kind === kind && s.name.toLowerCase() === (ts.name ?? "").toLowerCase()) ?? null;
    if (prev) used.add(prev);
    const auto = kind === "shellCommand" && ts.command === "auto";
    const command = kind !== "shellCommand" ? null : auto ? detectedStructure ?? DETECTED_STRUCTURE : ts.command ?? null;
    const undetected = auto && command === DETECTED_STRUCTURE;
    const skillId = kind === "skill" ? (ts.skill!.startsWith("skills/") ? ts.skill! : `skills/${ts.skill}`) : null;
    const check = kind === "artifactCheck" ? { verdict: { path: ts.verdictPath!, line: ts.verdictLine! } } : null;
    const base: LoopStage = {
      id: `custom/${slug(ts.name ?? "")}-${customs}`, name: "", kind, command: null, order, skillId: null, targetPath: null, outputPath: null, prompt: null,
      isDefault: false, enabled: true, defaultKey: null, severity: "blocking", timeoutSeconds: null, detectedCommand: null, check: null, testOp: null,
      graphOp: null, allowsRepair: kind !== "skill", runOnce: false, defaultRevision: null, disabledByDetection: null, raw: null,
    };
    return {
      ...base, ...(prev ?? {}),
      // Only a "custom/" id keeps a step out of the Factory's roles, so an older loop's random id is replaced.
      id: prev && isCustomStage(prev) ? prev.id : base.id,
      kind, name: ts.name ?? "", command, skillId, prompt: kind === "skill" ? ts.prompt ?? null : null,
      enabled: ts.enabled ?? !undetected, severity: ts.severity ?? "blocking", timeoutSeconds, order, runOnce: false,
      allowsRepair: prev?.allowsRepair ?? base.allowsRepair, check, testOp: null, graphOp: null, raw: null,
      disabledByDetection: undetected ? true : kind === "shellCommand" && auto ? false : prev?.disabledByDetection ?? null,
    };
  });
  const b = t.budget ?? {};
  const d = FACTORY_TEMPLATE.config;
  const cost = b.maxCostUsd ?? d.maxCostUsd ?? 0;
  return {
    ...loop,
    config: {
      ...loop.config,
      stages,
      maxIterations: b.maxIterations ?? d.maxIterations,
      maxCostUsd: cost === 0 ? null : cost,
      wallClockBudgetSeconds: (b.wallClockMinutes ?? Math.round((d.wallClockBudgetSeconds ?? 7200) / 60)) * 60,
    },
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Whether two loops are the same, whatever their key order (applyTemplate's "nothing changed" check). */
export function sameLoop(a: LoopDefinition, b: LoopDefinition): boolean {
  return canonical(a) === canonical(b);
}

export interface DiffLine { kind: " " | "-" | "+"; text: string }

/** A line diff for the "Reset to default" preview (longest common subsequence; a huge pair falls back to replace-all). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: " ", text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push({ kind: "-", text: a[i]! }); i++; }
    else { out.push({ kind: "+", text: b[j]! }); j++; }
  }
  while (i < a.length) out.push({ kind: "-", text: a[i++]! });
  while (j < b.length) out.push({ kind: "+", text: b[j++]! });
  return out;
}

/** The offset where 1-based `line` starts in `text` (the end when the line is past it): an error moves the caret there. */
export function lineStart(text: string, line: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

/** What a screen reader hears about the template's problems, once typing pauses. */
export function problemCountLabel(n: number): string {
  return n === 0 ? "No problems" : n === 1 ? "1 problem" : `${n} problems`;
}

// ---- the file ------------------------------------------------------------------------------------------------------

const codeOf = (e: unknown): string => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");

export type TemplateFile = { kind: "missing" } | { kind: "ok"; text: string; hash: string; parse: TemplateParse };

export async function readTemplateFile(fs: Pick<FsApi, "read">): Promise<TemplateFile> {
  let r;
  try {
    r = await fs.read(TEMPLATE_FILE, MAX_TEXT + 1);
  } catch (e) {
    if (codeOf(e) === "not_found" || codeOf(e) === "missing") return { kind: "missing" };
    throw e;
  }
  const text = r.status === "ok" && typeof r.text === "string" ? r.text : "";
  const unreadable = r.status === "too_large" ? "the file is larger than 200,000 characters" : r.status === "ok" ? null : "the file is not UTF-8 text";
  return { kind: "ok", text, hash: r.hash ?? "", parse: unreadable ? { ok: false, errors: [{ path: "", line: 1, message: unreadable }] } : parseFactoryTemplate(text) };
}

/** Writes the template for a project that has none yet; another writer winning the race is fine. */
export async function writeTemplateIfMissing(fs: Pick<FsApi, "write">, t: FactoryTemplate): Promise<void> {
  try {
    await fs.write(TEMPLATE_FILE, formatFactoryTemplate(t), { expected_hash: null });
  } catch (e) {
    if (codeOf(e) !== "exists" && codeOf(e) !== "conflict") throw e;
  }
}

/** The run-start message for a migration that could not keep every step: the template is written, this run stops once. */
export function droppedMessage(dropped: readonly DroppedStep[]): string {
  const list = dropped.map((d) => `${d.name}: ${d.reason}`).join("; ");
  return `The Factory now takes its steps from ${TEMPLATE_FILE}, and some of this project's Factory settings could not be kept: ${list}. Please review ${TEMPLATE_FILE} (Factory → Process), then run again. The run did not start.`;
}

/**
 * Whether the project's Factory process has an Intake step: from the template file, else from what the first run
 * would write for its loop (the previous default moves to one without Intake). Null when it cannot be told.
 */
export async function processHasIntake(fs: Pick<FsApi, "read">, factoryLoop: () => Promise<LoopDefinition | null>): Promise<boolean | null> {
  try {
    const file = await readTemplateFile(fs);
    const has = (t: FactoryTemplate) => t.stages.some((st) => st.role === "intake" && st.enabled !== false);
    if (file.kind === "ok") return file.parse.ok ? has(file.parse.template) : null;
    const loop = await factoryLoop();
    if (!loop) return null;
    const migrated = templateFromLoop(loop).template;
    return has(upgradeOldDefault(migrated) ?? migrated);
  } catch {
    return null;
  }
}

/** The run-start message for a template with problems: up to five, each with its line. */
export function templateProblemMessage(errors: readonly TemplateError[]): string {
  const shown = errors.slice(0, 5).map((e) => `line ${e.line}: ${e.path ? `${e.path}: ` : ""}${e.message}`).join("; ");
  const more = errors.length > 5 ? ` (and ${errors.length - 5} more)` : "";
  return `Fix ${TEMPLATE_FILE} (Factory → Process): ${shown}${more}. The run did not start.`;
}
