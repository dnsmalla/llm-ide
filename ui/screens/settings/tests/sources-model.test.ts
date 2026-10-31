import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCatalog, decodeRepos, connectorBadges, repoTitle, sourcesError } from "../sources-model.ts";

test("catalog: valid rows only, ids validated, untrusted text cleaned and capped", () => {
  const rows = decodeCatalog({
    catalog: [
      { id: "gmail", name: "Gmail", description: "Mail\u202e hijack \u0000 here", authKind: "google-oauth", pipelineReady: true, selected: true },
      { id: "BAD ID", name: "x" },
      { id: "miro", name: "", description: "", authKind: "miro-oauth", pipelineReady: false },
      { id: "a" },
      "nope",
      null,
    ],
  });
  assert.deepEqual(rows.map((r) => r.id), ["gmail", "miro"]);
  assert.equal(rows[0]!.name, "Gmail");
  assert.equal(rows[0]!.description, "Mail hijack here", "bidi and controls removed");
  assert.equal(rows[1]!.name, "miro", "a missing name falls back to the id");
  assert.deepEqual(connectorBadges(rows[0]!), ["Selected"]);
  assert.deepEqual(connectorBadges(rows[1]!), ["Hidden", "No import pipeline yet", "MCP connector"]);
  assert.deepEqual(decodeCatalog({ catalog: [] }), []);
  assert.deepEqual(decodeCatalog({}), []);
  assert.deepEqual(decodeCatalog(null), []);
});

test("catalog: the list is capped at 100 and long descriptions are cut", () => {
  const catalog = Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, name: "n", description: "d".repeat(500), authKind: "k", pipelineReady: true, selected: false }));
  const rows = decodeCatalog({ catalog });
  assert.equal(rows.length, 100);
  assert.ok(rows[0]!.description.length <= 300);
  assert.ok(rows[0]!.description.endsWith("…"));
});

test("repos: absolute paths only, labels cleaned, capped at 500", () => {
  const rows = decodeRepos({
    repos: [
      { path: "/Users/a/code/app", label: "App repo" },
      { path: "/Users/a/code/b" },
      { path: "relative/path" },
      { path: 42 },
      null,
    ],
  });
  assert.deepEqual(rows, [{ path: "/Users/a/code/app", label: "App repo" }, { path: "/Users/a/code/b", label: null }]);
  assert.equal(repoTitle(rows[0]!), "App repo");
  assert.equal(repoTitle(rows[1]!), "b");
  const many = Array.from({ length: 600 }, (_, i) => ({ path: `/r/${i}` }));
  assert.equal(decodeRepos({ repos: many }).length, 500);
  assert.deepEqual(decodeRepos(null), []);
});

test("errors become plain sentences, never server text", () => {
  assert.match(sourcesError({ code: "VALIDATION_FAILED" }), /refused/);
  assert.match(sourcesError({ code: "SESSION_EXPIRED" }), /Sign in/);
  assert.match(sourcesError({ code: "NETWORK" }), /not reachable/);
  assert.equal(sourcesError({ code: "SOMETHING_ELSE" }), "The action failed.");
  assert.equal(sourcesError("boom"), "boom");
  assert.equal(sourcesError("x".repeat(500)).length, 200);
});
