import { test } from "node:test";
import assert from "node:assert/strict";
import { FACTORY_BUILT_IN_STAGES, FACTORY_TEMPLATE, factoryRole } from "../native/factory.ts";
import { DETECTED_TEST } from "../native/environment.ts";
import {
  TEMPLATE_FILE, applyTemplate, defaultFactoryTemplate, processHasIntake, processStepNames, upgradeOldDefault, formatFactoryTemplate, lineDiff, lineStart, parseFactoryTemplate, problemCountLabel, readTemplateFile, sameLoop, templateFromLoop, templateProblemMessage, writeTemplateIfMissing,
} from "../native/factory-template.ts";

const loopOf = (stages = structuredClone(FACTORY_TEMPLATE.config.stages)) => ({ id: "F", name: "Factory", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: "factory", runsOnSchedule: false, config: { ...structuredClone(FACTORY_TEMPLATE.config), stages } });
const text = (o) => JSON.stringify(o, null, 2);
const base = () => ({ version: 1, stages: [{ role: "implement" }, { role: "verify", command: "npm test" }, { role: "review" }, { role: "reviewGate" }] });
const errorsOf = (t) => { const r = parseFactoryTemplate(t); assert.equal(r.ok, false, "expected errors"); return r.errors; };

test("the template file lives beside loop.json", () => {
  assert.equal(TEMPLATE_FILE, "system/factory-template.json");
});

test("the default template parses, round-trips and lists every built-in step", () => {
  const t = defaultFactoryTemplate();
  const s = formatFactoryTemplate(t);
  assert.ok(s.endsWith("}\n"));
  const r = parseFactoryTemplate(s);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.template, t);
  assert.deepEqual(t.stages.map((x) => x.role), ["setup", "plan", "implement", "custom", "verify", "custom", "custom", "review", "reviewGate"]);
  assert.deepEqual(t.stages[3], { role: "custom", name: "Structure verify", kind: "shellCommand", command: "auto" }, "undetected: auto, off until a command is found");
  assert.deepEqual(t.stages.filter((x) => x.kind === "skill").map((x) => [x.name, x.skill, x.severity]), [["Test gaps", "test-gap-writer", "advisory"], ["Doc review", "doc-writer", "advisory"]]);
  assert.equal(formatFactoryTemplate(r.template), s, "format is stable");
});

test("a syntax error names its line and column", () => {
  const e = errorsOf('{\n  "version": 1,\n  "stages": [\n    { "role": "implement", }\n  ]\n}\n');
  assert.equal(e.length, 1);
  assert.equal(e[0].line, 4);
  assert.match(e[0].message, /column \d+/);
  assert.equal(errorsOf('{ "version": 1')[0].line, 1);
  assert.match(errorsOf('{ "version": 1, "version": 1, "stages": [] }')[0].message, /duplicate key "version"/);
  for (const k of ["__proto__", "constructor", "prototype"]) {
    const e = errorsOf(`{\n  "version": 1,\n  "stages": [ { "role": "implement", "${k}": { "x": 1 } } ]\n}`);
    assert.equal(e[0].line, 3, k);
    assert.match(e[0].message, new RegExp(`key "${k}" is not allowed`));
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test("every error points at the exact line of the value it is about", () => {
  const t = text({ ...base(), stages: [{ role: "implement" }, { role: "verify", command: "npm test" }, { role: "reviw" }, { role: "reviewGate" }] });
  const e = errorsOf(t);
  const bad = e.find((x) => x.path === "stages[2].role");
  assert.ok(bad, JSON.stringify(e));
  assert.match(bad.message, /unknown role "reviw" \(expected one of/);
  assert.equal(t.split("\n")[bad.line - 1].includes('"reviw"'), true);
});

test("unknown keys, a wrong version and out-of-range budgets are refused", () => {
  assert.match(errorsOf(text({ ...base(), extra: 1 })).map((e) => `${e.path}: ${e.message}`).join("\n"), /^extra: unknown key/m);
  assert.equal(errorsOf(text({ ...base(), version: 2 }))[0].path, "version");
  const e = errorsOf(text({ ...base(), budget: { maxIterations: 0, maxCostUsd: -1, wallClockMinutes: 2000, retries: 1 } })).map((x) => x.path);
  assert.deepEqual(e.sort(), ["budget.maxCostUsd", "budget.maxIterations", "budget.retries", "budget.wallClockMinutes"]);
  assert.equal(errorsOf(text({ version: 1, stages: [] }))[0].path, "stages");
});

test("the Factory's required steps, their order and their uniqueness are enforced", () => {
  const msgs = (stages) => errorsOf(text({ version: 1, stages })).map((e) => `${e.path}: ${e.message}`).join("\n");
  assert.match(msgs([{ role: "implement" }, { role: "verify", command: "x" }, { role: "review" }]), /missing a "reviewGate" step/);
  assert.match(msgs([{ role: "implement" }, { role: "implement" }, { role: "verify", command: "x" }, { role: "review" }, { role: "reviewGate" }]), /stages\[1\]\.role: only one "implement" step/);
  assert.match(msgs([{ role: "verify", command: "x" }, { role: "implement" }, { role: "review" }, { role: "reviewGate" }]), /"verify" must come after "implement"/);
  assert.match(msgs([{ role: "implement" }, { role: "verify", command: "x" }, { role: "review" }, { role: "reviewGate" }, { role: "custom", name: "Lint", kind: "shellCommand", command: "npm run lint" }]), /"reviewGate" must be the last step/);
  assert.match(msgs([{ role: "intakeGate" }, { role: "intake" }, { role: "implement" }, { role: "verify", command: "x" }, { role: "review" }, { role: "reviewGate" }]), /"intakeGate" needs an "intake" step before it/);
  assert.match(msgs([{ role: "plan" }, { role: "plan" }, ...base().stages]), /only one "plan" step/);
  assert.match(msgs([{ role: "custom", name: "Review", kind: "shellCommand", command: "x" }, ...base().stages]), /name "Review" is used twice/);
  assert.match(msgs(Array.from({ length: 31 }, () => ({ role: "implement" }))), /at most 30 steps/);
  assert.match(msgs([{ role: "implement" }, { role: "verify", command: "x" }, { role: "review" }, { role: "reviewGate", enabled: false }]), /stages\[3\]\.enabled: the "reviewGate" step cannot be turned off/);
  assert.match(msgs([{ role: "implement" }, { role: "verify", command: "x", severity: "advisory" }, { role: "review" }, { role: "reviewGate" }]), /stages\[1\]\.severity: the "verify" step must stay blocking/);
  assert.match(msgs([{ role: "implement" }, { role: "verify", command: "x" }, { role: "review" }, { role: "custom", name: "Docs", kind: "skill", skill: "doc-writer" }, { role: "reviewGate" }]), /stages\[3\]\.role: a custom skill step cannot come between "review" and "reviewGate"/);
  assert.equal(parseFactoryTemplate(text({ version: 1, stages: [{ role: "implement" }, { role: "verify", command: "x" }, { role: "review" }, { role: "custom", name: "Lint", kind: "shellCommand", command: "npm run lint" }, { role: "reviewGate" }] })).ok, true, "a shell check there is fine");
});

test("fields are allowed only where they mean something, and custom steps need what they run", () => {
  const one = (stage) => errorsOf(text({ version: 1, stages: [stage, ...base().stages] })).map((e) => `${e.path}: ${e.message}`).join("\n");
  assert.match(one({ role: "intakeGate", prompt: "x" }), /stages\[0\]\.prompt: not allowed for a "intakeGate" step/);
  assert.match(one({ role: "plan", command: "x" }), /stages\[0\]\.command: not allowed/);
  assert.match(one({ role: "plan", kind: "skill" }), /stages\[0\]\.kind: only a "custom" step/);
  assert.match(one({ role: "custom", name: "A", kind: "shellCommand" }), /stages\[0\]\.command: a custom shell step needs a command/);
  assert.match(one({ role: "custom", name: "A", kind: "skill" }), /stages\[0\]\.skill: a custom skill step needs a skill/);
  assert.match(one({ role: "custom", name: "A", kind: "skill", skill: "Bad Skill" }), /stages\[0\]\.skill:/);
  assert.match(one({ role: "custom", name: "A", kind: "skill", skill: "plugins/x" }), /stages\[0\]\.skill:/, "only skills/<name> or a bare name");
  assert.equal(parseFactoryTemplate(text({ version: 1, stages: [{ role: "custom", name: "A", kind: "skill", skill: "skills/doc-writer" }, ...base().stages] })).ok, true);
  assert.match(one({ role: "custom", name: "A", kind: "artifactCheck", verdictPath: ".factory/LINT.md" }), /stages\[0\]\.verdictLine: a verdict check needs a verdictLine/);
  for (const bad of ["notes/LINT.md", ".factory/../x.md", ".factory/REVIEW.md", ".factory/READINESS.md"]) {
    assert.match(one({ role: "custom", name: "A", kind: "artifactCheck", verdictPath: bad, verdictLine: "Verdict: ok" }), /stages\[0\]\.verdictPath:/, bad);
  }
  assert.match(one({ role: "custom", name: "A", kind: "shellCommand", command: "x", verdictLine: "y" }), /stages\[0\]\.verdictLine: only a custom "artifactCheck" step/);
  assert.match(one({ role: "plan", severity: "loud" }), /stages\[0\]\.severity/);
  assert.equal(parseFactoryTemplate(text({ version: 1, stages: [{ role: "plan", severity: "advisory" }, ...base().stages] })).ok, true, "a non-required built-in step may be advisory");
  assert.match(one({ role: "custom", kind: "shellCommand", command: "x" }), /stages\[0\]\.name: a custom step needs a name/);
  assert.match(one({ role: "custom", name: "A", kind: "shellCommand", command: "a\nb" }), /one line/);
  assert.match(one({ role: "setup", enabled: true }), /an enabled "setup" step needs a command/);
  assert.match(one({ role: "plan", timeoutMinutes: 500 }), /timeoutMinutes/);
  assert.match(one({ role: "plan", name: "" }), /stages\[0\]\.name/);
  assert.equal(parseFactoryTemplate(text({ version: 1, stages: [{ role: "custom", name: "Lint", kind: "shellCommand", command: "npm run lint", severity: "advisory" }, ...base().stages] })).ok, true);
});

test("the built-in loop migrates to a template that applies back to the same steps", () => {
  const loop = loopOf();
  const { template: t, dropped } = templateFromLoop(loop);
  assert.deepEqual(dropped, []);
  assert.equal(parseFactoryTemplate(formatFactoryTemplate(t)).ok, true);
  assert.deepEqual(t, defaultFactoryTemplate(), "an unedited Factory loop is the default template");
  const applied = applyTemplate(loop, t, null);
  const view = (l) => l.config.stages.map((s) => ({ role: factoryRole(s), name: s.name, command: s.command, prompt: s.prompt, enabled: s.enabled, skillId: s.skillId }));
  assert.deepEqual(view(applied), view(loop));
  assert.equal(applied.config.stages.find((s) => factoryRole(s) === "verify").command, DETECTED_TEST);
  assert.equal(applyTemplate(loop, t, "npm test").config.stages.find((s) => factoryRole(s) === "verify").command, "npm test", "auto takes the detected command");
});

test("apply is deterministic, keeps existing stage ids, and an unchanged template changes nothing", () => {
  const loop = loopOf(structuredClone(FACTORY_TEMPLATE.config.stages).map((s, i) => ({ ...s, id: s.id.startsWith("custom/") ? s.id : `random-${i}` })));
  const t = templateFromLoop(loop).template;
  const a = applyTemplate(loop, t, null);
  assert.deepEqual(a, applyTemplate(loop, t, null));
  assert.deepEqual(a.config.stages.map((s) => s.id), loop.config.stages.map((s) => s.id));
  assert.equal(sameLoop(a, loop), true);
  const edited = applyTemplate(loop, { ...t, stages: t.stages.map((s) => (s.role === "implement" ? { ...s, prompt: "Keep it small." } : s)) }, null);
  assert.equal(sameLoop(edited, loop), false);
  assert.equal(edited.config.stages.find((s) => factoryRole(s) === "implement").prompt, "Keep it small.");
});

test("custom steps, budgets and user edits survive the migration and are built from scratch on apply", () => {
  const stages = structuredClone(FACTORY_BUILT_IN_STAGES);
  stages.splice(6, 0, { ...stages[5], id: "u1", name: "Lint", command: "npm run lint", severity: "advisory", order: 6 });
  stages.push({ ...stages[0], id: "u2", name: "Graph", kind: "codeGraph", command: null, order: 99 });
  const loop = loopOf(stages.map((s, i) => ({ ...s, order: i })));
  loop.config.maxIterations = 4;
  loop.config.maxCostUsd = null;
  loop.config.wallClockBudgetSeconds = 1800;
  const { template: t, dropped } = templateFromLoop(loop);
  assert.deepEqual(dropped, [{ name: "Graph", reason: 'a "codeGraph" step cannot be written in the template' }], "nothing is dropped silently");
  assert.deepEqual(t.budget, { maxIterations: 4, maxCostUsd: 0, wallClockMinutes: 30 });
  assert.deepEqual(t.stages.find((s) => s.role === "custom"), { role: "custom", name: "Lint", kind: "shellCommand", severity: "advisory", command: "npm run lint" });
  assert.equal(t.stages.some((s) => s.name === "Graph"), false, "a stage the template cannot express is left out, and reported");
  const applied = applyTemplate(loop, t, null);
  const lint = applied.config.stages.find((s) => s.name === "Lint");
  assert.deepEqual({ kind: lint.kind, command: lint.command, severity: lint.severity, id: lint.id }, { kind: "shellCommand", command: "npm run lint", severity: "advisory", id: "custom/lint-1" }, "an older loop's random id becomes a custom/ id, so it is never taken for Verify");
  assert.equal(applied.config.maxCostUsd, null);
  assert.equal(applied.config.wallClockBudgetSeconds, 1800);
  const fresh = applyTemplate(loopOf(), { version: 1, stages: [...base().stages.slice(0, 3), { role: "custom", name: "Docs check", kind: "skill", skill: "doc-writer", prompt: "Check docs." }, { role: "reviewGate" }] }, null);
  const docs = fresh.config.stages.find((s) => s.name === "Docs check");
  assert.deepEqual({ id: docs.id, skillId: docs.skillId, prompt: docs.prompt, order: docs.order }, { id: "custom/docs-check-1", skillId: "skills/doc-writer", prompt: "Check docs.", order: 3 });
});

test("lineDiff marks removed and added lines and keeps the common ones", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [{ kind: " ", text: "a" }, { kind: "-", text: "b" }, { kind: "+", text: "x" }, { kind: " ", text: "c" }]);
  assert.deepEqual(lineDiff("", "a"), [{ kind: "-", text: "" }, { kind: "+", text: "a" }]);
});

test("lineStart finds where an error's line begins, for moving the caret there", () => {
  assert.equal(lineStart("ab\ncd\nef", 1), 0);
  assert.equal(lineStart("ab\ncd\nef", 3), 6);
  assert.equal(lineStart("ab", 9), 2);
});

test("the file helpers read, create once and explain problems with their lines", async () => {
  const { memFs } = await import("../../factory/tests/mem-fs.mjs");
  const fs = memFs();
  assert.deepEqual(await readTemplateFile(fs), { kind: "missing" });
  await writeTemplateIfMissing(fs, defaultFactoryTemplate());
  await writeTemplateIfMissing(fs, { version: 1, stages: [] });
  const r = await readTemplateFile(fs);
  assert.equal(r.kind, "ok");
  assert.equal(r.parse.ok, true, "the second writer never overwrites the first");
  const msg = templateProblemMessage(Array.from({ length: 7 }, (_, i) => ({ path: `stages[${i}].role`, line: i + 2, message: "bad" })));
  assert.match(msg, /^Fix system\/factory-template\.json \(Factory → Process\): line 2: stages\[0\]\.role: bad;/);
  assert.match(msg, /\(and 2 more\)\. The run did not start\.$/);
});

test("severity and verdict-check steps migrate and apply instead of being dropped; what cannot is reported with a reason", () => {
  const stages = structuredClone(FACTORY_BUILT_IN_STAGES);
  stages.find((s) => s.name === "Plan").severity = "advisory";
  stages.find((s) => s.name === "Review").severity = "advisory";
  stages.find((s) => s.name === "Verify").prompt = "unused prompt";
  stages.splice(6, 0,
    { ...stages[2], id: "c1", name: "Lint gate", check: { verdict: { path: ".factory/LINT.md", line: "Verdict: clean" } }, severity: "advisory" },
    { ...stages[2], id: "c2", name: "Odd check", check: { files: ["a"] } },
    { ...stages[3], id: "c3", name: "Plugin skill", skillId: "plugins/thing" },
    { ...stages[5], id: "c4", name: "Lint", command: "npm run lint", testOp: "map" });
  const loop = loopOf(stages.map((s, i) => ({ ...s, order: i })));
  const { template, dropped } = templateFromLoop(loop);
  assert.equal(template.stages.find((s) => s.role === "plan").severity, "advisory");
  assert.deepEqual(template.stages.find((s) => s.name === "Lint gate"), { role: "custom", name: "Lint gate", kind: "artifactCheck", severity: "advisory", verdictPath: ".factory/LINT.md", verdictLine: "Verdict: clean" });
  const why = Object.fromEntries(dropped.map((d) => [d.name, d.reason]));
  assert.match(why["Review"], /must stay blocking/);
  assert.match(why["Verify"], /prompt/);
  assert.match(why["Odd check"], /verdict/);
  assert.match(why["Plugin skill"], /plugins\/thing/);
  assert.match(why["Lint"], /testOp/);
  assert.equal(parseFactoryTemplate(formatFactoryTemplate(template)).ok, true);
  const applied = applyTemplate(loop, template, null);
  const gate = applied.config.stages.find((s) => s.name === "Lint gate");
  assert.deepEqual({ kind: gate.kind, check: gate.check, severity: gate.severity, id: gate.id, role: factoryRole(gate) }, { kind: "artifactCheck", check: { verdict: { path: ".factory/LINT.md", line: "Verdict: clean" } }, severity: "advisory", id: "custom/lint-gate-1", role: null });
  assert.equal(applied.config.stages.find((s) => s.name === "Plan").severity, "advisory");
  assert.equal(applied.config.stages.find((s) => s.name === "Review").severity, "blocking");
});

test("an unreadable template says why: too large or not UTF-8 text", async () => {
  for (const [status, why] of [["too_large", /larger than 200,000 characters/], ["binary", /not UTF-8 text/]]) {
    const r = await readTemplateFile({ read: async () => ({ status, text: null, hash: "h" }) });
    assert.equal(r.parse.ok, false);
    assert.match(r.parse.errors[0].message, why);
  }
});

test("the spoken problem count is short", () => {
  assert.deepEqual([0, 1, 3].map(problemCountLabel), ["No problems", "1 problem", "3 problems"]);
});

test("an unedited loop of the previous default moves to the new default, keeping its commands and budget; an edited one keeps its steps", () => {
  const old = loopOf(structuredClone(FACTORY_BUILT_IN_STAGES).map((s) => (s.name === "Set up" ? { ...s, command: "npm ci", enabled: true } : s.name === "Verify" ? { ...s, command: "npm test" } : s)));
  old.config.maxIterations = 6;
  const migrated = templateFromLoop(old).template;
  const up = upgradeOldDefault(migrated);
  assert.deepEqual(up.stages.map((s) => s.role), defaultFactoryTemplate().stages.map((s) => s.role));
  assert.deepEqual(up.stages.find((s) => s.role === "setup"), { role: "setup", command: "npm ci" });
  assert.deepEqual(up.stages.find((s) => s.role === "verify"), { role: "verify", command: "npm test" });
  assert.equal(up.budget.maxIterations, 6);
  const edited = { ...migrated, stages: migrated.stages.map((s) => (s.role === "intake" ? { ...s, prompt: "Mine." } : s)) };
  assert.equal(upgradeOldDefault(edited), null);
  assert.equal(upgradeOldDefault(defaultFactoryTemplate()), null, "the current default is left alone");
});

test("a template that brings Intake back applies with the built-in Intake step", () => {
  const t = { version: 1, stages: [{ role: "intake" }, { role: "intakeGate" }, ...defaultFactoryTemplate().stages] };
  assert.equal(parseFactoryTemplate(formatFactoryTemplate(t)).ok, true);
  const applied = applyTemplate(loopOf(), t, null);
  assert.deepEqual(applied.config.stages.slice(0, 2).map((s) => [s.name, factoryRole(s)]), [["Intake", "intake"], ["Intake gate", "intakeGate"]]);
});

test("a custom shell step with command auto takes the detected structure command and is on only when one was found", () => {
  const t = defaultFactoryTemplate();
  const off = applyTemplate(loopOf(), t, null, null).config.stages.find((s) => s.name === "Structure verify");
  assert.deepEqual({ command: off.command, enabled: off.enabled, role: factoryRole(off) }, { command: "<detected-structure-command>", enabled: false, role: null });
  const on = applyTemplate(loopOf(), t, null, "npx tsc --noEmit").config.stages.find((s) => s.name === "Structure verify");
  assert.deepEqual({ command: on.command, enabled: on.enabled, id: on.id }, { command: "npx tsc --noEmit", enabled: true, id: "custom/structure-verify-1" });
});

test("migration reports a custom agent step between Review and its gate instead of keeping it", () => {
  const stages = structuredClone(FACTORY_BUILT_IN_STAGES);
  stages.splice(7, 0, { ...stages[6], id: "custom/x-1", name: "Polish", skillId: "skills/doc-writer" });
  const { template, dropped } = templateFromLoop(loopOf(stages.map((s, i) => ({ ...s, order: i }))));
  assert.deepEqual(dropped, [{ name: "Polish", reason: 'a custom skill step cannot come between "review" and "reviewGate" (it could change Review\'s report)' }]);
  assert.equal(template.stages.some((s) => s.name === "Polish"), false);
});

test("processHasIntake reads the template, else what the first run would write, else does not know", async () => {
  const { memFs } = await import("../../factory/tests/mem-fs.mjs");
  const none = async () => null;
  const withFile = (t) => memFs({ [TEMPLATE_FILE]: formatFactoryTemplate(t) });
  assert.equal(await processHasIntake(withFile(defaultFactoryTemplate()), none), false);
  assert.equal(await processHasIntake(withFile({ version: 1, stages: [{ role: "intake" }, { role: "intakeGate" }, ...defaultFactoryTemplate().stages] }), none), true);
  assert.equal(await processHasIntake(memFs({ [TEMPLATE_FILE]: "{" }), none), null, "a broken file: unknown");
  assert.equal(await processHasIntake(memFs(), none), null);
  assert.equal(await processHasIntake(memFs(), async () => loopOf(structuredClone(FACTORY_BUILT_IN_STAGES))), false, "the previous default moves to the new one");
  const edited = structuredClone(FACTORY_BUILT_IN_STAGES).map((s) => (s.name === "Intake" ? { ...s, prompt: "Mine." } : s));
  assert.equal(await processHasIntake(memFs(), async () => loopOf(edited)), true, "an edited loop keeps its Intake");
});

test("processStepNames: enabled steps in order are the board lanes; gates, an empty setup and auto-detected steps are not", () => {
  assert.deepEqual(processStepNames(base()), ["Implement", "Verify", "Review"]);
  const t = { version: 1, stages: [
    { role: "setup" }, { role: "plan", name: "Design" }, { role: "custom", name: "Structure verify", kind: "shellCommand", command: "auto" },
    { role: "implement", enabled: false }, { role: "custom", name: "Doc review", kind: "skill", skill: "doc-writer" }, { role: "review" }, { role: "reviewGate" },
  ] };
  assert.deepEqual(processStepNames(t), ["Design", "Doc review", "Review"]);
  // An auto step the loop's detection turned on keeps its place in the order.
  assert.deepEqual(processStepNames(t, new Set(["Structure verify"])), ["Design", "Structure verify", "Doc review", "Review"]);
  assert.deepEqual(processStepNames(defaultFactoryTemplate()).includes("Review gate"), false);
});
