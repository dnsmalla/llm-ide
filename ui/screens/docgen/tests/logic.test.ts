import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGenerateBody, estimateFit, fitNotice, formatBytes, MAX_BODY_CHARS, MAX_COMMAND, MAX_PROMPT, MAX_SOURCE_CONTENT, MAX_TOTAL_SOURCE_CHARS, validateDocRequest, type DocTemplate } from "../model.ts";
import { candidateName, documentStem, slugify } from "../naming.ts";
import { describeFailure, isCancel } from "../errors.ts";
import { folderForName, projectIdFor, PROJECT_ID_RE } from "../docs-api.ts";

const tpl = (over: Partial<DocTemplate> = {}): DocTemplate => ({ id: "t", name: "Notes", sections: ["Summary", "Decisions"], rawContent: "", isBuiltin: false, folderName: "notes", isProjectTemplate: true, surface: "doc", ...over });
const src = [{ name: "a.md", content: "hello" }];

test("validateDocRequest mirrors the core's accept/reject matrix", () => {
  const v = (b: object) => validateDocRequest(b);
  assert.deepEqual(v({ sources: src }), { ok: false, code: "needs_template_or_command", message: "Choose a template or write a command." });
  assert.equal(v({ templateName: "T", sections: [], sources: src }).ok, false, "template without sections is not a template");
  assert.equal(v({ templateName: "", sections: ["a"], sources: src }).ok, false);
  assert.equal(v({ command: "   ", sources: src }).ok, false, "blank command");
  assert.equal(v({ command: "x", sources: [] }).ok, false);
  assert.equal(v({ command: "x" }).ok, false);
  assert.deepEqual(v({ command: "x", sources: src }), { ok: true, hasTemplate: false, hasCommand: true });
  assert.deepEqual(v({ templateName: "T", sections: ["a"], sources: src }), { ok: true, hasTemplate: true, hasCommand: false });
  assert.deepEqual(v({ templateName: "T", sections: ["a"], command: "c", sources: src }), { ok: true, hasTemplate: true, hasCommand: true });
});

test("buildGenerateBody: request shape matches schema/http/fixtures post-generate-doc-200, trims, omits empties, caps", () => {
  const r = buildGenerateBody({ template: tpl({ name: "Meeting notes" }), command: "  Summarise the discussion ", prompt: " Keep it short " }, src);
  assert.ok(r.ok);
  assert.deepEqual(r.body, { templateName: "Meeting notes", sections: ["Summary", "Decisions"], command: "Summarise the discussion", prompt: "Keep it short", sources: src });
  const only = buildGenerateBody({ template: null, command: "c", prompt: "" }, src);
  assert.ok(only.ok);
  assert.deepEqual(Object.keys(only.body).sort(), ["command", "sources"]);
  assert.equal(buildGenerateBody({ template: null, command: "", prompt: "p" }, src).ok, false);
  assert.equal(buildGenerateBody({ template: null, command: "x".repeat(MAX_COMMAND + 1), prompt: "" }, src).ok, false);
  assert.equal(buildGenerateBody({ template: null, command: "c", prompt: "x".repeat(MAX_PROMPT + 1) }, src).ok, false);
  assert.equal(buildGenerateBody({ template: null, command: "c", prompt: "" }, [{ name: "big", content: "x".repeat(MAX_BODY_CHARS + 1) }]).ok, false);
  const manySections = tpl({ sections: Array.from({ length: 80 }, (_, i) => `S${i}`) });
  const m = buildGenerateBody({ template: manySections, command: "", prompt: "" }, src);
  assert.ok(m.ok);
  assert.equal(m.body.sections?.length, 30);
});

test("estimateFit: whole sources, per-source cap, shared budget, omitted tail; mirrors packSources", () => {
  const small = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, chars: 1000 }));
  assert.deepEqual({ ...estimateFit(small), tokens: 0, packedChars: 0 }, { whole: 10, shortened: 0, omitted: 0, packedChars: 0, tokens: 0 });
  const huge = estimateFit([{ name: "big", chars: 10 * MAX_SOURCE_CONTENT }]);
  assert.equal(huge.shortened, 1);
  assert.ok(huge.packedChars <= MAX_SOURCE_CONTENT + 20);
  // 100 sources of 50 MB total (500 KB each): all capped at 50k, then water-filled into 400k
  const big = estimateFit(Array.from({ length: 100 }, (_, i) => ({ name: `file-${i}.ts`, chars: 500_000 })));
  assert.ok(big.packedChars <= MAX_TOTAL_SOURCE_CHARS, `packed ${big.packedChars}`);
  assert.equal(big.omitted, 0);
  assert.equal(big.shortened, 100);
  // tens of thousands of tiny sources: prefix rule drops the tail, never throws, stays fast
  const t0 = performance.now();
  const many = estimateFit(Array.from({ length: 50_000 }, (_, i) => ({ name: `n${i}`, chars: 5000 })));
  assert.ok(performance.now() - t0 < 500);
  assert.ok(many.omitted > 0 && many.omitted < 50_000);
  assert.ok(many.packedChars <= MAX_TOTAL_SOURCE_CHARS);
  assert.deepEqual(estimateFit([]), { whole: 0, shortened: 0, omitted: 0, packedChars: 0, tokens: 0 });
});

test("fitNotice words what the core dropped, handles old servers", () => {
  const base = { truncated: [], truncatedCount: 0, omitted: [], omittedCount: 0, reportsFit: true };
  assert.equal(fitNotice(base, 3), null);
  assert.match(fitNotice({ ...base, omitted: ["a", "b", "c", "d"], omittedCount: 120 }, 200)!, /120 sources were left out \(a, b, c and 117 more\)/);
  assert.match(fitNotice({ ...base, truncated: ["x"], truncatedCount: 1 }, 3)!, /1 source was shortened to fit \(x\)/);
  assert.match(fitNotice({ ...base, reportsFit: false }, 30)!, /first 20 sources/);
  assert.equal(fitNotice({ ...base, reportsFit: false }, 5), null);
});

test("slugify: safe stems for hostile and non-latin names", () => {
  assert.equal(slugify("Meeting Notes / Q3: Plan!"), "meeting-notes-q3-plan");
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("..\\..\\win"), "win");
  assert.equal(slugify("\u0000‮"), "document");
  assert.equal(slugify("   "), "document");
  assert.equal(slugify("CON"), "con-doc");
  assert.equal(slugify("会議メモ 第3回"), "会議メモ-第3回");
  assert.equal(slugify("é à ü"), "e-a-u");
  assert.ok(slugify("x".repeat(500)).length <= 60);
  assert.ok(!/[\/\\:.]/.test(slugify("a/b\\c:d.e")));
});

test("candidate names: plain, then -2, -3; stem with date", () => {
  assert.equal(candidateName("doc", 0), "doc.md");
  assert.equal(candidateName("doc", 1), "doc-2.md");
  assert.equal(candidateName("doc", 2), "doc-3.md");
  assert.equal(documentStem({ templateName: "Decision Log", date: new Date(2026, 9, 31) }), "decision-log-20261031");
  assert.equal(documentStem({ date: new Date(2026, 0, 5) }), "document-20260105");
});

test("describeFailure: every known core code maps to wording, never raw server text", () => {
  const codes = ["VALIDATION_FAILED", "AUTH_REQUIRED", "RATE_LIMITED", "feature_disabled", "INTERNAL_ERROR", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "PROVIDER_ERROR", "PROVIDER_BLOCKED", "PROVIDER_AUTH", "MODEL_REJECTED", "CLAUDE_NOT_FOUND", "CLAUDE_CODE_OAUTH", "PAYLOAD_TOO_LARGE", "PROJECT_NOT_REGISTERED", "INVALID_ROOT", "INVALID_PROJECT_ID", "INVALID_FOLDER", "RESERVED_FOLDER", "UNSAFE_PATH", "TOO_LARGE", "TOO_MANY_PROJECTS", "DOCS_FAILED", "TIMEOUT", "NETWORK", "SESSION_EXPIRED", "NO_SESSION", "UNTRUSTED_CORE", "UNSAFE_URL", "BAD_RESPONSE"];
  for (const code of codes) {
    const f = describeFailure({ code, status: 400, message: "<img src=x onerror=alert(1)> secret /Users/me" });
    assert.ok(f.message.length > 10, code);
    assert.ok(!/img|secret|Users/.test(f.message), code);
  }
  for (const code of ["no_project", "exists", "conflict", "too_large", "permission_denied", "outside_root", "io", "unavailable"]) assert.ok(describeFailure({ code, message: "/x" }).message.length > 5, code);
  assert.equal(describeFailure({ status: 429 }).retryable, true);
  assert.equal(describeFailure({ status: 401 }).action, "sign_in");
  assert.equal(describeFailure({ code: "weird", status: 418 }).message, "Something went wrong. Try again.");
  assert.equal(describeFailure(null).message, "Something went wrong. Try again.");
  assert.equal(describeFailure({ code: "__proto__" }).message, "Something went wrong. Try again.");
  assert.equal(describeFailure({ code: "feature_disabled", status: 404 }).action, "settings");
  assert.equal(isCancel({ code: "ABORTED" }), true);
  assert.equal(isCancel(new DOMException("x", "AbortError")), true);
  assert.equal(isCancel({ code: "NETWORK" }), false);
});

test("project ids are stable, valid and root-specific; folder names are safe", async () => {
  const a = await projectIdFor("/Users/me/proj");
  assert.equal(a, await projectIdFor("/Users/me/proj"));
  assert.notEqual(a, await projectIdFor("/Users/me/proj2"));
  assert.match(a, PROJECT_ID_RE);
  assert.equal(folderForName("Sprint Review"), "sprint-review");
  assert.equal(folderForName("../x"), "x");
  assert.equal(folderForName("会議"), null);
  assert.equal(folderForName("  "), null);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(50 * 1024 * 1024), "50 MB");
});
