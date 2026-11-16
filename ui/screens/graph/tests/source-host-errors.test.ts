// The graph read takes the host's message and code from a string, an Error, or the SSH `{ code, message }` error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReadError, readProjectGraph, type ReadResult } from "../source.ts";

/** The failure branch of a read; the tests only read failures. */
function failureOf(out: ReadResult): Extract<ReadResult, { ok: false }> {
  if (out.ok) throw new Error("expected a failed read");
  return out;
}

const ROOT = "/srv/home/docs";

test("classifyReadError: the host code wins over the text", () => {
  assert.equal(classifyReadError("anything", "no_project"), "no-project");
  assert.equal(classifyReadError("anything", "too_large"), "too-large");
  assert.equal(classifyReadError("anything", "root_missing"), "not-found");
  assert.equal(classifyReadError("anything", "not_found"), "not-found");
  assert.equal(classifyReadError("No project root is open"), "no-project", "the text still works without a code");
});

test("a { code, message } error keeps its message and its kind", async () => {
  const invoke = async () => { throw { code: "too_large", message: "graph.json is over the 48 MiB limit" }; };
  const out = await readProjectGraph(invoke, ROOT, ["system/graph/graph.json"]);
  const bad = failureOf(out);
  assert.equal(bad.kind, "too-large");
  assert.equal(bad.message, "graph.json is over the 48 MiB limit");
});

test("a { code: no_project } error maps to the no-project kind with the host's message", async () => {
  const invoke = async () => { throw { code: "no_project", message: "No project is open on the server." }; };
  const out = await readProjectGraph(invoke, ROOT);
  const bad = failureOf(out);
  assert.equal(bad.kind, "no-project");
  assert.equal(bad.message, "No project is open on the server.");
});

test("a string error and an Error keep their message", async () => {
  const asString = await readProjectGraph(async () => { throw "host refused"; }, ROOT, ["system/graph.json"]);
  assert.equal(failureOf(asString).kind, "error");
  assert.equal(failureOf(asString).message, "host refused");
  const asError = await readProjectGraph(async () => { throw new Error("permission denied"); }, ROOT, ["system/graph.json"]);
  assert.equal(failureOf(asError).message, "permission denied");
});

test("an object with no message falls back to the old generic text", async () => {
  const out = await readProjectGraph(async () => { throw { code: "weird" }; }, ROOT, ["system/graph.json"]);
  assert.equal(failureOf(out).message, "read failed");
});

test("a { code: root_missing } error is not-found, so the next candidate is tried", async () => {
  const seen: string[] = [];
  const invoke = async (_cmd: string, args?: Record<string, unknown>) => {
    seen.push(String(args?.path));
    if (String(args?.path).endsWith("graph.json")) throw { code: "root_missing", message: "This folder is no longer on the server." };
    return "{}";
  };
  const out = await readProjectGraph(invoke, ROOT, ["system/graph/graph.json", "system/graph.json"]);
  assert.equal(seen.length, 2, "not-found moves on to the next candidate");
  assert.equal(failureOf(out).kind, "not-found");
});
