// Typed decoders and request shapes against the contract fixtures (schema/http/fixtures): the same files the
// extension's live contract test replays against the real handlers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCommands, decodeDeleted, decodeGenerateResult, decodeRegistered, decodeSeed, decodeTemplates, decodeTemplateWrite, DecodeError } from "../decode.ts";
import { describeFailure } from "../errors.ts";
import { buildGenerateBody, validateDocRequest } from "../model.ts";
import { createDocsApi } from "../docs-api.ts";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../schema/http/fixtures");
const load = (group: string, name: string) => JSON.parse(readFileSync(join(FIX, group, `${name}.json`), "utf8"));
const names = (group: string, re: RegExp) => readdirSync(join(FIX, group)).filter((f) => re.test(f)).map((f) => f.replace(/\.json$/, ""));

test("POST /generate-doc: the 200 fixture decodes; its request is what buildGenerateBody produces", () => {
  const f = load("notes-generation", "post-generate-doc-200");
  const r = decodeGenerateResult(f.response);
  assert.equal(r.content.startsWith("## Summary"), true);
  assert.equal(r.reportsFit, true);
  const b = f.request.body;
  const built = buildGenerateBody({ template: { id: "x", name: b.templateName, sections: b.sections, rawContent: "", isBuiltin: false, folderName: null, isProjectTemplate: true, surface: "doc" }, command: b.command, prompt: b.prompt }, b.sources);
  assert.ok(built.ok);
  assert.deepEqual(built.body, b, "same request shape as the Swift client / contract");
  assert.equal(validateDocRequest(b).ok, true);
});

test("POST /generate-doc: the 400 fixture request is refused locally by the same gate; every error fixture maps to wording", () => {
  const bad = load("notes-generation", "post-generate-doc-400");
  assert.equal(validateDocRequest(bad.request.body).ok, false);
  for (const n of names("notes-generation", /^post-generate-doc-(400|401|429|500)$/)) {
    const f = load("notes-generation", n);
    const e = describeFailure({ status: f.status, code: f.response.error.code, message: f.response.error.message });
    assert.ok(e.message.length > 10, n);
  }
  assert.equal(describeFailure({ status: 429, code: "RATE_LIMITED" }).retryable, true);
  assert.equal(describeFailure({ status: 401, code: "AUTH_REQUIRED" }).action, "sign_in");
});

test("old server (no fit report) and malformed answers", () => {
  assert.equal(decodeGenerateResult({ content: "x" }).reportsFit, false);
  assert.throws(() => decodeGenerateResult({}), DecodeError);
  assert.throws(() => decodeGenerateResult(null), DecodeError);
  assert.throws(() => decodeGenerateResult({ content: 5 }), DecodeError);
  const r = decodeGenerateResult({ content: "x", truncated: ["a", 3, "b"], omitted: "no", truncatedCount: -4, omittedCount: "7" });
  assert.deepEqual(r.truncated, ["a", "b"]);
  assert.equal(r.truncatedCount, 2);
  assert.equal(r.omittedCount, 0);
  assert.equal(decodeGenerateResult({ content: "x", omitted: Array.from({ length: 500 }, () => "n") }).omitted.length, 50);
});

test("docs fixtures: every 200 decodes with its decoder; every error maps to wording", () => {
  const t = decodeTemplates(load("docs", "get-kb-docs-templates-200").response);
  assert.ok(t.items.length >= 2);
  assert.ok(t.items.every((x) => x.name && Array.isArray(x.sections) && (x.surface === "doc" || x.surface === "visual")));
  assert.equal(t.truncated, false);
  const c = decodeCommands(load("docs", "get-kb-docs-commands-200").response);
  assert.ok(c.items.some((x) => x.surface === "visual") && c.items.every((x) => x.instruction.length > 0));
  const w = decodeTemplateWrite(load("docs", "put-kb-docs-templates-folder-200").response);
  assert.equal(w.surface, "visual");
  assert.equal(w.folderName, "sprint-review");
  assert.equal(decodeDeleted(load("docs", "delete-kb-docs-templates-folder-200").response), true);
  assert.ok(decodeSeed(load("docs", "post-kb-docs-seed-200").response).written > 0);
  decodeRegistered(load("docs", "post-kb-projects-register-200").response);
  for (const n of names("docs", /-(400|404|409)(-[a-z]+)?$/)) {
    const f = load("docs", n);
    const err = f.response?.error;
    if (!err) continue;
    const m = describeFailure({ status: f.status, code: err.code, message: err.message });
    assert.ok(m.message.length > 10, `${n} (${err.code})`);
    assert.notEqual(m.message, "Something went wrong. Try again.", `${n} has specific wording (${err.code})`);
  }
  assert.throws(() => decodeTemplates({}), DecodeError);
  assert.throws(() => decodeDeleted({}), DecodeError);
  assert.deepEqual(decodeTemplates({ templates: [null, 3, { name: "" }, { name: "ok", sections: ["a", 1] }] }).items.map((x) => [x.name, x.sections]), [["ok", ["a"]]]);
});

test("docs api: paths, bodies and validation of what goes into a URL", async () => {
  const seen: { path: string; opts: { method?: string; body?: unknown } }[] = [];
  const client = {
    async request(path: string, opts: { method?: string; body?: unknown } = {}) {
      seen.push({ path, opts });
      if (path.startsWith("/generate-doc")) return { content: "d" };
      if (path.startsWith("/kb/docs/templates/")) return opts.method === "DELETE" ? { deleted: true } : load("docs", "put-kb-docs-templates-folder-200").response;
      if (path.startsWith("/kb/docs/seed")) return { written: [], count: 0 };
      if (path.startsWith("/kb/projects/register")) return { id: "p1", root: "/r" };
      return { templates: [], commands: [] };
    },
  };
  const api = createDocsApi(client as never, "pabc", "/Users/me/proj");
  await api.register();
  await api.templates();
  await api.commands();
  await api.putTemplate("sprint-review", { name: "Sprint Review", sections: ["A"], surface: "visual" });
  await api.deleteTemplate("sprint-review");
  await api.seed();
  await api.generate({ command: "c", sources: [{ name: "n", content: "c" }] }, new AbortController().signal);
  assert.deepEqual(seen.map((s) => `${s.opts.method ?? "GET"} ${s.path}`), [
    "POST /kb/projects/register",
    "GET /kb/docs/templates?project=pabc",
    "GET /kb/docs/commands?project=pabc",
    "PUT /kb/docs/templates/sprint-review?project=pabc",
    "DELETE /kb/docs/templates/sprint-review?project=pabc",
    "POST /kb/docs/seed?project=pabc",
    "POST /generate-doc",
  ]);
  assert.deepEqual(seen[0]!.opts.body, { id: "pabc", root: "/Users/me/proj" });
  assert.deepEqual(seen[3]!.opts.body, { name: "Sprint Review", sections: ["A"], surface: "visual" });
  await assert.rejects(() => api.putTemplate("../etc", { name: "x", sections: [], surface: "doc" }), (e: { code: string }) => e.code === "INVALID_FOLDER");
  await assert.rejects(() => api.deleteTemplate("a/b"), (e: { code: string }) => e.code === "INVALID_FOLDER");
  assert.throws(() => createDocsApi(client as never, "bad id/../", "/r"));
});
